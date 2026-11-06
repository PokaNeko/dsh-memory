/**
 * MemoryEngine —— 门面（local 后端核心）。
 *
 *   const engine = new MemoryEngine(config, { dataDir, chat, embed })
 *   await engine.init()
 *   await engine.remember(dialog)    // 会话结束调用
 *   await engine.recall(query, 3)    // 每次对话调用
 *   engine.hotBlock()                // 拼进系统提示
 *   await engine.maintenance()       // 定时调用
 *
 * @module dsh-memory/lib/engine
 */

import { join, dirname } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Category, reinforce, scheduleScore, Status, Tier } from './models.js';
import { expireStaleFacts, purgeStale } from './gc.js';
import { autoExportMemory } from './exporter.js';
import { runIngest } from './ingest.js';
import { autoMergeSimilar, recomputeTiers } from './maintenance.js';
import { MemoryStore } from './store.js';
import { TierManager } from './tiers.js';
import { GENERAL_WORKSPACE, workspaceVisible } from './workspace.js';

// ---- A7：近期已注入卡的排名降权 --------------------------------
// 与 index.js 的 A1 硬过滤互补：A1 在调用侧把"24h 内注入过的卡"从最终命中里剔除，
// 但它发生在 topK 切片**之后**——已注入卡仍会占住 topK 名额，把新卡挤出去。
// A7 在排序前乘惩罚因子：已注入卡名次下沉，新卡顶上 topK；冷却期结束后 24h 内
// 线性恢复，避免"一刀切断崖式回弹"。只影响排序，不碰 relevance/bm25/强化门槛。
export const INJECTED_RANK_PENALTY = 0.6;
export const INJECTED_PENALTY_WINDOW_MS = 24 * 60 * 60 * 1000; // 与 index.js RECALL_COOLDOWN_MS 对齐
export const INJECTED_RECOVERY_MS = 24 * 60 * 60 * 1000;       // 冷却结束后再花 24h 线性恢复到 1.0

/** A7 惩罚因子：injectedAt 里没有这张卡 → 1；注入 <24h → 0.6；24~48h → 线性回 1。 */
export function injectedPenaltyFactor(injectedAt, cardId, now) {
	if (!injectedAt) return 1;
	const ts = injectedAt.get(cardId);
	if (!ts) return 1;
	const elapsed = now - ts;
	if (elapsed >= INJECTED_PENALTY_WINDOW_MS + INJECTED_RECOVERY_MS) return 1;
	if (elapsed >= INJECTED_PENALTY_WINDOW_MS) {
		return INJECTED_RANK_PENALTY
			+ (1 - INJECTED_RANK_PENALTY) * (elapsed - INJECTED_PENALTY_WINDOW_MS) / INJECTED_RECOVERY_MS;
	}
	return INJECTED_RANK_PENALTY;
}

/**
 * v0.6.0 存量卡一次性打 ws 标（engine.init 调用，也可独立使用）。
 *
 * 为什么在进程内做：宿主的 MemoryStore 常驻内存，任何时刻 recall 命中都可能
 * store.save() 整库回写——盘上跑迁移脚本会被下一次回写覆盖。init 时库刚加载、
 * 尚无并发写入，是唯一无竞态的窗口。
 *
 * @param {import('./store.js').MemoryStore} store
 * @param {string} mapPath - scripts/ws-map.json：{"<ws>": ["cardId", ...]}，表外默认 '*'
 * @param {string} markerPath - 迁移完成标记文件路径，存在即跳过
 * @returns {Promise<number>} 打标张数（0=已迁移过/无映射/空表）
 */
export async function applyLegacyWsMap(store, mapPath, markerPath) {
	try {
		await readFile(markerPath, 'utf8');
		return 0; // 已迁移
	} catch {
		/* 标记不存在 → 首次 */
	}
	let map;
	try {
		map = JSON.parse(await readFile(mapPath, 'utf8'));
	} catch {
		return 0; // 无映射表（或坏文件）→ 视为无迁移可做
	}
	if (!map || typeof map !== 'object') return 0;
	const idToWs = new Map();
	for (const [ws, ids] of Object.entries(map)) {
		if (ws.startsWith('$') || !Array.isArray(ids)) continue;
		for (const id of ids) idToWs.set(String(id), ws);
	}
	if (idToWs.size === 0) return 0;
	let tagged = 0;
	for (const card of store.cards.values()) {
		card.ws = idToWs.get(String(card.id)) ?? GENERAL_WORKSPACE;
		tagged += 1;
	}
	if (tagged === 0) return 0;
	await store.save();
	try {
		await writeFile(markerPath, `${new Date().toISOString()} tagged=${tagged}\n`, 'utf8');
	} catch {
		/* 标记写失败只影响幂等（下次启动会再跑一遍，force 语义下结果相同） */
	}
	return tagged;
}

export class MemoryEngine {
	/**
	 * @param {object} config - 插件配置
	 * @param {object} deps - { dataDir, chat, embed }
	 */
	constructor(config, deps) {
		this.config = config;
		this.dataDir = deps.dataDir;
		this.chat = deps.chat;
		this.embed = deps.embed;
		this.store = new MemoryStore(join(this.dataDir, 'cards.json'));
		this.tiers = new TierManager(config, this.dataDir);
	}

	async init() {
		await this.store.load();
		// v0.6.0 存量迁移：必须在新代码进程内做——宿主内存态权威，盘上迁移
		// 会被下一次 save()（召回强化就触发）覆盖。映射表随代码走
		// （scripts/ws-map.json），打过一次就落标记文件，之后零开销跳过。
		const tagged = await applyLegacyWsMap(
			this.store,
			join(dirname(this.dataDir), 'scripts', 'ws-map.json'),
			join(this.dataDir, '.ws-migrated')
		);
		if (tagged > 0) {
			// 热层按工作区分组重装，重启后热块立即是分离视图（不等维护周期）
			await recomputeTiers(this.store, this.tiers, this.config);
		}
	}

	/** 写入管线。dialog = [{role, content}, ...]。groupMode 用群聊专用提取标准。 */
	async remember(dialog, { pinned = false, groupMode = false, workspace, signal } = {}) {
		return runIngest({
			dialog,
			store: this.store,
			chat: this.chat,
			embed: this.embed,
			config: this.config,
			tiers: this.tiers,
			pinned,
			groupMode,
			workspace,
			signal
		});
	}

	/**
	 * 混合加权检索（v0.4.9 起两路）：余弦语义路 + BM25 字面路，RRF 融合后按综合分取 topK。
	 * 命中卡片自动强化（副作用）。
	 *
	 * v0.4.8 召回公平性修正（2026-10-29 实测驱动：trivia 卡 sim 0.57~0.59 却排第 11/13，
	 * 永远进不了注入位 → 永远拿不到强化 → 7 天后被过期清理，"记了等于没记"）：
	 *  1. trivia 有效重要度：7 天生命周期内的 trivia 卡按 {@link TRIVIA_EFFECTIVE_IMPORTANCE}
	 *     计综合分，不再被 0.3 的原始重要度拖死；
	 *  2. trivia 席位：相关度 ≥ {@link TRIVIA_SEAT_MIN_RELEVANCE} 的近期 trivia 卡
	 *     保证占一个注入位（换掉末位）——即时欲望的价值就在"最近"，靠重要度排队永远排不上；
	 *  3. 强化下放：候选池里相关度达标的卡**全部**强化，不再只喂注入出去的 topK
	 *     （防寄生卡的 reinforceMinRelevance 门槛原样保留，2026-10-23 实录仍被挡住）；
	 *  4. diag 出参：把候选池/强化计数带回给调用方写日志——此前日志里"候选=N"
	 *     记的是切片后的 topK 长度，排障时看不见检索池全貌。
	 *
	 * v0.4.9 混合检索（Zep 三路检索的字面+语义两路，图邻域因无图结构不做）：
	 *  - 字面路管余弦盲区：型号/缩写/换说法（"SHPC 配件"字面能撞上，余弦未必）；
	 *  - 融合用 RRF（Reciprocal Rank Fusion）：两路都靠前的卡显著增强，单路第一约等于 0.5；
	 *  - relevance 字段仍是余弦（阈值过滤/强化门槛/注入显示的语义不变）；
	 *    纯字面命中的卡靠 hit.bm25（查询内归一化 0~1）在调用侧按 bm25MinRelevance 放行。
	 *
	 * @param {object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @param {string[] | null} [options.scopes]
	 * @param {string | null} [options.workspace] - v0.6.0 工作区过滤：null 不过滤；'*' 不限；具体键=通用+该工作区
	 * @param {Map} [options.injectedAt] - A7：cardId → 注入时间戳（index.js 维护）；排名降权用
	 * @param {object} [options.diag] - 诊断出参：{ pool, candidates, bm25Candidates, reinforced, triviaSeat, penalized }
	 * @returns {Promise<Array<{card, relevance, bm25, fusion, freshness, score, penalty}>>}
	 */
	async recall(query, topK = 3, { signal, scopes = null, workspace = null, injectedAt = null, diag = null } = {}) {
		const qvec = (await this.embed([String(query ?? '')], { signal }))[0];
		if (!qvec) return [];
		const now = Date.now();
		const cfg = this.config;
		// ---- 两路候选 ----
		const cosineHits = this.store.search(qvec, topK * 4, scopes, workspace);
		const bm25Enabled = cfg.bm25Fusion !== false;
		const bm25Hits = bm25Enabled ? this.store.bm25Search(query, topK * 4, scopes, workspace) : [];
		const maxBm25 = bm25Hits.length > 0 ? bm25Hits[0].bm25 : 0;
		// ---- RRF 融合 ----
		const RRF_K = 60;
		const fused = new Map(); // id → {card, sim, bm25Norm, rrf}
		const bump = (hit, rank, kind) => {
			const entry = fused.get(hit.card.id) ?? { card: hit.card, sim: 0, bm25Norm: 0, rrf: 0 };
			entry.rrf += 1 / (RRF_K + rank + 1);
			if (kind === 'cos') entry.sim = hit.similarity;
			else entry.bm25Norm = maxBm25 > 0 ? hit.bm25 / maxBm25 : 0;
			fused.set(hit.card.id, entry);
		};
		cosineHits.forEach((hit, i) => bump(hit, i, 'cos'));
		bm25Hits.forEach((hit, i) => bump(hit, i, 'bm25'));
		// 上界归一化（两路第一 = 1.0，单路任意名次 ≈ 0.5）：分数可比、分布稳定
		const fusionCap = 2 / (RRF_K + 1);
		const results = [...fused.values()].map((entry) => {
			const fusion = Math.min(1, entry.rrf / fusionCap);
			const fresh = cardFresh(entry.card, cfg, now);
			const effective = isFreshTrivia(entry.card, now)
				? Math.max(entry.card.importance, TRIVIA_EFFECTIVE_IMPORTANCE)
				: entry.card.importance;
			const score =
				cfg.wRelevance * fusion + cfg.wImportance * effective + cfg.wFreshness * fresh;
			// A7：惩罚只乘排序键，score 字段保持诚实值（阈值/强化/显示都不受影响）
			const penalty = injectedPenaltyFactor(injectedAt, entry.card.id, now);
			return {
				card: entry.card,
				relevance: entry.sim,
				bm25: entry.bm25Norm,
				fusion,
				freshness: fresh,
				score: Math.max(0, Math.min(1, score)),
				penalty,
				rankScore: Math.max(0, Math.min(1, score)) * penalty
			};
		});
		results.sort((a, b) => b.rankScore - a.rankScore);
		const top = results.slice(0, topK);
		// trivia 席位：分数没挤进 top 但相关度达标的近期 trivia，换掉注入位末位
		let triviaSeatUsed = false;
		const seat = results.find(
			(r) => isFreshTrivia(r.card, now) && Number(r.relevance) >= TRIVIA_SEAT_MIN_RELEVANCE
		);
		if (seat && !top.includes(seat)) {
			top[top.length - 1] = seat;
			triviaSeatUsed = true;
		}
		// 强化门槛：相关度不足的边缘命中不加重要度——防寄生卡被弱命中反复喂胖
		// （2026-10-23 实录：规矩卡靠 0.37~0.46 的边缘命中三轮涨到 1.00）。
		// v0.4.8 范围从 top 扩到全部候选：达标即强化，注入位不再是强化的独木桥。
		// v0.4.9 强化依据仍取余弦（语义确认）：纯字面撞词不算"被理解"，不喂重要度。
		const reinforceMin = Number(cfg.reinforceMinRelevance ?? 0.5);
		let reinforced = 0;
		for (const hit of results) {
			if (Number(hit.relevance) >= reinforceMin) {
				reinforce(hit.card, cfg, now);
				reinforced += 1;
			}
		}
		if (diag) {
			const scopeSet = Array.isArray(scopes) && scopes.length > 0 ? new Set(scopes) : null;
			diag.pool = this.store.warm().filter(
				(c) => (!scopeSet || scopeSet.has(c.scope ?? 'global')) && workspaceVisible(c.ws, workspace)
			).length;
			diag.candidates = cosineHits.length;
			diag.bm25Candidates = bm25Hits.length;
			diag.reinforced = reinforced;
			diag.triviaSeat = triviaSeatUsed;
			diag.penalized = results.filter((r) => r.penalty < 1).length; // A7 观测
		}
		if (top.length > 0 || reinforced > 0) await this.store.save();
		return top;
	}

	/**
	 * 常驻系统提示的记忆块（v0.6.0 按工作区渲染）。
	 * @param {string | null} ws - null/'*' = 通用视图（只含通用卡）；具体键 = 通用 + 该工作区
	 */
	hotBlock(ws = null) {
		return this.tiers.renderHotBlock(this.store.hot(ws));
	}

	/** 维护一趟（v0.3.1 备份 → v0.3.4 清理 → v0.3.2 自动合并 → 分层重算 → v0.4 导出）。 */
	async maintenance() {
		await this.store.backupRotating(5);
		// 清理在合并前：先瘦身，autoMerge 的平方扫描少跑冤枉卡
		const purgeStats = purgeStale(this.store, this.config);
		const expireStats = await expireStaleFacts(this.store, this.chat, this.config, this.tiers);
		const mergeStats = await autoMergeSimilar(this.store, this.chat, this.embed, this.config, this.tiers);
		const stats = await recomputeTiers(this.store, this.tiers, this.config);
		const exportStats = await autoExportMemory(this.store, this.config, this.dataDir);
		return {
			...stats,
			merged: mergeStats.merged,
			mergeChecked: mergeStats.checked,
			expired: expireStats.expired,
			expireChecked: expireStats.checked,
			purgedSuperseded: purgeStats.superseded,
			purgedCold: purgeStats.cold,
			exported: exportStats.exported,
			exportPath: exportStats.path ?? null
		};
	}

	/** 翻冷层。 */
	async searchCold(keyword) {
		return this.tiers.searchArchive(keyword);
	}

	/**
	 * 按关键词或 id 软删卡片（标 superseded + 进 cold 归档，不物理删除）。
	 * @param {string} keyword - 内容子串或卡片 id
	 * @returns {Promise<Array>} 被删除的卡片
	 */
	async forget(keyword) {
		const needle = String(keyword ?? '').trim();
		if (!needle) return [];
		const removed = [];
		for (const card of [...this.store.cards.values()]) {
			if (card.status !== Status.ACTIVE && card.status !== Status.PINNED) continue;
			if (card.id !== needle && !card.content.includes(needle)) continue;
			card.status = Status.SUPERSEDED;
			card.tier = Tier.COLD;
			card.updatedAt = Date.now();
			await this.tiers.archive(card, 'forgotten');
			removed.push(card);
		}
		if (removed.length > 0) await this.store.save();
		return removed;
	}

	/**
	 * 全量活跃卡片（/memory list 用）：hot 在前 warm 在后，同层按 importance 降序。
	 * 冷层（已归档/软删）不在此列——翻旧账走 searchCold。
	 */
	listCards() {
		const tierOrder = { [Tier.HOT]: 0, [Tier.WARM]: 1 };
		return [...this.store.cards.values()]
			.filter((card) => card.status === Status.ACTIVE || card.status === Status.PINNED)
			.sort((a, b) => {
				const ta = tierOrder[a.tier] ?? 2;
				const tb = tierOrder[b.tier] ?? 2;
				return ta !== tb ? ta - tb : b.importance - a.importance;
			})
			.map((card) => ({
				id: card.id,
				content: card.content,
				category: card.category,
				importance: card.importance,
				tier: card.tier,
				ws: card.ws ?? GENERAL_WORKSPACE
			}));
	}

	/** 状态统计。 */
	status() {
		const cards = [...this.store.cards.values()];
		const byTier = {};
		for (const card of cards) byTier[card.tier] = (byTier[card.tier] ?? 0) + 1;
		const byWs = {};
		for (const card of cards) {
			const key = card.ws ?? GENERAL_WORKSPACE;
			byWs[key] = (byWs[key] ?? 0) + 1;
		}
		const avg = cards.length
			? cards.reduce((sum, c) => sum + c.importance, 0) / cards.length
			: 0;
		return { total: cards.length, byTier, byWs, avgImportance: Number(avg.toFixed(3)) };
	}

	async dispose() {
		await this.store.save();
	}
}

/** trivia 卡的召回优待窗口 = 其生命周期（与 gc.js 的过期判断对齐：7 天）。 */
const TRIVIA_LIFETIME_MS = 7 * 86400000;

/**
 * v0.4.8 trivia 召回优待的两个旋钮（有意不进 Config——行为修正，不是用户偏好）：
 *  - EFFECTIVE_IMPORTANCE：综合分里 trivia 的有效重要度下限。0.3 原值在 0.3 权重下
 *    先天比高重要度卡少约 0.2 综合分，实测转述问句（"我刚刚说想吃什么"）相似度
 *    0.57~0.59 时排全库第 11/13，top3 永远无缘；
 *  - SEAT_MIN_RELEVANCE：席位门槛。比 recallMinRelevance（0.35）高一档，避免
 *    随口一句不相关的话也把正经记忆挤出注入位。
 */
const TRIVIA_EFFECTIVE_IMPORTANCE = 0.5;
const TRIVIA_SEAT_MIN_RELEVANCE = 0.45;

/** 生命周期内的 trivia 卡（即时欲望/临时状态）。 */
function isFreshTrivia(card, now) {
	return card.category === Category.TRIVIA && now - (card.createdAt ?? 0) <= TRIVIA_LIFETIME_MS;
}

function cardFresh(card, config, now) {
	const halfLife =
		card.category === 'commitment' ? config.commitmentHalfLifeDays : config.halfLifeDays;
	const idleDays = Math.max(0, (now - card.lastAccessed) / 86400000);
	return Math.exp((-Math.LN2 * idleDays) / halfLife);
}
