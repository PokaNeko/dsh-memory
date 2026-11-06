/**
 * schemastery 桩 —— 链式 API 一律返回自身，供 apply 桩测试用。
 *
 * 宿主真实的 @deepseek-ai/schemastery 没有 `.volatile()`（那是插件加载器加的
 * 一层扩展），所以 apply 链路测试必须走这里的桩，而不是 profiles/node_modules
 * 下的真包。
 */
const chain = () => {
	const api = {};
	for (const method of ['default', 'volatile', 'description', 'step', 'min', 'max', 'required']) {
		api[method] = () => api;
	}
	return api;
};

const z = {};
for (const method of ['string', 'number', 'boolean', 'object', 'union', 'const', 'array']) {
	z[method] = () => chain();
}
export default z;