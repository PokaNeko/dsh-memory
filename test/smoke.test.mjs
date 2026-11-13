/**
 * TS 核心 smoke 测试 —— 不需要 ollama，假 embedding + 假 chat 全覆盖。
 *
 * 跑法（runtime 自带 node）：
 *   node --test test/smoke.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyLegacyWsMap, MemoryEngine } from '../lib/engine.js';
import { autoExportMemory, exportStore } from '../lib/exporter.js';
import { expireStaleFacts, purgeStale } from '../lib/gc.js';
import { sameFactNormalized } from '../lib/ingest.js';
import { classifySession, IM_SENDER_RE, isUsefulLine, senderIdsOf } from '../lib/im.js';
import { extractJson, makeDshChatFn, stripThink } from '../lib/llm.js';
import { Category, createCard, Status, Tier } from '../lib/models.js';
import { bigramsOf } from '../lib/store.js';
import { collectModelCatalog, parseRuntimeList, stripV1 } from '../lib/model-catalog.js';
import { drainRetryQueue, enqueueRetry, loadRetryQueue, saveRetryQueue } from '../lib/retry.js';
import {
	GENERAL_WORKSPACE,
	resolveWorkspaceKey,
	shortHash,
	workspaceKeyOf,
	workspaceVisible
} from '../lib/workspace.js';

/** 造一个只在第 idx 维为 1 的单位向量（手工控制余弦用）。 */
function unitVec(idx) {
	const v = new Array(DIM).fill(0);
	v[idx] = 1;
	return v;
}

// ----------------------------------------------------------------------
// fakes
// ----------------------------------------------------------------------
const DIM = 128;

/** 字符 unigram 哈希向量：共享字面字的文本有余弦相似（测机制够用）。 */
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

/** 按调用序号吐预置响应的假 chat。 */
function makeFakeChat(script) {
	let n = 0;
	const chat = async () => script[Math.min(n++, script.length - 1)];
	chat.calls = () => n;
	return chat;
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
		// dream 组（qwen-code 借鉴施工清单）：存量测试锁定**旧行为**——
		// dirtyGate:false = 维护期每轮全量跑 LLM 步；dreamManifest:false = 旧两两
		// 合并（fake chat 脚本是 MERGE_PROMPT 格式）。新协议行为由 dream.test.mjs 锁定。
		dirtyGate: false,
		dreamManifest: false,
		...overrides
	};
}

async function makeEngine(overrides = {}, chat = null) {
	const dataDir = await mkdtemp(join(tmpdir(), 'dshmem-'));
	const engine = new MemoryEngine(makeConfig(overrides), {
		dataDir,
		chat,
		embed: bigramEmbed
	});
	await engine.init();
	return { engine, dataDir };
}

function seed(engine, content, category, importance, pinned = false) {
	const card = createCard({
		content,
		category,
		importance,
		embedding: bigramEmbed([content])[0],
		status: pinned ? Status.PINNED : Status.ACTIVE
	});
	if (pinned) card.importance = Math.max(card.importance, 0.8);
	engine.store.put(card);
	return card;
}

function age(engine, card, days) {
	card.lastAccessed = Date.now() - days * 86400000;
	engine.store.put(card);
}

/** 手工二维单位向量（前两维非零）：与查询向量的余弦可精确控制（v0.4.8 用例）。 */
function vec2(a, b) {
	const v = new Array(DIM).fill(0);
	v[0] = a;
	v[1] = b;
	return v;
}

/** 直接指定 embedding 造卡（不经过 bigramEmbed，向量可控）。 */
function seedVec(engine, content, category, importance, embedding, createdAt) {
	const card = createCard({ content, category, importance, embedding, status: Status.ACTIVE, createdAt });
	engine.store.put(card);
	return card;
}

// ----------------------------------------------------------------------
test('召回命中并强化（importance 上涨、计数刷新）', async () => {
	const { engine } = await makeEngine();
	const card = seed(engine, '周三数学考试范围是二次函数', Category.FACT, 0.5);
	const hits = await engine.recall('数学考试', 3);
	assert.ok(hits.length > 0);
	assert.equal(hits[0].card.id, card.id);
	assert.ok(hits[0].card.importance > 0.5);
	assert.equal(hits[0].card.accessCount, 1);
});

test('高分工升 hot，闲置后降 cold 并写归档', async () => {
	const { engine, dataDir } = await makeEngine({ promoteScore: 0.5, demoteScore: 0.1 });
	const card = seed(engine, '周三数学考试范围是二次函数', Category.FACT, 0.9);
	const stats = await engine.maintenance();
	assert.equal(stats.promoted, 1);
	assert.match(engine.hotBlock(), /二次函数/);

	age(engine, card, 30);
	const stats2 = await engine.maintenance();
	assert.equal(stats2.demoted, 1);
	assert.doesNotMatch(engine.hotBlock(), /二次函数/);
	const archive = await engine.searchCold('二次函数');
	assert.match(archive, /二次函数/);
	void dataDir;
});

test('承诺卡衰减远慢于事实卡', async () => {
	const { engine } = await makeEngine({ demoteScore: 0.12 });
	const fact = seed(engine, '周三数学考试范围是二次函数', Category.FACT, 0.6);
	const promise = seed(engine, '周五前帮Poka整理错题本', Category.COMMITMENT, 0.6);
	age(engine, fact, 21);
	age(engine, promise, 21);
	await engine.maintenance();
	assert.equal(engine.store.get(fact.id).tier, Tier.COLD);
	assert.equal(engine.store.get(promise.id).tier, Tier.WARM);
});

test('pinned 卡不被降冷层', async () => {
	const { engine } = await makeEngine({ demoteScore: 0.9, promoteScore: 0.99 });
	const card = seed(engine, 'Poka 是初中生', Category.FACT, 0.5, true);
	await engine.maintenance();
	assert.equal(engine.store.get(card.id).tier, Tier.WARM);
	assert.ok(engine.store.get(card.id).importance >= 0.8);
});

test('hot 预算按调度分逐出', async () => {
	const { engine } = await makeEngine({ hotBudgetChars: 15, promoteScore: 0.3 });
	const a = seed(engine, '甲卡：数学考试二次函数', Category.FACT, 0.9);
	const b = seed(engine, '乙卡：喜欢简洁回复风格', Category.PREFERENCE, 0.85);
	await engine.maintenance();
	const hotIds = engine.store.hot().map((c) => c.id);
	assert.ok(hotIds.includes(a.id));
	assert.ok(!hotIds.includes(b.id));
});

test('写入管线：ADD 全量、DELETE 软删入归档', async () => {
	const extract = JSON.stringify({
		facts: [{ content: 'Poka不喜欢芝士披萨', category: 'preference', importance: 0.7 }]
	});
	const { engine } = await makeEngine({}, makeFakeChat([extract]));
	const old = seed(engine, 'Poka喜欢芝士披萨', Category.PREFERENCE, 0.6);

	// 第二次调用（决策）：DELETE 旧卡
	engine.chat = makeFakeChat([
		extract,
		JSON.stringify({ decisions: [{ action: 'DELETE', fact_index: 0, card_id: old.id }] })
	]);
	const report = await engine.remember([{ role: 'user', content: '我其实不吃芝士披萨了' }]);
	assert.deepEqual(report.deleted, [old.id]);
	assert.equal(engine.store.get(old.id).status, Status.SUPERSEDED);
	assert.match(await engine.searchCold('披萨'), /芝士披萨/);
	assert.equal((await engine.recall('披萨', 5)).length, 0);
});

test('写入管线：UPDATE 保持 id 并重嵌入', async () => {
	const extract = JSON.stringify({
		facts: [{ content: 'Poka在准备期中考试', category: 'fact', importance: 0.6 }]
	});
	const { engine } = await makeEngine();
	const old = seed(engine, 'Poka在准备期中考试', Category.FACT, 0.6);
	engine.chat = makeFakeChat([
		extract,
		JSON.stringify({
			decisions: [
				{
					action: 'UPDATE',
					fact_index: 0,
					card_id: old.id,
					content: 'Poka的期中考试结束了，下一步准备月考'
				}
			]
		})
	]);
	const report = await engine.remember([{ role: 'user', content: '期中考完了哦' }]);
	assert.deepEqual(report.updated, [old.id]);
	const card = engine.store.get(old.id);
	assert.equal(card.id, old.id);
	assert.match(card.content, /月考/);
	const hits = await engine.recall('月考', 1);
	assert.equal(hits[0]?.card.id, old.id);
});

test('JSON 容错：think 剥离 / 代码围栏 / 夹杂废话', () => {
	assert.equal(stripThink('<think>嗯…</think>{"a":1}'), '{"a":1}');
	assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
	assert.deepEqual(extractJson('好的，结果如下：{"a": [1,2]} 以上。'), { a: [1, 2] });
});

test('数据落盘并可重载', async () => {
	const { engine, dataDir } = await makeEngine();
	seed(engine, '测试持久化', Category.FACT, 0.7);
	await engine.dispose();

	const engine2 = new MemoryEngine(makeConfig(), {
		dataDir,
		chat: null,
		embed: bigramEmbed
	});
	await engine2.init();
	assert.ok([...engine2.store.cards.values()].some((c) => c.content === '测试持久化'));
});

// ----------------------------------------------------------------------
// v0.2.1~v0.2.4 防线（2026-10-23 清债补测）
// ----------------------------------------------------------------------
test('IM 双闸判据：cwd 与 [名字 (ID)] 前缀缺一不可', () => {
	const prefixed = [{ role: 'user', content: '[PokaNeko (5F2AAE298C6C1056E50ABFDB9A9B53EA)] 早啊各位' }];
	const plain = [{ role: 'user', content: '早啊，随便聊聊' }];
	// 本 GUI 实况：cwd 不含 profiles 但消息无前缀 → 桌面（v0.2.4 修的就是这个误判）
	assert.equal(classifySession('C:\\Users\\lanyi\\.dsh\\workspace', plain), 'desktop');
	// QQ：cwd 不含 profiles 且带桥前缀 → IM
	assert.equal(classifySession('C:\\Users\\lanyi\\.dsh\\workspace', prefixed), 'im');
	// profiles 目录下必是桌面
	assert.equal(classifySession('C:\\Users\\lanyi\\.dsh\\profiles\\desktop', plain), 'desktop');
	// 无 cwd / 异常输入保守护栏
	assert.equal(classifySession('', prefixed), 'desktop');
	assert.equal(classifySession('C:\\work', null), 'desktop');
	assert.ok(IM_SENDER_RE.test('[Alice (988AAF26863FEDF4ED3A5A397C43B211)] 在吗'));
	assert.ok(!IM_SENDER_RE.test('普通消息 (123)'));
});

test('IM 前置闸：剥前缀后过滤短消息与纯数字/符号', () => {
	assert.ok(isUsefulLine('[Alice (988AAF26863FEDF4ED3A5A397C43B211)] 明天数学考试范围说一下'));
	assert.ok(!isUsefulLine('[Alice (988AAF26863FEDF4ED3A5A397C43B211)] apt'));    // 剥前缀后 3 字符
	assert.ok(!isUsefulLine('[Alice (988AAF26863FEDF4ED3A5A397C43B211)] 123123')); // 纯数字
	assert.ok(!isUsefulLine('短的'));                                              // 无前缀短消息
});

test('跨表述查重：人称归一同实相等，反例不误并', () => {
	assert.ok(sameFactNormalized('PokaNeko喜欢喝碳酸饮料', '我喜欢喝碳酸饮料'));
	assert.ok(!sameFactNormalized('用户喜欢喝碳酸饮料', '用户讨厌喝碳酸饮料')); // 喜欢≠讨厌
	assert.ok(!sameFactNormalized('群友Alice是课代表', '群友Bob是课代表'));     // 群友名字是身份
	assert.ok(!sameFactNormalized('我', '我'));                                 // 归一后为空不判重
	assert.ok(sameFactNormalized('用户当前体温比平时高零点几度，未发烧（36.8度）', '体温比平时高零点几度，未发烧')); // 富化变体（v0.2.6 实战）
	assert.ok(sameFactNormalized('用户喜欢喝碳酸饮料（无糖）', '用户喜欢喝碳酸饮料')); // 前后缀富化 → 判重；中间插词的变体交给 DECIDE 走 UPDATE
});

test('写入管线：跨表述重复被人称归一兜底拦截（v0.2.4 实战场景回放）', async () => {
	const extract = JSON.stringify({
		facts: [{ content: 'PokaNeko喜欢喝碳酸饮料', category: 'preference', importance: 0.55 }]
	});
	const decide = JSON.stringify({
		decisions: [{ action: 'ADD', fact_index: 0, card_id: null, content: null }]
	});
	const { engine } = await makeEngine();
	seed(engine, '我喜欢喝碳酸饮料', Category.PREFERENCE, 0.65);
	engine.chat = makeFakeChat([extract, decide]);
	const report = await engine.remember(
		[{ role: 'user', content: '[PokaNeko (5F2AAE298C6C1056E50ABFDB9A9B53EA)] 我喜欢喝碳酸饮料' }],
		{ groupMode: true }
	);
	assert.equal(report.added.length, 0);
	assert.equal(report.deduped, 1);
});

test('强化门槛：相关度不到线的命中不喂重要度', async () => {
	const { engine } = await makeEngine({ reinforceMinRelevance: 0.99 });
	const card = seed(engine, '周三数学考试范围是二次函数', Category.FACT, 0.5);
	const hits = await engine.recall('数学考试', 3);
	assert.ok(hits.length > 0);
	assert.equal(hits[0].card.id, card.id);
	assert.equal(hits[0].card.importance, 0.5); // 门槛 0.99 挡住：不加
});

// ----------------------------------------------------------------------
// v0.4.8 召回公平性：强化下放 / trivia 席位 / diag 出参
// ----------------------------------------------------------------------
test('v0.4.8 强化下放：注入位之外的达标候选也涨重要度', async () => {
	const { engine } = await makeEngine();
	const qv = vec2(1, 0);
	engine.embed = (texts) => texts.map(() => qv); // 查询向量恒定，卡向量手工控制
	const inside = seedVec(engine, '甲占位卡', Category.FACT, 0.9, vec2(1, 0));                    // sim 1.00
	const outside = seedVec(engine, '乙落选卡', Category.FACT, 0.5, vec2(0.55, Math.sqrt(1 - 0.55 ** 2))); // sim 0.55
	const diag = {};
	const hits = await engine.recall('查询', 1, { diag });
	assert.equal(hits.length, 1);
	assert.equal(hits[0].card.id, inside.id);        // 注入位给满分卡（旧逻辑到此为止）
	assert.ok(outside.importance > 0.5);             // 落选但相关度 ≥0.5 → 也被强化（v0.4.8）
	assert.equal(diag.candidates, 2);
	assert.equal(diag.reinforced, 2);
	assert.equal(diag.pool, 2);
	assert.equal(diag.triviaSeat, false);
});

test('v0.4.8 trivia 席位：相关度达标的近期欲望必占一席', async () => {
	const { engine } = await makeEngine();
	const qv = vec2(1, 0);
	engine.embed = (texts) => texts.map(() => qv);
	const trivia = seedVec(engine, '用户想吃米线', Category.TRIVIA, 0.3, vec2(0.6, 0.8));
	seedVec(engine, '甲满分卡一', Category.FACT, 1.0, vec2(0.44, Math.sqrt(1 - 0.44 ** 2)));  // 综合 0.72
	seedVec(engine, '乙满分卡二', Category.FACT, 1.0, vec2(0.44, -Math.sqrt(1 - 0.44 ** 2))); // 综合 0.72
	const diag = {};
	const hits = await engine.recall('查询', 2, { diag });
	// trivia 综合 0.65（有效重要度 0.5）排第三，按分进不了 top2——席位换掉末位
	assert.equal(hits.length, 2);
	assert.ok(hits.some((h) => h.card.id === trivia.id));
	assert.equal(diag.triviaSeat, true);
	assert.ok(trivia.importance > 0.3); // sim 0.60 ≥0.5，席位之外强化照拿
});

test('v0.4.8 trivia 席位随 7 天生命周期失效', async () => {
	const { engine } = await makeEngine();
	const qv = vec2(1, 0);
	engine.embed = (texts) => texts.map(() => qv);
	const stale = seedVec(
		engine,
		'用户想吃米线',
		Category.TRIVIA,
		0.3,
		vec2(0.6, 0.8),
		Date.now() - 8 * 86400000 // 超 7 天生命周期：过期前夕，gc 即将接管
	);
	seedVec(engine, '甲满分卡一', Category.FACT, 1.0, vec2(0.44, Math.sqrt(1 - 0.44 ** 2)));
	seedVec(engine, '乙满分卡二', Category.FACT, 1.0, vec2(0.44, -Math.sqrt(1 - 0.44 ** 2)));
	const diag = {};
	const hits = await engine.recall('查询', 2, { diag });
	assert.ok(!hits.some((h) => h.card.id === stale.id)); // 席位不照顾过期卡
	assert.equal(diag.triviaSeat, false);
});

// ----------------------------------------------------------------------
// v0.4.9 混合检索（BM25 字面路 + RRF 融合）与时间线字段
// ----------------------------------------------------------------------
test('v0.4.9 bigramsOf：中文切二元、空白归零、附词频总数', () => {
	const g = bigramsOf('米线米线');
	assert.equal(g.get('米线'), 2);      // 重复 gram 计数
	assert.equal(g.total, 3);            // 米线/线米/米线
	assert.equal(bigramsOf('a b').get('ab'), 1); // 空白剔除后成对
	assert.equal(bigramsOf('  ').total, 0);      // 无有效 gram
	assert.equal(bigramsOf('').total, 0);
});

test('v0.4.9 bm25Search：字面命中排序，罕见词压过高频词', async () => {
	const { engine } = await makeEngine();
	seed(engine, '用户想吃米线', Category.TRIVIA, 0.3);
	seed(engine, '用户档案用户的用户', Category.FACT, 0.5); // 高频词"用户"堆料
	const hits = engine.store.bm25Search('米线', 5);
	assert.ok(hits.length > 0);
	assert.equal(hits[0].card.content, '用户想吃米线'); // "米线"gram 罕见 → IDF 高
	const noise = engine.store.bm25Search('不存在的词组', 5);
	assert.equal(noise.length, 0); // 无字面命中
});

test('v0.4.9 RRF 融合：双路命中压过单路语义第一，纯字面卡带 bm25 分', async () => {
	const { engine } = await makeEngine();
	const qv = vec2(1, 0);
	engine.embed = (texts) => texts.map(() => qv);
	// 双路卡：余弦 0.9 + 字面"米线"命中
	const both = seedVec(engine, '甲米线主题卡', Category.FACT, 0.4, vec2(0.9, Math.sqrt(1 - 0.81)));
	// 单路语义卡：余弦 0.44，重要度满分撑综合分，字面无命中
	const semOnly = seedVec(engine, '乙高分旧卡', Category.FACT, 1.0, vec2(0.44, Math.sqrt(1 - 0.44 ** 2)));
	// 纯字面卡：余弦 0（正交），字面强命中
	const literalOnly = seedVec(engine, '丙米线 Archives', Category.FACT, 0.4, vec2(0, 1));
	const diag = {};
	const hits = await engine.recall('米线', 3, { diag });
	assert.equal(hits[0].card.id, both.id);        // 双路第一：fusion=1.0
	assert.ok(hits.some((h) => h.card.id === semOnly.id));
	const lit = hits.find((h) => h.card.id === literalOnly.id);
	assert.ok(lit, '纯字面卡应进入候选');
	assert.equal(lit.relevance, 0);                // 余弦为零：语义上确实不相关
	assert.ok(lit.bm25 > 0);                       // 字面分在场，调用侧按 bm25MinRelevance 放行
	assert.equal(diag.bm25Candidates > 0, true);
});

test('v0.4.9 时间线：UPDATE 旧值落归档、validFrom 刷新', async () => {
	const { engine, dataDir } = await makeEngine({ promoteScore: 0.99 });
	const oldDays = Date.now() - 10 * 86400000;
	const card = seed(engine, '用户计划618期间检查内存价格', Category.FACT, 0.6);
	card.validFrom = oldDays;
	engine.store.put(card);
	const extract = JSON.stringify({
		facts: [{ content: '用户计划年后装机买内存', category: 'fact', importance: 0.6 }]
	});
	const decide = JSON.stringify({
		decisions: [{ action: 'UPDATE', fact_index: 0, card_id: card.id, content: '用户计划年后装机买内存' }]
	});
	engine.chat = makeFakeChat([extract, decide]);
	await engine.remember([{ role: 'user', content: '改主意了，年后再装' }]);
	const updated = engine.store.get(card.id);
	assert.equal(updated.content, '用户计划年后装机买内存');
	assert.equal(updated.validTo, null);                          // 活跃卡无失效时间
	assert.ok(updated.validFrom > oldDays);                      // 时间线前移到本次更新
	const archive = await readFile(join(dataDir, 'cold', 'archive.md'), 'utf8');
	assert.match(archive, /旧版归档/);
	assert.match(archive, /618期间检查内存价格/);                 // 旧文本留底
	assert.match(archive, /#\w+/);                                // 带卡 id（演化链锚点）
});

test('v0.4.9 旧卡回填：validFrom 缺省取 createdAt', () => {
	const created = Date.now() - 5 * 86400000;
	const card = createCard({ content: 'x', createdAt: created });
	assert.equal(card.validFrom, created);
	assert.equal(card.validTo, null);
});

// ----------------------------------------------------------------------
// v0.3 scope 隔离
// ----------------------------------------------------------------------
test('scope 隔离：IM 卡不进桌面召回与热块，IM 召回可查', async () => {
	const { engine } = await makeEngine();
	seed(engine, '用户喜欢喝碳酸饮料', Category.PREFERENCE, 0.6);
	const imCard = seed(engine, '群友Alice是班里的课代表', Category.FACT, 0.9);
	imCard.scope = 'im';
	engine.store.put(imCard); // 保持 warm——search 只扫 warm 层，热卡常驻提示词不参与搜索
	const all = await engine.recall('班里课代表是谁', 5, {}); // 不限 scope（对照组：查得到）
	assert.ok(all.some((h) => h.card.id === imCard.id));
	const desk = await engine.recall('班里课代表是谁', 5, { scopes: ['global'] });
	assert.ok(desk.every((h) => h.card.id !== imCard.id));  // 桌面查不到
	const im = await engine.recall('班里课代表是谁', 5, { scopes: ['global', 'im'] });
	assert.ok(im.some((h) => h.card.id === imCard.id));     // IM 会话查得到
	imCard.tier = 'hot';
	engine.store.put(imCard);
	assert.ok(!engine.store.hot().some((c) => c.id === imCard.id)); // hot() 只出 global
	assert.doesNotMatch(engine.hotBlock(), /Alice/);                // 热块无 IM 卡
});

test('群聊模式写入的卡自动带 im scope', async () => {
	const extract = JSON.stringify({
		facts: [{ content: '群友Bob喜欢钓鱼', category: 'preference', importance: 0.5 }]
	});
	const decide = JSON.stringify({
		decisions: [{ action: 'ADD', fact_index: 0, card_id: null, content: null }]
	});
	const { engine } = await makeEngine();
	engine.chat = makeFakeChat([extract, decide]);
	await engine.remember(
		[{ role: 'user', content: '[Bob (12345678ABCDEF0123456789ABCDEF01)] 周末去钓鱼吗' }],
		{ groupMode: true }
	);
	const added = engine.store.all().find((c) => c.content.includes('钓鱼'));
	assert.ok(added, '应有新卡');
	assert.equal(added.scope, 'im');
});

test('自动轮换备份：首备成功、24h 内节流', async () => {
	const { engine, dataDir } = await makeEngine();
	seed(engine, '备份测试卡', Category.FACT, 0.5);
	await engine.store.save();
	assert.equal(await engine.store.backupRotating(5), true);  // 首次备份
	assert.equal(await engine.store.backupRotating(5), false); // 24h 内节流
	const files = (await readdir(join(dataDir, 'backup'))).filter((f) => f.startsWith('auto-'));
	assert.equal(files.length, 1);
});

// ----------------------------------------------------------------------
// v0.3.2 自动合并 + 群标识观察
// ----------------------------------------------------------------------
test('维护期自动合并：同 scope 近似对合并、跨 scope 不动、重嵌入可检索', async () => {
	const merged = JSON.stringify({ content: '便宜的内存品牌当前缺货（两条合并）' });
	// promoteScore 抬高：幸存卡留在 warm 层，方便用 recall 验证重嵌入
	const { engine } = await makeEngine({ promoteScore: 0.99 });
	const a = seed(engine, '便宜且稳定的内存品牌缺货', Category.FACT, 0.6);
	const b = seed(engine, '便宜且稳定的内存品牌缺货', Category.FACT, 0.5); // 历史遗留完全重复
	const imDup = seed(engine, '便宜且稳定的内存品牌缺货', Category.FACT, 0.9);
	imDup.scope = 'im';
	engine.store.put(imDup);
	engine.chat = makeFakeChat([merged]);
	const stats = await engine.maintenance();
	assert.equal(stats.merged, 1);                                    // 只并了 global 的 a/b
	assert.equal(engine.store.get(a.id).status, 'active');           // 幸存者=重要度高的 a
	assert.match(engine.store.get(a.id).content, /两条合并/);
	assert.equal(engine.store.get(b.id).status, 'superseded');       // 落败者软删
	assert.equal(engine.store.get(imDup.id).status, 'active');       // im 域的同文卡不动
	const hits = await engine.recall('两条合并', 3);
	assert.ok(hits.some((h) => h.card.id === a.id));                 // 合并文本重嵌入后可检索
});

test('senderIdsOf：提取去重排序的发言者 ID', () => {
	const dialog = [
		{ role: 'user', content: '[PokaNeko (5F2AAE298C6C1056E50ABFDB9A9B53EA)] 早' },
		{ role: 'assistant', content: '早上好' },
		{ role: 'user', content: '[Alice (988AAF26863FEDF4ED3A5A397C43B211)] 在吗' },
		{ role: 'user', content: '[pokaneko (5faae298c6c1056e50abfdb9a9b53ea)] 大小写归一' },
		{ role: 'user', content: '没有前缀的普通消息' }
	];
	assert.deepEqual(senderIdsOf(dialog), [
		'5F2AAE298C6C1056E50ABFDB9A9B53EA',
		'5FAAE298C6C1056E50ABFDB9A9B53EA',
		'988AAF26863FEDF4ED3A5A397C43B211'
	]);
	assert.deepEqual(senderIdsOf(null), []);
});

// ----------------------------------------------------------------------
// v0.3.4 自动清理 + 重试队列
// ----------------------------------------------------------------------
test('purgeStale：超龄 superseded/cold 硬删，新近的与 active/pinned 不动', async () => {
	const { engine } = await makeEngine();
	const oldSuperseded = seed(engine, '被合并的旧卡', Category.FACT, 0.5);
	oldSuperseded.status = Status.SUPERSEDED;
	engine.store.put(oldSuperseded);
	oldSuperseded.updatedAt = Date.now() - 20 * 86400000; // put 会刷 updatedAt，软删时间要在 put 后落
	const freshSuperseded = seed(engine, '刚被合并的卡', Category.FACT, 0.5);
	freshSuperseded.status = Status.SUPERSEDED;
	engine.store.put(freshSuperseded);
	freshSuperseded.updatedAt = Date.now() - 2 * 86400000;
	const oldCold = seed(engine, '淡忘已久的老事实', Category.FACT, 0.3);
	oldCold.tier = Tier.COLD;
	oldCold.lastAccessed = Date.now() - 40 * 86400000; // 40 天未访问 > 30 天
	engine.store.put(oldCold);
	const freshCold = seed(engine, '刚降冷的卡', Category.FACT, 0.4);
	freshCold.tier = Tier.COLD;
	freshCold.lastAccessed = Date.now() - 3 * 86400000;
	engine.store.put(freshCold);
	const pinnedCold = seed(engine, '用户显式记住的', Category.FACT, 0.8, true);
	pinnedCold.tier = Tier.COLD;
	pinnedCold.lastAccessed = Date.now() - 40 * 86400000;
	engine.store.put(pinnedCold);
	const active = seed(engine, '正常活跃卡', Category.FACT, 0.6);

	const stats = purgeStale(engine.store, {});
	assert.equal(stats.superseded, 1);
	assert.equal(stats.cold, 1);
	assert.equal(engine.store.get(oldSuperseded.id), undefined);
	assert.equal(engine.store.get(oldCold.id), undefined);
	assert.ok(engine.store.get(freshSuperseded.id)); // 14 天缓冲带内
	assert.ok(engine.store.get(freshCold.id));       // 30 天内
	assert.ok(engine.store.get(pinnedCold.id));      // pinned 豁免
	assert.ok(engine.store.get(active.id));
});

test('expireStaleFacts：过期任务卡软删入归档，进行中/新卡不问 LLM', async () => {
	const { engine } = await makeEngine();
	const stale = seed(engine, '用户有健康报告待完成，睡前汇报三个数值', Category.COMMITMENT, 1);
	stale.createdAt = Date.now() - 10 * 86400000;
	engine.store.put(stale);
	const ongoing = seed(engine, '用户计划下周考数学', Category.FACT, 0.6);
	ongoing.createdAt = Date.now() - 10 * 86400000;
	engine.store.put(ongoing);
	const fresh = seed(engine, '用户需要明天带卷子', Category.FACT, 0.6); // 任务词但未满 7 天
	const noTask = seed(engine, '用户喜欢喝碳酸饮料', Category.PREFERENCE, 0.6);
	noTask.createdAt = Date.now() - 10 * 86400000;
	engine.store.put(noTask);

	engine.chat = makeFakeChat([
		JSON.stringify({ expired: true, reason: '报告已交，期限已过' }),
		JSON.stringify({ expired: false, reason: '计划仍在推进' })
	]);
	const stats = await expireStaleFacts(engine.store, engine.chat, {}, engine.tiers);
	assert.equal(stats.checked, 2);                                  // 只看满 7 天的任务词卡
	assert.equal(stats.expired, 1);
	assert.equal(engine.store.get(stale.id).status, Status.SUPERSEDED);
	assert.equal(engine.store.get(ongoing.id).status, Status.ACTIVE);
	assert.equal(engine.store.get(fresh.id).status, Status.ACTIVE);   // 未满龄没进候选
	assert.equal(engine.store.get(noTask.id).status, Status.ACTIVE);  // 非任务词没进候选
	assert.match(await engine.searchCold('健康报告'), /健康报告/);    // 过期也进归档留底
	assert.equal(engine.chat.calls(), 2);
});

test('expireStaleFacts：LLM 回包只认 expired=true，坏包不动卡', async () => {
	const { engine } = await makeEngine();
	const stale = seed(engine, '用户需将上下文从8192降至4096', Category.FACT, 0.5);
	stale.createdAt = Date.now() - 10 * 86400000;
	engine.store.put(stale);
	engine.chat = makeFakeChat(['{"expired": false, "reason": "x"}', 'not json at all']);
	await expireStaleFacts(engine.store, engine.chat, {}, engine.tiers);
	assert.equal(engine.store.get(stale.id).status, Status.ACTIVE); // 两次都没认过期
});

test('碎片吸收：短卡与近邻 0.80~0.92 也进合并候选', async () => {
	const merged = JSON.stringify({ content: '用户有感冒，伴随头痛喉咙痛（合并后）' });
	const { engine } = await makeEngine({ promoteScore: 0.99 });
	// 手工构造余弦 0.85 的单位向量：cos=0.85, sin=0.5268
	const a = seed(engine, '用户有感冒', Category.FACT, 0.7);
	const b = seed(engine, '用户有感冒伴随头痛和喉咙痛的症状记录', Category.FACT, 0.5);
	a.embedding = unitVec(0);
	b.embedding = [0.85, 0.526783, ...new Array(DIM - 2).fill(0)];
	engine.store.put(a);
	engine.store.put(b);
	engine.chat = makeFakeChat([merged]);
	const stats = await engine.maintenance();
	assert.equal(stats.merged, 1); // 旧阈值 0.92 抓不到的 0.85 对，靠短卡小灶并掉
	assert.match(engine.store.get(a.id).content, /合并后/);
});

test('重试队列：入队去重、重放计数、满次数放弃', async () => {
	const dialog = [{ role: 'user', content: '我喜欢喝碳酸饮料' }];
	let entries = [];
	const r1 = enqueueRetry(entries, { sessionId: 's1', dialog, options: {} });
	entries = r1.entries;
	assert.equal(r1.added, true);
	assert.equal(entries.length, 1);
	// 同会话同末条用户消息 → 重复失败不再堆叠
	const r2 = enqueueRetry(entries, { sessionId: 's1', dialog, options: {} });
	assert.equal(r2.added, false);
	assert.equal(r2.entries.length, 1);

	// 重放：第一回全失败（计数+1），第二回成功移除
	let failFirst = true;
	const run = async () => {
		if (failFirst) { failFirst = false; throw new Error('LLM HTTP 500'); }
	};
	const d1 = await drainRetryQueue(entries, run);
	assert.equal(d1.fail, 1);
	assert.equal(d1.entries.length, 1);
	assert.equal(d1.entries[0].attempts, 1);
	const d2 = await drainRetryQueue(d1.entries, run);
	assert.equal(d2.ok, 1);
	assert.equal(d2.entries.length, 0);

	// 5 次都失败 → 放弃出清
	entries = enqueueRetry([], { sessionId: 's2', dialog, options: {} }).entries;
	const alwaysFail = async () => { throw new Error('timeout'); };
	let d = await drainRetryQueue(entries, alwaysFail);
	d = await drainRetryQueue(d.entries, alwaysFail);
	d = await drainRetryQueue(d.entries, alwaysFail);
	d = await drainRetryQueue(d.entries, alwaysFail);
	d = await drainRetryQueue(d.entries, alwaysFail);
	assert.equal(d.entries.length, 0); // 第 5 次失败后不再保留
});

test('重试队列：文件读写往返、不存在视为空', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dshretry-'));
	const path = join(dir, 'retry-queue.json');
	assert.deepEqual(await loadRetryQueue(path), []); // ENOENT → []
	const dialog = [{ role: 'user', content: '明天要考数学' }];
	const entries = enqueueRetry([], { sessionId: 's1', dialog, options: { groupMode: true } }).entries;
	await saveRetryQueue(path, entries);
	const loaded = await loadRetryQueue(path);
	assert.equal(loaded.length, 1);
	assert.equal(loaded[0].options.groupMode, true);
	assert.deepEqual(loaded[0].dialog, dialog);
});

// ----------------------------------------------------------------------
// v0.4 云端路由 + 记忆导出
// ----------------------------------------------------------------------
test('makeDshChatFn：text-delta 累积、finish error 抛错、未配置路由报清晰错误', async () => {
	const fakeLlm = {
		stream: async function* () {
			yield { type: 'text-delta', text: '{"content":' };
			yield { type: 'text-delta', text: ' "合并后"}' };
			yield { type: 'finish', reason: { kind: 'stop' } };
		}
	};
	const chat = makeDshChatFn(() => fakeLlm, () => ({ provider: 'zai-coding-cn', model: 'glm-5.3-flash' }));
	const text = await chat([{ role: 'user', content: '合并一下' }]);
	assert.equal(text, '{"content": "合并后"}');

	// finish 带 error reason → 抛错（管线会走重试队列）
	const failLlm = {
		stream: async function* () {
			yield { type: 'finish', reason: { kind: 'error', failure: { message: '余额不足' } } };
		}
	};
	const chat2 = makeDshChatFn(() => failLlm, () => ({ provider: 'p', model: 'm' }));
	await assert.rejects(chat2([{ role: 'user', content: 'x' }]), /余额不足/);

	// provider/model 缺一 → 配置指引
	const chat3 = makeDshChatFn(() => fakeLlm, () => ({ provider: '', model: '' }));
	await assert.rejects(chat3([{ role: 'user', content: 'x' }]), /dshProvider/);

	// llm 服务不可达 → 报服务未注入
	const chat4 = makeDshChatFn(() => undefined, () => ({ provider: 'p', model: 'm' }));
	await assert.rejects(chat4([{ role: 'user', content: 'x' }]), /llm 服务未注入/);
});

test('makeDshChatFn：请求带 provider/model/signal，消息转 user 线格式', async () => {
	let seen;
	const fakeLlm = {
		stream: async function* (request) {
			seen = request;
			yield { type: 'text-delta', text: 'ok' };
			yield { type: 'finish', reason: { kind: 'stop' } };
		}
	};
	const chat = makeDshChatFn(() => fakeLlm, () => ({ provider: 'qwen-token-plan-cn', model: 'qwen3-max' }));
	await chat([{ role: 'user', content: '提取事实' }]);
	assert.equal(seen.provider, 'qwen-token-plan-cn');
	assert.equal(seen.model, 'qwen3-max');
	assert.equal(seen.messages.length, 1);
	assert.equal(seen.messages[0].role, 'user');
	assert.equal(seen.messages[0].content[0].type, 'text');
	assert.equal(seen.messages[0].content[0].text, '提取事实');
	assert.ok(seen.signal); // 超时保护在场
});

test('导出：md 按 scope/tier 分节、json 同构可回读', async () => {
	const { engine } = await makeEngine();
	const g1 = seed(engine, '用户喜欢喝碳酸饮料', Category.PREFERENCE, 0.65);
	g1.tier = Tier.HOT;
	engine.store.put(g1);
	const im1 = seed(engine, '群友Alice是班里的课代表', Category.FACT, 0.6);
	im1.scope = 'im';
	engine.store.put(im1);
	const dead = seed(engine, '被合并的旧卡', Category.FACT, 0.3);
	dead.status = Status.SUPERSEDED;
	engine.store.put(dead);

	const dir = await mkdtemp(join(tmpdir(), 'dshexport-'));
	const md = await exportStore(engine.store, dir, 'md');
	assert.match(md.path, /memory-export-\d{8}-\d{4}\.md$/);
	const mdText = await readFile(md.path, 'utf8');
	assert.match(mdText, /## 桌面\/全局记忆/);
	assert.match(mdText, /### 热层/);
	assert.match(mdText, /用户喜欢喝碳酸饮料/);
	assert.match(mdText, /## 群聊\/IM 记忆/);
	assert.doesNotMatch(mdText, /被合并的旧卡/); // 只导活跃卡
	assert.equal(md.count, 2);

	const js = await exportStore(engine.store, dir, 'json');
	const parsed = JSON.parse(await readFile(js.path, 'utf8'));
	assert.equal(parsed.cards.length, 2); // superseded 不导
	assert.ok(parsed.cards.every((c) => c.content && Array.isArray(c.embedding)));
});

test('自动导出：未配目录不动、24h 内节流、过期补导', async () => {
	const { engine } = await makeEngine();
	seed(engine, '导出节流测试卡', Category.FACT, 0.5);
	const dir = await mkdtemp(join(tmpdir(), 'dshautoexp-'));

	// 未配置 → 不动
	assert.equal((await autoExportMemory(engine.store, { exportDir: '' }, 'x')).exported, false);
	// 首次 → 导出
	const first = await autoExportMemory(engine.store, { exportDir: dir, exportFormat: 'md' }, 'x');
	assert.equal(first.exported, true);
	// 刚导过 → 节流
	assert.equal((await autoExportMemory(engine.store, { exportDir: dir, exportFormat: 'md' }, 'x')).exported, false);
	// 把导出件 mtime 拨回 25h 前 → 再导
	const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
	const old = new Date(Date.now() - 25 * 3600 * 1000);
	await utimes(join(dir, files[0]), old, old);
	assert.equal((await autoExportMemory(engine.store, { exportDir: dir, exportFormat: 'md' }, 'x')).exported, true);
});

// ----------------------------------------------------------------------
// v0.4.4 模型目录聚合（host 侧）
// ----------------------------------------------------------------------
test('collectModelCatalog：三源聚合、空 provider 隐藏、不可达降级', async () => {
	const fetchImpl = async (url) => {
		if (url.endsWith('/api/tags')) {
			return { json: async () => ({ models: [{ name: 'qwen3:4b' }, { model: 'bge-m3' }] }) };
		}
		if (url.endsWith('/v1/models')) {
			if (url.includes('8080')) return { json: async () => ({ data: [{ id: 'qwen3.6-35b-a3b' }] }) };
			throw new Error('ECONNREFUSED');
		}
		throw new Error('unexpected ' + url);
	};
	const llm = {
		listProviders: () => [
			{ id: 'deepseek-account', name: 'DeepSeek Account' },
			{ id: 'zai-coding-cn', name: '智谱' },
			{ id: 'offline-x', name: 'X' }
		],
		listModels: async (id) => {
			if (id === 'deepseek-account') return [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }];
			if (id === 'zai-coding-cn') return [{ id: 'glm-5.3-flash', name: 'GLM' }, { id: 'glm-5.3' }];
			if (id === 'offline-x') return [];
			throw new Error('no');
		}
	};
	const catalog = await collectModelCatalog({
		ollamaBaseUrl: 'http://127.0.0.1:11434/v1',
		runtimes: [{ id: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080' }],
		llm,
		fetchImpl
	});
	assert.equal(catalog.ollama.ok, true);
	assert.deepEqual(catalog.ollama.models, ['qwen3:4b', 'bge-m3']);
	assert.equal(catalog.runtimes[0].ok, true);
	assert.deepEqual(catalog.runtimes[0].models, ['qwen3.6-35b-a3b']);
	// 空列表的 provider 被隐藏（= 未激活），其余按 listProviders 顺序保留
	assert.deepEqual(catalog.cloud.map((c) => c.provider), ['deepseek-account', 'zai-coding-cn']);
	assert.equal(catalog.cloud[0].models[0].id, 'deepseek-flash');
});

test('collectModelCatalog：全不可达时降级不抛错（ollama/运行时/cloud 空）', async () => {
	const fetchImpl = async () => { throw new Error('refused'); };
	const catalog = await collectModelCatalog({
		ollamaBaseUrl: 'http://127.0.0.1:11434/v1',
		runtimes: [{ id: 'a', baseUrl: 'http://127.0.0.1:9999' }],
		llm: null,
		fetchImpl
	});
	assert.equal(catalog.ollama.ok, false);
	assert.equal(catalog.runtimes[0].ok, false);
	assert.deepEqual(catalog.cloud, []);
});

test('parseRuntimeList/stripV1：解析容错、apiKey 归一与端点归一', () => {
	assert.deepEqual(parseRuntimeList(''), []);
	assert.deepEqual(parseRuntimeList('bad json'), []);
	assert.deepEqual(parseRuntimeList('[{"id":"llama.cpp","baseUrl":"http://127.0.0.1:8080"}]'),
		[{ id: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080', apiKey: '' }]);
	assert.deepEqual(parseRuntimeList('[{"id":"deepseek","baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-123"}]'),
		[{ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-123' }]);
	assert.equal(stripV1('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
	assert.equal(stripV1('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
	assert.equal(stripV1(''), '');
});

test('collectModelCatalog：端点 apiKey 走 Authorization 头拉模型', async () => {
	let seenHeaders;
	const fetchImpl = async (url, options) => {
		if (url.endsWith('/v1/models')) {
			seenHeaders = options?.headers;
			return { json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }) };
		}
		throw new Error('refused');
	};
	const catalog = await collectModelCatalog({
		ollamaBaseUrl: 'http://127.0.0.1:11434/v1',
		runtimes: [{ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-abc' }],
		llm: null,
		fetchImpl
	});
	assert.equal(catalog.runtimes[0].ok, true);
	assert.deepEqual(catalog.runtimes[0].models, ['deepseek-chat', 'deepseek-reasoner']);
	assert.deepEqual(seenHeaders, { Authorization: 'Bearer sk-abc' });
});

// ----------------------------------------------------------------------
// v0.6.0 工作区分离
// ----------------------------------------------------------------------
test('workspaceKeyOf/resolveWorkspaceKey：末级目录名归一、同名去歧义、异常输入兜底', () => {
	assert.equal(workspaceKeyOf('C:\\Users\\lanyi\\.dsh\\workspace\\dsh-memory'), 'dsh-memory');
	assert.equal(workspaceKeyOf('E:\\notes'), 'notes');
	assert.equal(workspaceKeyOf('C:\\Users\\lanyi\\.dsh\\workspace'), 'workspace');
	assert.equal(workspaceKeyOf(''), GENERAL_WORKSPACE);          // 空 cwd
	assert.equal(workspaceKeyOf('D:\\'), GENERAL_WORKSPACE);       // 纯盘符
	assert.equal(workspaceKeyOf(null), GENERAL_WORKSPACE);         // 异常输入
	// 大小写与分隔符变体归同一个键
	assert.equal(workspaceKeyOf('C:/USERS/LANYI/.dsh/workspace/Notes/'), 'notes');
	// 同名目录去歧义：不同路径的 notes，后来者加短 hash 后缀
	const registry = new Map();
	assert.equal(resolveWorkspaceKey('E:\\notes', registry), 'notes');
	assert.equal(resolveWorkspaceKey('C:\\doc\\notes', registry), 'notes~' + shortHash('c:/doc/notes'));
	assert.equal(resolveWorkspaceKey('E:\\notes', registry), 'notes'); // 原键稳定复用
});

test('workspaceVisible：通用卡处处可见，工作区卡只在本区可见，null 不过滤', () => {
	assert.equal(workspaceVisible('*', 'notes'), true);
	assert.equal(workspaceVisible(undefined, 'notes'), true); // 旧卡缺字段按通用
	assert.equal(workspaceVisible('notes', 'notes'), true);
	assert.equal(workspaceVisible('workspace', 'notes'), false);
	assert.equal(workspaceVisible('notes', null), true);      // null = 不做工作区过滤
	assert.equal(workspaceVisible('notes', GENERAL_WORKSPACE), true); // 未识别 cwd 全放行
});

test('工作区分离：召回按 ws 过滤，热块按工作区渲染', async () => {
	const { engine } = await makeEngine();
	const gen = seed(engine, '用户喜欢喝碳酸饮料', Category.PREFERENCE, 0.9);
	const wsCard = seed(engine, 'dsh-memory 插件正在开发 v0.6.0 工作区分离', Category.FACT, 0.9);
	wsCard.ws = 'workspace';
	engine.store.put(wsCard);
	// notes 会话：只召回通用卡（查询与两张卡都字面重合，确保余弦>0）
	const query = '用户喜欢喝什么饮料？顺便问下插件开发进度';
	const notes = await engine.recall(query, 5, { workspace: 'notes' });
	assert.ok(notes.length > 0);
	assert.ok(notes.every((h) => h.card.ws !== 'workspace'));
	// workspace 会话：两张都可见
	const wsHits = await engine.recall(query, 5, { workspace: 'workspace' });
	assert.ok(wsHits.some((h) => h.card.id === wsCard.id));
	assert.ok(wsHits.some((h) => h.card.id === gen.id));
	// 不过滤（IM/隔离关闭）：全可见
	const all = await engine.recall(query, 5, { workspace: null });
	assert.ok(all.some((h) => h.card.id === wsCard.id));
	// 热块：hot 层分区渲染
	gen.tier = 'hot';
	wsCard.tier = 'hot';
	engine.store.put(gen);
	engine.store.put(wsCard);
	assert.match(engine.hotBlock('workspace'), /v0\.6\.0/);
	assert.doesNotMatch(engine.hotBlock('notes'), /v0\.6\.0/);
	assert.match(engine.hotBlock('notes'), /碳酸饮料/); // 通用卡处处在
});

test('写入打标：general=true 归通用，false 挂当前工作区；偏好/约定强制通用', async () => {
	const extract = JSON.stringify({
		facts: [
			{ content: '用户喜欢喝碳酸饮料', category: 'preference', importance: 0.5, general: false }, // 偏好强制通用
			{ content: 'dsh-memory v0.6.0 已完成工作区分离', category: 'fact', importance: 0.6, general: false },
			{ content: '用户在自学 bash 命令', category: 'fact', importance: 0.5 } // 缺省 general=true
		]
	});
	const decide = JSON.stringify({
		decisions: [
			{ action: 'ADD', fact_index: 0, card_id: null, content: null },
			{ action: 'ADD', fact_index: 1, card_id: null, content: null },
			{ action: 'ADD', fact_index: 2, card_id: null, content: null }
		]
	});
	const { engine } = await makeEngine();
	engine.chat = makeFakeChat([extract, decide]);
	await engine.remember([{ role: 'user', content: '聊聊近况' }], { workspace: 'workspace' });
	const byContent = (kw) => engine.store.all().find((c) => c.content.includes(kw));
	assert.equal(byContent('碳酸饮料').ws, '*');       // 偏好强制通用
	assert.equal(byContent('v0.6.0').ws, 'workspace'); // 项目卡挂当前工作区
	assert.equal(byContent('bash').ws, '*');           // 缺省按通用
});

test('跨工作区去重隔离：别的工作区同名事实不压制本区 ADD', async () => {
	const extract = JSON.stringify({
		facts: [{ content: '便宜且稳定的内存品牌缺货', category: 'fact', importance: 0.6, general: false }]
	});
	const decide = JSON.stringify({
		decisions: [{ action: 'ADD', fact_index: 0, card_id: null, content: null }]
	});
	const { engine } = await makeEngine();
	const elsewhere = seed(engine, '便宜且稳定的内存品牌缺货', Category.FACT, 0.9);
	elsewhere.ws = 'notes';
	engine.store.put(elsewhere);
	engine.chat = makeFakeChat([extract, decide]);
	const report = await engine.remember([{ role: 'user', content: '内存到货没' }], { workspace: 'workspace' });
	assert.equal(report.added.length, 1); // 没被 notes 区的同文卡去重掉
	assert.equal(engine.store.get(report.added[0]).ws, 'workspace');
	// 同工作区内仍会被确定性去重挡住
	engine.chat = makeFakeChat([extract, decide]);
	const again = await engine.remember([{ role: 'user', content: '再说一次' }], { workspace: 'workspace' });
	assert.equal(again.added.length, 0);
	assert.equal(again.deduped, 1);
});

test('维护期热层按工作区分组装配：一个区吃满预算不挤占另一个区', async () => {
	// 小预算让分组效果可见：每区 maxCards=2
	const { engine } = await makeEngine({ hotBudgetChars: 1000, hotMaxCards: 2, promoteScore: 0.3, demoteScore: 0.01 });
	for (let i = 0; i < 3; i += 1) {
		const c = seed(engine, `workspace 区项目进展卡编号${i}号内容`, Category.FACT, 0.9);
		c.ws = 'workspace';
		engine.store.put(c);
	}
	const gen = seed(engine, '用户喜欢喝碳酸饮料通用偏好卡', Category.PREFERENCE, 0.9); // 通用区只有 1 张
	await engine.maintenance();
	// hot('workspace') 视图 = 通用卡 + workspace 卡；只数 workspace 卡验证分组预算
	const wsHot = engine.store.hot('workspace').filter((c) => c.ws === 'workspace');
	const genHot = engine.store.hot('notes'); // notes 视图 = 通用区
	assert.equal(wsHot.length, 2);            // workspace 区自己的预算只装 2 张
	assert.equal(engine.store.all().filter((c) => c.ws === 'workspace' && c.tier === 'warm').length, 1); // 第 3 张留在 warm
	assert.ok(genHot.some((c) => c.id === gen.id)); // 通用区的卡没被 workspace 区挤出热层
});

test('维护期自动合并：跨工作区的近似对不合并', async () => {
	const merged = JSON.stringify({ content: '合并后的陈述' });
	const { engine } = await makeEngine({ promoteScore: 0.99 });
	const a = seed(engine, '插件进展重复陈述卡', Category.FACT, 0.6);
	const b = seed(engine, '插件进展重复陈述卡', Category.FACT, 0.5);
	a.ws = 'workspace';
	b.ws = 'notes'; // 同文不同区
	engine.store.put(a);
	engine.store.put(b);
	engine.chat = makeFakeChat([merged]);
	const stats = await engine.maintenance();
	assert.equal(stats.merged, 0); // 跨 ws 不并：隔离优先于去重
	assert.equal(engine.store.get(a.id).status, 'active');
	assert.equal(engine.store.get(b.id).status, 'active');
});

test('applyLegacyWsMap：按映射打标、标记幂等、坏表/无表零作用', async () => {
	const { engine, dataDir } = await makeEngine();
	const mapped1 = seed(engine, '插件项目进展卡一', Category.FACT, 0.6);
	const mapped2 = seed(engine, '插件项目进展卡二', Category.FACT, 0.6);
	const other = seed(engine, '用户喜欢喝碳酸饮料', Category.PREFERENCE, 0.6);
	const mapPath = join(dataDir, 'ws-map.json');
	const markerPath = join(dataDir, '.ws-migrated');
	const { writeFile } = await import('node:fs/promises');
	await writeFile(mapPath, JSON.stringify({ workspace: [mapped1.id, mapped2.id] }), 'utf8');
	const tagged = await applyLegacyWsMap(engine.store, mapPath, markerPath);
	assert.equal(tagged, 3); // 全库都过了一遍（表外 → '*'）
	assert.equal(engine.store.get(mapped1.id).ws, 'workspace');
	assert.equal(engine.store.get(mapped2.id).ws, 'workspace');
	assert.equal(engine.store.get(other.id).ws, '*');
	// 标记文件存在 → 幂等跳过（改映射也不重打）
	await writeFile(mapPath, JSON.stringify({ notes: [other.id] }), 'utf8');
	assert.equal(await applyLegacyWsMap(engine.store, mapPath, markerPath), 0);
	assert.equal(engine.store.get(other.id).ws, '*');
	// 坏表 / 无表 → 零作用
	const { engine: e2, dataDir: d2 } = await makeEngine();
	seed(e2, '无映射场景卡', Category.FACT, 0.5);
	await writeFile(join(d2, 'ws-map.json'), '{bad json', 'utf8');
	assert.equal(await applyLegacyWsMap(e2.store, join(d2, 'ws-map.json'), join(d2, '.ws-migrated')), 0);
	assert.equal(await applyLegacyWsMap(e2.store, join(d2, 'nope.json'), join(d2, '.ws-migrated')), 0);
});
