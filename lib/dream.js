/**
 * dream 核心 —— qwen-code 借鉴施工清单 B1/B2/B4（本插件唯一新文件）。
 *
 * B1 快照与事后校验：LLM 步前落盘 + 快照，步后按**库的实际状态** diff 校验，
 *   计划外改动整批回滚——不信 LLM 自述（qwen-code dream.ts 的
 *   "fail closed on the filesystem, not the agent's self-report"）。
 * B2 批量合并清单协议：候选池 → LLM 一次提案（dedupe/split）→ 运行时校验
 *   （任何一条违规整单作废，qwen-code："the runtime rejects the whole manifest
 *   otherwise"）→ 确定性执行（先归档后生效，全程无物理删除）。
 * B4 执行预算：提案 ≤2 次 LLM 调用（含一次重试）+ 90 秒超时，超时放弃本轮
 *   合并步——不给 dream 代理 shell，攻击面比 qwen-code 原版小一圈。
 *
 * @module dsh-memory/lib/dream
 */

import { extractJson } from './llm.js';
import { LIMITS, validateBudget, cosine, createCard, Status, Tier } from './models.js';
import { scanSecrets, truncateSafe } from './prompt-safety.js';
import { GENERAL_WORKSPACE } from './workspace.js';

// ---- B4 预算（D3/D7 决策值） ------------------------------------------
const DREAM_TIMEOUT_MS = 90000;    // 单次提案调用超时；超时放弃本轮合并步
const DREAM_MAX_PAIRS = 30;        // 候选相似对上限
const DREAM_MAX_OVERSIZE = 10;     // 超长卡上限
const DREAM_OVERSIZE_CHARS = 800;  // 超长卡判定线（正文超此值进拆分候选）
const DREAM_MAX_OPS = 10;          // 单类操作条数上限
const DREAM_INPUT_CHARS = 25000;   // 候选清单渲染预算（LLM 输入上限）
const DREAM_MIN_CARDS = 2;
const DREAM_MAX_CARDS = 1000;      // 平方扫描护栏（超过直接跳过，毫秒级也省了）

export const DREAM_PROMPT = `你是记忆库管理员。以下是记忆库中值得整理的候选卡（id + 内容）。请提出整理提案：
1. dedupe：多张卡讲同一件事 → sources 填这些卡的 id，targetContent 给合并后的一条陈述（保留全部有效信息，数值/日期取更新的，去掉重复表述）。
2. split：一张卡混有多条互不相关的事实 → source 填这张卡的 id，targets 给拆出的每条陈述（每条独立、完整、无代词）。
规则：
- 只能使用列出的 id，不要发明新 id；每张卡最多出现在一个操作里。
- targetContent / targets 每条不超过 ${LIMITS.contentChars} 字符，一句话、独立、完整、无代词。
- 拿不准就不提案——漏并一张比错并一张好。完全不需要整理就输出空数组。

候选卡：
{cards}

近义对参考（sim 为向量相似度）：
{pairs}

只输出 JSON：
{"dedupe":[{"sources":["id1","id2"],"targetContent":"合并后的陈述"}],"split":[{"source":"id","targets":["陈述一","陈述二"]}]}
没有整理点就输出 {"dedupe":[],"split":[]}`;

// ---- B1 快照与事后校验 -------------------------------------------------

/**
 * 卡片语义哈希。只取内容语义字段；**importance 不进哈希**——召回 reinforce 会在
 * 维护期并发抬重要度（只增不减），进哈希会把正常强化误判成计划外改动。tier/
 * embedding/时间戳/命中计数都是调度状态或派生物，同理不进（qwen-code 快照同样
 * 只对比"内容语义"，调度字段漂移不算 dream 的账）。
 */
function cardHash(card) {
	return [card.content, card.category, card.ws ?? GENERAL_WORKSPACE, card.status].join('\u0000');
}

/** 全库语义快照：id → 哈希。 */
export function snapshotStore(store) {
	const snap = new Map();
	for (const [id, card] of store.cards) snap.set(id, cardHash(card));
	return snap;
}

/**
 * 前后快照 diff + 校验。allowed = dream 流程明确触碰的 id 集合；不在集合内的
 * 创建/变更/删除都算计划外改动（unexpected），调用方据此整批回滚。
 */
export function diffAndValidate(before, after, { allowed = null } = {}) {
	const created = [];
	const changed = [];
	const deleted = [];
	const unexpected = [];
	const outside = (id) => !allowed?.has(id);
	for (const [id, hash] of after) {
		const prev = before.get(id);
		if (prev === undefined) {
			created.push(id);
			if (outside(id)) unexpected.push(id);
		} else if (prev !== hash) {
			changed.push(id);
			if (outside(id)) unexpected.push(id);
		}
	}
	for (const id of before.keys()) {
		if (!after.has(id)) {
			deleted.push(id);
			if (outside(id)) unexpected.push(id);
		}
	}
	return { created, changed, deleted, unexpected };
}

// ---- B2 候选池与清单协议 -----------------------------------------------

/**
 * 候选池（纯代码，确定性）：近义对 top-N + 超长卡 top-M。
 * 近义对扫描沿用旧 autoMergeSimilar 的口径（同 scope + 同 ws + 双向量，
 * dupThreshold 0.92 / 碎片 0.80），保证新旧协议候选一致、回退无感。
 */
export function buildCandidatePool(store, config, {
	maxPairs = DREAM_MAX_PAIRS,
	oversizeLimit = DREAM_MAX_OVERSIZE,
	oversizeChars = DREAM_OVERSIZE_CHARS
} = {}) {
	const cards = store.all(); // 默认只取 ACTIVE——PINNED 天然不在池里（B3 的一部分）
	if (cards.length < DREAM_MIN_CARDS || cards.length > DREAM_MAX_CARDS) {
		return { pairs: [], oversize: [] };
	}
	const threshold = Number(config.dupThreshold ?? 0.92);
	const FRAGMENT_MIN_CHARS = 12;
	const FRAGMENT_THRESHOLD = 0.8;
	const pairs = [];
	for (let i = 0; i < cards.length; i += 1) {
		for (let j = i + 1; j < cards.length; j += 1) {
			const a = cards[i];
			const b = cards[j];
			if ((a.scope ?? 'global') !== (b.scope ?? 'global')) continue; // 跨 scope 不并
			if ((a.ws ?? GENERAL_WORKSPACE) !== (b.ws ?? GENERAL_WORKSPACE)) continue; // 跨工作区不并
			if (!a.embedding || !b.embedding) continue;
			const sim = cosine(a.embedding, b.embedding);
			const shorter = Math.min(a.content.length, b.content.length);
			if (sim >= threshold || (shorter < FRAGMENT_MIN_CHARS && sim >= FRAGMENT_THRESHOLD)) {
				pairs.push({ a, b, sim });
			}
		}
	}
	pairs.sort((x, y) => y.sim - x.sim);
	const oversize = cards
		.filter((c) => c.content.length > oversizeChars)
		.sort((x, y) => y.content.length - x.content.length)
		.slice(0, oversizeLimit);
	return { pairs: pairs.slice(0, maxPairs), oversize };
}

/** 候选池 → LLM 输入文本（带 25k 字符预算，超限截断）。返回 ids 供调试。 */
export function renderCandidates(pairs, oversize, { maxChars = DREAM_INPUT_CHARS } = {}) {
	const ids = new Set();
	const cardLines = [];
	const addCard = (card) => {
		if (ids.has(card.id)) return;
		ids.add(card.id);
		cardLines.push(`- id=${card.id} [${card.category} 重要${Number(card.importance).toFixed(2)}] ${truncateSafe(card.content, 120)}`);
	};
	for (const { a, b } of pairs) {
		addCard(a);
		addCard(b);
	}
	for (const card of oversize) addCard(card);
	const pairLines = pairs.map(({ a, b, sim }) => `- ${a.id} 与 ${b.id}（sim=${sim.toFixed(3)}）`);
	let text = cardLines.length ? `候选卡：\n${cardLines.join('\n')}` : '候选卡：（无）';
	if (pairLines.length) text += `\n\n近义对参考：\n${pairLines.join('\n')}`;
	if (oversize.length) text += `\n\n内容偏长、可考虑拆分：${oversize.map((c) => c.id).join(', ')}`;
	if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（候选过多，已按预算截断）`;
	return { ids, text };
}

/**
 * 提案清单运行时校验（纯代码）。**任何一条违规 → 整单作废**——与 qwen-code
 * 的清单纪律一致：部分放行会让 LLM 学会"夹带"。校验点：
 *   id 存在且 ACTIVE（B3：PINNED 到不了这里，因为池子就不含；校验双保险）；
 *   每张卡只出现在一个操作里；条数 ≤ 上限；产物过密钥扫描（A2）与预算（A3）。
 */
export function validateManifest(manifest, store, { maxOps = DREAM_MAX_OPS } = {}) {
	if (!manifest || typeof manifest !== 'object') return { ok: false, reason: '提案不是对象' };
	const dedupe = Array.isArray(manifest.dedupe) ? manifest.dedupe : [];
	const split = Array.isArray(manifest.split) ? manifest.split : [];
	if (dedupe.length > maxOps || split.length > maxOps) {
		return { ok: false, reason: `操作条数超上限（dedupe ${dedupe.length} / split ${split.length} > ${maxOps}）` };
	}
	const seen = new Set();
	const dedupeOps = [];
	for (const op of dedupe) {
		const sourceIds = Array.isArray(op?.sources) ? op.sources : [];
		const targetContent = String(op?.targetContent ?? '').trim();
		if (sourceIds.length < 2) return { ok: false, reason: 'dedupe 的 sources 少于 2 张' };
		if (!targetContent) return { ok: false, reason: 'targetContent 为空' };
		if (!validateBudget(targetContent).ok) return { ok: false, reason: 'targetContent 超预算' };
		const secretRule = scanSecrets(targetContent);
		if (secretRule) return { ok: false, reason: `targetContent 命中密钥规则 ${secretRule}` };
		const sources = [];
		for (const id of sourceIds) {
			const card = store.get(String(id));
			if (!card) return { ok: false, reason: `id 不存在：${id}` };
			if (card.status !== Status.ACTIVE) return { ok: false, reason: `id 非 ACTIVE（含 PINNED 拒并）：${id}` };
			if (seen.has(card.id)) return { ok: false, reason: `id 跨操作重复：${id}` };
			seen.add(card.id);
			sources.push(card);
		}
		dedupeOps.push({ sources, targetContent });
	}
	const splitOps = [];
	for (const op of split) {
		const card = store.get(String(op?.source ?? ''));
		if (!card) return { ok: false, reason: `split source 不存在：${op?.source}` };
		if (card.status !== Status.ACTIVE) return { ok: false, reason: `split source 非 ACTIVE（含 PINNED 拒拆）：${card.id}` };
		if (seen.has(card.id)) return { ok: false, reason: `id 跨操作重复：${card.id}` };
		const targets = (Array.isArray(op?.targets) ? op.targets : [])
			.map((t) => String(t ?? '').trim())
			.filter(Boolean);
		if (targets.length < 2) return { ok: false, reason: 'split 的 targets 少于 2 条' };
		for (const target of targets) {
			if (!validateBudget(target).ok) return { ok: false, reason: 'split target 超预算' };
			const secretRule = scanSecrets(target);
			if (secretRule) return { ok: false, reason: `split target 命中密钥规则 ${secretRule}` };
		}
		seen.add(card.id);
		splitOps.push({ source: card, targets });
	}
	return { ok: true, dedupe: dedupeOps, split: splitOps };
}

/**
 * 确定性执行校验通过的清单。先归档后生效：被并/被拆的原卡 SUPERSEDED + cold
 * 归档（人读演化史），全程无物理删除；合并/拆分产物逐条重嵌入（内容变了向量
 * 必须跟着变，否则新内容永远搜不到）。
 */
export async function applyManifest(validated, store, embed, tiers, now = Date.now()) {
	const stats = { deduped: 0, split: 0, touched: [] };
	for (const op of validated.dedupe) {
		// 幸存者规则与旧两两合并一致：重要度高者（平局取更早创建）
		const sorted = [...op.sources].sort(
			(a, b) => b.importance - a.importance || a.createdAt - b.createdAt
		);
		const keep = sorted[0];
		keep.content = op.targetContent;
		keep.importance = Math.max(...op.sources.map((c) => c.importance));
		keep.embedding = (await embed([op.targetContent]))[0];
		keep.lastAccessed = now;
		store.put(keep);
		stats.touched.push(keep.id);
		for (const card of sorted.slice(1)) {
			card.status = Status.SUPERSEDED;
			card.tier = Tier.COLD;
			card.updatedAt = now;
			store.put(card);
			await tiers.archive(card, 'superseded');
			stats.touched.push(card.id);
		}
		stats.deduped += 1;
	}
	for (const op of validated.split) {
		const source = op.source;
		source.status = Status.SUPERSEDED;
		source.tier = Tier.COLD;
		source.updatedAt = now;
		store.put(source);
		await tiers.archive(source, 'superseded');
		stats.touched.push(source.id);
		// 拆分产物不继承全卡重要度（一拆多后单条只值一部分），封顶 0.7
		const childImportance = Math.min(source.importance, 0.7);
		for (const content of op.targets) {
			const card = createCard({
				content,
				category: source.category,
				importance: childImportance,
				embedding: (await embed([content]))[0],
				tier: Tier.WARM,
				status: Status.ACTIVE,
				scope: source.scope ?? 'global',
				ws: source.ws ?? GENERAL_WORKSPACE,
				createdAt: now,
				lastAccessed: now
			});
			store.put(card);
			stats.touched.push(card.id);
		}
		stats.split += 1;
	}
	return stats;
}

/** 提案 → 人话清单（dry-run 展示与日志用）。 */
export function renderProposal(validated) {
	const lines = [];
	for (const op of validated.dedupe) {
		lines.push(`合并 [${op.sources.map((c) => c.id.slice(-4)).join('+')}] → ${truncateSafe(op.targetContent, 60)}`);
	}
	for (const op of validated.split) {
		lines.push(`拆分 [${op.source.id.slice(-4)}] → ${op.targets.map((t) => truncateSafe(t, 30)).join(' / ')}`);
	}
	return lines.join('\n');
}

// ---- B2+B4 主流程 ------------------------------------------------------

/** 给 promise 套超时（B4）。定时器 unref——超时放弃时不阻止进程退出。 */
function withTimeout(promise, ms, message) {
	let timer = null;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
			timer.unref?.();
		})
	]);
}

/**
 * dream 整理一趟：候选池 → LLM 一次提案 → 运行时校验 → 确定性执行。
 * 不直接落库保存（调用方 engine 负责校验后的 save 与失败回滚）。
 *
 * @returns {Promise<{checked, deduped, split, touched, dryRun, proposal, rejected, skipped}>}
 */
export async function dreamConsolidate(store, chat, embed, config, tiers, {
	dryRun = false,
	timeoutMs = DREAM_TIMEOUT_MS,
	signal
} = {}) {
	const stats = {
		checked: 0, deduped: 0, split: 0, touched: [],
		dryRun: Boolean(dryRun), proposal: '', rejected: '', skipped: ''
	};
	if (config.dreamManifest === false) {
		stats.skipped = 'dreamManifest 已关闭';
		return stats;
	}
	if (typeof chat !== 'function' || typeof embed !== 'function') {
		stats.skipped = '无 chat/embed';
		return stats;
	}
	const { pairs, oversize } = buildCandidatePool(store, config);
	stats.checked = pairs.length + oversize.length;
	if (stats.checked === 0) {
		stats.skipped = '无候选';
		return stats;
	}
	const rendered = renderCandidates(pairs, oversize);
	const prompt = DREAM_PROMPT.replace('{cards}', () => rendered.text).replace(
		'{pairs}',
		() => pairs.map(({ a, b, sim }) => `- ${a.id} 与 ${b.id}（sim=${sim.toFixed(3)}）`).join('\n') || '（无）'
	);
	// B4：提案 ≤2 次调用（原尝试 + 一次重试），单次 90 秒超时
	let raw = null;
	let lastError = null;
	for (let attempt = 0; attempt < 2 && !raw; attempt += 1) {
		try {
			raw = await withTimeout(
				chat([{ role: 'user', content: prompt }], { jsonMode: true, signal }),
				timeoutMs,
				`dream 提案超时（>${timeoutMs}ms）`
			);
		} catch (error) {
			lastError = error;
		}
	}
	if (!raw) {
		stats.skipped = `提案失败：${lastError?.message ?? '未知错误'}`;
		return stats;
	}
	const manifest = extractJson(raw);
	const validated = validateManifest(manifest, store);
	if (!validated.ok) {
		// 整单作废（qwen-code 同款纪律）：部分放行会让 LLM 学会夹带私货
		stats.rejected = validated.reason;
		return stats;
	}
	stats.proposal = renderProposal(validated);
	if (stats.dryRun) return stats; // dry-run 只出提案不执行（D1 首轮验收模式）
	const applied = await applyManifest(validated, store, embed, tiers);
	stats.deduped = applied.deduped;
	stats.split = applied.split;
	stats.touched = applied.touched;
	return stats;
}
