/**
 * 工作区标识 —— 记忆按会话的工作目录分区（v0.6.0）。
 *
 * 问题：一张库混装所有目录的记忆，"插件 v0.3.3 记忆面板待启动"这种项目进展会跟着
 * 用户去 notes 目录做数学题，还会挤占 hot 块 2000 字符的常驻预算。
 *
 * 解法：卡片带 `ws` 标签，取值是 cwd 的末级目录名（小写），例如
 *   D:\dsh\workspace\project-a    → project-a
 *   /home/me/notes                → notes
 * 认不出目录（空/根目录/纯盘符）一律归 '*'（跨工作区通用，任何会话都可见）。
 *
 * 两个正交维度（别混）：
 *   scope —— 来源域：global 桌面 / im 群聊（v0.3 起）
 *   ws    —— 主题域：'*' 通用 / 具体目录名（v0.6.0 起）
 *
 * @module dsh-memory/lib/workspace
 */

/** 通用域：跨工作区可见的记忆（个人偏好、身份、约定、硬件事实等）。 */
export const GENERAL_WORKSPACE = '*';

/**
 * cwd → 规范化路径（统一分隔符、去尾斜杠、小写）。
 * Windows 路径不区分大小写，小写化让同目录大小写变体落到同一个键。
 * @param {string} cwd
 * @returns {string} 空串表示认不出
 */
export function canonicalCwd(cwd) {
	const raw = String(cwd ?? '').trim();
	if (!raw) return '';
	return raw.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * cwd → 工作区键（cwd 末级目录名）。纯函数，不碰注册表。
 * @param {string} cwd
 * @returns {string} 认不出时返回 {@link GENERAL_WORKSPACE}
 */
export function workspaceKeyOf(cwd) {
	const canonical = canonicalCwd(cwd);
	if (!canonical) return GENERAL_WORKSPACE;
	const segments = canonical.split('/').filter(Boolean);
	const last = segments[segments.length - 1] ?? '';
	if (!last || /^[a-z]:$/.test(last)) return GENERAL_WORKSPACE; // 纯盘符（D:\）不是目录名
	return last || GENERAL_WORKSPACE;
}

/**
 * 稳定短哈希（djb2 32 位 → base36 四位）。只用于同名目录去歧义，不是安全用途。
 * @param {string} text
 * @returns {string}
 */
export function shortHash(text) {
	let hash = 5381;
	const s = String(text ?? '');
	for (let i = 0; i < s.length; i += 1) {
		hash = ((hash * 33) ^ s.charCodeAt(i)) >>> 0;
	}
	return hash.toString(36).slice(-4).padStart(4, '0');
}

/**
 * 带同名去歧义的键解析：不同目录末级同名（如两个盘的 notes）时，后来者加 `~<hash>` 后缀。
 * registry 是 key → 规范路径 的 Map，由调用方持久化（data/workspaces.json）。
 *
 * @param {string} cwd
 * @param {Map<string, string> | null} registry
 * @returns {string}
 */
export function resolveWorkspaceKey(cwd, registry = null) {
	const base = workspaceKeyOf(cwd);
	if (base === GENERAL_WORKSPACE || !registry) return base;
	const canonical = canonicalCwd(cwd);
	const known = registry.get(base);
	if (known === undefined) {
		registry.set(base, canonical);
		return base;
	}
	if (known === canonical) return base;
	const suffixed = `${base}~${shortHash(canonical)}`;
	if (!registry.has(suffixed)) registry.set(suffixed, canonical);
	return suffixed;
}

/**
 * 卡片对当前会话工作区是否可见。
 * 规则：通用卡（'*'）处处可见；工作区卡只在自己的会话里可见。
 * 第三参数 defaultGeneral=true 时，缺 ws 字段的老卡按通用处理（兼容未迁移的库）。
 *
 * @param {string | undefined} cardWs
 * @param {string | null | undefined} currentWs - null/undefined 表示不做工作区过滤
 * @returns {boolean}
 */
export function workspaceVisible(cardWs, currentWs) {
	if (!currentWs || currentWs === GENERAL_WORKSPACE) return true;
	const ws = cardWs ?? GENERAL_WORKSPACE;
	return ws === GENERAL_WORKSPACE || ws === currentWs;
}

/**
 * 一张卡属于哪个渲染分区：'general' 还是具体工作区。
 * @param {object} card
 * @returns {string}
 */
export function workspaceOfCard(card) {
	return card?.ws ?? GENERAL_WORKSPACE;
}