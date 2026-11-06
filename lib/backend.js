/**
 * Backend 抽象层 —— local（TS 一体化） / python（HTTP 桥）双实现，可切换。
 *
 *   Config.backend = 'local'  → 直接跑内存里的 MemoryEngine（A 主力）
 *   Config.backend = 'python' → fetch 到本机 Python 服务（B 备用）
 *
 * 两个实现暴露同一组方法，插件业务逻辑只写一遍：
 *   init(), recall(query, k), remember(dialog), hotBlock(), maintenance(),
 *   searchCold(keyword), status(), dispose()
 *
 * @module dsh-memory/lib/backend
 */

import { spawn } from 'node:child_process';
import { MemoryEngine } from './engine.js';

/** local 后端：TS 一体化，直接调 MemoryEngine。 */
class LocalBackend {
	constructor(config, deps) {
		this.kind = 'local';
		this.engine = new MemoryEngine(config, deps);
	}

	async init() {
		await this.engine.init();
	}

	recall(query, k, options) {
		return this.engine.recall(query, k, options);
	}

	remember(dialog, options) {
		return this.engine.remember(dialog, options);
	}

	hotBlock(ws = null) {
		// v0.6.0 工作区视图透传；python 后端无参调用回落通用视图（ws=null 同义）
		return this.engine.hotBlock(ws);
	}

	maintenance() {
		return this.engine.maintenance();
	}

	searchCold(keyword) {
		return this.engine.searchCold(keyword);
	}

	forget(keyword) {
		return this.engine.forget(keyword);
	}

	status() {
		return this.engine.status();
	}

	listCards() {
		return this.engine.listCards();
	}

	async dispose() {
		await this.engine.dispose();
	}
}

/** python 后端：HTTP 桥，可选自动拉起 Python 子进程。 */
class PythonBackend {
	constructor(config, logger) {
		this.kind = 'python';
		this.config = config;
		this.logger = logger;
		this.url = String(config.pythonUrl ?? 'http://127.0.0.1:8765').replace(/\/+$/, '');
		this.child = null;
	}

	async init() {
		if (await this._healthy()) return;
		if (!this.config.pythonAutoStart) return;
		await this._spawn();
	}

	async recall(query, k) {
		const data = await this._post('/recall', { query, k });
		return data.results ?? [];
	}

	async remember(dialog, { pinned = false } = {}) {
		const data = await this._post('/remember', { dialog, pinned });
		return data;
	}

	async hotBlock() {
		const data = await this._get('/hot');
		return data.text ?? '[长期记忆]（空）';
	}

	async maintenance() {
		return this._post('/maintenance', {});
	}

	async searchCold(keyword) {
		const data = await this._get('/cold', { keyword });
		return data.text ?? '';
	}

	async forget(keyword) {
		const data = await this._post('/forget', { keyword });
		return data.removed ?? [];
	}

	async status() {
		return this._get('/status');
	}

	async dispose() {
		if (this.child) {
			try {
				this.child.kill();
			} catch {
				/* ignore */
			}
			this.child = null;
		}
	}

	// ---- 内部 ---------------------------------------------------------
	async _healthy() {
		try {
			const response = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
			return response.ok;
		} catch {
			return false;
		}
	}

	async _spawn() {
		const script = String(this.config.pythonScript ?? '').trim();
		const exe = String(this.config.pythonExe ?? 'python').trim() || 'python';
		if (!script) {
			this.logger?.warn?.('dsh-memory: python 后端未配置 pythonScript，跳过自动启动');
			return;
		}
		this.child = spawn(exe, [script, '--port', String(this.url.split(':').pop())], {
			stdio: 'ignore',
			detached: false
		});
		this.child.on?.('exit', () => {
			this.child = null;
		});
		// 等它起来（最多 15 秒）
		for (let i = 0; i < 30; i += 1) {
			await sleep(500);
			if (await this._healthy()) {
				this.logger?.info?.(`dsh-memory: python 后端已启动 ${this.url}`);
				return;
			}
		}
		this.logger?.warn?.(`dsh-memory: python 后端启动超时 ${this.url}`);
	}

	async _get(path, query) {
		const qs = query ? `?${new URLSearchParams(query)}` : '';
		const response = await fetch(`${this.url}${path}${qs}`, {
			signal: AbortSignal.timeout(this.config.pythonTimeoutMs ?? 180000)
		});
		if (!response.ok) throw new Error(`python 后端 HTTP ${response.status} ${path}`);
		return response.json();
	}

	async _post(path, payload) {
		const response = await fetch(`${this.url}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(this.config.pythonTimeoutMs ?? 180000)
		});
		if (!response.ok) throw new Error(`python 后端 HTTP ${response.status} ${path}`);
		return response.json();
	}
}

/**
 * 按配置创建后端。
 * @param {object} config - 插件配置
 * @param {object} deps - local 后端依赖 { dataDir, chat, embed }
 * @param {object} logger
 * @returns {LocalBackend | PythonBackend}
 */
export function createBackend(config, deps, logger) {
	return config.backend === 'python'
		? new PythonBackend(config, logger)
		: new LocalBackend(config, deps);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
