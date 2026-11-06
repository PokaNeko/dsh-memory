/**
 * apply 桩测试的模块解析垫片 —— 把宿主包换成 stubs/ 下的本地桩。
 *
 * 为什么需要：`index.js` 顶层的 `z.string().default(...).volatile()` 依赖
 * 插件加载器给 schemastery 加的扩展，直接用 profiles/node_modules 里的真包会
 * 报 `volatile is not a function`。桩化之后，这个测试不装 dsh 也能跑（只需要
 * 同级的 dsh-api-stable）。
 */
const STUBS = new URL('./stubs/', import.meta.url);

const MAP = {
	'@deepseek-ai/schemastery': new URL('schemastery.js', STUBS).href,
	'@deepseek-ai/dsh-llm/message': new URL('dsh-llm-message.js', STUBS).href
};

export async function resolve(specifier, context, nextResolve) {
	const hit = MAP[specifier];
	if (hit) return { url: hit, shortCircuit: true };
	return nextResolve(specifier, context);
}