/**
 * 写入失败重试队列（v0.3.4）—— LLM 传输层抖动不再丢档。
 *
 * 背景（debug.log 实录）：复读机 500、连接崩、超时——下一轮写入都自愈了，
 * 但那一窗对话的提炼永久丢失。队列是纯 JSON 文件（data/retry-queue.json），
 * 失败入队、下次写入成功或维护期重放；5 次仍失败/超 48h 的条目放弃。
 *
 * @module dsh-memory/lib/retry
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_ENTRIES = 20;   // 队列上限（每条是一窗对话，20 窗足够缓冲一天的事故）
const MAX_AGE_MS = 48 * 3600 * 1000;
const MAX_ATTEMPTS = 5;

/** 读队列（文件不存在视为空）。 */
export async function loadRetryQueue(path) {
	try {
		const data = JSON.parse(await readFile(path, 'utf8'));
		return Array.isArray(data?.entries) ? data.entries : [];
	} catch (error) {
		if (error?.code === 'ENOENT') return [];
		return []; // 损坏文件当作空——丢重试别丢主流程
	}
}

/** 原子写队列。 */
export async function saveRetryQueue(path, entries) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify({ savedAt: Date.now(), entries }, null, 2), 'utf8');
	await rename(tmp, path);
}

/**
 * 入队（纯函数，便于测试）：去重（同会话末条用户消息相同视为同批）、
 * 淘汰超龄、封顶。返回新数组和是否真的入队。
 */
export function enqueueRetry(entries, { sessionId, dialog, options }, now = Date.now()) {
	const lastUser = [...(dialog ?? [])].reverse().find((m) => m?.role === 'user')?.content ?? '';
	const dup = entries.some(
		(e) => e.sessionId === sessionId && lastUser && lastUserOf(e.dialog) === lastUser
	);
	if (dup) return { entries, added: false };
	const fresh = entries.filter((e) => now - e.ts < MAX_AGE_MS && e.attempts < MAX_ATTEMPTS);
	fresh.push({ ts: now, sessionId: String(sessionId ?? ''), dialog, options: options ?? {}, attempts: 0 });
	const capped = fresh.slice(-MAX_ENTRIES);
	return { entries: capped, added: true };
}

/**
 * 重放（drain）：逐条调 run(dialog, options)，成功移除、失败计数。
 * @param {Function} run - async (dialog, options) => void，抛错即失败
 * @returns {Promise<{ok: number, fail: number, entries: Array}>}
 */
export async function drainRetryQueue(entries, run, { max = 3 } = {}) {
	const rest = [...entries];
	let ok = 0;
	let fail = 0;
	for (const entry of rest.splice(0, max)) {
		try {
			await run(entry.dialog, entry.options);
			ok += 1;
		} catch {
			fail += 1;
			entry.attempts = (entry.attempts ?? 0) + 1;
			if (entry.attempts < MAX_ATTEMPTS) rest.push(entry); // 仍有机会；满次数的就此放弃
		}
	}
	return { ok, fail, entries: rest };
}

function lastUserOf(dialog) {
	return [...(dialog ?? [])].reverse().find((m) => m?.role === 'user')?.content ?? '';
}
