/**
 * 存储层 —— JSON 文件 + 内存索引 + 暴力余弦检索。
 *
 * 个人记忆库规模（几千条以内）全量加载毫秒级，不值得引入 SQLite/向量库依赖。
 * 原子写：先写 .tmp 再 rename，避免进程崩溃留下半截文件。
 *
 * @module dsh-memory/lib/store
 */

import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cosine, createCard, Status, Tier } from './models.js';
import { GENERAL_WORKSPACE, workspaceVisible } from './workspace.js';

const FORMAT_VERSION = 1;

export class MemoryStore {
	/**
	 * @param {string} filePath - cards.json 的绝对路径。
	 */
	constructor(filePath) {
		this.filePath = filePath;
		/** @type {Map<string, object>} id → card */
		this.cards = new Map();
		// C1（qwen-code 借鉴）：脏度计数——自上次 LLM 整理以来的写入/更新/软删次数。
		// 维护定时器据此决定要不要跑 LLM 步，库没变化就不烧 token。
		this.dirtyMutations = 0;
	}

	/** 从磁盘加载（文件不存在视为空库）。 */
	async load() {
		try {
			const raw = await readFile(this.filePath, 'utf8');
			const data = JSON.parse(raw);
			if (!Array.isArray(data?.cards)) return;
			this.cards = new Map(data.cards.map((c) => [c.id, createCard(c)]));
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
		}
		this.dirtyMutations = 0;
	}

	/**
	 * 原子写回磁盘 + **落盘校验**（C1 / 契约 I5）。
	 *
	 * 为什么 tmp→rename 还不够：rename 成功只说明目录项换了，不说明内容真的可读回
	 * （磁盘满、杀软锁文件、权限变更都可能让文件变成 0 字节或半截）。此前 save() 返回
	 * 即视为成功，调用方无从判别——「以为记住了」比「记住失败」更糟。
	 *
	 * 校验做什么（刻意选便宜的两项）：
	 *   ① 字节数与写入 payload 完全相等；
	 *   ② 真读回文件尾部 64 字节，确认以 JSON 收尾字符结束（文件可读、未截断）。
	 *
	 * 为什么不做全量读回 + JSON.parse：当前 cards.json 7.34 MB，其中 99.6% 是向量；
	 * 全量 parse 会在内存里再造一份几十 MB 的对象图，而这台机器内存长期 95% 占用。
	 * 每次写入都这么做等于拿稳定性换校验强度。**B1（向量移出真源）落地后文件降到
	 * 百 KB 级，届时升级为全量读回解析**——这条取舍记在契约 I5，不是遗漏。
	 *
	 * 失败即 throw：调用方（rememberDialog）已有 catch → 重试队列 + 日志，不会静默。
	 */
	async save() {
		await mkdir(dirname(this.filePath), { recursive: true });
		const payload = JSON.stringify(
			{ version: FORMAT_VERSION, savedAt: Date.now(), cards: [...this.cards.values()] },
			null,
			2
		);
		const tmp = `${this.filePath}.tmp`;
		await writeFile(tmp, payload, 'utf8');
		await rename(tmp, this.filePath);

		const expected = Buffer.byteLength(payload, 'utf8');
		const handle = await open(this.filePath, 'r');
		try {
			const st = await handle.stat();
			if (st.size !== expected) {
				throw new Error(`落盘校验失败：磁盘 ${st.size} B ≠ 写入 ${expected} B（${this.filePath}）`);
			}
			const tailLen = Math.min(64, st.size);
			const tail = Buffer.alloc(tailLen);
			await handle.read(tail, 0, tailLen, st.size - tailLen);
			if (!tail.toString('utf8').trimEnd().endsWith('}')) {
				throw new Error(`落盘校验失败：文件尾部不是合法 JSON 收尾（${this.filePath}）`);
			}
		} finally {
			await handle.close();
		}
	}

	/**
	 * 自动轮换备份（v0.3.1）：距最近一份自动备份 ≥24h 才做，保留最近 keep 份 auto-*。
	 * 手动备份（cards-*.json 命名）不在此列，永不自动删。失败静默——备份不打扰主流程。
	 * @returns {Promise<boolean>} 本次是否真的做了备份
	 */
	async backupRotating(keep = 5) {
		try {
			const dir = join(dirname(this.filePath), 'backup');
			await mkdir(dir, { recursive: true });
			const entries = await readdir(dir);
			const stats = (
				await Promise.all(
					entries
						.filter((n) => n.startsWith('auto-') && n.endsWith('.json'))
						.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs }))
				)
			).sort((a, b) => b.mtime - a.mtime);
			if (stats.length > 0 && Date.now() - stats[0].mtime < 24 * 3600 * 1000) {
				return false; // 24 小时内备过，节流跳过
			}
			for (const old of stats.slice(Math.max(0, keep - 1))) {
				await rm(join(dir, old.name), { force: true });
			}
			const t = new Date();
			const pad = (n) => String(n).padStart(2, '0');
			const name = `auto-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}.json`;
			await copyFile(this.filePath, join(dir, name)); // 备份磁盘上的当前文件（完整一致的快照）
			return true;
		} catch {
			return false;
		}
	}

	// ---- 基础 CRUD ---------------------------------------------------
	get(id) {
		return this.cards.get(id);
	}

	/**
	 * 写入一张卡。opts.dirty=false 表示纯调度状态写入（tier/命中计数等），
	 * 不推进脏度——C1 门控只认内容语义变更（ADD/UPDATE/软删），否则分层重算
	 * 每轮的 put 会把脏度永远顶在阈值上，门控形同虚设。
	 */
	put(card, { dirty = true } = {}) {
		card.updatedAt = Date.now();
		this.cards.set(card.id, card);
		if (dirty) this.dirtyMutations += 1;
	}

	/** 物理移除（GC 硬删走这里；opts.dirty=false 同 put——出清不触发整理）。 */
	remove(id, { dirty = true } = {}) {
		this.cards.delete(id);
		if (dirty) this.dirtyMutations += 1;
	}

	// ---- 查询 ---------------------------------------------------------
	/** 指定状态的活卡（默认只要 ACTIVE；维护时传 ACTIVE+PINNED）。 */
	all(statuses = [Status.ACTIVE]) {
		const set = new Set(statuses);
		return [...this.cards.values()].filter((c) => set.has(c.status));
	}

	warm() {
		return this.all().filter((c) => c.tier === Tier.WARM);
	}

	hot(ws = null) {
		// v0.3 scope 隔离：热块只放 global 卡——IM 卡不进任何会话的常驻系统提示，
		// 群聊上下文需要时靠召回按需取。
		// v0.6.0 工作区分离：ws=null 不过滤（全局视图）；否则 '*' 通用卡 + 当前工作区卡。
		return this.all()
			.filter(
				(c) =>
					c.tier === Tier.HOT &&
					(c.scope ?? 'global') === 'global' &&
					workspaceVisible(c.ws, ws)
			)
			.sort((a, b) => b.importance - a.importance);
	}

	/**
	 * 工作区分布统计（/memory 面板用）。
	 * @returns {Array<{ws: string, cards: number, hot: number, warm: number}>} 按 cards 降序
	 */
	workspaces() {
		const stats = new Map();
		for (const card of this.all([Status.ACTIVE, Status.PINNED])) {
			const key = card.ws ?? GENERAL_WORKSPACE;
			const entry = stats.get(key) ?? { ws: key, cards: 0, hot: 0, warm: 0 };
			entry.cards += 1;
			if (card.tier === Tier.HOT) entry.hot += 1;
			if (card.tier === Tier.WARM) entry.warm += 1;
			stats.set(key, entry);
		}
		return [...stats.values()].sort((a, b) => b.cards - a.cards);
	}

	cold() {
		return [...this.cards.values()]
			.filter((c) => c.tier === Tier.COLD)
			.sort((a, b) => b.lastAccessed - a.lastAccessed);
	}

	/**
	 * 向量检索：warm 活跃卡全量余弦，返回 [{card, similarity}] 按相似度降序。
	 * @param {number[]} queryVec
	 * @param {number} topK
	 * @param {string[] | null} scopes - null 不过滤；否则只查这些 scope（'global' / 'im'）
	 * @param {string | null} ws - v0.6.0 工作区过滤：null 不过滤；'*' 只看通用卡之外不做限制；
	 *   具体目录名 = 通用卡 + 该工作区卡
	 */
	search(queryVec, topK = 20, scopes = null, ws = null) {
		const scopeSet = Array.isArray(scopes) && scopes.length > 0 ? new Set(scopes) : null;
		const candidates = this.warm().filter(
			(c) => (!scopeSet || scopeSet.has(c.scope ?? 'global')) && workspaceVisible(c.ws, ws)
		);
		if (candidates.length === 0) return [];
		const scored = candidates
			.map((card) => ({ card, similarity: card.embedding ? cosine(queryVec, card.embedding) : 0 }))
			.filter((hit) => hit.similarity > 0)
			.sort((a, b) => b.similarity - a.similarity);
		return scored.slice(0, topK);
	}

	/**
	 * BM25 字面检索（v0.4.9 混合检索的字面路）：中文按字符 bigram 切词（零分词依赖），
	 * DF/avgdl 库内现算——个人库几千张以内毫秒级，不值得建索引。
	 * 站在余弦的盲区上：字面强命中但语义向量对不上的卡（型号、缩写、生僻词）。
	 * @param {string} query - 原始查询文本
	 * @param {number} topK
	 * @param {string[] | null} scopes - 与 search 同语义
	 * @param {string | null} ws - 与 search 同语义
	 * @returns {Array<{card, bm25}>} 按字面分降序
	 */
	bm25Search(query, topK = 12, scopes = null, ws = null) {
		const qGrams = bigramsOf(query);
		if (qGrams.total === 0) return [];
		const scopeSet = Array.isArray(scopes) && scopes.length > 0 ? new Set(scopes) : null;
		const cards = this.warm().filter(
			(c) => (!scopeSet || scopeSet.has(c.scope ?? 'global')) && workspaceVisible(c.ws, ws)
		);
		if (cards.length === 0) return [];
		const docs = [];
		const df = new Map();
		for (const card of cards) {
			const grams = bigramsOf(card.content);
			docs.push({ card, grams, dl: grams.total });
			for (const g of grams.keys()) df.set(g, (df.get(g) ?? 0) + 1);
		}
		const n = docs.length;
		const avgdl = docs.reduce((sum, d) => sum + d.dl, 0) / n || 1;
		const k1 = 1.5;
		const b = 0.75;
		const scored = [];
		for (const doc of docs) {
			let score = 0;
			for (const [g, qf] of qGrams) {
				if (qf === 0) continue;
				const tf = doc.grams.get(g) ?? 0;
				if (tf === 0) continue;
				const freq = df.get(g) ?? 0;
				const idf = Math.log(1 + (n - freq + 0.5) / (freq + 0.5));
				score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.dl) / avgdl)));
			}
			if (score > 0) scored.push({ card: doc.card, bm25: score });
		}
		scored.sort((a, b2) => b2.bm25 - a.bm25);
		return scored.slice(0, topK);
	}
}

/**
 * 文本 → 字符 bigram 频率表（Map gram→count，附 total 属性=总词频）。
 * 统一小写、去空白；英文/数字串拆成 bigram 也能工作（SHPC → SH/HP/PC，查询同切法照命中）。
 * @returns {Map<string, number> & {total: number}}
 */
export function bigramsOf(text) {
	const s = String(text ?? '').toLowerCase().replace(/\s+/g, '');
	const counts = new Map();
	for (let i = 0; i < s.length - 1; i += 1) {
		const gram = s.slice(i, i + 2);
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
	}
	counts.total = [...counts.values()].reduce((sum, c) => sum + c, 0);
	return counts;
}

/** 默认数据目录：插件目录下的 data/。 */
export function defaultDataDir(pluginDir) {
	return join(pluginDir, 'data');
}
