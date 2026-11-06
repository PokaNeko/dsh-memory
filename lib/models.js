/**
 * 数据模型 —— 一张记忆卡片的完整生命周期状态。
 * 移植自 Python 版 memory_mvp/models.py，行为保持一致。
 *
 * @module dsh-memory/lib/models
 */

import { GENERAL_WORKSPACE } from './workspace.js';

/** 记忆分类：决定衰减速度和调度特权。 */
export const Category = Object.freeze({
	FACT: 'fact',              // 事实 / 事件
	PREFERENCE: 'preference',  // 偏好
	COMMITMENT: 'commitment',  // 约定 / 承诺 → 慢衰减
	CONCEPT: 'concept',        // 长期认知
	TRIVIA: 'trivia'           // 琐事
});

/** 存储层级：hot=常驻上下文 / warm=向量检索 / cold=归档文件。 */
export const Tier = Object.freeze({ HOT: 'hot', WARM: 'warm', COLD: 'cold' });

/** 卡片状态。 */
export const Status = Object.freeze({
	ACTIVE: 'active',
	SUPERSEDED: 'superseded',  // 被新事实取代（软删，不物理删）
	PINNED: 'pinned'           // 用户显式"记住"，有重要性下限
});

const CATEGORIES = new Set(Object.values(Category));
const TIERS = new Set(Object.values(Tier));
const STATUSES = new Set(Object.values(Status));

let uidCounter = 0;

/** 生成短 id：时间戳 + 进程内序号，避免依赖 crypto 的随机数。 */
export function newId() {
	uidCounter = (uidCounter + 1) % 0x10000;
	return `${Date.now().toString(36)}${uidCounter.toString(36).padStart(4, '0')}`;
}

/** 建一张卡片（默认值齐全，调用方只传业务字段）。 */
export function createCard(fields = {}) {
	const now = Date.now();
	return {
		id: fields.id ?? newId(),
		content: String(fields.content ?? ''),
		category: CATEGORIES.has(fields.category) ? fields.category : Category.FACT,
		scope: fields.scope ?? 'global',
		// v0.6.0 工作区分离：'*'=跨工作区通用；具体目录名=只在对应 cwd 的会话可见。
		// 旧卡缺此字段时按 '*' 处理（workspaceVisible 的兜底语义一致）。
		ws: typeof fields.ws === 'string' && fields.ws ? fields.ws : GENERAL_WORKSPACE,
		importance: clamp01(fields.importance ?? 0.5),
		tier: TIERS.has(fields.tier) ? fields.tier : Tier.WARM,
		status: STATUSES.has(fields.status) ? fields.status : Status.ACTIVE,
		embedding: Array.isArray(fields.embedding) ? fields.embedding : null,
		accessCount: fields.accessCount ?? 0,
		hitCount: fields.hitCount ?? 0,
		createdAt: fields.createdAt ?? now,
		updatedAt: fields.updatedAt ?? now,
		lastAccessed: fields.lastAccessed ?? now,
		// v0.4.9 时间线（Zep 边失效的轻量版）：事实"何时为真"，与 createdAt（何时写入）分离。
		// 旧卡回填 validFrom=createdAt；UPDATE 换内容时旧值落 cold 归档、validFrom 刷新。
		validFrom: fields.validFrom ?? fields.createdAt ?? now,
		validTo: fields.validTo ?? null
	};
}

/** 新鲜度：纯函数，无状态。闲置半衰期后为 0.5，指数衰减。 */
export function freshness(card, halfLifeDays, now = Date.now()) {
	const idleDays = Math.max(0, (now - card.lastAccessed) / 86400000);
	return Math.exp((-Math.LN2 * idleDays) / Math.max(1e-6, halfLifeDays));
}

/** 卡片实际半衰期（承诺类极慢衰减）。 */
export function effectiveHalfLife(card, config) {
	return card.category === Category.COMMITMENT
		? config.commitmentHalfLifeDays
		: config.halfLifeDays;
}

/** 调度分：决定升降级。score = importance × freshness × 命中系数。 */
export function scheduleScore(card, config, now = Date.now()) {
	const fresh = freshness(card, effectiveHalfLife(card, config), now);
	const hitFactor = 1 + (0.5 * Math.min(card.hitCount, 10)) / 10;
	return card.importance * fresh * hitFactor;
}

/** 被召回命中：importance 上涨 + 计数刷新（强化回路）。 */
export function reinforce(card, config, now = Date.now()) {
	card.importance = Math.min(config.maxImportance, card.importance + config.reinforceDelta);
	card.accessCount += 1;
	card.hitCount += 1;
	card.lastAccessed = now;
	card.updatedAt = now;
}

/** 余弦相似度，零向量安全。 */
export function cosine(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i += 1) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : Math.max(-1, Math.min(1, dot / denom));
}

export function clamp01(x) {
	const n = Number(x);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

/** 把任意分类名归一化（LLM 可能吐未知值）。 */
export function safeCategory(name) {
	return CATEGORIES.has(name) ? name : Category.FACT;
}
