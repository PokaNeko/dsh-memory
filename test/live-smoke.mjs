/**
 * 真模型端到端冒烟 —— 连本地 ollama 跑完整 TS 管线（local 后端）。
 *
 * 跑法：
 *   node test/live-smoke.mjs
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../lib/engine.js';
import { makeChatFn, makeEmbedFn, probeOllama } from '../lib/llm.js';

const BASE_URL = 'http://127.0.0.1:11434/v1';

function step(n, title) {
	console.log(`\n[${n}] ${title} ${'.'.repeat(40)}`);
}

const probe = await probeOllama(BASE_URL);
if (!probe.ok) {
	console.error(`ollama 不可达：${probe.error}`);
	process.exit(1);
}
console.log('ollama 模型：', probe.models.join(', '));

const chat = makeChatFn({ baseUrl: BASE_URL, chatModel: 'qwen3:4b', timeoutMs: 240000 });
const embed = makeEmbedFn({ baseUrl: BASE_URL, embedModel: 'bge-m3', timeoutMs: 120000 });

step(1, 'embedding');
const vecs = await embed(['周三数学考试', '今天天气不错']);
console.log(`2 条文本 → ${vecs.length} 个向量，维度 ${vecs[0].length}`);

const dataDir = await mkdtemp(join(tmpdir(), 'dshmem-live-'));
const config = {
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
	wFreshness: 0.2
};
const engine = new MemoryEngine(config, { dataDir, chat, embed });
await engine.init();

step(2, '写入管线（提取 + 决策，两次 LLM 调用）');
const report = await engine.remember([
	{ role: 'user', content: '下周三数学考试，范围是二次函数，帮我安排复习计划' },
	{ role: 'assistant', content: '好，周一刷错题卷，周二过公式，周三早上快速复盘。' }
]);
console.log(
	`提取 ${report.factsExtracted} 条 → ADD ${report.added.length} UPDATE ${report.updated.length} DELETE ${report.deleted.length} 跳过 ${report.skipped}`
);
for (const id of report.added) {
	const card = engine.store.get(id);
	if (card) console.log(`  + [${card.category}/${card.importance.toFixed(2)}] ${card.content}`);
}

step(3, '矛盾更新（改考数列）');
const report2 = await engine.remember([
	{ role: 'user', content: '数学考试改到周五了，不考二次函数了，改考数列' }
]);
console.log(
	`ADD ${report2.added.length} UPDATE ${report2.updated.length} DELETE ${report2.deleted.length} 跳过 ${report2.skipped}`
);

step(4, '检索');
for (const query of ['数学考试考什么范围', '帮我安排复习']) {
	const hits = await engine.recall(query, 2);
	console.log(`查询「${query}」：`);
	if (!hits.length) console.log('  （无命中）');
	for (const hit of hits) {
		console.log(
			`  [${hit.score.toFixed(2)}] 相关${hit.relevance.toFixed(2)} 重要${hit.card.importance.toFixed(2)} ${hit.card.content}`
		);
	}
}

step(5, '维护 + 热块');
console.log(' ', JSON.stringify(await engine.maintenance()));
console.log(engine.hotBlock());
console.log('\n', JSON.stringify(engine.status()));
await engine.dispose();
console.log('\nLIVE SMOKE OK');
