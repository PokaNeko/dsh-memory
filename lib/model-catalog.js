/**
 * 模型目录聚合（v0.4.4）—— host 侧统一拉三路模型清单，客户端只消费。
 *
 * 背景（2026-10-29 实测）：浏览器直连 ollama /api/tags 的 CORS 本身是通的
 * （Access-Control-Allow-Origin 正常回显），但实际页面 fetch 失败（原因未定位，
 * 疑为渲染进程网络策略）。官方模型选择器也从不直连端口：它由 host 侧
 * `listProviders() → listModels(provider)` 构建目录。本模块复刻该模式：
 *
 *   - ollama：Node fetch /api/tags（无 CORS 概念）
 *   - 本地 OpenAI 兼容运行时（llama.cpp 等）：Node fetch /v1/models
 *   - 云端：ctx.llm.listProviders() + listModels(provider)——listModels 是官方
 *     模型选择器的数据源，能拉出内置 DeepSeek 账号等无 discoverModels 的 provider；
 *     模型列表为空的 provider（未登录/无凭据）直接不输出 = 「未激活隐藏」。
 *
 * @module dsh-memory/lib/model-catalog
 */

/** 剥掉 URL 结尾的 /v1 与斜杠。 */
export function stripV1(url) {
	return String(url || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** 宽松解析 localRuntimes 配置（JSON 字符串 → 数组）。 */
export function parseRuntimeList(raw) {
	try {
		const list = JSON.parse(String(raw == null || raw === '' ? '[]' : raw));
		if (!Array.isArray(list)) return [];
		return list
			.filter(
				(item) => item && typeof item.id === 'string' && item.id && typeof item.baseUrl === 'string' && item.baseUrl
			)
			.map((item) => ({
				id: item.id,
				baseUrl: item.baseUrl,
				apiKey: typeof item.apiKey === 'string' ? item.apiKey : ''
			}));
	} catch {
		return [];
	}
}

/**
 * 聚合三路模型目录。
 * @param {object} deps
 * @param {string} deps.ollamaBaseUrl - ollama 端点（可带 /v1）
 * @param {Array<{id: string, baseUrl: string}>} deps.runtimes - 本地兼容运行时
 * @param {object} [deps.llm] - host llm 服务（listProviders/listModels）
 * @param {Function} [deps.fetchImpl] - 注入 fetch（测试用），默认全局 fetch
 * @param {number} [deps.timeoutMs] - 单请求超时
 * @returns {Promise<{ollama: {ok: boolean, models: string[]}, runtimes: Array, cloud: Array}>}
 */
export async function collectModelCatalog({
	ollamaBaseUrl,
	runtimes = [],
	llm = null,
	fetchImpl = typeof fetch === 'function' ? fetch : null,
	timeoutMs = 5000
}) {
	const timeout = () => AbortSignal.timeout(timeoutMs);
	const ollama = await probeOllamaModels(ollamaBaseUrl, fetchImpl, timeout);
	const runtimeResults = await Promise.all(
		runtimes.map(async (rt) => {
			try {
				const headers = rt.apiKey ? { Authorization: `Bearer ${rt.apiKey}` } : undefined;
				const res = await fetchImpl(stripV1(rt.baseUrl) + '/v1/models', { signal: timeout(), headers });
				const data = await res.json();
				return {
					id: rt.id,
					baseUrl: rt.baseUrl,
					ok: true,
					models: (data?.data ?? []).map((m) => m?.id).filter(Boolean)
				};
			} catch {
				return { id: rt.id, baseUrl: rt.baseUrl, ok: false, models: [] };
			}
		})
	);
	const cloud = await collectCloudProviders(llm);
	return { ollama, runtimes: runtimeResults, cloud };
}

async function probeOllamaModels(baseUrl, fetchImpl, timeout) {
	try {
		const res = await fetchImpl(stripV1(baseUrl) + '/api/tags', { signal: timeout() });
		const data = await res.json();
		const models = (data?.models ?? []).map((m) => m?.name || m?.model).filter(Boolean);
		return { ok: true, models };
	} catch {
		return { ok: false, models: [] };
	}
}

/** 云端目录：listModels 逐个 provider；空列表（未登录/无凭据）不输出。 */
async function collectCloudProviders(llm) {
	if (!llm || typeof llm.listModels !== 'function' || typeof llm.listProviders !== 'function') return [];
	const providers = llm.listProviders() ?? [];
	const rows = await Promise.all(
		providers.map(async (provider) => {
			try {
				const models = await llm.listModels(provider.id);
				if (!Array.isArray(models) || models.length === 0) return null;
				return {
					provider: provider.id,
					name: provider.name || provider.id,
					models: models.map((m) => ({ id: m.id, name: m.name || m.id }))
				};
			} catch {
				return null; // 单 provider 失败不阻塞整体
			}
		})
	);
	return rows.filter(Boolean);
}
