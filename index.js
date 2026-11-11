/**
 * dsh-memory —— 长期记忆插件（三方拼装版）。
 *
 * 写入抄 mem0（提取→对照→ADD/UPDATE/DELETE/NONE 事件化决策 + 确定性执行），
 * 权重抄 Neural-AI-Memory-system（importance × 新鲜度 × 命中强化），
 * 热层抄 Letta（限额块常驻系统提示），升降级是自研的确定性调度。
 *
 * 接入点：
 *   agent/pre-step        → 召回：检索相关记忆，作为 notice 注入本步
 *   systemPrompt.context  → hot 块常驻系统提示（动态函数）
 *   agent/turn-stopping   → 写入：用 session.deriveMessages() 取本轮对话，异步提炼事实
 *                           （注意：session/event 是 session-scoped，根 scope 监听器收不到，
 *                            不能靠它缓存轮次消息——之前写入全失败的根因）
 *   timer                 → 定时维护（衰减/升降级）
 *   commands              → /memory 手动入口
 *
 * @module dsh-memory
 */

import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import {
	readConfigValue,
	readTrimmedString,
	requireApi
} from '../dsh-api-stable/lib/index.js';
import { createBackend } from './lib/backend.js';
import { autoExportMemory, exportStore } from './lib/exporter.js';
import { classifySession, isUsefulLine, senderIdsOf } from './lib/im.js';
import { setSelfNames } from './lib/ingest.js';
import { makeChatFn, makeDshChatFn, makeEmbedFn, probeOllama } from './lib/llm.js';
import { collectModelCatalog, parseRuntimeList } from './lib/model-catalog.js';
// 注入面净化（施工清单 A1/A2）：只在出口改写注入副本，真源不动。见 lib/prompt-safety.js 头注。
import { buildRecallText, QUERY_NOTICE, renderUntrustedBlock, sanitizeForContext, stripLoneSurrogates, truncateSafe } from './lib/prompt-safety.js';
import { drainRetryQueue, enqueueRetry, loadRetryQueue, saveRetryQueue } from './lib/retry.js';
import { GENERAL_WORKSPACE, resolveWorkspaceKey } from './lib/workspace.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-memory';

/** 声明 boot 就绪的基础服务（systemPrompt 用 ctx.get 可选获取，不 inject）。 */
export const inject = ['commands', 'llm'];

export const Config = z.object({
	// ---- 后端选择 ----
	backend: z
		.string()
		.default('local')
		.description('存储后端：local=TS 一体化（主力）/ python=HTTP 桥（备用）'),

	// ---- local 后端 ----
	ollamaBaseUrl: z.string().default('http://127.0.0.1:11434/v1').volatile().description('Ollama OpenAI 兼容端点（local 后端）'),
	chatModel: z.string().default('qwen3:4b').volatile().description('提取/决策用的对话模型（local 路由）'),
	embedModel: z.string().default('bge-m3').volatile().description('embedding 模型（本地 ollama，不随路由切换——换模型=向量空间全变）'),
	chatRoute: z.string().default('local').volatile().description('对话模型路由（v0.4.2 三档）：local=ollama 原生 / openai=本地 OpenAI 兼容端点（llama.cpp/LM Studio/vLLM，配 openaiBaseUrl）/ dsh=云端路由（「设置 → 模型」里的账号）'),
	openaiBaseUrl: z.string().default('').volatile().description('openai 档的端点，如 http://127.0.0.1:8080/v1（llama.cpp server 默认 8080）'),
	localRuntimes: z.string().default('[]').volatile().description('本地 OpenAI 兼容运行时目录（JSON 数组，「设置 → 记忆」界面管理，供统一模型下拉拉列表用）：[{"id":"llama.cpp","baseUrl":"http://127.0.0.1:8080"}]'),
	modelList: z.string().default('[]').volatile().description('精选模型列表（JSON 数组，v0.4.3「设置 → 记忆」管理：请求可用模型后勾选添加；主下拉只显示这里）：[{"source":"dsh:zai-coding-cn","model":"glm-5.3-flash"}]'),
	dshProvider: z.string().default('').volatile().description('dsh 路由的 provider 路由名，填「设置 → 模型」里配置的路由（如 zai-coding-cn、qwen-token-plan-cn）'),
	dshModel: z.string().default('').volatile().description('dsh 路由的模型 id（如 glm-5.3-flash、deepseek-flash）；flash 级即可，写入每次 2 次调用，按量计费很便宜'),
	dataDir: z.string().default('').volatile().description('数据目录；留空=插件目录/data'),
	ollamaAutoStart: z.boolean().default(true).volatile().description('dsh 启动时自动拉起本地 ollama 服务（已在运行则不接管）；dsh 退出时停掉自己拉起的'),
	ollamaExe: z.string().default('').volatile().description('ollama 可执行文件路径；留空=自动探测 %LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe'),
	ollamaKeepAlive: z.string().default('5m').volatile().description('模型空闲卸载时间（OLLAMA_KEEP_ALIVE，如 5m/30s/-1 常驻，默认 5 分钟自动释放显存）'),
	chatUnloadAfterUse: z.boolean().default(true).volatile().description('提取/决策用完 1 分钟后自动卸载对话模型释放显存（6G 卡常驻 3.8G 吃不消，游戏党保持 true）；介意每次写入多几秒加载开销改 false'),
	ollamaContextLength: z.string().default('8192').volatile().description('ollama 运行时上下文窗口；提取/决策每请求携带 num_ctx（原生 /api/chat，与谁拉起的进程无关），同时作为插件自启实例的 OLLAMA_CONTEXT_LENGTH。换 LM Studio 等后端时清空即走 OpenAI 兼容路径'),

	// ---- python 后端 ----
	pythonUrl: z.string().default('http://127.0.0.1:8765').volatile().description('Python 记忆服务地址（python 后端）'),
	pythonExe: z.string().default('python').volatile().description('Python 解释器路径'),
	pythonScript: z.string().default('').volatile().description('http_server.py 的绝对路径；配置且 pythonAutoStart 开时自动拉起'),
	pythonAutoStart: z.boolean().default(false).volatile().description('python 后端不可达时自动启动服务'),

	// ---- 行为开关 ----
	autoRecall: z.boolean().default(true).volatile().description('每轮对话自动召回相关记忆并注入'),
	recallTopK: z.number().step(1).min(1).max(10).default(3).volatile().description('每次召回注入的记忆条数上限'),
	recallMinRelevance: z.number().min(0).max(1).default(0.35).volatile().description('召回的最低语义相关度（低于此值不注入，过滤噪音）'),
	reinforceMinRelevance: z.number().min(0).max(1).default(0.5).volatile().description('强化门槛：召回命中相关度达到此值才加重要度（防边缘弱命中反复喂胖寄生卡）；v0.4.8 起达标候选全部强化，不再限于注入位'),
	wRelevance: z.number().min(0).max(1).default(0.5).volatile().description('召回排序三分之一的权重：语义相关度。调高=问什么答什么；调低容易被"老资格"高分卡霸榜'),
	wImportance: z.number().min(0).max(1).default(0.3).volatile().description('召回排序权重：卡片重要度。调低可削弱高重要度旧卡对注入位的垄断（trivia 这类低重要度新卡受益最明显）'),
	wFreshness: z.number().min(0).max(1).default(0.2).volatile().description('召回排序权重：新鲜度（近期访问过的卡占优）。三个权重建议合计约 1.0，比例即语义'),
	bm25Fusion: z.boolean().default(true).volatile().description('混合检索（v0.4.9）：召回在余弦语义路之外加一条 BM25 字面路（中文按字二元组切词，零依赖）。字面命中管"型号/缩写/换说法"这类余弦对不上的场景；关掉则退回纯余弦'),
	bm25MinRelevance: z.number().min(0).max(1).default(0.3).volatile().description('字面放行线：余弦不到 recallMinRelevance 但 BM25 达此值（本查询最高字面分的倍率）的记忆照样注入——两条路各救各的盲区'),
	scopeIsolation: z.boolean().default(true).volatile().description('scope 隔离（v0.3）：群聊写入的卡进 im 域——桌面召回/热块只查 global，IM 会话 global+im 都查；关掉则全部混查'),
	wsIsolation: z.boolean().default(true).volatile().description('工作区记忆分离（v0.6.0）：卡片按会话工作目录（末级目录名）打 ws 标签——通用卡（个人偏好/身份/约定，LLM 判 general）处处可见，项目卡只在对应目录的会话召回与热块出现；关掉则全部混用'),
	autoMerge: z.boolean().default(true).volatile().description('维护期自动合并（v0.3.2）：同 scope 相似度 ≥0.92 的存量卡对 LLM 合并成一条，每轮最多 5 对'),
	autoExpire: z.boolean().default(true).volatile().description('维护期过期判断（v0.3.4）：创建超 7 天且含任务词的卡问一次 LLM 是否已过时，过期的软删归档，每轮最多 5 张'),
	gcSupersededDays: z.number().step(1).min(1).default(14).volatile().description('自动清理（v0.3.4）：superseded 软删卡保留天数，超龄硬删（cold 归档与轮换备份里有底）'),
	gcColdDays: z.number().step(1).min(1).default(30).volatile().description('自动清理（v0.3.4）：cold 层未访问保留天数，超龄硬删（cold 本就不可召回）'),
	retryQueue: z.boolean().default(true).volatile().description('写入失败重试队列（v0.3.4）：LLM 传输失败的对话窗存盘，下次写入成功或维护期重放，最多 5 次/48h'),
	autoRemember: z.boolean().default(true).volatile().description('轮次结束时自动提炼事实写入记忆'),
	imRememberMode: z.string().default('group').volatile().description('IM 会话（QQ/微信，cwd 非 profiles）写入模式：off=不写 / pinned-only=仅显式记住 / group=群聊攒批提炼'),
	imSelfNames: z.string().default('').volatile().description('你在 QQ/微信 的昵称（多个用逗号分隔，如「小明,阿鱼」）。群聊消息前缀里这些名字视为"用户本人"，其余按群友记；留空则只认消息里自称"我"'),
	imBatchQuietMinutes: z.number().step(1).min(1).default(5).volatile().description('IM 攒批静默窗口（分钟）：消息静默这么久后合并提炼一次'),
	imBatchMaxLines: z.number().step(1).min(5).default(20).volatile().description('IM 单批最大消息条数（超出拆批；4B 长文注意力有限，别调太大）'),
	rememberThrottleSeconds: z.number().step(1).min(10).default(45).volatile().description('桌面会话两次写入的最小间隔（秒），防高频触发'),
	maintenanceMinutes: z.number().step(1).min(1).default(60).volatile().description('定时维护间隔（分钟）'),
	exportDir: z.string().default('').volatile().description('记忆导出目录（v0.4）：维护期自动导出快照（24h 节流）+ /memory export 手动导出；留空=不导出。建议填工作区下的一个目录，如 <工作区>/memory-export'),
	exportFormat: z.string().default('md').volatile().description('导出格式：md（人读，scope/tier 分节）/ json（cards.json 同构快照）'),

	// ---- 热层与权重 ----
	hotBudgetChars: z.number().step(1).min(200).default(2000).description('hot 块字符预算'),
	hotMaxCards: z.number().step(1).min(1).default(15).description('hot 块最大卡片数'),
	halfLifeDays: z.number().min(0.1).default(7).description('普通事实的新鲜度半衰期（天）'),
	commitmentHalfLifeDays: z.number().min(1).default(90).description('约定/承诺的半衰期（天）'),
	promoteScore: z.number().min(0).max(1).default(0.55).description('升 hot 的调度分阈值'),
	demoteScore: z.number().min(0).max(1).default(0.12).description('降 cold 的调度分阈值'),
	reinforceDelta: z.number().min(0).max(1).default(0.05).description('命中一次的重要性增幅'),
	pinnedImportance: z.number().min(0).max(1).default(0.8).description('显式"记住"的重要性下限'),
	noneAddThreshold: z.number().min(0).max(1).default(0.5).description('NONE 兜底阈值：新事实与所有旧卡相似度都低于此值时强制 ADD（防 4B 误判）'),

	// ---- 调试 ----
	debug: z.boolean().default(false).volatile().description('在日志里输出召回/写入明细')
});

/** 当前插件目录。 */
const pluginDir = dirname(fileURLToPath(import.meta.url));

/**
 * 注册记忆插件。
 * @param ctx - Cordis plugin context.
 * @param config - plugin configuration (volatile fields read per use).
 */
export function apply(ctx, config) {
	requireApi('^1.0.0');
	const logger = ctx.logger ?? console;

	// ---- 配置快照（handler 里现读，volatile 即时生效） ----
	const dataDir = readTrimmedString(config.dataDir) || join(pluginDir, 'data');

	/**
	 * 把配置里的 IM 本人昵称同步进写入管线（v0.6.1：原来硬编码在提示词里，
	 * 现在由 imSelfNames 提供；volatile 字段每轮现读，改了不用重启）。
	 */
	const syncSelfNames = () => setSelfNames(readTrimmedString(config.imSelfNames));

	// ---- v0.6.0 工作区注册表：ws 键 → 规范 cwd（同名目录去歧义），data/workspaces.json 持久化 ----
	const wsRegistryPath = join(dataDir, 'workspaces.json');
	const wsRegistry = new Map();
	let wsRegistryLoaded = false;
	const loadWsRegistry = async () => {
		if (wsRegistryLoaded) return;
		wsRegistryLoaded = true;
		try {
			const { readFile } = await import('node:fs/promises');
			const raw = JSON.parse(await readFile(wsRegistryPath, 'utf8'));
			if (raw && typeof raw === 'object') {
				for (const [key, path] of Object.entries(raw)) {
					if (typeof key === 'string' && typeof path === 'string') wsRegistry.set(key, path);
				}
			}
		} catch {
			/* 首次运行无文件，空表起步 */
		}
	};
	const persistWsRegistry = async () => {
		try {
			const { writeFile } = await import('node:fs/promises');
			const obj = {};
			for (const [key, path] of wsRegistry) obj[key] = path;
			await writeFile(wsRegistryPath, JSON.stringify(obj, null, 2), 'utf8');
		} catch {
			/* 注册表落盘失败不影响主流程 */
		}
	};
	/**
	 * 会话 cwd → 工作区键。隔离开关关闭时返回 null（调用方据此不做过滤）；
	 * 首见/撞名的键会注册进 wsRegistry（幂等），返回 GENERAL_WORKSPACE 表示未识别。
	 */
	const sessionWorkspace = (cwd) => {
		if (liveConfig.wsIsolation === false) return null;
		const before = wsRegistry.size;
		const key = resolveWorkspaceKey(cwd, wsRegistry);
		if (wsRegistry.size !== before) void persistWsRegistry(); // 新键异步落盘
		return key;
	};

	/**
	 * 配置声明式映射（v0.2.5 清债）：加字段只改 Config schema + 下面各一行。
	 * 旧写法同一个默认值要抄三处（schema/liveConfig/syncConfig），25 个字段纯手搓重复。
	 */
	const SCALAR_DEFAULTS = {
		hotBudgetChars: 2000,
		hotMaxCards: 15,
		halfLifeDays: 7,
		commitmentHalfLifeDays: 90,
		promoteScore: 0.55,
		demoteScore: 0.12,
		reinforceDelta: 0.05,
		pinnedImportance: 0.8,
		noneAddThreshold: 0.5,
		reinforceMinRelevance: 0.5,
		wRelevance: 0.5,
		wImportance: 0.3,
		wFreshness: 0.2,
		bm25Fusion: true,
		bm25MinRelevance: 0.3,
		scopeIsolation: true,
		wsIsolation: true,
		autoMerge: true,
		autoExpire: true,
		gcSupersededDays: 14,
		gcColdDays: 30,
		retryQueue: true,
		pythonAutoStart: false
	};
	const STRING_DEFAULTS = {
		backend: 'local',
		pythonUrl: 'http://127.0.0.1:8765',
		pythonExe: 'python',
		pythonScript: '',
		chatRoute: 'local',
		openaiBaseUrl: '',
		localRuntimes: '[]',
		modelList: '[]',
		dshProvider: '',
		dshModel: '',
		exportFormat: 'md'
	};
	/** 引擎固定参数（不暴露为配置）。v0.4.8：召回三权重移入 Config（上面 SCALAR_DEFAULTS）。 */
	const FIXED_CONFIG = {
		dataDir,
		maxImportance: 1,
		pythonTimeoutMs: 180000
	};

	let backend = null; // 先声明，syncConfig 在 createBackend 之前也会被调用
	const liveConfig = { ...FIXED_CONFIG, ...SCALAR_DEFAULTS, ...STRING_DEFAULTS };

	/** 把插件 Config 现读值同步进 liveConfig（volatile 即时生效）。 */
	const syncConfig = () => {
		for (const key of Object.keys(SCALAR_DEFAULTS)) {
			liveConfig[key] = readConfigValue(config[key]) ?? SCALAR_DEFAULTS[key];
		}
		for (const key of Object.keys(STRING_DEFAULTS)) {
			liveConfig[key] = readTrimmedString(config[key]) || STRING_DEFAULTS[key];
		}
		// exportDir 走原样读取（不经 || 兜底）：留空=关闭自动导出是合法语义
		liveConfig.exportDir = readTrimmedString(config.exportDir) ?? '';
		if (backend?.engine) Object.assign(backend.engine.config, liveConfig);
	};

	const chatRoute = () => {
		const route = readTrimmedString(config.chatRoute);
		return route === 'dsh' || route === 'openai' ? route : 'local';
	};
	// 本地 chat：local 档走 ollama 原生（num_ctx 每请求带）；openai 档走 OpenAI 兼容
	// 端点（llama.cpp/LM Studio/vLLM——llm.js 的 numCtx=0 分支），baseUrl 换到 openaiBaseUrl
	const localChat = makeChatFn({
		get baseUrl() {
			return chatRoute() === 'openai'
				? (readTrimmedString(config.openaiBaseUrl) || 'http://127.0.0.1:8080/v1')
				: (readTrimmedString(config.ollamaBaseUrl) || 'http://127.0.0.1:11434/v1');
		},
		get chatModel() { return readTrimmedString(config.chatModel) || 'qwen3:4b'; },
		get numCtx() {
			if (chatRoute() === 'openai') return 0; // 兼容端点不认 options.num_ctx，走 /chat/completions
			const n = Number(readTrimmedString(config.ollamaContextLength));
			return Number.isFinite(n) && n > 0 ? n : 0;
		},
		get chatKeepAlive() {
			// 用完即卸（默认）：写完 1 分钟放显存，不受托盘 serve 驻留政策摆布；关掉则跟 serve keep-alive 走
			return readConfigValue(config.chatUnloadAfterUse) === false
				? (readTrimmedString(config.ollamaKeepAlive) || '5m')
				: '1m';
		},
		get apiKey() {
			// openai 档：从 localRuntimes 里匹配当前端点的 key（DeepSeek 等云端点用；本地不填则无 Authorization 值）
			if (chatRoute() !== 'openai') return undefined;
			const baseUrl = readTrimmedString(config.openaiBaseUrl);
			const hit = parseRuntimeList(readTrimmedString(config.localRuntimes) || '[]').find(
				(rt) => rt.baseUrl.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '')
			);
			return hit?.apiKey || undefined;
		},
		timeoutMs: 180000
	});
	// v0.4 云端路由：借「设置 → 模型」的 provider，key/计费归 DSH 管；embed 永远本地 bge
	const dshChat = makeDshChatFn(
		() => ctx.llm,
		() => ({
			provider: readTrimmedString(config.dshProvider),
			model: readTrimmedString(config.dshModel),
			timeoutMs: 180000
		})
	);
	const chat = (messages, options) => (chatRoute() === 'dsh' ? dshChat(messages, options) : localChat(messages, options));
	const embed = makeEmbedFn({
		get baseUrl() { return readTrimmedString(config.ollamaBaseUrl) || 'http://127.0.0.1:11434/v1'; },
		get embedModel() { return readTrimmedString(config.embedModel) || 'bge-m3'; },
		get numCtx() {
			const n = Number(readTrimmedString(config.ollamaContextLength));
			return Number.isFinite(n) && n > 0 ? n : 0;
		},
		get embedKeepAlive() { return readTrimmedString(config.ollamaKeepAlive) || '5m'; },
		timeoutMs: 180000
	});

	syncConfig();
	backend = createBackend(liveConfig, { dataDir, chat, embed }, logger);
	if (backend.engine) Object.assign(backend.engine.config, liveConfig);

	// ---- ollama 进程托管：dsh 开 → 没有就拉起；dsh 关 → 停掉自己拉起的 ----
	const ollamaSupervisor = {
		child: null,
		owned: false,
		async ensure() {
			if (backend.kind !== 'local') return;
			if (readConfigValue(config.ollamaAutoStart) === false) return;
			const base = readTrimmedString(config.ollamaBaseUrl) || 'http://127.0.0.1:11434/v1';
			if ((await probeOllama(base, 2000)).ok) {
				this.owned = false; // 已在运行（托盘/手动起的），不接管
				// 外部实例吃不到注入的环境变量，但提取/决策每请求带 num_ctx，ctx 仍有保证
				logger.info?.('dsh-memory: 检测到外部 ollama 已在运行（不接管；上下文由每请求 num_ctx 保证）');
				return;
			}
			const exe = readTrimmedString(config.ollamaExe) || autoDetectOllama();
			if (!exe) {
				logger.warn?.('dsh-memory: 找不到 ollama 可执行文件（配置 ollamaExe 或关闭 ollamaAutoStart）');
				return;
			}
			try {
				const { spawn } = await import('node:child_process');
				const keepAlive = readTrimmedString(config.ollamaKeepAlive) || '5m';
				const contextLength = readTrimmedString(config.ollamaContextLength) || '8192';
				this.child = spawn(exe, ['serve'], {
					stdio: 'ignore',
					windowsHide: true,
					env: {
						...process.env,
						OLLAMA_KEEP_ALIVE: keepAlive,
						OLLAMA_CONTEXT_LENGTH: contextLength
					}
				});
				this.child.unref?.(); // 不阻止 dsh 退出
				this.owned = true;
				this.child.on?.('exit', () => { this.child = null; });
				for (let i = 0; i < 20; i += 1) {
					await sleep(1000);
					if ((await probeOllama(base, 1500)).ok) {
						logger.info?.(`dsh-memory: ollama 已由插件拉起（keepAlive=${keepAlive}，ctx=${contextLength}）`);
						return;
					}
				}
				logger.warn?.('dsh-memory: ollama 拉起超时');
			} catch (error) {
				logger.warn?.(`dsh-memory: ollama 拉起失败：${errorMessage(error)}`);
			}
		},
		stop() {
			if (!this.owned || !this.child) return;
			try {
				this.child.kill();
			} catch {
				/* ignore */
			}
			this.child = null;
			this.owned = false;
		}
	};

	// ---- 运行时状态 ----
	let hotText = '[长期记忆]（空）';
	let ollamaOk = null; // null=未探测，true/false=最近一次探测或写入结果
	// C3（契约 I5）：写入失败必须有一处用户可见面，不能只躺在 debug.log 里。
	// 这里只记「最近一次」与累计次数，不做历史堆栈——状态面板要的是结论，不是日志。
	const writeHealth = { okAt: 0, failAt: 0, failures: 0, lastError: '' };
	let readyResolve;
	const ready = new Promise((resolve) => { readyResolve = resolve; });
	const lastRecallTurn = new Map(); // sessionId → turn（每轮只注入一次）
	// A1 跨轮注入冷却：sessionId → Map(cardId → 注入时间戳)。
	// 24h 内注入过的卡不再注入，防同一张卡轮轮命中轮轮注入（token 白吃 + 唠叨）。
	const injectedAt = new Map();
	const RECALL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
	// A1 逃生门：冷却是防唠叨，不能挡住"你还记得X吗"——用户显式问记忆时无视冷却放行。
	const RECALL_ESCAPE_RE = /记得|还记得|记忆|remember|memory/i;
	const debugOn = () => readConfigValue(config.debug) === true;

	/** 调试流水：跟 debug 开关走（排障期在 yml 开着；平时可关省 I/O）。v0.2.5 前是无条件写。 */
	const debugLog = async (line) => {
		if (!debugOn()) return;
		try {
			const { appendFile, mkdir } = await import('node:fs/promises');
			await mkdir(dataDir, { recursive: true });
			await appendFile(join(dataDir, 'debug.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
		} catch {
			/* 不影响主流程 */
		}
	};

	const refreshHot = async () => {
		try {
			hotText = await backend.hotBlock();
		} catch (error) {
			logger.warn?.(`dsh-memory: 刷新 hot 块失败：${errorMessage(error)}`);
		}
		if (backend.kind === 'local' && ollamaOk === false) {
			hotText += chatRoute() === 'dsh'
				? '\n[⚠️ 记忆召回离线：本地 embedding（ollama）不可达；写入走云端路由不受影响]'
				: '\n[⚠️ 记忆服务离线：ollama 不可达，本轮不会写入新记忆]';
		}
		hotByWs.clear(); // v0.6.0：工作区视图缓存随全局缓存一起失效
	};

	// ---- v0.6.0 工作区热块：ws 键 → 渲染文本，惰性同步重建（181 张卡毫秒级） ----
	const hotByWs = new Map();
	/**
	 * 按会话渲染热块。assemble 上下文带 agent（dsh-agent assembleContextFor 的
	 * {agent, scope: agent} 约定），从 agent.session.header.cwd 解析工作区；
	 * 拿不到 agent / 未识别 cwd / 隔离关闭时回落全局缓存 hotText。
	 */
	const hotTextFor = (agent) => {
		try {
			const ws = sessionWorkspace(String(agent?.session?.header?.cwd ?? ''));
			if (!ws || ws === GENERAL_WORKSPACE) return hotText;
			let text = hotByWs.get(ws);
			if (text === undefined) {
				text = backend.hotBlock(ws);
				hotByWs.set(ws, text);
			}
			return text;
		} catch {
			return hotText;
		}
	};

	const runMaintenance = async () => {
		await ready;
		syncConfig();
		await drainRetryQueueFromDisk(); // v0.3.4：先把上回失败的对话窗补写进去
		try {
			const stats = await backend.maintenance();
			await refreshHot();
			void debugLog(`维护完成 ${JSON.stringify(stats)}`); // v0.3.4：debug.log 是唯一真相源，统计也落这里
			if (stats.promoted || stats.demoted || stats.evicted || stats.merged) {
				logger.info?.(`dsh-memory: 维护完成 ${JSON.stringify(stats)}`);
			}
			return stats;
		} catch (error) {
			logger.warn?.(`dsh-memory: 维护失败：${errorMessage(error)}`);
			return { promoted: 0, demoted: 0, evicted: 0 };
		}
	};

	// ---- v0.4.4 模型目录同源路由：设置页的「请求可用模型」只消费，目录由 host 拉 ----
	// 官方模型选择器也是 host 侧 listProviders→listModels；浏览器直连本地端口不可靠。
	// ⚠️ 2026-10-29 实机教训：此块必须放在 debugLog 定义之后（此前写在前面 = TDZ
	// ReferenceError）；effect 必须用 ctx（服务实例没有 effect 方法）——两条都会让
	// apply 抛错 → 整个插件不加载 → 设置页全面只读。
	const catalogHandler = async (req, res) => {
		if (req.method !== 'GET') {
			res.statusCode = 405;
			res.end('method not allowed');
			return;
		}
		try {
			const catalog = await collectModelCatalog({
				ollamaBaseUrl: readTrimmedString(config.ollamaBaseUrl) || 'http://127.0.0.1:11434/v1',
				runtimes: parseRuntimeList(readTrimmedString(config.localRuntimes) || '[]'),
				llm: ctx.get('llm')
			});
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.end(JSON.stringify(catalog));
			void debugLog(`模型目录路由请求：ollama=${catalog.ollama.ok ? catalog.ollama.models.length + '个' : '不可达'} cloud=${catalog.cloud.length}组`);
		} catch (error) {
			res.statusCode = 500;
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.end(JSON.stringify({ error: errorMessage(error) }));
			void debugLog(`模型目录路由失败：${errorMessage(error)}`);
		}
	};
	const pickWebServer = () => {
		try {
			const direct = ctx.webServer;
			if (direct && typeof direct.register === 'function') return direct;
		} catch {
			/* 服务未就绪时属性访问可能抛错 */
		}
		try {
			const viaGet = ctx.get('webServer');
			if (viaGet && typeof viaGet.register === 'function') return viaGet;
		} catch {
			/* 同上 */
		}
		return null;
	};
	const existingWebServer = pickWebServer();
	if (existingWebServer) {
		ctx.effect(() => existingWebServer.register({ kind: 'exact', path: '/dsh-memory/models', handler: catalogHandler }));
		void debugLog('模型目录路由已注册 GET /dsh-memory/models');
	} else {
		void debugLog('模型目录路由：webServer 尚未就绪，走 inject 等待');
		ctx.inject(['webServer'], (webCtx) => {
			webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: '/dsh-memory/models', handler: catalogHandler }));
			void debugLog('模型目录路由已注册（inject 路径）GET /dsh-memory/models');
		});
	}

	// ---- v0.3.4 重试队列接线 ------------------------------------------------
	const retryPath = join(dataDir, 'retry-queue.json');

	/** 从盘上读队列 → 重放 → 写回。给维护期和写入成功后两条路径复用。 */
	const drainRetryQueueFromDisk = async () => {
		if (liveConfig.retryQueue === false) return { ok: 0, fail: 0 };
		let entries = await loadRetryQueue(retryPath);
		if (entries.length === 0) return { ok: 0, fail: 0 };
		const result = await drainRetryQueue(entries, async (dialog, options) => {
			await backend.remember(dialog, options);
		});
		await saveRetryQueue(retryPath, result.entries);
		if (result.ok || result.fail) {
			void debugLog(`重试重放 成功${result.ok} 失败${result.fail} 剩余${result.entries.length}`);
		}
		return result;
	};

	// ---- 初始化（异步，不阻塞 apply） ----
	void (async () => {
		try {
			await loadWsRegistry();           // v0.6.0 工作区注册表先于任何键解析
			await ollamaSupervisor.ensure();   // 没有 ollama 就先拉起（dsh 同步启停）
			await backend.init();
			await refreshHot();
			const probe = backend.kind === 'local'
				? await probeOllama(readTrimmedString(config.ollamaBaseUrl) || 'http://127.0.0.1:11434/v1')
				: { ok: true };
			ollamaOk = probe.ok;
			await refreshHot();
			if (backend.kind === 'local' && !probe.ok) {
				logger.warn?.(`dsh-memory: 连不上 ollama（${probe.error}），召回/写入会失败。请确认 ollama 在运行。`);
			}
			logger.info?.(`dsh-memory: 已就绪（backend=${backend.kind}，${hotText.split('\n')[0]}）`);
			await writeReadyMarker(dataDir, backend.kind, hotText);
		} catch (error) {
			logger.error?.(`dsh-memory: 初始化失败：${errorMessage(error)}`);
		} finally {
			readyResolve();
		}
	})();

	// ==================================================================
	// ① 召回注入：agent/pre-step
	// ==================================================================
	/** 诊断专用：绕过 debugOn 门禁直写 debug.log（v0.4.6 召回排查期临时保留）。 */
	const rawLog = async (line) => {
		try {
			const { appendFile, mkdir } = await import('node:fs/promises');
			await mkdir(dataDir, { recursive: true });
			await appendFile(join(dataDir, 'debug.log'), `${new Date().toISOString()} [raw] ${line}\n`, 'utf8');
		} catch {
			/* 不影响主流程 */
		}
	};
	ctx.on(
		'agent/pre-step',
		async (payload, next) => {
			syncSelfNames();
			const sid = String(payload.agent?.id ?? 'unknown').slice(-8);
			void rawLog(`pre-step 入口 sid=${sid} turn=${payload.turn} aborted=${payload.signal?.aborted} autoRecall=${readConfigValue(config.autoRecall)}`);
			const decision = await next();
			void rawLog(`pre-step 返回 sid=${sid} kind=${decision?.kind} msgs=${decision?.messages?.length}`);
			if (decision.kind === 'reject' || payload.signal.aborted) {
				void rawLog(`召回跳过 sid=${sid}：reject/aborted`);
				return decision;
			}
			if (readConfigValue(config.autoRecall) === false) return decision;

			const sessionId = String(payload.agent?.id ?? 'unknown');
			const turn = payload.turn;
			if (lastRecallTurn.get(sessionId) === turn) return decision;   // 每轮一次

			const query = latestUserText(decision.messages);
			if (!query) {
				void rawLog(`召回跳过 sid=${sid}：query 为空（消息里没有用户文本）`);
				return decision;
			}
			lastRecallTurn.set(sessionId, turn);

			await ready;
			syncConfig();
			try {
				const minRel = Number(readConfigValue(config.recallMinRelevance) ?? 0.35);
				// v0.3 scope 隔离：桌面会话只查 global；IM 会话 global+im 都查
				const cwd = String(payload.agent?.session?.header?.cwd ?? '');
				const im = classifySession(cwd, messagesFromSession(payload.agent?.session)) === 'im';
				const scopes = liveConfig.scopeIsolation === false
					? null
					: (im ? ['global', 'im'] : ['global']);
				// v0.6.0 工作区分离：IM 会话不过滤（群聊卡与工作区无关）；桌面按 cwd 键过滤
				const ws = im ? null : sessionWorkspace(cwd);
				// v0.4.8 diag 出参：engine 把候选池/强化计数带回来——此前"候选=N"
				// 记的是 topK 切片后的长度（永远等于注入上限），检索池全貌不可见
				const diag = {};
				// A1/A7 逃生门提前判：用户显式问记忆时，硬过滤（A1）与排名降权（A7）都不生效
				const escapeCooldown = RECALL_ESCAPE_RE.test(query);
				const raw = await backend.recall(query, readConfigValue(config.recallTopK) ?? 3, {
					signal: payload.signal,
					scopes,
					workspace: ws, // v0.6.0：null 不过滤；'*' 视图=全部；具体键=通用+本工作区
					// A7：传入本会话注入时间表，engine 据此给近期已注入卡排名降权（防占 topK 名额）
					injectedAt: escapeCooldown ? undefined : injectedAt.get(sessionId),
					diag
				});
				// v0.4.9 双路放行：余弦达标（语义确认）或 BM25 达标（字面强命中）都注入。
				// bm25 是查询内归一化分（本查询最高字面分=1.0），门槛即"达到最高字面分的几成"。
				const bm25Min = Number(readConfigValue(config.bm25MinRelevance) ?? 0.3);
				let hits = raw.filter(
					(hit) => Number(hit.relevance) >= minRel || Number(hit.bm25 ?? 0) >= bm25Min
				);
				// A1 跨轮冷却：24h 内注入过的卡滤掉；逃生门命中时放行（见声明处注释）。
				let cooled = 0;
				if (!escapeCooldown && hits.length > 0) {
					const seenCards = injectedAt.get(sessionId);
					if (seenCards) {
						const before = hits.length;
						const now = Date.now();
						hits = hits.filter((hit) => {
							const ts = seenCards.get(hit.card.id);
							return !(ts && now - ts < RECALL_COOLDOWN_MS);
						});
						cooled = before - hits.length;
					}
				}
				// v0.4.6：召回结论无条件落 debug.log（此前走宿主日志，排障全盲）
				const routeTag = chatRoute() === 'dsh'
					? `dsh/${readTrimmedString(config.dshProvider)}/${readTrimmedString(config.dshModel)}`
					: chatRoute() === 'openai'
						? `openai/${readTrimmedString(config.openaiBaseUrl)}`
						: `local/${readTrimmedString(config.chatModel) || 'qwen3:4b'}`;
				const best = raw.length > 0 ? Number(raw[0].relevance).toFixed(2) : '0.00';
				const bm25Rescued = hits.filter((h) => Number(h.relevance) < minRel).length;
				void rawLog(
					`召回 ${hits.length > 0 ? `注入${hits.length}条` : '为空'} sid=${sid} route=${routeTag} ws=${ws ?? '-'} 最高=${best} 阈值=${minRel} 池=${diag.pool ?? '?'} 候选=语义${diag.candidates ?? raw.length}+字面${diag.bm25Candidates ?? '?'} 强化=${diag.reinforced ?? '?'}${bm25Rescued > 0 ? ` 字面救回${bm25Rescued}` : ''}${cooled > 0 ? ` 冷却滤除${cooled}条` : ''}${diag.penalized > 0 ? ` 降权${diag.penalized}` : ''}${escapeCooldown ? ' 逃生门' : ''}${diag.triviaSeat ? ' trivia席=1' : ''}` +
					(hits.length > 0 ? ` → ${hits.map((h) => h.card.content.slice(0, 18)).join(' | ')}` : '')
				);
				if (!hits.length || payload.signal.aborted) return decision;
				// A2 历史查重：同内容召回块已在上文尾部（重放/边界场景）则本轮不注入。
				// memoryNotice 首尾带 [memory recall] 围栏，此处比对全文。
				const notice = memoryNotice(hits);
				const noticeText = textOf(notice);
				const alreadyInjected = decision.messages
					.slice(-6)
					.some((message) => message?.role === 'user' && textOf(message) === noticeText);
				if (alreadyInjected) {
					void rawLog(`召回跳过 sid=${sid}：同块已在上文尾部`);
					return decision;
				}
				let seen = injectedAt.get(sessionId);
				if (!seen) {
					seen = new Map();
					injectedAt.set(sessionId, seen);
				}
				for (const hit of hits) seen.set(hit.card.id, Date.now());
				return { ...decision, messages: [...decision.messages, notice] };
			} catch (error) {
				void rawLog(`召回异常 sid=${sid}：${errorMessage(error)}`);
				logger.warn?.(`dsh-memory: 召回失败：${errorMessage(error)}`);
				return decision;
			}
		},
		{ prepend: true }
	);

	// ==================================================================
	// ② hot 块常驻系统提示：systemPrompt.context
	// ==================================================================
	const systemPrompt = ctx.get('systemPrompt');
	if (systemPrompt && typeof systemPrompt.context === 'function') {
		ctx.effect(function* () {
			yield systemPrompt.context({
				name: 'dsh-memory:hot',
				order: 1000,
				// v0.6.0：assemble 上下文带 agent（dsh-agent assembleContextFor 约定
				// {agent, scope: agent}），从 agent.session.header.cwd 按会话渲染热块
				// v0.7.0（A1）：**必须过 sanitizeForContext** —— 宿主 renderPrompt 会对每段
				// context 文本做严格 `{{var}}` 插值，完整组一律 throw（无转义语法）。热块正文
				// 来自卡片内容，任意文本都可能含 `{{…}}`（docker --format / Jinja / Vue 模板…），
				// 一旦命中则该轮 assemble 抛错，而热块每轮重建 ⇒ 会话永久不可用，只能改/删卡恢复。
				// v0.7.0（A2）：再套不可信边界 —— 热块是体积最大的注入面（近 2000 字全是
				// 用户/工具/群聊沉淀的可控文本），只净化不设界等于把数据摆在指令位上。
				text: (asm) => renderUntrustedBlock(sanitizeForContext(hotTextFor(asm?.agent)))
			});
		});
	} else {
		logger.warn?.('dsh-memory: systemPrompt 服务不可用，hot 块不会注入（召回仍工作）');
	}

	// ==================================================================
	// ③ 写入：agent/turn-stopping
	//
	// 桌面会话：每轮直接提炼（带 45 秒节流）。
	// IM 会话（双闸判定见 lib/im.js：cwd + [名字 (ID)] 前缀）：攒批模式——消息进队列，
	//   静默 5 分钟或攒满 20 条后合并成一次提炼（群聊专用提示词：
	//   只记群友持久信息/约定/群规则，宁缺毋滥）。
	// session/event 是 session-scoped 收不到，统一用 deriveMessages()。
	// ==================================================================
	const imQueues = new Map();       // sessionId → { messages: [{role,content}], timer }
	const lastRememberAt = new Map(); // sessionId → ts（桌面节流）
	const rememberTail = new Map();   // sessionId → 上次已交提取的末条签名（A4 游标）

	// IM 双闸判据（classifySession）与前置闸（isUsefulLine）在 lib/im.js——纯函数，测试锁定行为

	const rememberDialog = async (sessionId, dialog, options) => {
		try {
			await ready;
			syncConfig();
			const report = await backend.remember(dialog, options);
			ollamaOk = true;
			writeHealth.okAt = Date.now();
			await refreshHot();
			void debugLog(
				`remember OK 提取${report.factsExtracted} ADD${report.added.length} ` +
				`UPDATE${report.updated.length} DELETE${report.deleted.length} ` +
				`跳过${report.skipped} 去重${report.deduped ?? 0} 强制${report.forced ?? 0}`
			);
			// v0.3.4：写入通道恢复了，顺手把上次失败的窗口补进去（队列空时零开销）
			void drainRetryQueueFromDisk();
		} catch (error) {
			// ollamaOk 只反映本地 ollama（embed/召回通道）：dsh 云端路由的失败与它无关
			if (chatRoute() === 'local') ollamaOk = false;
			writeHealth.failAt = Date.now();
			writeHealth.failures += 1;
			writeHealth.lastError = errorMessage(error);
			void debugLog(`remember FAILED: ${errorMessage(error)}`);
			if (liveConfig.retryQueue !== false) {
				try {
					const entries = await loadRetryQueue(retryPath);
					const { entries: next, added } = enqueueRetry(entries, { sessionId, dialog, options });
					await saveRetryQueue(retryPath, next);
					if (added) void debugLog(`重试入队 sid=${String(sessionId).slice(-8)} lines=${dialog.length}`);
				} catch (queueError) {
					void debugLog(`重试入队失败：${errorMessage(queueError)}`);
				}
			}
			await refreshHot();
			logger.warn?.(`dsh-memory: 写入失败：${errorMessage(error)}`);
		}
	};

	const flushImQueue = async (sessionId, queue) => {
		imQueues.delete(sessionId);
		const maxLines = Number(readConfigValue(config.imBatchMaxLines) ?? 20);
		while (queue.messages.length > 0) {
			const chunk = queue.messages.splice(0, maxLines);
			const dialog = chunk.map((entry) => ({ role: entry.role, content: entry.content }));
			await rememberDialog(sessionId, dialog, { groupMode: true });
		}
	};

	const enqueueIm = (sessionId, entries) => {
		let queue = imQueues.get(sessionId);
		if (!queue) {
			queue = { messages: [], timer: null };
			imQueues.set(sessionId, queue);
		}
		queue.messages.push(...entries);
		if (queue.timer) clearTimeout(queue.timer);
		const quietMs = Number(readConfigValue(config.imBatchQuietMinutes) ?? 5) * 60000;
		const maxLines = Number(readConfigValue(config.imBatchMaxLines) ?? 20);
		const flush = () => {
			queue.timer = null;
			void flushImQueue(sessionId, queue);
		};
		if (queue.messages.length >= maxLines) {
			void flush();
		} else {
			queue.timer = setTimeout(flush, quietMs);
			queue.timer.unref?.();
		}
	};

	const loggedHeaderSessions = new Set(); // 每会话记一次 header 字段名（学习 IM/desktop 判别字段用，只记键不记值）
	const loggedImGroups = new Set();       // 每会话记一次发言者 ID 集合（per-group scope 观察用）

	ctx.on('agent/turn-stopping', (payload) => {
		syncSelfNames();
		const sessionId = String(payload.agent?.id ?? '');
		lastRecallTurn.delete(sessionId);
		// A1：顺手清掉已过冷却期的注入记录，防 Map 无界增长
		const seenCards = injectedAt.get(sessionId);
		if (seenCards) {
			const now = Date.now();
			for (const [cardId, ts] of seenCards) {
				if (now - ts >= RECALL_COOLDOWN_MS) seenCards.delete(cardId);
			}
			if (seenCards.size === 0) injectedAt.delete(sessionId);
		}
		const sidTag = sessionId.slice(-8);
		if (!loggedHeaderSessions.has(sidTag)) {
			loggedHeaderSessions.add(sidTag);
			void debugLog(`header[${sidTag}] keys: ${Object.keys(payload.agent?.session?.header ?? {}).join(',')}`);
		}
		if (readConfigValue(config.autoRemember) === false) return;

		// 对话只派生一次：双闸判据（lib/im.js）与后续写入共用同一份
		const dialog = messagesFromSession(payload.agent?.session);
		const im = classifySession(String(payload.agent?.session?.header?.cwd ?? ''), dialog) === 'im';
		const mode = im ? String(readConfigValue(config.imRememberMode) ?? 'group') : 'desktop';
		if (mode === 'off') return;

		void debugLog(`turn-stopping session=${sidTag} im=${im} mode=${mode} dialog=${dialog.length}`);
		if (dialog.length === 0) return;

		if (im) {
			// per-group scope 观察埋点（v0.3.2）：每会话记一次发言者 ID 集合，
			// 跨会话对号验证"成员集合"能否当稳定群标识（数据够了再决定细分手桶）
			if (!loggedImGroups.has(sidTag)) {
				loggedImGroups.add(sidTag);
				const ids = senderIdsOf(dialog);
				void debugLog(`im-group[${sidTag}] members=${ids.length} ids=${ids.join(',').slice(0, 120)}`);
			}
			// pinned-only 模式：丢弃非显式内容（显式记住走 /memory remember，不经这里）
			if (mode === 'pinned-only') return;
			const entries = dialog
				.filter((entry) => isUsefulLine(entry.content))
				.map((entry) => ({ role: entry.role, content: entry.content }));
			if (entries.length === 0) {
				void debugLog('IM 前置闸：全部消息为噪音，不入批');
				return;
			}
			enqueueIm(sessionId, entries);
			return;
		}

		// 桌面：节流 + A4 游标增量。旧做法每轮把尾部 20 条窗口整段重喂提取 LLM
		// （靠 sameFactNormalized 去重兜底，token 白花）；现在只喂"上次已交提取之后
		// 新增"的部分。节流跳过时游标不前进，新增自然累积到下次一起喂——不丢消息。
		// 锚点找不到（压缩/rewind 改写历史）→ 回退整段尾部窗口，宁重喂不漏喂。
		const throttleMs = Number(readConfigValue(config.rememberThrottleSeconds) ?? 45) * 1000;
		const last = lastRememberAt.get(sessionId) ?? 0;
		if (Date.now() - last < throttleMs) {
			void debugLog(`桌面节流：距上次写入不足 ${Math.round(throttleMs / 1000)}s，跳过（增量累积中）`);
			return;
		}
		let feed = dialog;
		const prevSig = rememberTail.get(sessionId);
		if (prevSig) {
			let anchor = -1;
			for (let i = dialog.length - 1; i >= 0; i -= 1) {
				if (dialogEntrySignature(dialog[i]) === prevSig) { anchor = i; break; }
			}
			if (anchor >= 0) feed = dialog.slice(anchor + 1);
			else void debugLog('桌面提取：游标锚点未命中（历史被改写），回退整段窗口');
		}
		if (feed.length === 0) {
			void debugLog(`桌面提取：无新增（游标命中，窗口${dialog.length}条）`);
			return;
		}
		lastRememberAt.set(sessionId, Date.now());
		rememberTail.set(sessionId, dialogEntrySignature(dialog[dialog.length - 1]));
		void debugLog(`桌面提取：增量${feed.length}条（窗口${dialog.length}条）`);
		// v0.6.0：桌面写入携带会话工作区键，general=false 的新卡挂这个标
		void rememberDialog(sessionId, feed, {
			workspace: sessionWorkspace(String(payload.agent?.session?.header?.cwd ?? ''))
		});
	});

	/**
	 * 从 session.deriveMessages() 取 user/assistant 对话（跳过插件 notice），
	 * 只保留尾部 20 条——4B 模型的上下文和注意力都有限，宁少勿滥。
	 */
	function messagesFromSession(session) {
		if (!session || typeof session.deriveMessages !== 'function') {
			void debugLog('messagesFromSession: session.deriveMessages 不可用');
			return [];
		}
		let messages;
		try {
			messages = session.deriveMessages();
		} catch (error) {
			void debugLog(`messagesFromSession FAILED: ${errorMessage(error)}`);
			return [];
		}
		const dialog = [];
		for (const message of messages ?? []) {
			if (message?.role !== 'user' && message?.role !== 'assistant') continue;
			if (isPluginMessage(message)) continue;
			const text = textOf(message);
			// A3：合成内容（压缩摘要/系统注入/召回块）不进提取管道——只信原文
			if (!text || isSyntheticExtractionNoise(text)) continue;
			dialog.push({ role: message.role, content: text });
		}
		return dialog.slice(-20);
	}

	// ==================================================================
	// ⑤ 定时维护
	// ==================================================================
	ctx.effect(function* () {
		const minutes = readConfigValue(config.maintenanceMinutes) ?? 60;
		const handle = setInterval(() => { void runMaintenance(); }, Math.max(1, minutes) * 60000);
		handle.unref?.();
		yield () => clearInterval(handle);
	});

	// ==================================================================
	// ⑥ /memory 手动入口 + 生命周期
	// ==================================================================
	ctx.effect(function* () {
		yield () => {
			ollamaSupervisor.stop();
			void backend.dispose();
		};
		yield ctx.commands.register({
			name: 'memory',
			description: '长期记忆：直接输入查看状态；recall <查询> / remember <内容> / list / maintenance / export / cold <关键词>',
			handler: async (invocation) => {
				const raw = String(invocation?.rawInput ?? '').trim();
				const [verb, ...rest] = raw.split(/\s+/);
				const arg = rest.join(' ').trim();
				try {
					await ready;
					syncConfig();
					if (verb === 'recall') {
						if (!arg) return { kind: 'error', text: '用法：/memory recall <查询>' };
						const hits = await backend.recall(arg, 5);
						if (!hits.length) return { kind: 'success', text: '（没有命中记忆）' };
						// A7：查询面也是模型可见面——加一行「数据非指令」声明；正文清孤立代理。
						const lines = hits.map((h) => `- [${h.card.category} 重要${h.card.importance.toFixed(2)}] ${stripLoneSurrogates(h.card.content)}`);
						return { kind: 'success', text: `${QUERY_NOTICE}\n召回结果：\n${lines.join('\n')}` };
					}
					if (verb === 'remember') {
						if (!arg) return { kind: 'error', text: '用法：/memory remember <要记住的内容>' };
						const report = await backend.remember([{ role: 'user', content: arg }], { pinned: true });
						await refreshHot();
						return {
							kind: 'success',
							text: `已记住：提取${report.factsExtracted} 新增${report.added.length} 更新${report.updated.length} 跳过${report.skipped}`
						};
					}
					if (verb === 'maintenance') {
						const stats = await runMaintenance();
						return { kind: 'success', text: `维护完成：${JSON.stringify(stats)}` };
					}
					if (verb === 'export') {
						const dir = readTrimmedString(config.exportDir);
						if (!dir) return { kind: 'error', text: '未配置 exportDir：在设置里填导出目录（留空=不导出）' };
						if (!backend.engine?.store) return { kind: 'error', text: 'python 后端暂不支持 export' };
						const format = readTrimmedString(config.exportFormat) || 'md';
						const result = await exportStore(backend.engine.store, dir, format);
						return { kind: 'success', text: `已导出 ${result.count} 张活跃卡片 → ${result.path}` };
					}
					if (verb === 'cold') {
						const text = await backend.searchCold(arg);
						return { kind: 'success', text: text ? `${QUERY_NOTICE}\n${stripLoneSurrogates(text)}` : `（冷层没有匹配 "${arg}" 的条目）` };
					}
					if (verb === 'forget') {
						if (!arg) return { kind: 'error', text: '用法：/memory forget <关键词或卡片id>（软删，进 cold 归档）' };
						const removed = await backend.forget(arg);
						await refreshHot();
						if (!removed.length) return { kind: 'success', text: `没有匹配 "${arg}" 的卡片` };
						// A3（A4 审计修正）：slice(0,40) 会劈开 emoji 代理对 → 命令结果进历史后
						// JSON 化出非法码元，服务端可能拒整条请求。改用不劈代理对的安全截断。
						const lines = removed.map((card) => `- ${truncateSafe(card.content, 40)}`);
						return { kind: 'success', text: `${QUERY_NOTICE}\n已删除 ${removed.length} 张卡片（进 cold 归档，可 /memory cold 找回）：\n${lines.join('\n')}` };
					}
					if (verb === 'list' || verb === 'cards') {
						if (typeof backend.listCards !== 'function') {
							return { kind: 'error', text: 'python 后端暂不支持 list，用 /memory status 看统计' };
						}
						const cards = backend.listCards();
						if (!cards.length) return { kind: 'success', text: '（记忆库为空）' };
						const tierTag = { hot: '🔥', warm: '🌤️', cold: '❄️' };
						const lines = cards.map(
							(c) => `${tierTag[c.tier] ?? '·'} [${String(c.id).slice(-4)}]${c.ws && c.ws !== '*' ? ` @${c.ws}` : ''} 重要${Number(c.importance).toFixed(2)} ${stripLoneSurrogates(c.content)}`
						);
						return { kind: 'success', text: `${QUERY_NOTICE}\n记忆库共 ${cards.length} 张活跃卡片：\n${lines.join('\n')}` };
					}
					// 无参数/未知：显示状态
					const status = await backend.status();
					const routeText = chatRoute() === 'dsh'
						? `云端 ${readTrimmedString(config.dshProvider) || '?'}/${readTrimmedString(config.dshModel) || '?'}`
						: `本地 ${readTrimmedString(config.chatModel) || 'qwen3:4b'}`;
					const health = backend.kind === 'local'
						? (ollamaOk === false ? '⚠️ ollama 离线（召回不可用）' : '✅ ollama 在线')
						: '✅ python 后端';
					// C3（契约 I5）：三项「记忆可能没记住」的信号，此前只躺在 debug.log 里。
					// 只在有问题时输出，正常情况一个字都不加（状态面板不该变啰嗦）。
					const warnings = [];
					if (writeHealth.failures > 0) {
						const agoMin = Math.max(0, Math.round((Date.now() - writeHealth.failAt) / 60000));
						warnings.push(`⚠️ 写入失败 ${writeHealth.failures} 次（最近 ${agoMin} 分钟前）：${truncateSafe(writeHealth.lastError, 80)}`);
					}
					try {
						const queued = await loadRetryQueue(retryPath);
						if (queued.length > 0) warnings.push(`⚠️ 重试队列待重放 ${queued.length} 个对话窗`);
					} catch {
						/* 队列读不到不影响状态输出 */
					}
					const liveStore = backend.engine?.store;
					if (liveStore) {
						const noVec = liveStore.all().filter((c) => !Array.isArray(c.embedding) || c.embedding.length === 0).length;
						if (noVec > 0) warnings.push(`⚠️ ${noVec} 张卡缺向量（只能字面召回，语义检索找不到）`);
					}
					const warningText = warnings.length > 0 ? `\n${warnings.join('\n')}` : '';
					return {
						kind: 'success',
						text: `后端：${backend.kind} ｜ 写入模型：${routeText} ｜ ${health}\n${JSON.stringify(status)}${warningText}\n\n${renderUntrustedBlock(sanitizeForContext(hotText))}`
					};
				} catch (error) {
					return { kind: 'error', text: `记忆操作失败：${errorMessage(error)}` };
				}
			}
		});
	});
}

// ----------------------------------------------------------------------
/** 从消息列表里取最后一条用户文本（跳过插件 notice）。 */
function latestUserText(messages) {
	if (!Array.isArray(messages)) return '';
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== 'user' || isPluginMessage(message)) continue;
		const text = textOf(message);
		// A3：压缩摘要/系统注入不当作用户查询——压缩后的第一轮没有真实用户文本就干脆不召回
		if (text && !isSyntheticExtractionNoise(text)) return text;
	}
	return '';
}

/** 拼接消息的 text 块。 */
function textOf(message) {
	if (!message || !Array.isArray(message.content)) return '';
	return message.content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
		.trim();
}

/** 插件产生的消息（source.kind = 'plugin:xxx'）。 */
function isPluginMessage(message) {
	const kind = message?.source?.kind;
	return typeof kind === 'string' && kind.startsWith('plugin:');
}

/**
 * A3合成内容判别：压缩摘要、宿主系统注入、本插件召回块都不是
 * 用户/助手真的说过的话。两处消费：提取管道（防摘要转述被记成事实——二次
 * 转述=幻觉进库）与召回查询派生（防拿摘要当用户查询）。
 */
function isSyntheticExtractionNoise(text) {
	if (text.includes('<compacted-summary>')) return true; // DSH 压缩检查点
	if (text.startsWith('<system-reminder>')) return true; // 宿主系统注入（技能目录/运行时上下文等）
	if (text.startsWith('[memory recall]')) return true;   // 本插件召回块（isPluginMessage 已挡一层，兜底）
	return false;
}

/** 召回结果 → 一条 notice 用户消息。 */
function memoryNotice(hits) {
	const lines = hits.map((hit) => {
		// v0.4.9 时间线标注：事实"从何时起是真的"。今天刚写的不标（省字符），
		// ≥1 天的带 自MM-dd——模型据此判断信息新旧，过时记忆自己会打折。
		const from = Number(hit.card.validFrom ?? hit.card.createdAt ?? 0);
		const ageDays = from > 0 ? (Date.now() - from) / 86400000 : 0;
		const when = ageDays >= 1 ? ` 自${fmtMonthDay(from)}` : '';
		const rel = Number(hit.relevance);
		const relTag = rel >= 0.01 ? `相关${rel.toFixed(2)}` : `字面${Number(hit.bm25 ?? 0).toFixed(2)}`;
		return `- [${hit.card.category} 重要${Number(hit.card.importance).toFixed(2)} ${relTag}${when}] ${hit.card.content}`;
	});
	const text = buildRecallText({
		header: '[memory recall] 根据用户当前消息，从长期记忆库中检索到以下内容（按匹配度排序）：',
		lines,
		footer: [
			'（以上是历史记忆，仅供参考；与当前语境无关时请忽略）',
			// A2 闭合围栏：与首行 [memory recall] 成对，历史查重按"围栏块全文相等"判定
			'[/memory recall]'
		]
	});
	return createUserMessage({
		content: [{ type: 'text', text }],
		source: {
			kind: 'plugin:dsh-memory',
			form: 'notice',
			summary: `记忆召回：${hits.length} 条`
		}
	});
}

/** A4 游标签名：role + 全文。相同签名视为同一条消息（查重窗口内足够稳定）。 */
function dialogEntrySignature(entry) {
	return `${entry?.role ?? ''}\u0000${entry?.content ?? ''}`;
}

/** MM-dd 短日期。 */
function fmtMonthDay(ms) {
	const d = new Date(Number(ms ?? 0));
	const pad = (n) => String(n).padStart(2, '0');
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/** 自动探测 ollama 可执行文件常见安装位置（win32 / Linux 双平台，A5）。 */
function autoDetectOllama() {
	const home = process.env.USERPROFILE || process.env.HOME;
	const candidates = process.platform === 'win32' ? [
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : '',
		'C:\\Program Files\\Ollama\\ollama.exe'
	] : [
		'/usr/bin/ollama',
		'/usr/local/bin/ollama',
		home ? join(home, '.local', 'bin', 'ollama') : '',
		'/snap/bin/ollama'
	].filter(Boolean);
	for (const candidate of candidates) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			/* 不存在 */
		}
	}
	return '';
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 自检标记：初始化成功时落一个 .ready 文件，便于确认插件完整激活。 */
async function writeReadyMarker(dataDir, backendKind, hotText) {
	try {
		const { mkdir, writeFile } = await import('node:fs/promises');
		await mkdir(dataDir, { recursive: true });
		await writeFile(
			join(dataDir, '.ready'),
			`${new Date().toISOString()} backend=${backendKind}\n${hotText.split('\n')[0]}\n`,
			'utf8'
		);
	} catch {
		/* 标记失败不影响主流程 */
	}
}
