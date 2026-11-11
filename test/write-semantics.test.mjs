/**
 * 写入语义守卫测试 —— 钉 docs/注入面契约.md 的 I5 / I6（外加 A3 的安全截断）。
 *
 * 跑法：node test/write-semantics.test.mjs
 *
 * 这组守的是「以为记住了，其实没记住」这类静默故障：
 *   · 落盘成功要有判据，失败必须可判别（不能 rename 完就当成功）；
 *   · 嵌入不齐备时宁可整批失败，也不写「没有向量的半残卡」；
 *   · 同一批对话重跑不得新增重复卡（重试幂等）。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MemoryEngine } from '../lib/engine.js';
import { Category, createCard, Status } from '../lib/models.js';
import { truncateSafe } from '../lib/prompt-safety.js';
import { drainRetryQueue, enqueueRetry } from '../lib/retry.js';
import { MemoryStore } from '../lib/store.js';

const DIM = 128;

/** 与 smoke 同口径的假向量：共享字面字的文本有余弦相似。 */
function bigramEmbed(texts) {
	return texts.map((text) => {
		const vec = new Array(DIM).fill(0);
		for (const ch of String(text)) {
			let h = 0;
			for (const c of ch) h = (h * 31 + c.codePointAt(0)) >>> 0;
			vec[h % DIM] += 1;
		}
		const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
		return vec.map((v) => v / norm);
	});
}

function makeFakeChat(script) {
	let n = 0;
	return async () => script[Math.min(n++, script.length - 1)];
}

function makeConfig(overrides = {}) {
	return {
		backend: 'local',
		hotBudgetChars: 2000,
		hotMaxCards: 15,
		halfLifeDays: 7,
		commitmentHalfLifeDays: 90,
		promoteScore: 0.55,
		demoteScore: 0.12,
		reinforceDelta: 0.05,
		maxImportance: 1,
		pinnedImportance: 0.8,
		wRelevance: 0.5,
		wImportance: 0.3,
		wFreshness: 0.2,
		...overrides
	};
}

const EXTRACT = JSON.stringify({
	facts: [{ content: 'Poka 每周三下午有数学考试', category: 'fact', importance: 0.6 }]
});
const DECIDE_ADD = JSON.stringify({
	decisions: [{ action: 'ADD', fact_index: 0, card_id: null, content: null }]
});
const DIALOG = [{ role: 'user', content: '记一下，我每周三下午有数学考试' }];

async function makeEngine(embed = bigramEmbed) {
	const dataDir = await mkdtemp(join(tmpdir(), 'dshwrite-'));
	const engine = new MemoryEngine(makeConfig(), {
		dataDir,
		chat: makeFakeChat([EXTRACT, DECIDE_ADD]),
		embed
	});
	await engine.init();
	return { engine, dataDir };
}

// ---------------------------------------------------------------- I5：落盘判据

test('I5 落盘后磁盘内容与内存一致（真读回解析，不只看 rename 返回）', async () => {
	const { engine, dataDir } = await makeEngine();
	await engine.remember(DIALOG);
	const onDisk = JSON.parse(await readFile(join(dataDir, 'cards.json'), 'utf8'));
	assert.equal(onDisk.cards.length, engine.store.cards.size);
	assert.ok(onDisk.cards.length >= 1, '写入后磁盘上应至少有 1 张卡');
	assert.ok(onDisk.cards.every((c) => Array.isArray(c.embedding) && c.embedding.length === DIM));
});

test('I5 写入失败必须可判别：save() 要 reject，不能静默当成功', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dshwrite-bad-'));
	// 把目标路径设成一个**已存在的目录** → rename 必然失败
	const target = join(dir, 'cards.json');
	await mkdir(target);
	const store = new MemoryStore(target);
	store.put(createCard({ content: '一张必然写不进去的卡', category: Category.FACT, importance: 0.5 }));
	await assert.rejects(() => store.save(), '写入失败却 resolve 了 —— 调用方无从判别');
});

test('I5 写入失败不吞掉内存态：卡还在，下次 save 可恢复', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dshwrite-keep-'));
	const target = join(dir, 'cards.json');
	await mkdir(target);
	const store = new MemoryStore(target);
	const card = createCard({ content: '失败后仍应留在内存里的卡', category: Category.FACT, importance: 0.5 });
	store.put(card);
	await assert.rejects(() => store.save());
	assert.equal(store.get(card.id)?.content, card.content, '失败路径把内存态也清了 → 记忆真丢');
});

// ---------------------------------------------------------------- I5/I6：嵌入齐备性

test('I6 嵌入条数不足 → 整批不写（不产出没有向量的半残卡）', async () => {
	const shortEmbed = async (texts) => bigramEmbed(texts).slice(0, Math.max(0, texts.length - 1));
	const { engine } = await makeEngine(shortEmbed);
	await assert.rejects(() => engine.remember(DIALOG), /嵌入返回/);
	assert.equal(engine.store.cards.size, 0, '半残卡被写进真源了');
});

test('I6 向量为空数组 → 整批不写', async () => {
	const emptyEmbed = async (texts) => texts.map(() => []);
	const { engine } = await makeEngine(emptyEmbed);
	await assert.rejects(() => engine.remember(DIALOG), /向量为空/);
	assert.equal(engine.store.cards.size, 0);
});

test('I6 嵌入齐备时正常写入（校验没有误伤正常路径）', async () => {
	const { engine } = await makeEngine();
	const report = await engine.remember(DIALOG);
	assert.equal(report.added.length, 1);
	assert.equal(engine.store.cards.size, 1);
});

// ---------------------------------------------------------------- I6：重试幂等

test('I6 同一批对话跑两遍，卡片总数不变', async () => {
	const { engine } = await makeEngine();
	await engine.remember(DIALOG);
	const after1 = engine.store.cards.size;
	// 第二遍用全新的假 chat（同样的提取/决策响应），模拟重试重放
	engine.chat = makeFakeChat([EXTRACT, DECIDE_ADD]);
	await engine.remember(DIALOG);
	assert.equal(engine.store.cards.size, after1, '重试把同一条事实又写了一张');
});

test('I6 重试入队幂等：同会话同末条用户消息只入队一次', () => {
	const first = enqueueRetry([], { sessionId: 's1', dialog: DIALOG, options: {} });
	assert.equal(first.added, true);
	assert.equal(first.entries.length, 1);
	const second = enqueueRetry(first.entries, { sessionId: 's1', dialog: DIALOG, options: {} });
	assert.equal(second.added, false, '同批重复入队 → 重放时会重复写入');
	assert.equal(second.entries.length, 1);
});

test('I6 重放失败计数，满次数后放弃（不无限重试）', async () => {
	let entries = enqueueRetry([], { sessionId: 's2', dialog: DIALOG, options: {} }).entries;
	const boom = async () => {
		throw new Error('模拟传输失败');
	};
	for (let i = 0; i < 5; i += 1) {
		const res = await drainRetryQueue(entries, boom, { max: 1 });
		entries = res.entries;
		assert.equal(res.fail, 1);
	}
	assert.equal(entries.length, 0, '满 5 次仍留在队列里 → 无限重试');
});

// ---------------------------------------------------------------- A3：安全截断

test('A3 截断不劈开代理对（emoji 在预算边界上）', () => {
	// '😀' 占 2 个码元；预算 3 → 只能容纳 1 个完整 emoji + 1 个汉字
	const text = '考试😀加油';
	const out = truncateSafe(text, 3);
	assert.equal(out, '考试', `劈开了代理对：${JSON.stringify(out)}`);
	for (let i = 0; i < out.length; i += 1) {
		const code = out.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = out.charCodeAt(i + 1);
			assert.ok(next >= 0xdc00 && next <= 0xdfff, '输出含孤立高位代理');
		}
	}
});

test('A3 预算足够时原样返回，且顺手清掉已有孤立代理', () => {
	assert.equal(truncateSafe('普通文本', 40), '普通文本');
	assert.equal(truncateSafe('前\uD83D后', 40), '前后');
});

test('A3 截断是幂等的', () => {
	const once = truncateSafe('考试😀加油😀再来', 5);
	assert.equal(truncateSafe(once, 5), once);
});