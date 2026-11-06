/**
 * 自动清理 GC（v0.3.4）—— 记忆库瘦身，防 cards.json 无限膨胀。
 *
 * 两段式，延续"确定性优先，LLM 只做判断"：
 *   1) purgeStale（纯代码）：超龄硬删。所有 supersede/降冷路径都会先写
 *      cold/archive.md 人读归档（merge/forget/demote/expire 全走 tiers.archive），
 *      轮换备份里还有全量快照——硬删不丢底。
 *      - superseded 卡：软删是缓冲带，超 gcSupersededDays 天后出清
 *      - cold 层卡：search 只扫 warm，cold 本就召不回，超 gcColdDays 天未访问出清
 *   2) expireStaleFacts（LLM 判断 + 代码执行）：过期任务卡。
 *      "今晚要交健康报告"这种卡，完成后没人来 UPDATE——创建超 7 天且命中
 *      任务词的卡交给 LLM 判一次 expired/keep，过期走软删（同样进归档，
 *      14 天后由 1) 出清）。
 *
 * @module dsh-memory/lib/gc
 */

import { Status, Tier } from './models.js';

/** 过期判断提示词：保守取向——拿不准就 keep。 */
export const EXPIRE_PROMPT = `你是记忆库管理员。判断下面这条记忆是否已经过时（任务已完成/期限已过/情况已变化，继续留着只会误导）。

判断标准：
- 明确的一次性任务/承诺/提醒，创建时间已过去很久，正常情况下早已完成或失效 → 过期
- 计划正在推进或无明确期限的长期状态（偏好、配置、身份、进行中的长期目标）→ 不过期
- 拿不准 → 不过期（宁可留着，另有机制清理）

今天距离这条记忆的创建已经过去 {days} 天。

记忆内容：{content}

只输出 JSON：{"expired": true, "reason": "一句话依据"} 或 {"expired": false, "reason": "..."}`;

/** 任务词（过期判断的前置筛选，控制 LLM 调用量）。v0.4.7 加入即时欲望词。 */
export const TASK_WORD_RE = /待|需要|需将|计划|准备|打算|今晚|明天|后天|本周|下周|暂定|预约|排期|提醒|睡前|汇报|想吃|想喝|想买|想去|想玩|想见/;

/** 创建多少天后的任务词卡才进入过期判断。 */
const EXPIRE_MIN_AGE_DAYS = 7;

/**
 * 确定性出清：超龄 superseded / cold 硬删。
 * @returns {{superseded: number, cold: number}} 各删了几张
 */
export function purgeStale(store, config, now = Date.now()) {
	const stats = { superseded: 0, cold: 0 };
	const supersededDays = Math.max(1, Number(config.gcSupersededDays ?? 14));
	const coldDays = Math.max(1, Number(config.gcColdDays ?? 30));
	const supersededCutoff = now - supersededDays * 86400000;
	const coldCutoff = now - coldDays * 86400000;
	for (const card of [...store.cards.values()]) {
		if (card.status === Status.SUPERSEDED && (card.updatedAt ?? card.createdAt) < supersededCutoff) {
			store.remove(card.id); // 文本已在 cold/archive.md + 备份里
			stats.superseded += 1;
		} else if (
			card.status !== Status.PINNED &&
			card.tier === Tier.COLD &&
			card.status !== Status.SUPERSEDED && // 上面已处理，别双计数
			(card.lastAccessed ?? card.createdAt) < coldCutoff
		) {
			store.remove(card.id);
			stats.cold += 1;
		}
	}
	return stats;
}

/**
 * LLM 过期判断：任务词卡逐条问一次，过期的软删进归档。
 * @param {object} tiers - TierManager（归档用）
 * @returns {Promise<{checked: number, expired: number}>}
 */
export async function expireStaleFacts(store, chat, config, tiers, now = Date.now()) {
	const stats = { checked: 0, expired: 0 };
	if (config.autoExpire === false) return stats;
	if (typeof chat !== 'function') return stats;
	const candidates = store.all([Status.ACTIVE, Status.PINNED]).filter((card) => {
		if (now - (card.createdAt ?? now) < EXPIRE_MIN_AGE_DAYS * 86400000) return false;
		if (card.status === Status.PINNED) return false; // 用户显式记住的不自动过期
		return TASK_WORD_RE.test(card.content);
	});
	stats.checked = candidates.length;
	for (const card of candidates.slice(0, 5)) {
		try {
			const days = Math.floor((now - card.createdAt) / 86400000);
			const raw = await chat(
				[{ role: 'user', content: EXPIRE_PROMPT.replace('{days}', String(days)).replace('{content}', card.content) }],
				{ jsonMode: true }
			);
			// 兼容裸 bool 与对象两种回法
			const parsed = extractLoose(raw);
			if (parsed !== true && parsed?.expired !== true) continue;
			card.status = Status.SUPERSEDED;
			card.tier = Tier.COLD;
			card.updatedAt = now;
			store.put(card);
			await tiers.archive(card, 'expired');
			stats.expired += 1;
		} catch {
			/* 单张失败不阻塞 */
		}
	}
	return stats;
}

/** 从 LLM 回包里抠 expired 布尔（支持 {"expired":true} / true / "true"）。 */
function extractLoose(raw) {
	const text = String(raw ?? '').trim();
	if (text === 'true') return true;
	if (text === 'false') return false;
	const m = text.match(/"expired"\s*:\s*(true|false)/);
	if (m) return m[1] === 'true';
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
