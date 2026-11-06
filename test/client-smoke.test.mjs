/**
 * client.js 冒烟 —— 不需要真 React：createElement 记对象树，useState 可写回，
 * 断言栏目注册、组件渲染出的关键 UI 结构与 local/dsh 两档分支。
 *
 * 跑法：node --test test/client-smoke.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 React 桩：createElement 产出纯对象树；useState 可写回（供异步加载后重渲染）。 */
function makeReactStub() {
	const hooks = [];
	const stub = {
		createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
		useState: (initial) => {
			const slot = hooks[stub._cursor] ?? (hooks[stub._cursor] = { value: initial });
			stub._cursor += 1;
			return [slot.value, (next) => {
				slot.value = typeof next === 'function' ? next(slot.value) : next;
			}];
		},
		useEffect: (fn) => {
			fn();
			return () => {};
		},
		_cursor: 0,
		/** 每次组件渲染前调用：hook 槽位按索引对齐。 */
		beginRender: () => { stub._cursor = 0; }
	};
	return stub;
}

/**
 * 载入 client.js（window.__ModuleLoader__.load 信封）。
 * @returns {Promise<{client: {apply, inject}, React: object}>}
 */
async function loadClient() {
	const source = await readFile(join(pluginDir, 'client.js'), 'utf8');
	const React = makeReactStub();
	const require = (name) => {
		if (name === 'react') return React;
		throw new Error(`unexpected require: ${name}`);
	};
	let moduleExports;
	const run = () => {
		globalThis.window = { __ModuleLoader__: { load: (def) => {
			moduleExports = def.factory(require);
		} } };
		new Function(source)(); // eslint-disable-line no-new-func
	};
	run();
	assert.ok(moduleExports && typeof moduleExports.apply === 'function', 'factory 应挂出 apply');
	return { client: moduleExports, React };
}

function makeFakeCtx(view) {
	return {
		remote: {
			settings: {
				describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'dsh-memory', value: view, revision: 7 }] } }),
				mutate: async () => ({ ok: true, value: { value: view, revision: 8 } })
			},
			llm: {
				listProviders: async () => ({ ok: true, value: [{ id: 'zai-coding-cn', name: '智谱' }] }),
				listConfigurableProviders: async () => ({ ok: true, value: [
					{ provider: 'zai-coding-cn', displayName: '智谱', settingsNs: 'llm.zai' },
					{ provider: 'qwen-token-plan-cn', displayName: 'Qwen', settingsNs: 'llm.qwen' }
				] }),
				discoverModels: async () => ({ ok: true, value: [
					{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
					{ id: 'glm-5.3', name: 'GLM-5.3' }
				] })
			},
			$on: () => () => {}
		}
	};
}

/** 注册栏目并返回渲染组件。 */
function registerSection(client, ctx) {
	let registered = null;
	ctx.slots = {
		inject: (slot, factory) => { factory(); },
		register: (meta, component) => { registered = { ...meta, component }; return registered; }
	};
	client.apply(ctx);
	assert.ok(registered, 'slots.register 应被调用');
	return registered;
}

/** 渲染三轮（每轮间等一拍：view→providers→models 逐层异步落地），返回最后一轮的树。 */
async function renderSettled(component, React) {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
	React.beginRender();
	component(); // 第一轮：describe 发起
	await tick();
	React.beginRender();
	component(); // 第二轮：view 就绪，providers 发起 / loadModels 发起
	await tick();
	React.beginRender();
	return component(); // 第三轮：models 就绪
}

/** 收集树里所有文本节点。 */
function texts(node, out = []) {
	if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
	if (node && typeof node === 'object') {
		if (node.props && typeof node.props.children !== 'undefined') texts(node.props.children, out);
	}
	if (typeof node === 'string') out.push(node);
	return out;
}

/** 找类型为 type 的第一个节点。 */
function findByType(node, type) {
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findByType(child, type);
			if (hit) return hit;
		}
		return null;
	}
	if (node && typeof node === 'object') {
		if (node.type === type) return node;
		return findByType(node.props?.children, type);
	}
	return null;
}
test('client.js：栏目注册（settings.section，label=记忆）且 inject 集与 image-relay 对齐', async () => {
	const { client } = await loadClient();
	assert.deepEqual(client.inject, ['slots', 'remote', 'remote.settings', 'remote.llm']);
	const registered = registerSection(client, makeFakeCtx({}));
	assert.equal(registered.name, 'settings.section');
	assert.equal(registered.id, 'dsh-memory');
	assert.equal(registered.label, '记忆');
	assert.equal(registered.order, 9);
	assert.equal(typeof registered.component, 'function');
});

test('client.js：默认渲染（模型列表标题、请求按钮、空列表只有当前项）', async () => {
	const { client, React } = await loadClient();
	const registered = registerSection(client, makeFakeCtx({
		chatRoute: 'local', chatModel: 'qwen3:4b', exportDir: 'C:\\x\\memory-export'
	}));
	const tree = await renderSettled(registered.component, React);
	const all = texts(tree).join('\n');
	assert.match(all, /模型列表/);
	assert.doesNotMatch(all, /写入模型（统一目录）/, '标题已改（v0.4.3）');
	assert.match(all, /请求可用模型/);
	assert.match(all, /勾选/);
	assert.match(all, /手动指定/);
	assert.match(all, /记忆导出/);
	assert.match(all, /当前生效值/);
	assert.match(all, /OpenAI 兼容端点/);
	assert.match(all, /ollama \/ qwen3:4b/); // 生效值行
	const select = findByType(tree, 'select');
	assert.ok(select, '模型列表下拉应存在');
	// 空精选列表：只有「当前」占位 option，无来源 optgroup
	const groups = (select.props.children || []).filter((n) => n && n.type === 'optgroup');
	assert.equal(groups.length, 0, '空精选列表不应有来源分组');
	const currentOption = (select.props.children || []).filter((n) => n && String(n.props.value) === '');
	assert.ok(currentOption.length >= 1, '应有「当前」占位项');
});

test('client.js：精选列表渲染（modelList 分组选项 + 云端当前值）', async () => {
	const { client, React } = await loadClient();
	const registered = registerSection(client, makeFakeCtx({
		chatRoute: 'dsh', dshProvider: 'zai-coding-cn', dshModel: 'glm-5.3-flash',
		modelList: JSON.stringify([
			{ source: 'dsh:zai-coding-cn', model: 'glm-5.3-flash', label: 'GLM-5.3-Flash' },
			{ source: 'dsh:zai-coding-cn', model: 'glm-5.3', label: 'GLM-5.3' },
			{ source: 'ollama', model: 'qwen3:4b', label: 'qwen3:4b' }
		])
	}));
	const tree = await renderSettled(registered.component, React);
	const select = findByType(tree, 'select');
	assert.ok(select, '应有模型列表下拉');
	const groups = (select.props.children || []).filter((n) => n && n.type === 'optgroup');
	const labels = groups.map((g) => String(g.props.label));
	assert.ok(labels.includes('ollama'), '精选列表应有 ollama 分组');
	assert.ok(labels.includes('zai-coding-cn'), '精选列表应有云端分组');
	const cloudGroup = groups.find((g) => String(g.props.label) === 'zai-coding-cn');
	const modelIds = (cloudGroup.props.children || []).map((o) => o.props.value);
	assert.ok(modelIds.includes('dsh:zai-coding-cn\u0001glm-5.3-flash'), '选项编码为 source+model');
	assert.match(texts(tree).join(''), /云端 zai-coding-cn \/ glm-5\.3-flash/);
});

// ----------------------------------------------------------------------
// v0.4.3 精选模型列表纯函数
// ----------------------------------------------------------------------
test('parseModelList：合法/坏输入/缺字段过滤', async () => {
	const { client } = await loadClient();
	assert.deepEqual(client.parseModelList('[{"source":"ollama","model":"qwen3:4b"}]'),
		[{ source: 'ollama', model: 'qwen3:4b' }]);
	assert.deepEqual(client.parseModelList(''), []);
	assert.deepEqual(client.parseModelList('not json'), []);
	assert.deepEqual(client.parseModelList('[{"source":"","model":"x"},{"source":"ollama"},{"model":"y"}]'), []);
});

test('sourceOf/sourceLabel：三种来源标签往返', async () => {
	const { client } = await loadClient();
	assert.equal(client.sourceOf('ollama', 'ollama'), 'ollama');
	assert.equal(client.sourceOf('runtime', 'llama.cpp'), 'runtime:llama.cpp');
	assert.equal(client.sourceOf('cloud', 'zai-coding-cn'), 'dsh:zai-coding-cn');
	assert.equal(client.sourceLabel('ollama'), 'ollama');
	assert.equal(client.sourceLabel('runtime:llama.cpp'), 'llama.cpp');
	assert.equal(client.sourceLabel('dsh:zai-coding-cn'), 'zai-coding-cn');
});

test('opsForSource：三档落库（ollama/runtime/cloud 字段写齐）', async () => {
	const { client } = await loadClient();
	const runtimes = [{ id: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080' }];
	assert.deepEqual(client.opsForSource('ollama', 'qwen3:4b', runtimes), [
		{ op: 'set', path: ['chatRoute'], value: 'local' },
		{ op: 'set', path: ['chatModel'], value: 'qwen3:4b' }
	]);
	assert.deepEqual(client.opsForSource('runtime:llama.cpp', 'qwen3.6-35b-a3b', runtimes), [
		{ op: 'set', path: ['chatRoute'], value: 'openai' },
		{ op: 'set', path: ['openaiBaseUrl'], value: 'http://127.0.0.1:8080' },
		{ op: 'set', path: ['chatModel'], value: 'qwen3.6-35b-a3b' }
	]);
	assert.deepEqual(client.opsForSource('dsh:zai-coding-cn', 'glm-5.3-flash', runtimes), [
		{ op: 'set', path: ['chatRoute'], value: 'dsh' },
		{ op: 'set', path: ['dshProvider'], value: 'zai-coding-cn' },
		{ op: 'set', path: ['dshModel'], value: 'glm-5.3-flash' }
	]);
});

test('toggleList：加入/移除幂等、重复项去重', async () => {
	const { client } = await loadClient();
	let list = client.toggleList([], { source: 'ollama', model: 'qwen3:4b' }, true);
	assert.deepEqual(list, [{ source: 'ollama', model: 'qwen3:4b', label: 'qwen3:4b' }]);
	// 幂等：重复勾选不重复加入
	list = client.toggleList(list, { source: 'ollama', model: 'qwen3:4b' }, true);
	assert.equal(list.length, 1);
	// 取消勾选移除
	list = client.toggleList(list, { source: 'ollama', model: 'qwen3:4b' }, false);
	assert.deepEqual(list, []);
	// 不同来源同模型名共存
	list = client.toggleList([{ source: 'ollama', model: 'x' }], { source: 'dsh:a', model: 'x' }, true);
	assert.equal(list.length, 2);
});

test('buildChoices：按来源聚合、保持配置顺序', async () => {
	const { client } = await loadClient();
	const groups = client.buildChoices([
		{ source: 'dsh:zai-coding-cn', model: 'glm-5.3-flash' },
		{ source: 'ollama', model: 'qwen3:4b' },
		{ source: 'dsh:zai-coding-cn', model: 'glm-5.3' }
	]);
	assert.deepEqual(groups.map((g) => g.source), ['dsh:zai-coding-cn', 'ollama']);
	assert.equal(groups[0].entries.length, 2);
	assert.equal(groups[0].label, 'zai-coding-cn');
	assert.equal(groups[1].label, 'ollama');
});

test('buildCatalog：勾选面板三源合并有序、不可达标注、云端空目录标注', async () => {
	const { client } = await loadClient();
	const groups = client.buildCatalog({
		ollama: { ok: false, models: [] },
		runtimes: [
			{ id: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080', ok: true, models: ['qwen3.6-35b-a3b'] }
		],
		cloud: [
			{ provider: 'zai-coding-cn', name: '智谱', models: [{ id: 'glm-5.3-flash' }] },
			{ provider: 'qwen-token-plan-cn', name: 'Qwen', models: [] }
		]
	});
	assert.deepEqual(groups.map((g) => g.kind), ['ollama', 'runtime', 'cloud', 'cloud']);
	assert.match(groups[0].note, /不可达/);
	assert.equal(groups[1].models[0].id, 'qwen3.6-35b-a3b');
	assert.equal(groups[2].label, '智谱');
	assert.match(groups[3].note, /无可用模型/);
});
