/**
 * apply() 桩测试 —— 用假 ctx 验证插件入口的 import 链与注册逻辑。
 * 宿主里的 cordis 语义无法完全复现，但能抓同步异常、import 错误、注册失败。
 *
 * 跑法：node test/apply-stub/run.mjs
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';

// 先把宿主包换成本地桩（见 stub-loader.mjs），再动态 import 插件入口：
// 不装 dsh 也能跑这份 apply 链路测试。
register(new URL('./stub-loader.mjs', import.meta.url));

const events = new Map();
const commands = [];
const contextContributions = [];
const injected = [];

const ctx = {
	logger: console,
	on(event, handler, options) {
		events.set(event, { handler, options });
		return () => {};
	},
	get(name) {
		if (name === 'systemPrompt') {
			return {
				context(contribution) {
					contextContributions.push(contribution);
					return () => {};
				}
			};
		}
		return undefined;
	},
	effect(genFactory) {
		const gen = genFactory();
		const disposers = [];
		let step = gen.next();
		while (!step.done) {
			disposers.push(step.value);
			step = gen.next();
		}
		return () => {
			for (const dispose of disposers.reverse()) {
				try {
					dispose?.();
				} catch {
					/* ignore */
				}
			}
		};
	},
	/**
	 * cordis 的 inject()：等服务就绪后回调。桩里没有 webServer 这类服务，
	 * 只记录一个 disposer，不触发回调（真实宿主里由 III 层服务提供）。
	 */
	inject(names, callback) {
		injected.push({ names, callback });
		return () => {};
	},
	commands: {
		register(definition) {
			commands.push(definition);
			return () => {};
		}
	}
};

// 桩配置：普通对象（readConfigValue 支持普通值）
const config = {
	backend: 'local',
	ollamaBaseUrl: 'http://127.0.0.1:11434/v1',
	chatModel: 'qwen3:4b',
	embedModel: 'bge-m3',
	dataDir: './stub-data',   // 桩测试用独立目录，别污染真实记忆库
	pythonUrl: 'http://127.0.0.1:8765',
	pythonExe: 'python',
	pythonScript: '',
	pythonAutoStart: false,
	autoRecall: true,
	recallTopK: 3,
	recallMinRelevance: 0.35,
	autoRemember: true,
	maintenanceMinutes: 60,
	hotBudgetChars: 2000,
	hotMaxCards: 15,
	halfLifeDays: 7,
	commitmentHalfLifeDays: 90,
	promoteScore: 0.55,
	demoteScore: 0.12,
	reinforceDelta: 0.05,
	pinnedImportance: 0.8,
	debug: true
};

const mod = await import('../../index.js');
assert.equal(mod.name, 'dsh-memory');
assert.ok(Array.isArray(mod.inject));
assert.ok(mod.Config);

mod.apply(ctx, config);
await new Promise((resolve) => setTimeout(resolve, 1500)); // 等初始化 IIFE

console.log('已注册事件 handler:', [...events.keys()].join(', '));
console.log('已注册命令:', commands.map((c) => `/${c.name}`).join(', '));
console.log('systemPrompt.context 贡献:', contextContributions.length);

assert.ok(events.has('agent/pre-step'), 'pre-step 未注册');
assert.ok(!events.has('session/event'), 'session/event 不应再注册（session-scoped，根 scope 收不到）');
assert.ok(events.has('agent/turn-stopping'), 'turn-stopping 未注册');
assert.ok(commands.some((c) => c.name === 'memory'), '/memory 命令未注册');
assert.equal(contextContributions.length, 1, 'hot 块 context 未注册');
assert.equal(contextContributions[0].name, 'dsh-memory:hot');
assert.ok(typeof contextContributions[0].text === 'function');

// ---- 行为冒烟：turn-stopping 从 session.deriveMessages() 取对话 → 真 ollama 写入 ----
const preStep = events.get('agent/pre-step').handler;
const onTurnStopping = events.get('agent/turn-stopping').handler;

/** 假 agent：session.deriveMessages() 返回本轮对话（模拟宿主 Session 类）。 */
const fakeAgent = {
	id: 'session-test',
	session: {
		deriveMessages: () => [
			{ role: 'user', content: [{ type: 'text', text: '帮我记住周三数学考试' }], source: { kind: 'user' } },
			{ role: 'assistant', content: [{ type: 'text', text: '好的，记下了' }], source: { kind: 'model' } }
		]
	}
};

// pre-step：召回（空库 → 返回原决策，不炸）
const decision = await preStep(
	{ agent: fakeAgent, turn: 1, step: 0, signal: new AbortController().signal },
	async () => ({ kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: '数学考试' }], source: { kind: 'user' } }] })
);
assert.equal(decision.kind, 'continue');

// turn-stopping：fire-and-forget，不 await
const stopped = onTurnStopping({ agent: fakeAgent, turn: 1, signal: new AbortController().signal });
assert.equal(stopped, undefined, 'turn-stopping 不应返回 Promise（会阻塞轮次关闭）');
await new Promise((resolve) => setTimeout(resolve, 8000)); // 等异步写入（真 ollama，两次调用）

console.log('APPLY STUB OK');
