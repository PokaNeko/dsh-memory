/**
 * Ollama 客户端 —— OpenAI 兼容端点，Node 原生 fetch。
 *
 * 换 LM Studio / vLLM / 任何 OpenAI 兼容后端：只改 baseUrl。
 * Node 的 fetch 不读系统代理环境变量，本机调用天然绕开 TUN/Clash 劫持。
 *
 * @module dsh-memory/lib/llm
 */

import { clamp01 } from './models.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';

const THINK_RE = /<think>[\s\S]*?<\/think>/g;
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;

/** 剥掉 Qwen3 的思考块（qwen3:4b 默认思考模式）。 */
export function stripThink(text) {
	return String(text ?? '').replace(THINK_RE, '').trim();
}

/**
 * 从容错地抠 JSON —— 4B 模型偶尔包 markdown 围栏或说废话。
 * 顺序：剥 think → 剥围栏 → 整体 parse → 抠第一个 { 到最后一个 }。
 */
export function extractJson(text) {
	let body = stripThink(text);
	const fenced = FENCE_RE.exec(body);
	if (fenced) body = fenced[1].trim();
	try {
		return JSON.parse(body);
	} catch {
		/* fall through */
	}
	const start = body.indexOf('{');
	const end = body.lastIndexOf('}');
	if (start !== -1 && end > start) {
		return JSON.parse(body.slice(start, end + 1));
	}
	throw new Error(`LLM 输出里找不到 JSON：\n${body.slice(0, 400)}`);
}

/**
 * 创建 chat 函数：messages = [{role, content}, ...] → 文本。
 *
 * 配置了 numCtx（ollama 场景）时走原生 /api/chat：每请求显式带 options.num_ctx——
 * 托盘自启的 ollama 吃不到 serve 启动时的 OLLAMA_CONTEXT_LENGTH，且它的 OpenAI
 * 兼容端点会静默忽略 options 参数（实测 ctx 仍 4096），只有原生端点生效。
 * 未配 numCtx（LM Studio / vLLM 等）回落 OpenAI 兼容端点，只改 baseUrl 即可换。
 *
 * @param {object} cfg - { baseUrl, chatModel, apiKey?, numCtx?, chatKeepAlive?, timeoutMs? }
 */
export function makeChatFn(cfg) {
	return async function chat(messages, { jsonMode = false, signal } = {}) {
		if (cfg.numCtx) {
			const root = trimSlash(cfg.baseUrl).replace(/\/v1$/, '');
			const body = {
				model: cfg.chatModel,
				messages,
				stream: false,
				options: { temperature: 0.2, num_ctx: cfg.numCtx }
			};
			if (jsonMode) body.format = 'json'; // 原生端点用 format，语法级强制合法 JSON
			if (cfg.chatKeepAlive) body.keep_alive = cfg.chatKeepAlive; // 用完即卸显存，不受 serve 驻留政策摆布
			const data = await postJson(`${root}/api/chat`, body, cfg, signal);
			// 思考内容在新版 ollama 分离到 message.thinking；旧版可能混进 content，stripThink 双保险
			return stripThink(data?.message?.content ?? '');
		}
		const body = {
			model: cfg.chatModel,
			messages,
			temperature: 0.2,
			stream: false
		};
		if (jsonMode) body.response_format = { type: 'json_object' };
		const data = await postJson(
			`${trimSlash(cfg.baseUrl)}/chat/completions`,
			body,
			cfg,
			signal
		);
		return stripThink(data?.choices?.[0]?.message?.content ?? '');
	};
}

/**
 * 创建 embed 函数：texts: string[] → number[][]（按输入顺序）。
 * 配置 numCtx（ollama 场景）时走原生 /api/embed：keep_alive 自己说了算
 * （bge 才 0.6G，保几分钟热省得每次召回都付加载延迟）。
 * @param {object} cfg - { baseUrl, embedModel, apiKey?, numCtx?, embedKeepAlive?, timeoutMs? }
 */
export function makeEmbedFn(cfg) {
	return async function embed(texts, { signal } = {}) {
		if (!Array.isArray(texts) || texts.length === 0) return [];
		if (cfg.numCtx) {
			const root = trimSlash(cfg.baseUrl).replace(/\/v1$/, '');
			const data = await postJson(
				`${root}/api/embed`,
				{ model: cfg.embedModel, input: texts, keep_alive: cfg.embedKeepAlive ?? '5m' },
				cfg,
				signal
			);
			return [...(data.embeddings ?? [])].map((vec) => vec.map(Number));
		}
		const data = await postJson(
			`${trimSlash(cfg.baseUrl)}/embeddings`,
			{ model: cfg.embedModel, input: texts },
			cfg,
			signal
		);
		const items = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
		return items.map((item) => item.embedding.map(Number));
	};
}

/**
 * 创建走 DSH 提供商路由的 chat 函数（v0.4 云端大脑）。
 *
 * 借用「设置 → 模型」里配好的路由（dshProvider + dshModel，如 zai-coding-cn /
 * glm-5.3-flash）：key、计费、重试全归宿主的 LLM 服务管，插件零 key 配置。
 * 消费姿势抄 image-relay（已验证的生产用法）：ctx.llm.stream + text-delta 累积。
 *
 * jsonMode 在此路由不生效：GenerateOptions 无 response_format 入口，云端
 * flash 级模型对 JSON 指令服从性好，extractJson 本身就有围栏/废话容错。
 *
 * @param {() => object} getLlm - 惰性取 llm 服务（apply 时 ctx.llm 未就绪也安全）
 * @param {() => {provider: string, model: string, timeoutMs?: number}} cfgGet - 每调用现读（volatile）
 */
export function makeDshChatFn(getLlm, cfgGet) {
	return async function chat(messages, { signal } = {}) {
		const llm = getLlm();
		if (!llm || typeof llm.stream !== 'function') {
			throw new Error('dsh 路由不可用：llm 服务未注入');
		}
		const { provider, model, timeoutMs } = cfgGet();
		if (!provider || !model) {
			throw new Error('chatRoute=dsh 需要同时配置 dshProvider（路由名）和 dshModel（模型 id）');
		}
		// 管线提示词都是 user 消息；assistant 分支留个保底转换（现有调用不会走到）
		const wire = messages.map((m) => {
			const text = String(m.content ?? '');
			if (m.role === 'user') {
				return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
			}
			return { role: m.role, content: [{ type: 'text', text }], source: { kind: 'assistant' } };
		});
		const timeout = timeoutMs ?? 120000;
		const request = {
			provider,
			model,
			messages: wire,
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
				: AbortSignal.timeout(timeout)
		};
		let text = '';
		for await (const chunk of llm.stream(request)) {
			if (chunk.type === 'text-delta') text += chunk.text;
			else if (chunk.type === 'finish') {
				const reason = chunk.reason;
				if (reason.kind === 'error' || reason.kind === 'aborted') {
					throw new Error(`dsh 路由调用失败（${reason.kind}）：${reason.failure?.message ?? '未知错误'}`);
				}
			}
		}
		return stripThink(text);
	};
}

/** 健康探测：/api/tags 是否可达。 */
export async function probeOllama(baseUrl, timeoutMs = 3000) {
	const root = trimSlash(baseUrl).replace(/\/v1$/, '');
	try {
		const response = await fetch(`${root}/api/tags`, {
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
		const data = await response.json();
		const models = (data?.models ?? []).map((m) => m.name);
		return { ok: true, models };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function trimSlash(url) {
	return String(url ?? '').replace(/\/+$/, '');
}

async function postJson(url, payload, cfg, outerSignal) {
	const timeout = cfg.timeoutMs ?? 120000;
	const signal = outerSignal
		? AbortSignal.any([outerSignal, AbortSignal.timeout(timeout)])
		: AbortSignal.timeout(timeout);
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${cfg.apiKey ?? 'ollama'}`
		},
		body: JSON.stringify(payload),
		signal
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new Error(`LLM HTTP ${response.status} ${url}: ${detail.slice(0, 300)}`);
	}
	return response.json();
}

/** 归一化重要性（LLM 可能吐字符串或越界值）。 */
export function safeImportance(value, fallback = 0.5) {
	const n = Number(value);
	return Number.isFinite(n) ? clamp01(n) : fallback;
}
