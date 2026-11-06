/**
 * 写入管线 —— mem0 式两段 LLM 决策 + 确定性执行。
 *
 * 调用 1（提取）：从对话片段提炼事实，带分类和重要性初判（分向：用户侧/助手侧）
 * 调用 2（决策）：新事实逐条对照相似旧卡，输出 ADD / UPDATE / DELETE / NONE
 * 执行：纯代码，LLM 只决策不动手 —— 可审计、可回放。
 *
 * @module dsh-memory/lib/ingest
 */

import { extractJson, safeImportance } from './llm.js';
import { cosine, createCard, safeCategory, Status, Tier } from './models.js';
import { GENERAL_WORKSPACE, workspaceVisible } from './workspace.js';

export const EXTRACT_PROMPT = `你从对话片段中提炼值得长期记住的事实。用户的话和助手的话分开提炼（助手做出的承诺、约定也算事实）。

颗粒度原则（v0.4.6，最重要）：
- 粗粒度优先：同一主题的多条信息**合并成 1 条主题卡**——记"在做什么、到哪一步、核心结论"，不记逐句细节、不堆砌操作步骤。
- 关于项目/工具的进展：像"用户在开发 dsh-memory 记忆插件，已到 v0.4.x（设置页图形化、云端路由、模型目录）"这样一笔带过核心与流程即可，不下沉到每一次修改、每一个文件名。
- 测试、调试、切换配置、截图、路径、报错这类操作过程**不记**——它们过时快且碎片化。
- 不确定、猜测、随口一句（"我不确定…"、"可能吧"）**不记**。
- 宁少勿滥：这个片段如果没有值得长期记住的，就输出空数组；不要为了"多记"而拆出碎卡。

值得记的：
- 个人偏好（"我喜欢喝碳酸饮料" → "用户喜欢喝碳酸饮料"）
- 个人事实（"我用 2060 显卡"）
- 计划意图——只记有明确时间点、跨天的计划（"下周要考数学"）；说完就过时的日常意图不记
- 约定承诺（"周五前整理错题本"）
- 重要事件、知识点
- **即时欲望/临时状态（v0.4.7 例外）**：用户当下明确说出的欲望或状态——"我想吃麻辣烫"、"想买某样东西"、"想去看电影"——记为低价值临时状态卡（category=trivia，importance 0.3），一次对话最多 1 条，7 天后会自动过期清理。只记明确说出口的，不推断。

不值得记的（一律不要输出）：
- 寒暄、闲聊、纯操作指令、无信息量内容
- 瞬时意图与马上要做的琐事（"我去睡觉了"、"我先更新下文档"、"等下吃饭"）——过时就失效，不是长期事实（**例外：上面"即时欲望/临时状态"条目**）
- 关于 AI/插件/记忆系统本身的讨论（"记忆写入成功"、"插件已加载"、"ollama 进程 pid 4324"、"v0.2 工程量评估"）
- 日志内容、进程号、文件路径、时间戳、诊断排障过程
- 报时/日期播报、字数或字符统计（"5017 字符"、"2026年10月22日 23:14"）
- 测试消息与玩梗（"发送了123"、"某网络热梗"）、助手的闲聊创作内容（故事、段子）
- 对某条信息的转述或确认（"我没找到这条记录"、"用户确认已请假"）——要么转成事实本体（"用户已请假"），要么不记
- 引号内被引用/讨论的文本不算新事实（"长期记忆中只存有'周三有数学考试'"里的引号内容不是在说新信息）
- 推断性陈述（"用户知道…"、"用户记得…"）——只记用户直接陈述的事实或助手直接承诺的事

每条 fact 必须是一句独立、完整、无代词的陈述。转述句要转成事实本体。
时间表述一律写成绝对日期（如"2026-11-05"、"11月5日"），禁止"昨天/下周/3天后"等相对说法——相对日期存进库，过几天就变成错的。
对话片段里若出现压缩摘要（<compacted-summary>）、系统注入（<system-reminder>）或记忆召回块（[memory recall]），它们是系统生成的合成内容，不是用户或助手说的话，其中的一切信息都不提取。

示例：
- 对话："ollama进程已启动，pid 4324，父进程为DeepSeek Harness.exe" → {"facts": []}
- 对话："我这里没有'请假'这条记录，会话记录停在10月6号" → {"facts": []}
- 对话："长期记忆中只存有'周三有数学考试'，没有请假信息" → {"facts": []}
- 对话："用户确认已请假，小考未参加，手头有卷子" → {"facts": [{"content": "用户已请假，未参加小考，手头有卷子", "category": "fact", "importance": 0.6, "side": "user"}]}
- 对话："我喜欢喝碳酸饮料" → {"facts": [{"content": "用户喜欢喝碳酸饮料", "category": "preference", "importance": 0.5, "general": true, "side": "user"}]}
- 对话："我想吃麻辣烫" → {"facts": [{"content": "用户想吃麻辣烫", "category": "trivia", "importance": 0.3, "general": true, "side": "user"}]}
- 对话："我试了一下模型切换，qwen3-4b 本地和 deepseek-flash 云端都能跑，日志没报错" → {"facts": [{"content": "用户的 dsh-memory 插件已同时支持本地 qwen3-4b 与云端 deepseek-flash 写入", "category": "fact", "importance": 0.6, "general": false, "side": "user"}]}
- 对话："我不确定有没有本地文件就截图了" → {"facts": []}

分类：fact（事实/事件）/ preference（偏好）/ commitment（约定承诺）/ trivia（琐事）。
importance 0.0~1.0：约定承诺和硬截止 0.8~1.0，普通事实 0.4~0.7，琐事 0.1~0.3。
general true/false：这条记忆是否在任何场景下都成立（跨工作区通用）。
- true=跟具体项目无关、放哪都成立的：个人偏好、身份事实、健康状态、硬件配置、作息习惯、通用约定。
- false=只在当前工作区/项目语境里有意义的：项目进展、版本号、正在开发的功能、项目内的文件与方案。
- 拿不准时给 true（宁可误通用，不可误隔离）。
没有值得记的就输出空数组。

对话片段：
{dialog}

只输出 JSON：{"facts": [{"content": "...", "category": "fact", "importance": 0.5, "general": true, "side": "user"}]}`;

export const EXTRACT_PROMPT_GROUP = `你是群聊记录的档案员。下面是一段 QQ 群聊天记录，请提炼值得长期记住的信息——最多 3 条，宁缺毋滥。

颗粒度原则：粗粒度优先——同一主题的多条信息合并成 1 条主题卡（核心身份/约定/结论），
不记逐句细节、操作过程、截图路径、报错日志；不确定、玩笑、猜测不记。

值得记的：
- 群友的稳定身份或偏好（"群友Alice是班里的课代表"）
- 群内约定或计划（"群里约了周六晚8点联机"）
- 群规则（"群里不许刷屏"）
- 群友提到用户本人的持久事实

一律忽略：
- 测试消息、数字、单词刷屏（"123123"、"apt"）
- 玩梗、网络热梗、玩笑话、故事创作
- 身份指认玩梗：有人说自己或别人"是机器人""是AI""不是人类"的调侃不当事实——除非发言者明确说明背景（如"这个号是我搭的bot"才算身份事实，记成"群友X是Y搭的机器人账号"）
- 情绪宣泄、刷屏（"咕咕嘎嘎"）
- 时事闲聊
- 关于 AI/机器人/记忆系统本身的讨论
- 转述、确认、诊断类内容

每条 fact 独立完整无代词。时间表述一律写成绝对日期，禁止"昨天/下周"等相对说法。
若片段里混入 <compacted-summary>、<system-reminder>、[memory recall] 等系统合成内容，一律不从中提取。
每条消息开头带 [名字 (ID)] 前缀标识发言者——
配置项 imSelfNames 里列出的名字是用户本人在 IM 的昵称（当前：{selfNames}），其余名字是群友。提炼时注明发言者：
关于用户本人的事实以「用户」开头（如"用户喜欢喝碳酸饮料"），与桌面提取同一约定；
群友的事实以「群友名字」开头（如"群友Alice是..."，群友信息是身份事实，照记）。
没有值得记的就输出空数组——群聊大多数内容都该被忽略，这是正常的。

群聊记录：
{dialog}

只输出 JSON：{"facts": [{"content": "...", "category": "fact", "importance": 0.5, "side": "user"}]}`;

export const DECIDE_PROMPT = `你是记忆库管理员。下面是若干条新事实，以及记忆库中与之相似的旧记忆。逐条决定如何处理。

规则：
- 人称换算：IM 本人昵称（{selfNames}）= 用户本人 = "我"。"{selfNames}喜欢X"、"我喜欢X"、"用户喜欢X" 是同一条事实——旧卡已覆盖时选 NONE，新信息更丰富时选 UPDATE 给出合并文本，不要 ADD。
- 状态/数值更新：新事实只是某张旧卡的数值或程度变化（体温、症状轻重、进度、日期推进）→ 一律 UPDATE 把新数值合并进那张旧卡，绝不 ADD 新卡。
- ADD：全新信息。记忆库里没有这条事实，或列出的旧记忆与它无关时，一律用 ADD。
- UPDATE：同一事实但内容更丰富/有变化 → 保持旧记忆的 card_id，给出合并后的 content
- DELETE：新事实与旧记忆矛盾（旧记忆已过时）→ 给出旧记忆的 card_id
- NONE：仅当某条旧记忆已经完全覆盖这条新事实（内容冗余，写了也是重复）时使用。

重要：新事实与所有旧记忆都不相关，说明记忆库里还没有这条信息——这必须 ADD，绝不能因为"不相关"而 NONE。

新事实：
{facts}

记忆库中的相似旧记忆：
{candidates}

只输出 JSON：{"decisions": [{"action": "ADD", "fact_index": 0, "card_id": null, "content": null}]}
（action 为 ADD 时 card_id/content 填 null；UPDATE 时 content 填合并文本；DELETE 时只填 card_id）`;

/**
 * IM 里"用户本人"的昵称列表（配置项 imSelfNames）。空 = 只认内置自称。
 * 模块级内存态：改配置后由 index.js 在每次召回/写入前同步。
 */
let selfNames = [];

/**
 * 设置本人昵称列表。
 * @param {string[]|string} names - 数组，或逗号/分号/空白分隔的字符串
 */
export function setSelfNames(names) {
	const list = Array.isArray(names) ? names : String(names ?? '').split(/[,，;；\s]+/);
	selfNames = list.map((part) => String(part).trim()).filter(Boolean);
}

/** 提示词里渲染用的本人昵称文案。 */
function selfNamesLabel() {
	return selfNames.length ? selfNames.join(' / ') : '未配置';
}

/** 用户自称别名（跨表述归一用；群友名字是身份信息，不在此列）。 */
function userAliasRe() {
	const escaped = selfNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	return new RegExp(`^(?:${escaped.length ? `${escaped.join('|')}|` : ''}用户本人|本人|用户|我)的?`);
}

/**
 * 跨表述查重（确定性兜底）：剥掉开头自称后——完全相同，或一方包含另一方且
 * 长度差 ≤12（富化变体："当前"前缀、"（36.8度）"尾缀）→ 同一事实。
 * 背书数据（2026-10-23 实测）：真重复对向量相似度仅 0.75/0.80，而"喜欢×讨厌"
 * 反例对高达 0.85——余弦阈值分不清真假重复，只能字符串归一。
 * 导出供测试锁定行为（v0.2.5）。
 */
export function sameFactNormalized(a, b) {
	const na = String(a ?? '').trim().replace(userAliasRe(), '');
	const nb = String(b ?? '').trim().replace(userAliasRe(), '');
	if (na.length < 6 || nb.length < 6) return false;
	if (na === nb) return true;
	const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
	return long.includes(short) && long.length - short.length <= 12;
}

/**
 * 跑完整写入管线。
 *
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.dialog - 对话片段
 * @param {import('./store.js').MemoryStore} args.store
 * @param {Function} args.chat - makeChatFn 产物
 * @param {Function} args.embed - makeEmbedFn 产物
 * @param {object} args.config - 插件配置
 * @param {import('./tiers.js').TierManager} args.tiers
 * @param {boolean} [args.pinned] - 用户显式"记住"
 * @param {boolean} [args.groupMode] - 群聊批量提炼模式（用群聊专用提取标准）
 * @param {string} [args.workspace] - v0.6.0 当前会话工作区键；general=false 的新卡打这个标
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{factsExtracted: number, added: string[], updated: string[], deleted: string[], skipped: number}>}
 */
export async function runIngest(args) {
	const { dialog, store, chat, embed, config, tiers, pinned = false, groupMode = false, workspace = GENERAL_WORKSPACE, signal } = args;
	const report = { factsExtracted: 0, added: [], updated: [], deleted: [], skipped: 0, forced: 0, deduped: 0, facts: [], decisions: [] };
	if (!Array.isArray(dialog) || dialog.length === 0) return report;

	// ---- 调用 1：事实提取（桌面/群聊用不同标准） ----
	const dialogText = dialog.map((m) => `${m.role}: ${m.content}`).join('\n');
	const promptTemplate = (args.groupMode ? EXTRACT_PROMPT_GROUP : EXTRACT_PROMPT).replaceAll(
		'{selfNames}',
		selfNamesLabel()
	);
	const raw = await chat(
		[{ role: 'user', content: promptTemplate.replace('{dialog}', dialogText) }],
		{ jsonMode: true, signal }
	);
	const data = extractJson(raw);
	let facts = (data?.facts ?? []).filter((f) => f && typeof f.content === 'string' && f.content.trim());
	report.factsExtracted = facts.length;
	// v0.6.0 general 判定：缺省/漏输出/非 false 一律视为通用（宁误通用，不误隔离）；
	// preference/commitment 强制通用——偏好与约定天然跨工作区。
	// 归一化结果直接写回 facts 本体：ADD 执行段读的是 facts[idx]，
	// 只存 report.facts 会让漏输出的卡拿到相反的缺省（首跑测试踩过）。
	const normalized = facts.map((f) => {
		const category = safeCategory(f.category);
		const general = groupMode
			? true // 群聊卡与工作区无关（scope=im 已隔离来源）
			: f.general !== false || category === 'preference' || category === 'commitment';
		return { content: f.content, category, importance: safeImportance(f.importance), general };
	});
	report.facts = normalized;
	facts = normalized; // 下游（嵌入/决策/执行）统一用归一化后的副本
	if (facts.length === 0) return report;

	// ---- 向量化 + 检索相似旧卡，作为决策上下文（保留每条 fact 的候选，供 NONE 兜底用） ----
	// v0.6.0：候选按工作区可见性过滤——别的工作区里的同名事实不算"库里已有"，
	// 各工作区各存各的副本是有意为之（隔离 > 去重）。
	const embeddings = await embed(facts.map((f) => f.content), { signal });
	const factCandidates = embeddings.map((vec) =>
		store.search(vec, 3, null, workspace).map((hit) => hit.card)
	);
	const candidateMap = new Map();
	for (const list of factCandidates) for (const card of list) candidateMap.set(card.id, card);
	const candLines = candidateMap.size
		? [...candidateMap.values()].map((c) => `- card_id=${c.id} [${c.category}] ${c.content}`)
		: ['（记忆库为空）'];

	// ---- 调用 2：事件决策 ----
	const factLines = facts.map(
		(f, i) => `${i}. [${f.category ?? 'fact'}] (importance=${safeImportance(f.importance)}) ${f.content}`
	);
	const rawDecide = await chat(
		[
			{
				role: 'user',
				content: DECIDE_PROMPT.replaceAll('{selfNames}', selfNamesLabel())
					.replace('{facts}', factLines.join('\n'))
					.replace('{candidates}', candLines.join('\n'))
			}
		],
		{ jsonMode: true, signal }
	);
	const decideData = extractJson(rawDecide);
	const decisions = (decideData?.decisions ?? []).filter((d) => d && typeof d === 'object');

	// ---- 确定性执行 ----
	const now = Date.now();
	for (const dec of decisions) {
		let action = String(dec.action ?? 'NONE').toUpperCase();
		const idx = Number(dec.fact_index);
		if (!(Number.isInteger(idx) && idx >= 0 && idx < facts.length)) {
			report.skipped += 1;
			continue;
		}
		const fact = facts[idx];
		const vec = embeddings[idx];

		// NONE 兜底：4B 模型常把"与旧记忆不相关"误判成 NONE（本次排障的根因）。
		// 若新事实与所有候选旧卡的最大相似度低于阈值，说明库里没有相近信息 → 强制 ADD。
		if (action === 'NONE') {
			const threshold = Number(config.noneAddThreshold ?? 0.5);
			const maxSim = (factCandidates[idx] ?? []).reduce(
				(max, card) => Math.max(max, card.embedding ? cosine(vec, card.embedding) : 0),
				0
			);
			if (maxSim < threshold) {
				action = 'ADD';
				report.forced += 1;
			}
		}
		report.decisions.push({ action, fact_index: idx, content: String(fact.content) });

		if (action === 'ADD') {
			// 确定性去重兜底：批内重复（同一轮提取出两条相同事实，决策时库还没更新）
			// 与跨批重复（4B 没认出已存在）都在这里挡住——相似度 ≥ 阈值视为已存在。
			// v0.6.0：与候选检索同一可见性口径，别的工作区的卡不压制本工作区的 ADD。
			const dupThreshold = Number(config.dupThreshold ?? 0.92);
			const duplicate = store
				.all()
				.find(
					(existing) =>
						workspaceVisible(existing.ws, workspace) &&
						((existing.embedding && cosine(vec, existing.embedding) >= dupThreshold) ||
							sameFactNormalized(fact.content, existing.content))
				);
			if (duplicate) {
				report.deduped += 1;
				continue;
			}
			const card = createCard({
				content: String(fact.content).trim(),
				category: safeCategory(fact.category),
				importance: safeImportance(fact.importance),
				embedding: vec,
				tier: Tier.WARM,
				status: pinned ? Status.PINNED : Status.ACTIVE,
				scope: groupMode ? 'im' : 'global', // v0.3 scope 隔离：群聊卡进 im 域，桌面召回/热块只查 global
				// v0.6.0 工作区分离：LLM 判 general=true 或偏好/约定 → 通用；否则挂当前工作区
				ws: fact.general ? GENERAL_WORKSPACE : workspace,
				createdAt: now,
				lastAccessed: now
			});
			if (pinned) card.importance = Math.max(card.importance, config.pinnedImportance);
			store.put(card);
			report.added.push(card.id);
		} else if (action === 'UPDATE') {
			const card = store.get(String(dec.card_id ?? ''));
			const newContent = String(dec.content ?? '').trim();
			if (!card || !newContent) {
				report.skipped += 1;
				continue;
			}
			// v0.4.9 时间线（非破坏更新）：内容真变了才归档旧值。旧文本带有效区间落
			// cold/archive.md，同 id 多行归档自然构成"这张卡的演化史"，翻旧账有据可查；
			// 卡本体 validFrom 刷新——注入侧据此标注"这条信息从什么时候起是真的"。
			if (newContent !== card.content) {
				card.validTo = now;
				await tiers.archive(card, 'updated');
				card.validTo = null;
				card.validFrom = now;
			}
			card.content = newContent;
			card.importance = Math.max(card.importance, safeImportance(fact.importance));
			// 关键：用合并后的文本重新嵌入（提取事实 ≠ 合并文本），
			// 否则向量描述旧内容，新内容永远搜不到。
			card.embedding = (await embed([newContent], { signal }))[0];
			card.lastAccessed = now;
			store.put(card);
			report.updated.push(card.id);
		} else if (action === 'DELETE') {
			const card = store.get(String(dec.card_id ?? ''));
			if (!card) {
				report.skipped += 1;
				continue;
			}
			// 软删：标 superseded + 落归档。不硬删 —— 冷层永远可翻旧账。
			card.status = Status.SUPERSEDED;
			card.tier = Tier.COLD;
			store.put(card);
			await tiers.archive(card, 'superseded');
			report.deleted.push(card.id);
		} else {
			report.skipped += 1;
		}
	}

	await store.save();
	return report;
}
