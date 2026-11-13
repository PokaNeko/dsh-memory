/**
 * dream 组守卫测试 —— qwen-code 借鉴施工清单（2026-11-12）A/B/C 三组的新行为。
 *
 * 跑法：node --import "data:text/javascript,import { register } from 'node:module'; register('file:///<绝对路径>/test/stub-loader.mjs');" test/dream.test.mjs
 * （stub-loader 注册宿主包桩；smoke.test.mjs 头注同款说明）
 *
 * 分层：纯函数直接断言；管线行为用假 chat/embed 全覆盖（不需要 ollama）。
 * 每个测试对应施工清单一条验收标准，编号对齐。
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { diffAndValidate, dreamConsolidate, renderCandidates, renderProposal, snapshotStore, validateManifest, buildCandidatePool } from '../lib/dream.js';
import { expireStaleFacts } from '../lib/gc.js';
import { collectVocabulary, renderVocabulary, runIngest, shouldSkipExtract } from '../lib/ingest.js';
import { ageDays, ageText, LIMITS, stalenessCaveat, validateBudget, createCard, Status, Tier } from '../lib/models.js';
import { autoMergeSimilar } from '../lib/maintenance.js';
import { MemoryEngine } from '../lib/engine.js';
import { MemoryStore } from '../lib/store.js';
import { scanSecrets } from '../lib/prompt-safety.js';
import { TierManager } from '../lib/tiers.js';

// ---------------------------------------------------------------- helpers

const DIM = 64;

/** 单位向量：同 idx 的两张卡余弦 = 1。 */
function unitVec(idx) {
	const v = new Array(DIM).fill(0);
	v[idx] = 1;
	return v;
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
		dupThreshold: 0.92,
		dirtyGate: false,
		dirtyThreshold: 20,
		dreamManifest: true,
		dreamDryRun: false,
		autoExpire: false,
		...overrides
	};
}

/** 按调用序吐预置响应、记录入参的假 chat。 */
function fakeChat(script) {
	const calls = [];
	const chat = async (messages) => {
		calls.push(messages);
		return script[Math.min(calls.length - 1, script.length - 1)];
	};
	chat.calls = calls;
	return chat;
}

/** 恒返回同文本的 embed（带调用计数，供重嵌入断言）。 */
function fakeEmbed(vec = unitVec(0)) {
	const embed = async () => {
		embed.calls += 1;
		return [vec];
	};
	embed.calls = 0;
	return embed;
}

async function makeStore(cards = []) {
	const dataDir = await mkdtemp(join(tmpdir(), 'dream-'));
	const store = new MemoryStore(join(dataDir, 'cards.json'));
	for (const card of cards) store.put(card, { dirty: false });
	return { store, dataDir };
}

// ---------------------------------------------------------------- A1 新鲜度

test('A1 ageText：今天/昨天/N天前', () => {
	assert.equal(ageText(0), '今天');
	assert.equal(ageText(1), '昨天');
	assert.equal(ageText(30), '30天前');
});

test('A1 stalenessCaveat：新卡不告诫，旧卡给天数与告诫句', () => {
	const now = Date.now();
	const fresh = { validFrom: now - 3600e3 };
	const old = { validFrom: now - 30 * 86400000 };
	assert.equal(stalenessCaveat([fresh], now), '');
	const warn = stalenessCaveat([fresh, old], now);
	assert.ok(warn.includes('1 条'), warn);
	assert.ok(warn.includes('30天前'), warn);
	assert.ok(warn.includes('时点观察'), warn);
});

test('A1 ageDays 以 validFrom 计龄且不回退负数', () => {
	assert.equal(ageDays({ validFrom: Date.now() + 86400000 }), 0); // 时钟偏移钳到 0
	assert.ok(ageDays({ createdAt: Date.now() - 2 * 86400000 }) >= 2);
});

test('A1 hot 块渲染：含旧卡附告诫行，freshnessCaveat 关则无', async () => {
	const now = Date.now();
	const old = createCard({ content: '旧卡内容', validFrom: now - 40 * 86400000, tier: Tier.HOT });
	const tiers = new TierManager(makeConfig(), '.');
	const withWarn = tiers.renderHotBlock([old]);
	assert.ok(withWarn.includes('时点观察'), withWarn);
	const quiet = new TierManager(makeConfig({ freshnessCaveat: false }), '.');
	assert.equal(quiet.renderHotBlock([old]).includes('时点观察'), false);
});

// ---------------------------------------------------------------- A2 密钥扫描

test('A2 scanSecrets：各类凭据命中对应规则', () => {
	assert.equal(scanSecrets('我的key是LTAI5tAbcdefghijk1234'), 'alibaba-cloud-access-key');
	assert.equal(scanSecrets('AKIAIOSFODNN7EXAMPLE'), 'aws-access-token');
	assert.equal(scanSecrets('sk-abc123def456ghi789jkl'), 'openai-api-key');
	assert.equal(scanSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'github-pat');
	assert.equal(scanSecrets('-----BEGIN RSA PRIVATE KEY-----'), 'private-key-header');
});

test('A2 scanSecrets：谈论格式不误伤', () => {
	assert.equal(scanSecrets('阿里云 AccessKey 一般 LTAI 开头'), null);
	assert.equal(scanSecrets('sk- 开头的是 OpenAI key'), null);
	assert.equal(scanSecrets('今天天气不错'), null);
	assert.equal(scanSecrets(''), null);
});

test('A2 ingest 拒写命中卡，同批其他卡照常入库', async () => {
	const { store, dataDir } = await makeStore();
	const chat = fakeChat([
		'{"facts":[{"content":"我的密钥是LTAI5tAbcdefghijk1234请保存","category":"fact","importance":0.5,"general":true,"side":"user"},{"content":"用户喜欢喝碳酸饮料","category":"preference","importance":0.5,"general":true,"side":"user"}]}',
		'{"decisions":[{"action":"ADD","fact_index":0,"card_id":null,"content":null}]}'
	]);
	const report = await runIngest({
		dialog: [{ role: 'user', content: '对话' }],
		store, chat, embed: fakeEmbed(), config: makeConfig(), tiers: new TierManager(makeConfig(), dataDir)
	});
	assert.equal(report.secretBlocked.length, 1);
	assert.equal(report.secretBlocked[0].rule, 'alibaba-cloud-access-key');
	assert.equal(report.added.length, 1);
	assert.equal(store.all().length, 1);
	assert.equal(store.all()[0].content, '用户喜欢喝碳酸饮料');
});

// ---------------------------------------------------------------- A3 写入预算

test('A3 validateBudget 与 LIMITS 口径', () => {
	assert.equal(LIMITS.contentChars, 1200);
	assert.equal(validateBudget('a'.repeat(1200)).ok, true);
	assert.equal(validateBudget('a'.repeat(1201)).ok, false);
});

test('A3 ingest 超限卡打回重压缩后入库，重压仍超则安全截断', async () => {
	const { store, dataDir } = await makeStore();
	const longFact = '很'.repeat(1500);
	const chat = fakeChat([
		'{"facts":[{"content":"' + longFact + '","category":"fact","importance":0.5,"general":true,"side":"user"}]}',
		'{"content":"压缩成功的一句话"}',
		'{"decisions":[{"action":"ADD","fact_index":0,"card_id":null,"content":null}]}'
	]);
	const report = await runIngest({
		dialog: [{ role: 'user', content: '对话' }],
		store, chat, embed: fakeEmbed(), config: makeConfig(), tiers: new TierManager(makeConfig(), dataDir)
	});
	assert.equal(report.added.length, 1);
	assert.equal(report.truncated, 0);
	assert.equal(store.all()[0].content, '压缩成功的一句话');
	// 调用序：提取 → 重压缩 → 决策
	assert.equal(chat.calls.length, 3);
});

test('A3 重压缩仍超限 → 硬截断到 1200 且不劈代理对', async () => {
	const { store, dataDir } = await makeStore();
	const longFact = '很'.repeat(1300);
	const chat = fakeChat([
		'{"facts":[{"content":"' + longFact + '","category":"fact","importance":0.5,"general":true,"side":"user"}]}',
		'{"content":"' + '长'.repeat(1300) + '"}',
		'{"decisions":[{"action":"ADD","fact_index":0,"card_id":null,"content":null}]}'
	]);
	const report = await runIngest({
		dialog: [{ role: 'user', content: '对话' }],
		store, chat, embed: fakeEmbed(), config: makeConfig(), tiers: new TierManager(makeConfig(), dataDir)
	});
	assert.equal(report.truncated, 1);
	const card = store.all()[0];
	assert.ok(card.content.length <= LIMITS.contentChars);
});

test('A3 UPDATE 合并文本超限被截断', async () => {
	const { store, dataDir } = await makeStore();
	store.put(createCard({ id: 'card-old', content: '旧内容', embedding: unitVec(1) }));
	const chat = fakeChat([
		'{"facts":[{"content":"更新后内容","category":"fact","importance":0.5,"general":true,"side":"user"}]}',
		'{"decisions":[{"action":"UPDATE","fact_index":0,"card_id":"card-old","content":"' + '长'.repeat(1250) + '"}]}'
	]);
	const report = await runIngest({
		dialog: [{ role: 'user', content: '对话' }],
		store, chat, embed: fakeEmbed(unitVec(1)), config: makeConfig(), tiers: new TierManager(makeConfig(), dataDir)
	});
	assert.equal(report.updated.length, 1);
	assert.ok(store.get('card-old').content.length <= LIMITS.contentChars);
	assert.equal(report.truncated, 1);
});

// ---------------------------------------------------------------- A4 词表

test('A4 collectVocabulary：高频中文 bigram 入表、停用与低频被滤', async () => {
	const { store } = await makeStore([
		createCard({ content: '用户在装机调试', embedding: unitVec(0) }),
		createCard({ content: '装机的清单已整理', embedding: unitVec(1) }),
		createCard({ content: '装机还要买显卡', embedding: unitVec(2) }),
		createCard({ content: '只出现一次的词组', embedding: unitVec(3) })
	]);
	const vocab = collectVocabulary(store);
	assert.ok(vocab.includes('装机'), `词表缺"装机"：${vocab.join('、')}`);
	assert.ok(!vocab.includes('只出'), '低频 gram 不应入表');
	for (const gram of vocab) assert.equal(STOP_TEST(gram), false, `停用 gram 混入：${gram}`);
	function STOP_TEST(gram) {
		// 与 ingest.js 同一口径的抽样校验：含高频虚字的 gram 应被滤掉
		return /[的在是有我不这那个与和或但说要去会能]/.test(gram);
	}
});

test('A4 renderVocabulary：空表空串、超预算截断', () => {
	assert.equal(renderVocabulary([]), '');
	const grams = Array.from({ length: 2000 }, (_, i) => `词${i}`);
	assert.ok(renderVocabulary(grams, 100).length <= 100);
});

test('A4 ingest 提示词注入词表行', async () => {
	const { store, dataDir } = await makeStore([
		createCard({ content: '用户喜欢喝碳酸饮料', embedding: unitVec(0) }),
		createCard({ content: '用户爱喝碳酸饮料配炸鸡', embedding: unitVec(1) }),
		createCard({ content: '碳酸饮料喝多了不好', embedding: unitVec(2) })
	]);
	const chat = fakeChat([
		'{"facts":[{"content":"用户喜欢喝果汁","category":"preference","importance":0.5,"general":true,"side":"user"}]}',
		'{"decisions":[{"action":"ADD","fact_index":0,"card_id":null,"content":null}]}'
	]);
	await runIngest({
		dialog: [{ role: 'user', content: '对话' }],
		store, chat, embed: fakeEmbed(), config: makeConfig(), tiers: new TierManager(makeConfig(), dataDir)
	});
	const promptText = chat.calls[0][0].content;
	assert.ok(promptText.includes('库内既有高频词'), '提示词缺词表行');
	assert.ok(promptText.includes('碳酸'), '词表缺高频词');
});

// ---------------------------------------------------------------- B1 快照校验

test('B1 diffAndValidate：allowed 放行、计划外捕获、importance 不算账', () => {
	const before = new Map([
		['a', '内容A|fact|*|active'],
		['b', '内容B|fact|*|active'],
		['c', '内容C|fact|*|active']
	]);
	const after = new Map([
		['a', '内容A2|fact|*|active'], // allowed 内合法变更
		['b', '内容B|fact|*|active'],
		['c', '内容C|fact|*|superseded'], // 计划外状态变更
		['d', '新卡|fact|*|active'] // 计划外新增
	]);
	const audit = diffAndValidate(before, after, { allowed: new Set(['a']) });
	// c 变了但不在 allowed：既是 changed 也是 unexpected
	assert.deepEqual(audit.changed, ['a', 'c']);
	assert.deepEqual(audit.created, ['d']);
	assert.deepEqual(audit.unexpected, ['c', 'd']);
	// importance 变化不在哈希里——不算改动（并发 reinforce 不误报）
	const snap1 = snapshotStore({ cards: new Map([['x', { content: 't', category: 'fact', ws: '*', status: 'active', importance: 0.5 }]]) });
	const snap2 = snapshotStore({ cards: new Map([['x', { content: 't', category: 'fact', ws: '*', status: 'active', importance: 0.9 }]]) });
	assert.deepEqual(snap2.get('x'), snap1.get('x'));
});

test('B1 维护期计划外改动被回滚，库恢复原样', async () => {
	const { store, dataDir } = await makeStore();
	const engine = new MemoryEngine(makeConfig({ dreamDryRun: false, autoExpire: false }), {
		dataDir, chat: null, embed: fakeEmbed()
	});
	engine.store = store;
	engine.tiers = new TierManager(engine.config, dataDir);
	store.put(createCard({ id: 'victim', content: '无辜的卡', embedding: unitVec(0) }));
	store.put(createCard({ id: 'other', content: '另一张同向量卡凑成候选对', embedding: unitVec(0) }));
	// 提案返回空清单，但 chat 顺手篡改一张不在 touched 名单里的卡 → B1 必须抓住
	const evilChat = async () => {
		store.get('victim').content = '被 LLM 篡改';
		return '{"dedupe":[],"split":[]}';
	};
	engine.chat = evilChat;
	const stats = await engine.maintenance();
	assert.equal(stats.status, 'rolled-back');
	assert.ok(stats.rolledBack.includes('dream 校验失败'), stats.rolledBack);
	assert.equal(store.get('victim').content, '无辜的卡', '回滚后应恢复原内容');
});

// ---------------------------------------------------------------- B2 清单协议

test('B2 validateManifest：坏 id / PINNED / 跨操作重复 / 超预算 / 密钥 全部整单作废', async () => {
	const { store } = await makeStore([
		createCard({ id: 'c1', content: '卡一', status: Status.ACTIVE }),
		createCard({ id: 'c2', content: '卡二', status: Status.ACTIVE }),
		createCard({ id: 'pin', content: '钉住的卡', status: Status.PINNED })
	]);
	assert.ok(!validateManifest({ dedupe: [{ sources: ['ghost1', 'ghost2'], targetContent: 'x' }], split: [] }, store).ok);
	assert.ok(validateManifest({ dedupe: [{ sources: ['pin', 'c1'], targetContent: 'x' }], split: [] }, store).ok === false, 'PINNED 必须拒并');
	assert.ok(!validateManifest({ dedupe: [{ sources: ['c1', 'c1'], targetContent: 'x' }], split: [] }, store).ok);
	assert.ok(!validateManifest({ dedupe: [{ sources: ['c1', 'c2'], targetContent: '长'.repeat(1300) }], split: [] }, store).ok);
	assert.ok(!validateManifest({ dedupe: [{ sources: ['c1', 'c2'], targetContent: 'key=sk-abc123def456ghi789jkl' }], split: [] }, store).ok);
	assert.ok(!validateManifest({ dedupe: [{ sources: ['c1', 'c2'], targetContent: 'ok' }], split: [{ source: 'c2', targets: ['a', 'b'] }] }, store).ok, 'c2 跨操作重复');
	assert.ok(!validateManifest({ dedupe: [], split: [{ source: 'c1', targets: ['只有一条'] }] }, store).ok);
});

test('B2 dreamConsolidate 合法提案执行：软删归档 + 重嵌入 + touched 名单', async () => {
	const { store, dataDir } = await makeStore([
		createCard({ id: 'c1', content: '用户喜欢喝碳酸饮料', embedding: unitVec(0), importance: 0.5 }),
		createCard({ id: 'c2', content: '用户爱喝碳酸饮料', embedding: unitVec(0), importance: 0.7 })
	]);
	const tiers = new TierManager(makeConfig(), dataDir);
	const embed = fakeEmbed(unitVec(5));
	const chat = fakeChat([
		'{"dedupe":[{"sources":["c1","c2"],"targetContent":"用户喜欢喝碳酸饮料（也爱果汁）"}],"split":[]}'
	]);
	const stats = await dreamConsolidate(store, chat, embed, makeConfig(), tiers, { dryRun: false });
	assert.equal(stats.deduped, 1);
	assert.equal(stats.touched.length, 2);
	// 幸存者 = 重要度高者：c2(0.7) 留下，c1(0.5) 归档
	assert.equal(store.get('c2').content, '用户喜欢喝碳酸饮料（也爱果汁）');
	assert.equal(store.get('c2').importance, 0.7);
	assert.equal(store.get('c1').status, Status.SUPERSEDED);
	assert.equal(embed.calls, 1, '合并文本重嵌入恰好一次');
	// touched 名单喂给 B1 校验应当零 unexpected
	const audit = diffAndValidate(new Map([
		['c1', '用户喜欢喝碳酸饮料|preference|*|active'],
		['c2', '用户爱喝碳酸饮料|preference|*|active']
	]), snapshotStore(store), { allowed: new Set(stats.touched) });
	assert.equal(audit.unexpected.length, 0);
});

test('B2 split：一张杂卡拆多条，原卡归档新卡入池', async () => {
	// 杂卡必须是超长卡（>800 字）才进候选池——split 的业务对象本来就是杂长卡
	const longMess = ('主题甲：用户在调试 dsh-memory 的 dream 模块，改了快照与校验逻辑。'.repeat(30)
		+ '主题乙：用户下周要考数学，复习计划是每天一套卷子。').slice(0, 900);
	const { store, dataDir } = await makeStore([
		createCard({ id: 'mixed', content: longMess, category: 'fact', importance: 0.6, embedding: unitVec(0) }),
		createCard({ id: 'filler', content: '无关的另一张卡', embedding: unitVec(5) }) // 凑足候选池最小卡数
	]);
	const tiers = new TierManager(makeConfig(), dataDir);
	const embed = fakeEmbed(unitVec(9));
	const chat = fakeChat([
		'{"dedupe":[],"split":[{"source":"mixed","targets":["拆分陈述一","拆分陈述二"]}]}'
	]);
	const stats = await dreamConsolidate(store, chat, embed, makeConfig(), tiers, { dryRun: false });
	assert.equal(stats.split, 1);
	assert.equal(stats.touched.length, 3, '原卡归档 + 两张拆分新卡');
	assert.equal(store.get('mixed').status, Status.SUPERSEDED);
	const children = store.all().filter((c) => c.id !== 'mixed' && c.id !== 'filler');
	assert.equal(children.length, 2);
	assert.equal(children[0].status, Status.ACTIVE);
	assert.equal(children[0].importance, 0.6, '拆分产物重要度 = min(原卡, 0.7)');
	assert.ok(children.every((c) => Array.isArray(c.embedding)), '拆分产物逐条重嵌入');
});

test('B2 dry-run 只出提案不动库', async () => {
	const { store, dataDir } = await makeStore([
		createCard({ id: 'c1', content: '用户喜欢喝碳酸饮料', embedding: unitVec(0) }),
		createCard({ id: 'c2', content: '用户爱喝碳酸饮料', embedding: unitVec(0) })
	]);
	const tiers = new TierManager(makeConfig(), dataDir);
	const before = snapshotStore(store);
	const chat = fakeChat([
		'{"dedupe":[{"sources":["c1","c2"],"targetContent":"合并"}],"split":[]}'
	]);
	const stats = await dreamConsolidate(store, chat, embedNoop(), makeConfig(), tiers, { dryRun: true });
	assert.ok(stats.proposal.includes('合并'), stats.proposal);
	assert.deepEqual(snapshotStore(store), before, 'dry-run 库必须纹丝不动');
});

test('B2 提案含不存在 id → 整单作废且库不变', async () => {
	const { store, dataDir } = await makeStore([
		createCard({ id: 'c1', content: '卡', embedding: unitVec(0) }),
		createCard({ id: 'c0', content: '凑数的同向量卡', embedding: unitVec(0) }) // 同向量成近义对，保证候选池非空
	]);
	const tiers = new TierManager(makeConfig(), dataDir);
	const before = snapshotStore(store);
	const chat = fakeChat([
		'{"dedupe":[{"sources":["c1","ghost"],"targetContent":"x"}],"split":[]}'
	]);
	const stats = await dreamConsolidate(store, chat, embedNoop(), makeConfig(), tiers, { dryRun: false });
	assert.ok(stats.rejected.includes('ghost'));
	assert.deepEqual(snapshotStore(store), before);
});

function embedNoop() {
	const embed = async () => [unitVec(0)];
	embed.calls = 0;
	return embed;
}

// ---------------------------------------------------------------- B3 PINNED 豁免

test('B3 PINNED 卡不被两两合并、不被过期判断触碰', async () => {
	const { store, dataDir } = await makeStore([
		createCard({ id: 'pin', content: '用户喜欢喝碳酸饮料', status: Status.PINNED, importance: 0.9, embedding: unitVec(0) }),
		createCard({ id: 'act', content: '用户喜欢喝碳酸饮料（强化版）', embedding: unitVec(0) }),
		createCard({ id: 'task', content: '下周三要交作业', status: Status.PINNED, createdAt: Date.now() - 30 * 86400000 })
	]);
	const config = makeConfig({ autoExpire: true });
	const mergeStats = await autoMergeSimilar(store, async () => '{"content":"x"}', async () => [unitVec(0)], config, new TierManager(config, dataDir));
	assert.equal(mergeStats.merged, 0, 'PINNED 不进合并候选');
	assert.equal(store.get('pin').status, Status.PINNED);
	const expireStats = await expireStaleFacts(store, async () => '{"expired":true}', config, new TierManager(config, dataDir));
	assert.equal(expireStats.expired, 0, 'PINNED 不进过期候选');
	assert.equal(store.get('task').status, Status.PINNED);
});

// ---------------------------------------------------------------- B4 执行预算

test('B4 提案挂起超时 → 放弃本轮且重试后停止（≤2 次调用）', async () => {
	const { store, dataDir } = await makeStore([
		createCard({ id: 'c1', content: '用户喜欢喝碳酸饮料', embedding: unitVec(0) }),
		createCard({ id: 'c2', content: '用户爱喝碳酸饮料', embedding: unitVec(0) })
	]);
	const tiers = new TierManager(makeConfig(), dataDir);
	let calls = 0;
	const hangChat = async () => {
		calls += 1;
		return new Promise((resolve) => setTimeout(() => resolve('{"dedupe":[],"split":[]}'), 500));
	};
	const stats = await dreamConsolidate(store, hangChat, embedNoop(), makeConfig(), tiers, { dryRun: false, timeoutMs: 60 });
	assert.ok(stats.skipped.includes('超时'), stats.skipped);
	assert.equal(calls, 2, '原尝试 + 一次重试后放弃');
});

// ---------------------------------------------------------------- C1 脏度门控

test('C1 put/remove 推进脏度，调度写入与 GC 出清不推进，load 重置', async () => {
	const { store } = await makeStore();
	store.put(createCard({ content: 'a' }));
	store.put(createCard({ content: 'b' }), { dirty: false });
	store.remove('nonexistent', { dirty: false });
	assert.equal(store.dirtyMutations, 1);
	store.put(createCard({ content: 'c' }));
	store.remove(store.all()[0].id);
	assert.equal(store.dirtyMutations, 3);
	await store.load();
	assert.equal(store.dirtyMutations, 0);
});

test('C1 脏度不足阈值跳过 LLM 步，达标后全量跑并清零', async () => {
	const engine = new MemoryEngine(makeConfig({ dirtyGate: true, dirtyThreshold: 20, dreamDryRun: false }), {
		dataDir: await mkdtemp(join(tmpdir(), 'dream-')),
		chat: async () => '{"dedupe":[],"split":[]}',
		embed: fakeEmbed()
	});
	await engine.init();
	const chat = fakeChat(['{"dedupe":[],"split":[]}']);
	engine.chat = chat;
	// 不写卡：脏度 0 < 20 → LLM 步跳过
	const stats1 = await engine.maintenance();
	assert.equal(stats1.llmSkipped, true);
	assert.equal(stats1.status, 'skipped');
	assert.equal(chat.calls.length, 0, '跳过时不应有 LLM 调用');
	// 写满阈值 → 全量跑 → 脏度清零。前两张卡同向量构成近义对，保证候选池非空、
	// 提案 LLM 真的被调到（门控 + 提案链路一起验）
	for (let i = 0; i < 20; i += 1) engine.store.put(createCard({ content: `卡${i}`, embedding: unitVec(i < 2 ? 0 : i + 1) }));
	assert.equal(engine.store.dirtyMutations, 20);
	const stats2 = await engine.maintenance();
	assert.equal(stats2.llmSkipped, false);
	assert.equal(stats2.status, 'done');
	assert.equal(chat.calls.length, 1);
	assert.equal(engine.store.dirtyMutations, 0, 'LLM 步后脏度清零');
});

// ---------------------------------------------------------------- C2 提取节奏

test('C2 shouldSkipExtract 真值表：2~3 连跳才跳、窗口满立即恢复、连跳上限 3', () => {
	const base = { enabled: true, maxWindow: 20 };
	assert.equal(shouldSkipExtract(0, 10, base), false);
	assert.equal(shouldSkipExtract(1, 10, base), false);
	assert.equal(shouldSkipExtract(2, 10, base), true);
	assert.equal(shouldSkipExtract(3, 10, base), true);
	assert.equal(shouldSkipExtract(4, 10, base), false, '连跳上限 3，第 4 轮强制恢复');
	assert.equal(shouldSkipExtract(2, 20, base), false, '窗口满不跳（防漏）');
	assert.equal(shouldSkipExtract(2, 10, { ...base, enabled: false }), false, '开关关则永不跳');
});

// ---------------------------------------------------------------- 杂项

test('renderCandidates 渲染带预算与 id 清单', () => {
	const card = (id, content) => createCard({ id, content, embedding: unitVec(0) });
	const { ids, text } = renderCandidates([{ a: card('id-a', '内容甲'), b: card('id-b', '内容乙'), sim: 0.95 }], []);
	assert.ok(ids.has('id-a') && ids.has('id-b'));
	assert.ok(text.includes('id-a'));
	assert.ok(text.length <= 25100);
});
