/**
 * IM 会话识别与消息过滤 —— 纯函数模块，index.js 与测试共用。
 *
 * 判据演进史：v0.2.1 用 cwd 单判据（不含 profiles = IM）→ v0.2.4 证伪
 * （桌面 GUI/TUI 的 cwd 常是 workspace，整段桌面对话被按群聊攒批了一天）
 * → 改为 cwd + [名字 (ID)] 前缀双闸。函数无副作用，行为全部有测试锁定。
 *
 * @module dsh-memory/lib/im
 */

/** IM 身份前缀：QQ/微信桥给 user 消息固定添加 [名字 (ID)]，桌面用户不会手打。 */
export const IM_SENDER_RE = /^\[[^\]\n]+ \([0-9A-Fa-f]{8,64}\)\]/;

/** cwd 在 profiles 目录下 → 一定是桌面会话。 */
const PROFILES_CWD_RE = /profiles[/\\]/i;

/**
 * IM 判据双闸：cwd 不含 profiles 只是必要条件，必须再用 IM 桥特有的
 * [名字 (ID)] 用户消息前缀做二次确认——对话里出现一条带前缀的 user 消息即判定 IM。
 *
 * @param {string} cwd - 会话工作目录（session.header.cwd）
 * @param {Array<{role: string, content: string}>} dialog - 已派生的对话（user/assistant）
 * @returns {'im' | 'desktop'}
 */
export function classifySession(cwd, dialog) {
	const dir = String(cwd ?? '');
	if (!dir.length || PROFILES_CWD_RE.test(dir)) return 'desktop';
	const list = Array.isArray(dialog) ? dialog : [];
	return list.some((entry) => entry.role === 'user' && IM_SENDER_RE.test(entry.content))
		? 'im'
		: 'desktop';
}

/**
 * IM 消息前置闸：剥掉 [名字 (ID)] 前缀后，短消息（<6 字符）、纯数字/符号直接不进批。
 * 群聊里大量"apt"、"123123"、刷屏靠这里挡掉，省下游 LLM 调用。
 */
export function isUsefulLine(text) {
	const t = String(text ?? '').trim().replace(/^\[[^\]]*\]\s*/, '');
	if (t.length < 6) return false;
	if (/^[\d\s\p{P}]+$/u.test(t)) return false;
	return true;
}

/**
 * 从对话里收集 IM 发言者 ID（去重、大写、排序）——per-group scope 的候选键。
 * v0.3.2 观察期：session id 跨重启会变，先靠这个集合的稳定性判断"同群不同会话"
 * 能否对上号；观察日志见 index.js 的 im-group 行。纯函数，测试锁定。
 */
export function senderIdsOf(dialog) {
	const ids = new Set();
	for (const entry of Array.isArray(dialog) ? dialog : []) {
		if (entry?.role !== 'user') continue;
		const m = /^\[[^\]\n]+ \(([0-9A-Fa-f]{8,64})\)\]/.exec(String(entry.content ?? ''));
		if (m) ids.add(m[1].toUpperCase());
	}
	return [...ids].sort();
}
