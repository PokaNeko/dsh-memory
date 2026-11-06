# dsh-memory

给 [dsh（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 会话做的**长期记忆层**：
每轮对话自动召回相关记忆注入上下文，轮末把值得记的事提炼进本地记忆库，冷热分层调度，并按工作区
隔离。所有数据都在你自己的 `data/` 目录里，不上传、不外发。

写入管线拼装自三家，冷热升降级与工作区隔离是自研的确定性调度：

- [mem0](https://github.com/mem0ai/mem0) —— 提取 → 事件决策（ADD/UPDATE/DELETE/NONE）→ 确定性执行
- [NAMS](https://github.com/Reezxy/Neural-AI-Memory-system) —— 权重闭环：重要度 × 新鲜度 × 命中强化
- [Letta](https://github.com/letta-ai/letta) —— 限额热层：一小块常驻系统提示的"置顶记忆"

## 它能做什么

- **自动召回**：按用户这句话检索相关记忆，作为 `[memory recall]` 块注入本轮
- **自动写入**：轮末从对话里提炼事实（粗粒度主题卡优先，宁少勿滥），两步 LLM 决策后落库
- **两级存储**：hot（常驻系统提示，有字符预算）/ cold（归档，`/memory cold` 可翻）
- **混合检索**：余弦语义（bge-m3）+ BM25 字面（中文二元组，零分词依赖），RRF 融合
- **工作区隔离**：个人偏好处处可见，项目进展只在对应目录的会话里出现
- **IM 群聊**：QQ/微信桥的群聊按静默窗口攒批提炼，群友身份与本人事实分开记
- **Web 设置页**：「设置 → 记忆」里管模型路由、阈值、导出

## 环境要求

| 项 | 要求 |
|---|---|
| dsh | 能在 `profiles/plugins/` 下挂载本地插件（含 `agent/pre-step`、`systemPrompt.context` 等钩子） |
| [dsh-api-stable](https://github.com/PokaNeko/dsh-api-stable) | **必需**，v1。本插件从它取配置读取与版本门面，必须放在**同级目录** |
| Node.js | ≥ 22（ESM + `node:test`） |
| ollama | 本地 embedding 模型 `bge-m3`（**嵌入模型不可随路由切换——一换就等于换了整个向量库**） |
| 对话模型 | 本地 `qwen3:4b` 起步，或云端任意 OpenAI 兼容端点（DeepSeek / 通义 / GLM 等） |

## 安装

目录布局必须是同级，因为 `index.js` 用 `../dsh-api-stable` 相对导入：

```
~/.dsh/profiles/plugins/
├── dsh-api-stable/     # 依赖：版本化稳定门面（v1）
│   └── lib/index.js
└── dsh-memory/         # 本插件
    ├── index.js
    └── ...
```

```bash
cd ~/.dsh/profiles/plugins
git clone https://github.com/PokaNeko/dsh-api-stable.git
git clone https://github.com/PokaNeko/dsh-memory.git
```

然后在对应 profile 的 `cordis.patch.yml` 里挂上插件（相对 specifier 按 profile 目录解析，
即 `profiles/<profile>/../plugins/`，跨平台通用）：

```yaml
- insert:
    - id: dsh-memory
      name: '../plugins/dsh-memory/index.js'
      config:
        backend: local
        chatModel: qwen3:4b
        embedModel: bge-m3
```

重启 dsh。首次启动会在插件目录下生成 `data/`（含 `cards.json`、`debug.log`）。

> `data/` 已经在 `.gitignore` 里，别把它提交——那是你自己的对话记忆。

## 配置

全量字段在「设置 → 记忆」里（悬停有说明），也可直接写在上面的 `config:` 段。常用：

| 字段 | 默认 | 说明 |
|---|---|---|
| `backend` | `local` | `local`=插件内一体化引擎（主力）；`python`=转调本机 HTTP 服务（备用，本仓库不含服务端） |
| `ollamaBaseUrl` | `http://127.0.0.1:11434/v1` | ollama 的 OpenAI 兼容端点 |
| `chatModel` | `qwen3:4b` | 提取/决策用的对话模型（local 路由） |
| `embedModel` | `bge-m3` | 嵌入模型，**固定本地** |
| `chatRoute` | `local` | `local` / `openai`（任意兼容端点）/ `dsh`（借宿主「设置 → 模型」里的云端账号） |
| `localRuntimes` | `[]` | 本地 OpenAI 兼容运行时目录（JSON），供模型下拉列表用；`apiKey` 字段可选 |
| `recallTopK` | `3` | 单轮注入条数上限 |
| `recallMinRelevance` | `0.35` | 余弦放行线 |
| `bm25MinRelevance` | `0.3` | 字面路放行线（两路各救各的盲区） |
| `wRelevance` / `wImportance` / `wFreshness` | `0.5/0.3/0.2` | 排序三权重，建议合计 ≈1 |
| `autoRemember` | `true` | 轮末自动提炼写入 |
| `rememberThrottleSeconds` | `45` | 桌面会话两次写入的最小间隔 |
| `imSelfNames` | `''` | **你在 IM 里的昵称**（逗号分隔，如 `小明,阿鱼`）。群聊里这些名字视为"用户本人"，其余按群友记；留空则只认消息里自称"我" |
| `imRememberMode` | `group` | IM 写入模式：`off` / `pinned-only`（只记显式 remember）/ `group`（攒批提炼） |
| `wsIsolation` | `true` | 工作区记忆分离 |
| `exportDir` | `''` | 记忆快照导出目录，留空 = 不导出 |
| `debug` | `false` | `data/debug.log` 里记写入/维护明细（召回结论始终记录） |

> `imSelfNames` 是给 QQ/微信桥用的。群聊里 `user` 消息带 `[名字 (ID)]` 身份前缀，插件靠它区分
> "你"和"群友"。不填也不会出错，只是你自己在群里的发言会被当成群友事实。

## 工作方式

### 召回

`agent/pre-step` 每轮触发一次：查询 = 最后一条用户文本 → 余弦（bge-m3）+ BM25 → RRF 融合
（K=60）→ `综合分 = wRelevance×融合 + wImportance×有效重要度 + wFreshness×新鲜度` → 取 topK。

放行双保险：余弦 ≥ `recallMinRelevance` **或** BM25 ≥ `bm25MinRelevance`。

防重复三件套：24h 跨轮注入冷却（消息含"记得/记忆/remember"时放行）+ `[memory recall]` 围栏与
查重 + 已注入卡排序降权（×0.6，冷却结束后 24h 线性恢复）。

### 写入

`agent/turn-stopping` 触发。桌面用**游标增量**（只喂上次之后的新消息），IM 攒批。
两步 LLM：① 提炼事实（带分类、重要度、是否跨工作区通用）② 逐条对照相似旧卡决策
ADD / UPDATE / DELETE / NONE；执行是纯代码，可审计、可回放。

三条硬规矩：**只信原文**（压缩摘要、`<system-reminder>`、自家召回块不进提取）、
**时间写绝对日期**（禁"昨天/下周"）、**游标增量**（锚点失效则回退尾部窗口，宁重喂不漏喂）。

兜底：NONE 误判时相似度全低于 `noneAddThreshold` 强制 ADD；查重 = 人称归一字符串比对 +
余弦 0.92；LLM 失败进重试队列（最多 5 次 / 48h）。

### 工作区分离

卡片带 `ws` 标签，取值是会话 cwd 的**末级目录名**（如 `notes`、`project-a`；`*` = 跨区通用），
与 `scope`（`global` 桌面 / `im` 群聊）正交。提取时让 LLM 顺手判 `general` true/false
（缺省 true：宁误通用不误隔离；偏好与约定强制通用）。热层按工作区**分组装配**，各区各享预算。

> 升级后存量卡默认全部归 `*`（处处可见）。想让老卡归到具体工作区，参考 `scripts/ws-map.example.json`：
> 复制成 `scripts/ws-map.json` 填卡片 id，重启时一次性打标（或宿主停机时手动跑 `scripts/ws-migrate.mjs`）。

### IM 会话

双闸判定：cwd 不含 `profiles` **且**用户消息带 `[名字 (ID)]` 前缀。群聊卡进 `im` 域
（桌面召回/热块只查 `global`，IM 会话两者都查）。攒批：静默 5 分钟或满 20 条触发一次。

## `/memory` 命令

```
/memory                    状态（后端/统计/hot 块）
/memory list               卡片清单
/memory recall <q>         检索 top5
/memory remember <内容>     显式记住（重要度 ≥0.8）
/memory forget <词|id>      软删入归档
/memory maintenance        手动维护（衰减/合并/清理/备份）
/memory cold <q>           翻归档
/memory export             导出快照
```

## 数据与隐私

| 文件 | 内容 |
|---|---|
| `data/cards.json` | 记忆卡本体（原子写：tmp + rename；自动轮换备份 ×5，24h 节流） |
| `data/cold/archive.md` | 软删 / 降冷 / 过期 / 合并落败者的人可读归档 |
| `data/debug.log` | 召回结论（`debug:true` 时加写入与维护明细） |
| `data/workspaces.json` | 同名工作区目录的去歧义注册表 |
| `data/retry-queue.json` | 写入失败待重放的对话窗 |

全部在本机。插件本身**没有任何联网上报**；唯一的网络请求是你在配置里指定的模型端点
（本地 ollama，或你自己填的云端 API）。

> 仓库里不含任何真实凭据。云端 API Key 通过「设置 → 记忆」的输入框写进**你自己的** profile
> 配置（`cordis.patch.yml`），那个文件不要提交、不要贴进 issue。

## 测试

```bash
node test/smoke.test.mjs           # 49 项：召回/写入/分层/GC/导出/工作区/IM 等核心机制（假向量 + 假 LLM）
node test/client-smoke.test.mjs    # 9 项：设置页渲染与模型列表逻辑
node test/apply-stub/run.mjs       # apply() 链路：桩宿主 + 桩 schemastery，验证注册与钩子不炸
node test/live-smoke.mjs           # 端到端（需要真 ollama + bge-m3）
```

前三个既不需要 ollama，也不需要装 dsh —— `apply-stub` 自带 `stubs/` 把宿主包换成本地桩
（唯一前提是同级的 `dsh-api-stable` 在位）。只有 `live-smoke.mjs` 会真的调模型。

## 已知边界

- 冷却与降权是**会话级内存态**，宿主重启清零（重启后同一张卡可能再注入一次）。
- 跨表述查重靠字符串归一：实测真重复对向量相似度只有 0.75~0.80，而"喜欢×讨厌"这类反例对可达
  0.85——余弦分不清真假重复，只能靠文本归一兜底。
- `python` 后端缺 diag 出参、export、list 与已注入降权，仅作备用。
- 群聊目前按单桶 `im` 域，per-group 细分还在观察（`im-group` 埋点已就位）。
- 4B 级本地模型的提取质量明显不如云端；写入频繁的话建议 `chatRoute: dsh` 借一个 flash 级云端模型。

## 版本史

| 版本 | 要点 |
|---|---|
| v0.6.1 | 开源整理：IM 本人昵称由硬编码改为 `imSelfNames` 配置项；补齐 `apply-stub` 测试（桩 schemastery + 桩宿主 `inject`）；新增 `ws-map` 示例与本 README |
| v0.6.0 | 工作区分离：`ws` 标签 + LLM 判 general + 召回/热块分区过滤 + 热层分组装配 + 存量卡一次性归类 |
| v0.5.0 | 跨轮冷却 + 逃生门 / 围栏 + 查重 / 提取只信原文 / 游标增量 / 热块硬预算 / 绝对日期 / 已注入降权 |
| v0.4.9 | 混合检索（余弦 + BM25，RRF 融合、双保险放行）；时间线 `validFrom/validTo`；UPDATE 非破坏归档 |
| v0.4.8 | 召回公平性：强化下放、trivia 席位 + 有效重要度、三权重进配置 |
| v0.4.7 | 即时欲望记 trivia 卡（重要度 0.3，7 天过期） |
| v0.4.6 | 粗粒度主题卡提取标准、召回日志落盘 |
| v0.3 ~ v0.4.5 | scope 隔离 / 自动合并 / GC / 重试队列 / 导出 / 设置页 / 模型三档路由 |

## 许可

[MIT](./LICENSE) © 2026 Poka