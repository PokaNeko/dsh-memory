/**
 * 分层管理 —— hot 块渲染 / cold 归档文件。
 *
 * hot  : 常驻系统提示的限额块（字符预算即冷热边界）
 * warm : 向量检索主战场（store.search）
 * cold : 人可读的 Markdown 归档
 *
 * @module dsh-memory/lib/tiers
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class TierManager {
	/**
	 * @param {object} config - 插件配置（hotBudgetChars / hotMaxCards 等）
	 * @param {string} dataDir - 数据目录
	 */
	constructor(config, dataDir) {
		this.config = config;
		this.archivePath = join(dataDir, 'cold', 'archive.md');
	}

	/**
	 * 降入冷层：追加一行到归档文件。不删除任何数据。
	 * v0.4.9：reason='updated'（UPDATE 前的旧值快照）带 validFrom→validTo 有效区间，
	 * 同一卡 id 的多行归档自然构成演化链。
	 */
	async archive(card, reason) {
		const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
		const tag = reason === 'superseded'
			? '已被取代'
			: reason === 'forgotten'
				? '手动删除'
				: reason === 'expired'
					? '已过期'
					: reason === 'updated'
						? '旧版归档'
						: '淡忘归档';
		const span = reason === 'updated'
			? `·${fmtDay(card.validFrom ?? card.createdAt)}→${fmtDay(card.validTo ?? Date.now())}`
			: '';
		await mkdir(dirname(this.archivePath), { recursive: true });
		await appendFile(
			this.archivePath,
			`- [${stamp}] (${tag}/${card.category}${span}) ${card.content}  \`#${card.id}\`\n`,
			'utf8'
		);
	}

	/** 读冷层全文。 */
	async readArchive() {
		try {
			return await readFile(this.archivePath, 'utf8');
		} catch (error) {
			if (error?.code === 'ENOENT') return '';
			throw error;
		}
	}

	/** 按关键词翻冷层。 */
	async searchArchive(keyword) {
		const text = await this.readArchive();
		if (!text) return '';
		const needle = String(keyword ?? '').trim();
		const lines = text.split('\n').filter((line) => needle && line.includes(needle));
		return lines.join('\n');
	}

	/** 渲染常驻系统提示的记忆块（带用量可视化 + A5 渲染期硬预算）。 */
	renderHotBlock(hotCards) {
		if (!Array.isArray(hotCards) || hotCards.length === 0) return '[长期记忆]（空）';
		const budget = this.config.hotBudgetChars;
		// A5：准入（fitsHot）只管增量——预算调小、卡片 UPDATE 变长时
		// 存量仍可能超。渲染期按入序（重要度降序）装到装不下为止，装不下的不渲染，
		// 并提示模型用 recall 查——抄 ZCode 索引硬上限 + 截断警告的机制。
		const lines = [`[长期记忆]（自动维护，共 ${hotCards.length} 条）`];
		let used = 0;
		let dropped = 0;
		for (let i = 0; i < hotCards.length; i += 1) {
			const card = hotCards[i];
			if (used + card.content.length > budget) {
				dropped = hotCards.length - i;
				break;
			}
			lines.push(`- ${card.content}`);
			used += card.content.length;
		}
		if (dropped > 0) {
			lines.push(`（还有 ${dropped} 条因字符预算未展示，需要时用 /memory recall <关键词> 查询）`);
		}
		lines.push(`[长期记忆结束] ${used}/${budget} 字符`);
		return lines.join('\n');
	}

	/** hot 预算是否装得下这张卡。 */
	fitsHot(hotCards, extra) {
		const used = hotCards.reduce((sum, c) => sum + c.content.length, 0) + extra.content.length;
		return used <= this.config.hotBudgetChars && hotCards.length + 1 <= this.config.hotMaxCards;
	}
}

/** MM-dd 短日期（归档行的有效区间标注用）。 */
function fmtDay(ms) {
	const d = new Date(Number(ms ?? 0));
	const pad = (n) => String(n).padStart(2, '0');
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
