/**
 * 后台维护 —— 衰减无需计算（freshness 是纯函数），只做分层重算。
 *
 * 调度规则（三家都没有的确定性升降级）：
 *  1. 全局降级：score < demote 线 → 降 cold 写归档（hot 成员也不例外；pinned 豁免）
 *  2. 热层重装：剩余 hot 成员按分装入字符预算，装不下的回 warm
 *  3. 升级：非 hot 中 score ≥ promote 线且 hot 有空位 → 升 hot
 *
 * @module dsh-memory/lib/maintenance
 */

import { cosine, scheduleScore, Status, Tier } from './models.js';
import { extractJson } from './llm.js';
import { GENERAL_WORKSPACE } from './workspace.js';

/**
 * @param {import('./store.js').MemoryStore} store
 * @param {import('./tiers.js').TierManager} tiers
 * @param {object} config
 * @returns {Promise<{promoted: number, demoted: number, evicted: number}>}
 */
export async function recomputeTiers(store, tiers, config) {
	const stats = { promoted: 0, demoted: 0, evicted: 0 };
	const cards = store.all([Status.ACTIVE, Status.PINNED]);
	if (cards.length === 0) return stats;

	const now = Date.now();
	const scored = cards
		.map((card) => ({ card, score: scheduleScore(card, config, now) }))
		.sort((a, b) => b.score - a.score);

	// ---- 1) 全局降级：分数跌破线就出局，热层不搞终身制 ----
	for (const { card, score } of scored) {
		if (card.status === Status.PINNED) continue; // 用户显式记住的，永不进冷层
		if (score < config.demoteScore && card.tier !== Tier.COLD) {
			card.tier = Tier.COLD;
			store.put(card);
			await tiers.archive(card, 'demoted');
			stats.demoted += 1;
		}
	}

	// ---- 2)+3) 热层重装与升级（v0.6.0 起按工作区分组装配）----
	// 每个工作区（含 '*' 通用域）各享一份 hotBudgetChars/hotMaxCards：
	// 否则一个活跃项目的进展卡会吃光全局热预算，别的目录开聊只剩空块。
	// IM 卡（scope=im）不参与 hot——热块只渲染 global scope（v0.3 起不变）。
	const byWs = new Map();
	for (const entry of scored) {
		if ((entry.card.scope ?? 'global') !== 'global') continue;
		const key = entry.card.ws ?? GENERAL_WORKSPACE;
		let group = byWs.get(key);
		if (!group) {
			group = [];
			byWs.set(key, group);
		}
		group.push(entry);
	}
	for (const group of byWs.values()) {
		const hotMembers = [];
		// 2) 重装：按分装预算，装不下的回 warm
		for (const { card } of group) {
			if (card.tier !== Tier.HOT) continue;
			if (tiers.fitsHot(hotMembers, card)) {
				hotMembers.push(card);
			} else {
				card.tier = Tier.WARM;
				store.put(card);
				stats.evicted += 1;
			}
		}
		// 3) 升级：够分且热层有空位
		for (const { card, score } of group) {
			if (
				card.tier !== Tier.HOT &&
				score >= config.promoteScore &&
				tiers.fitsHot(hotMembers, card)
			) {
				card.tier = Tier.HOT;
				store.put(card);
				hotMembers.push(card);
				stats.promoted += 1;
			}
		}
	}

	if (stats.promoted || stats.demoted || stats.evicted) {
		// 维护周期结束，重置本轮命中计数（下一轮重新累计）
		for (const { card } of scored) {
			if (card.hitCount && (card.status === Status.ACTIVE || card.status === Status.PINNED)) {
				card.hitCount = 0;
				store.put(card);
			}
		}
	}

	await store.save();
	return stats;
}

/** 合并提示词（v0.3.2 自动合并用）：两张高度相似的卡合成一条信息最全的陈述。 */
export const MERGE_PROMPT = `你是记忆库管理员。下面两张卡片内容高度相似，请合并成一条信息最完整的陈述。
规则：保留两张卡的全部有效信息；数值/日期取更新的；去掉重复表述；一句话、独立、完整、无代词。
卡片A：{a}
卡片B：{b}
只输出 JSON：{"content": "合并后的陈述"}`;

/**
 * 维护期自动合并（v0.3.2）：扫**存量**近似卡——写入时的防线只管新增，
 * 历史遗留的近亲对（富化变体、漏网重复）靠这趟打扫。
 *
 * 规则：同 scope 的活跃卡两两余弦 ≥ dupThreshold → LLM 合并 → 重嵌入 →
 * 落败卡软删进归档。每轮最多 maxPairs 对（4B 速度约束）；
 * 无 chat/无对/超 500 张（平方复杂度护栏）时零成本跳过。
 *
 * @returns {Promise<{checked: number, merged: number}>}
 */
export async function autoMergeSimilar(store, chat, embed, config, tiers, maxPairs = 5) {
	const stats = { checked: 0, merged: 0 };
	if (config.autoMerge === false) return stats;
	if (typeof chat !== 'function' || typeof embed !== 'function') return stats;
	const cards = store.all();
	if (cards.length < 2 || cards.length > 500) return stats;

	const threshold = Number(config.dupThreshold ?? 0.92);
	// v0.3.4 碎片吸收：短卡（<12 字）与近邻 ≥0.80 也算候选——"用户有感冒"这类
	// 碎片被长卡覆盖时阈值 0.92 抓不到（实测这种对只有 0.5~0.7），给它们开小灶
	const FRAGMENT_MIN_CHARS = 12;
	const FRAGMENT_THRESHOLD = 0.8;
	const pairs = [];
	for (let i = 0; i < cards.length; i += 1) {
		for (let j = i + 1; j < cards.length; j += 1) {
			const a = cards[i];
			const b = cards[j];
			if ((a.scope ?? 'global') !== (b.scope ?? 'global')) continue; // 跨 scope 不并：scope 语义优先
			if ((a.ws ?? GENERAL_WORKSPACE) !== (b.ws ?? GENERAL_WORKSPACE)) continue; // v0.6.0 跨工作区不并：同名事实各存副本是隔离设计，不是重复
			if (!a.embedding || !b.embedding) continue;
			const sim = cosine(a.embedding, b.embedding);
			const shorter = Math.min(a.content.length, b.content.length);
			const hit = sim >= threshold || (shorter < FRAGMENT_MIN_CHARS && sim >= FRAGMENT_THRESHOLD);
			if (hit) pairs.push({ a, b, sim });
		}
	}
	stats.checked = pairs.length;
	if (pairs.length === 0) return stats;
	pairs.sort((x, y) => y.sim - x.sim);

	const touched = new Set();
	for (const { a, b } of pairs) {
		if (stats.merged >= maxPairs) break;
		if (touched.has(a.id) || touched.has(b.id)) continue; // 一轮一卡只参与一次，防链式合并
		try {
			const raw = await chat(
				[{ role: 'user', content: MERGE_PROMPT.replace('{a}', a.content).replace('{b}', b.content) }],
				{ jsonMode: true }
			);
			const content = String(extractJson(raw)?.content ?? '').trim();
			if (!content) continue;
			// 幸存者：重要度高者（平局取更早创建的）；落败者软删进归档
			const keepFirst = a.importance > b.importance
				|| (a.importance === b.importance && a.createdAt <= b.createdAt);
			const [keep, drop] = keepFirst ? [a, b] : [b, a];
			keep.content = content;
			keep.importance = Math.max(a.importance, b.importance);
			keep.embedding = (await embed([content]))[0]; // 用合并文本重嵌入，保证新内容可检索
			keep.lastAccessed = Date.now();
			store.put(keep);
			drop.status = Status.SUPERSEDED;
			drop.tier = Tier.COLD;
			store.put(drop);
			await tiers.archive(drop, 'superseded');
			stats.merged += 1;
			touched.add(a.id);
			touched.add(b.id);
		} catch {
			/* 单对失败不阻塞整轮 */
		}
	}
	if (stats.merged > 0) await store.save();
	return stats;
}
