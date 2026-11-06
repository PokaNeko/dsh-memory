/**
 * ws-migrate —— v0.6.0 存量卡工作区归类脚本（手动备选工具）。
 *
 * ⚠️ 首选路径是引擎内置的启动自动迁移（lib/engine.js 的 applyLegacyWsMap：
 * init 时按 scripts/ws-map.json 打标并落 data/.ws-migrated 标记）——宿主内存态
 * 权威，运行期间在盘上跑本脚本会被下一次 save() 覆盖。本脚本只在
 * **宿主停机**（或对副本数据）时使用。
 *
 * 用法：
 *   node scripts/ws-migrate.mjs --dry-run              # 预览不落盘
 *   node scripts/ws-migrate.mjs                        # 按映射落盘（自动先备份）
 *   node scripts/ws-migrate.mjs --data <dir> --map <file>
 *
 * 规则：
 *   - 映射文件 {"<ws>": ["cardId", ...]}；表外的卡一律归 '*'（通用）。
 *   - 幂等：已有非空 ws 字段的卡跳过（--force 可重打）。
 *   - 落盘前把 cards.json 复制到 data/backup/ws-migrate-<时间戳>.json。
 *   - 只改 ws 字段，不碰 tier/status——分层重算交给维护期。
 *
 * @module dsh-memory/scripts/ws-migrate
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const args = { dryRun: false, force: false, data: '', map: '' };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === '--dry-run') args.dryRun = true;
		else if (a === '--force') args.force = true;
		else if (a === '--data') args.data = argv[++i] ?? '';
		else if (a === '--map') args.map = argv[++i] ?? '';
		else if (a === '-h' || a === '--help') {
			console.log('用法：node scripts/ws-migrate.mjs [--dry-run] [--force] [--data <dir>] [--map <file>]');
			process.exit(0);
		}
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(args.data || join(scriptDir, '..', 'data'));
const cardsPath = join(dataDir, 'cards.json');
const mapPath = resolve(args.map || join(scriptDir, 'ws-map.json'));

// ---- 读映射：ws → id 集合，再反转成 id → ws ----
let rawMap;
try {
	rawMap = JSON.parse(await readFile(mapPath, 'utf8'));
} catch (error) {
	console.error(`读不到映射表：${mapPath}`);
	console.error('先把 scripts/ws-map.example.json 复制成 scripts/ws-map.json，再按自己的卡库填 id。');
	console.error(`（${error.message}）`);
	process.exit(1);
}
const idToWs = new Map();
for (const [ws, ids] of Object.entries(rawMap)) {
	if (ws.startsWith('$') || !Array.isArray(ids)) continue;
	for (const id of ids) idToWs.set(String(id), ws);
}

// ---- 读卡库 ----
const payload = JSON.parse(await readFile(cardsPath, 'utf8'));
const cards = Array.isArray(payload?.cards) ? payload.cards : [];

const stats = { total: cards.length, tagged: 0, kept: 0, unknownIds: 0 };
const unknown = [];
for (const card of cards) {
	if (card.ws && !args.force) {
		stats.kept += 1; // 幂等：已有标签的跳过
		continue;
	}
	const mapped = idToWs.get(String(card.id));
	if (idToWs.size > 0 && mapped === undefined) stats.unknownIds += 1;
	card.ws = mapped ?? '*';
	stats.tagged += 1;
}
// 映射表里指向不存在卡片的 id（防手抖打错）
for (const id of idToWs.keys()) {
	if (!cards.some((c) => String(c.id) === id)) unknown.push(id);
}

console.log(`库：${cardsPath}`);
console.log(`映射：${mapPath}（${idToWs.size} 个显式 id）`);
console.log(`结果：打标 ${stats.tagged} 张 / 已有标签跳过 ${stats.kept} 张 / 表外默认 '*' 的 ${stats.unknownIds} 张`);
if (unknown.length > 0) console.log(`⚠️ 映射表里有 ${unknown.length} 个 id 在库中不存在：${unknown.join(', ').slice(0, 200)}`);

// 分布预览
const dist = new Map();
for (const card of cards) {
	const k = card.ws ?? '*';
	dist.set(k, (dist.get(k) ?? 0) + 1);
}
const parts = [...dist.entries()].map(([k, n]) => (k === '*' ? `通用(*)=${n}` : `@${k}=${n}`));
console.log(`分布：${parts.join(' ')}`);

if (args.dryRun) {
	console.log('--dry-run：未落盘。');
	process.exit(0);
}
if (stats.tagged === 0) {
	console.log('没有需要打标的卡，不落盘不备份。');
	process.exit(0);
}

// ---- 备份 + 原子写 ----
const stamp = new Date();
const pad = (n) => String(n).padStart(2, '0');
const backupName = `ws-migrate-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`;
const backupPath = join(dataDir, 'backup', backupName);
await mkdir(dirname(backupPath), { recursive: true });
await copyFile(cardsPath, backupPath);
console.log(`备份：${backupPath}`);

payload.savedAt = Date.now();
const tmp = `${cardsPath}.tmp`;
await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
await rename(tmp, cardsPath);
console.log('已落盘。记得跑一次 /memory maintenance 让热层按工作区重新装配。');
