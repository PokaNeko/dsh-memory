/**
 * 记忆导出（v0.4）—— 把 cards.json 以人读 Markdown 或 JSON 快照落到配置目录。
 *
 * 动机：记忆库平时锁在插件 data 目录里，翻阅/搬运都不方便。导出件是**只读快照**，
 * 不参与任何管线（改了导出件不会影响记忆库）；恢复/迁移以 backup/ 和 cards.json 为准。
 *
 * 自动：维护期顺带（24h 节流，扫目录里最新导出件的 mtime）；手动：/memory export。
 *
 * @module dsh-memory/lib/exporter
 */

import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 生成导出文件名：memory-export-YYYYMMDD-HHmm.<ext>。 */
function exportName(now, ext) {
	const t = new Date(now);
	const pad = (n) => String(n).padStart(2, '0');
	return `memory-export-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}.${ext}`;
}

/**
 * 导出一趟：md（人读，scope/tier 分节）或 json（cards.json 同构快照）。
 * @param {import('./store.js').MemoryStore} store
 * @returns {Promise<{path: string, count: number}>}
 */
export async function exportStore(store, dir, format = 'md', now = Date.now()) {
	const cards = [...store.cards.values()].filter((c) => c.status === 'active' || c.status === 'pinned');
	await mkdir(dir, { recursive: true });
	const ext = format === 'json' ? 'json' : 'md';
	const path = join(dir, exportName(now, ext));
	const tmp = `${path}.tmp`;

	if (ext === 'json') {
		const payload = JSON.stringify(
			{ version: 1, exportedAt: now, cards: store.all(['active', 'pinned']) },
			null,
			2
		);
		await writeFile(tmp, payload, 'utf8');
	} else {
		await writeFile(tmp, renderMarkdown(cards, now), 'utf8');
	}
	await rename(tmp, path);
	return { path, count: cards.length };
}

/** 人读 Markdown：scope → tier 两级分节，卡片按重要度降序。 */
function renderMarkdown(cards, now) {
	const byScope = new Map();
	for (const card of cards) {
		const scope = card.scope ?? 'global';
		if (!byScope.has(scope)) byScope.set(scope, new Map());
		const tiers = byScope.get(scope);
		const tier = card.tier ?? 'warm';
		if (!tiers.has(tier)) tiers.set(tier, []);
		tiers.get(tier).push(card);
	}
	const tierOrder = ['hot', 'warm', 'cold'];
	const tierName = { hot: '热层（常驻上下文）', warm: '温层（向量检索）', cold: '冷层（归档）' };
	const scopeName = { global: '桌面/全局记忆', im: '群聊/IM 记忆' };
	const lines = [
		'# 长期记忆导出',
		'',
		`> 生成时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })} ｜ 活跃卡片 ${cards.length} 张`,
		'> 本文件是只读快照，修改不影响记忆库本体。',
		''
	];
	for (const [scope, tiers] of [...byScope.entries()].sort()) {
		lines.push(`## ${scopeName[scope] ?? scope}（scope: ${scope}）`, '');
		for (const tier of tierOrder) {
			const group = tiers.get(tier);
			if (!group || group.length === 0) continue;
			group.sort((a, b) => b.importance - a.importance);
			lines.push(`### ${tierName[tier] ?? tier} · ${group.length} 张`, '');
			for (const card of group) {
				lines.push(`- [${card.category}｜重要 ${Number(card.importance).toFixed(2)}] ${card.content}`);
			}
			lines.push('');
		}
	}
	return lines.join('\n');
}

/**
 * 自动导出（维护期调用）：目录没配 → 不动；24h 内已导过 → 节流跳过。
 * @returns {Promise<{exported: boolean, path?: string, count?: number}>}
 */
export async function autoExportMemory(store, config, dataDir, now = Date.now()) {
	const dir = String(config.exportDir ?? '').trim();
	if (!dir) return { exported: false };
	const format = config.exportFormat === 'json' ? 'json' : 'md';
	try {
		const entries = await readdir(dir).catch(() => []);
		const stamps = (
			await Promise.all(
				entries
					.filter((n) => n.startsWith('memory-export-') && /-(md|json)\.tmp$/.test(n) === false && /\.(md|json)$/.test(n))
					.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs }))
			)
		).sort((a, b) => b.mtime - a.mtime);
		if (stamps.length > 0 && now - stamps[0].mtime < 24 * 3600 * 1000) {
			return { exported: false };
		}
		const result = await exportStore(store, dir, format, now);
		return { exported: true, path: result.path, count: result.count };
	} catch {
		return { exported: false }; // 导出失败不打扰主流程
	}
}
