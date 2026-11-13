/**
 * dsh-memory · 浏览器半侧
 *
 * 职责：注册「设置 → 记忆」栏目（settings.section slot），把改 yml 才能动的
 * 记忆插件配置变成图形化入口（结构与交互对齐 image-relay 的「图片转述」栏目）：
 *   - 模型列表（v0.4.3）：精选模型 select（只显示你勾选添加过的模型）——
 *     · 「请求可用模型」按钮：并发拉三路来源（ollama /api/tags、本地运行时
 *       /v1/models、云端 live 路由 discoverModels），按来源分组列出全部可用模型
 *     · 勾选 = 加入精选列表（存 modelList 配置），取消勾选 = 移除
 *     · 千问百炼这类聚合端点只在勾选面板里展开，主列表保持干净
 *     · 选中即写全套路由字段（chatRoute/chatModel/openaiBaseUrl/dshProvider/dshModel）
 *   - 本地运行时管理（增删 llama.cpp 等端点，存 localRuntimes JSON）
 *   - 记忆导出：目录 + 格式（md/json）
 *   - 当前生效值摘要
 *
 * 读写走 `ctx.remote.settings`（describe / mutate）：namespace 是 profile patch 里
 * 那一行的 id（`dsh-memory`），字段全部 volatile，写回即生效（不重启宿主）。
 *
 * ⚠️ 不声明 `settingsScope`（boot 审计时未注册 → 应用起不来，见 image-relay 探针实录）；
 * 不声明 `remote.directoryPicker`（无官方页面先例，验证成本是整个应用）。
 * 本地端口直连的 CORS：ollama 默认放行 localhost 任意端口 origin；llama.cpp
 * llama-server 默认放行跨域。被拦时该来源显示不可达，不影响其他来源。
 */

window.__ModuleLoader__.load({
  id: "dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;

    console.log("[dsh-memory] client 半侧已加载");

    /** Settings namespace = the profile patch row id. */
    var NS = "dsh-memory";
    var SECTION_ID = "dsh-memory";
    var SEP = "\u0001";

    var CSS = [
      ".dshm{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px}",
      ".dshm-title{font-size:15px;font-weight:600}",
      ".dshm-sub{color:var(--dsw-alias-label-secondary);line-height:1.65;margin-top:6px}",
      ".dshm-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}",
      ".dshm-cardTitle{font-weight:600;font-size:13px}",
      ".dshm-row{display:flex;align-items:flex-start;gap:12px}",
      ".dshm-label{width:118px;flex:none;color:var(--dsw-alias-label-secondary);line-height:32px}",
      ".dshm-labelTop{line-height:1.5;padding-top:6px}",
      ".dshm-field{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}",
      ".dshm-input,.dshm-select{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;font-size:13px;font-family:inherit;line-height:20px;outline:none}",
      ".dshm-input:focus,.dshm-select:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".dshm-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}",
      ".dshm-note{font-size:12px;line-height:1.5}",
      ".dshm-ok{color:var(--dsw-alias-state-success-primary)}",
      ".dshm-err{color:var(--dsw-alias-state-error-primary)}",
      ".dshm-warn{color:var(--dsw-alias-state-warn-primary)}",
      ".dshm-idle{color:var(--dsw-alias-state-idle-primary)}",
      ".dshm-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".dshm-eff{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary)}",
      ".dshm-mini{width:auto;flex:1;min-width:110px}",
      ".dshm-miniBtn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 12px;font-size:13px;font-family:inherit;cursor:pointer;flex:none}",
      ".dshm-miniBtn:hover{border-color:var(--dsw-alias-brand-primary)}",
      ".dshm-miniBtn:disabled{opacity:.5;cursor:default}",
      ".dshm-rtRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshm-rtId{font-family:ui-monospace,Consolas,monospace;font-size:12px}",
      ".dshm-del{background:none;border:none;color:var(--dsw-alias-state-error-primary);cursor:pointer;font-size:12px;padding:2px 6px;font-family:inherit}",
      ".dshm-picker{max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:10px}",
      ".dshm-groupTitle{font-weight:600;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:2px}",
      ".dshm-check{display:flex;align-items:center;gap:6px;font-size:12px;line-height:1.6;cursor:pointer}",
      ".dshm-check input{accent-color:var(--dsw-alias-brand-primary);width:14px;height:14px;flex:none}",
      ".dshm-check .dshm-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".dshm-checkGroup{display:flex;flex-direction:column;gap:2px}"
    ].join("\n");

    /* ---------------- 纯函数（导出供测试） ---------------- */

    /** 解析 localRuntimes 配置（JSON 字符串 → 数组；保留可选 apiKey）。 */
    function parseRuntimes(raw) {
      try {
        var list = JSON.parse(String(raw == null || raw === "" ? "[]" : raw));
        if (!Array.isArray(list)) return [];
        return list
          .filter(function (item) {
            return item && typeof item.id === "string" && item.id && typeof item.baseUrl === "string" && item.baseUrl;
          })
          .map(function (item) {
            return { id: item.id, baseUrl: item.baseUrl, apiKey: typeof item.apiKey === "string" ? item.apiKey : "" };
          });
      } catch (error) {
        return [];
      }
    }

    /** 解析精选模型列表（modelList 配置）。 */
    function parseModelList(raw) {
      try {
        var list = JSON.parse(String(raw == null || raw === "" ? "[]" : raw));
        if (!Array.isArray(list)) return [];
        return list.filter(function (item) {
          return item && typeof item.source === "string" && item.source && typeof item.model === "string" && item.model;
        });
      } catch (error) {
        return [];
      }
    }

    /** 来源标签：ollama / runtime:<id> / dsh:<provider>。 */
    function sourceOf(kind, id) {
      if (kind === "runtime") return "runtime:" + id;
      if (kind === "cloud") return "dsh:" + id;
      return "ollama";
    }

    /** 来源标签 → 展示名。 */
    function sourceLabel(source) {
      if (source === "ollama") return "ollama";
      if (source.indexOf("runtime:") === 0) return source.slice(8);
      if (source.indexOf("dsh:") === 0) return source.slice(4);
      return source;
    }

    /**
     * 可用模型目录（勾选面板的数据结构）：三路来源合并为有序分组。
     * @param {object} parts - {ollama:{ok,models}, runtimes:[{id,baseUrl,ok,models}], cloud:[{provider,name,models}]}
     */
    function buildCatalog(parts) {
      var groups = [];
      if (parts.ollama) {
        groups.push({
          kind: "ollama",
          key: "ollama",
          label: "ollama",
          note: parts.ollama.ok ? undefined : "不可达（未启动或跨域被拦）",
          models: (parts.ollama.models || []).map(function (m) { return { id: m, label: m }; })
        });
      }
      (parts.runtimes || []).forEach(function (rt) {
        groups.push({
          kind: "runtime",
          key: rt.id,
          label: rt.id,
          note: rt.ok ? undefined : "不可达（服务未启动？）",
          models: (rt.models || []).map(function (m) { return { id: m, label: m }; })
        });
      });
      (parts.cloud || []).forEach(function (p) {
        groups.push({
          kind: "cloud",
          key: p.provider,
          label: p.name || p.provider,
          note: (p.models || []).length === 0 ? "无可用模型" : undefined,
          models: (p.models || []).map(function (m) { return { id: m.id, label: m.name || m.id }; })
        });
      });
      return groups;
    }

    /** 当前配置值 → 选中来源与模型（下拉高亮/测试用）。 */
    function choiceOfValue(value) {
      var v = value || {};
      var route = v.chatRoute === "dsh" || v.chatRoute === "openai" ? v.chatRoute : "local";
      if (route === "dsh") return { source: sourceOf("cloud", String(v.dshProvider || "")), model: String(v.dshModel || "") };
      if (route === "openai") {
        var runtimes = parseRuntimes(v.localRuntimes);
        var hit = null;
        for (var i = 0; i < runtimes.length; i += 1) {
          if (runtimes[i].baseUrl === v.openaiBaseUrl) { hit = runtimes[i]; break; }
        }
        return { source: hit ? sourceOf("runtime", hit.id) : "", model: String(v.chatModel || "") };
      }
      return { source: "ollama", model: String(v.chatModel || "") };
    }

    /** 从来源标签还原选中键（旧接口兼容：kind/key/model）。 */
    function choiceFromSource(source, model) {
      if (source === "ollama") return { kind: "ollama", key: "ollama", model: model };
      if (source.indexOf("runtime:") === 0) return { kind: "runtime", key: source.slice(8), model: model };
      if (source.indexOf("dsh:") === 0) return { kind: "cloud", key: source.slice(4), model: model };
      return { kind: "ollama", key: "ollama", model: model };
    }

    /** 来源+模型 → settings.mutate 的 ops（路由全套字段一次写齐）。 */
    function opsForSource(source, model, runtimes) {
      if (source.indexOf("dsh:") === 0) {
        return [
          { op: "set", path: ["chatRoute"], value: "dsh" },
          { op: "set", path: ["dshProvider"], value: source.slice(4) },
          { op: "set", path: ["dshModel"], value: model }
        ];
      }
      if (source.indexOf("runtime:") === 0) {
        var id = source.slice(8);
        var baseUrl = "";
        (runtimes || []).forEach(function (rt) { if (rt.id === id) baseUrl = rt.baseUrl; });
        return [
          { op: "set", path: ["chatRoute"], value: "openai" },
          { op: "set", path: ["openaiBaseUrl"], value: baseUrl },
          { op: "set", path: ["chatModel"], value: model }
        ];
      }
      return [
        { op: "set", path: ["chatRoute"], value: "local" },
        { op: "set", path: ["chatModel"], value: model }
      ];
    }

    /** 精选列表勾选切换（幂等）：返回新列表。 */
    function toggleList(list, entry, checked) {
      var next = list.filter(function (item) {
        return !(item.source === entry.source && item.model === entry.model);
      });
      if (checked) next.push({ source: entry.source, model: entry.model, label: entry.label || entry.model });
      return next;
    }

    /** 精选列表 → 下拉分组（按来源聚合，保持配置顺序）。 */
    function buildChoices(list) {
      var order = [];
      var bySource = {};
      list.forEach(function (item) {
        if (!bySource[item.source]) {
          bySource[item.source] = [];
          order.push(item.source);
        }
        bySource[item.source].push(item);
      });
      return order.map(function (source) {
        return { source: source, label: sourceLabel(source), entries: bySource[source] };
      });
    }

    /* ---------------- 设置视图与工具（image-relay 同款） ---------------- */

    function useSettingsView(ctx) {
      var pair = React.useState({ status: "loading", value: {}, revision: undefined, error: undefined });
      var view = pair[0];
      var setView = pair[1];
      React.useEffect(function () {
        var alive = true;
        var load = function () {
          Promise.resolve(ctx.remote.settings.describe()).then(function (doc) {
            if (!alive) return;
            var payload = unwrap(doc) || {};
            var rows = toArray(payload.namespaces !== undefined ? payload.namespaces : payload);
            var found = null;
            for (var index = 0; index < rows.length; index += 1) {
              if (rows[index].ns === NS) {
                found = rows[index];
                break;
              }
            }
            if (found === null) {
              setView({ status: "missing", value: {}, revision: undefined, error: "宿主里没有名为 " + NS + " 的配置项" });
              return;
            }
            setView({
              status: "ready",
              value: found.value && typeof found.value === "object" ? found.value : {},
              revision: found.revision,
              error: undefined
            });
          }, function (error) {
            if (!alive) return;
            setView({ status: "error", value: {}, revision: undefined, error: (error && error.message) || String(error) });
          });
        };
        load();
        var dispose = function () {};
        try {
          if (ctx.remote.$on) dispose = ctx.remote.$on("settings/document-updated", load) || function () {};
        } catch (error) {
          /* 事件订阅不可用时只保留首次读取 */
        }
        return function () {
          alive = false;
          try {
            dispose();
          } catch (error) {
            /* 忽略卸载竞态 */
          }
        };
      }, []);
      return [view, setView];
    }

    function display(value, fallback) {
      return value === undefined || value === null || value === "" ? fallback : String(value);
    }

    function toArray(payload) {
      var unwrapped = payload;
      if (unwrapped !== null && typeof unwrapped === "object" && !Array.isArray(unwrapped) && "ok" in unwrapped && "value" in unwrapped) {
        unwrapped = unwrapped.value;
      }
      if (Array.isArray(unwrapped)) return unwrapped;
      if (unwrapped !== null && typeof unwrapped === "object") {
        var keys = Object.keys(unwrapped);
        for (var index = 0; index < keys.length; index += 1) {
          if (Array.isArray(unwrapped[keys[index]])) return unwrapped[keys[index]];
        }
      }
      return [];
    }

    function unwrap(payload) {
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && "ok" in payload && "value" in payload) return payload.value;
      return payload;
    }

    /**
     * 把 mutate 的拒绝信封压成一句能定位问题的话。
     *
     * 宿主对「revision 不一致」和「字段校验失败 / 无权限」的返回结构并不相同，
     * 早先一律笼统报「revision 仍不一致」，把真因全盖住了。这里按
     * error → message → reason → code → detail 的优先级抽取文本；
     * 其余字段只列键名——value 可能是整份配置，序列化会爆。
     */
    function summarizeRejection(response) {
      if (response === undefined || response === null) return "宿主没有返回内容";
      if (typeof response !== "object") return String(response);
      var fields = ["error", "message", "reason", "code", "detail"];
      var used = {};
      var pieces = [];
      for (var index = 0; index < fields.length; index += 1) {
        var name = fields[index];
        used[name] = true;
        var raw = response[name];
        if (raw === undefined || raw === null || raw === "") continue;
        // Error / RemoteError 的 message 不是可枚举属性，JSON.stringify 会把它丢掉，
        // 只剩 {code, details, name}——先直接取 message，取不到再退回序列化。
        var text;
        if (typeof raw === "string") text = raw;
        else if (typeof raw.message === "string" && raw.message !== "") {
          var rawCode = typeof raw.code === "string" && raw.code !== "" ? raw.code + "：" : "";
          text = rawCode + raw.message;
        } else text = JSON.stringify(raw);
        if (pieces.indexOf(text) === -1) pieces.push(text);
      }
      var rest = [];
      var keys = Object.keys(response);
      for (var key = 0; key < keys.length; key += 1) {
        if (used[keys[key]] === true) continue;
        rest.push(keys[key]);
      }
      var summary = pieces.length > 0 ? pieces.join("；") : "宿主拒绝了写入，但没给出原因字段";
      if (rest.length > 0) summary += "［返回的键：" + rest.join(", ") + "］";
      return summary;
    }

    /* ---------------- 组件 ---------------- */

    function makeSection(ctx) {
      return function MemorySection() {
        var viewPair = useSettingsView(ctx);
        var view = viewPair[0];
        var setView = viewPair[1];
        var value = view.value && typeof view.value === "object" ? view.value : {};
        var writable = view.status === "ready";

        var catalogState = React.useState(null); // null=未请求；{ollama, runtimes, cloud}=已请求
        var catalog = catalogState[0];
        var setCatalog = catalogState[1];
        var loadingState = React.useState(false);
        var loading = loadingState[0];
        var setLoading = loadingState[1];
        var manualState = React.useState("");
        var manual = manualState[0];
        var setManual = manualState[1];
        var rtIdState = React.useState("");
        var rtId = rtIdState[0];
        var setRtId = rtIdState[1];
        var rtUrlState = React.useState("");
        var rtUrl = rtUrlState[0];
        var setRtUrl = rtUrlState[1];
        var rtKeyState = React.useState("");
        var rtKey = rtKeyState[0];
        var setRtKey = rtKeyState[1];
        var noteState = React.useState({ kind: "idle", text: "" });
        var note = noteState[0];
        var setNote = noteState[1];

        var runtimes = parseRuntimes(value.localRuntimes);
        var modelList = parseModelList(value.modelList);
        var current = choiceOfValue(value);
        var currentKey = current.source && current.model ? current.source + SEP + current.model : "";
        var choices = buildChoices(modelList);
        var inList = modelList.some(function (item) {
          return item.source === current.source && item.model === current.model;
        });

        var save = function (ops, message) {
          setNote({ kind: "idle", text: "保存中…" });
          var applyView = function (next) {
            setView({
              status: "ready",
              value: next.value && typeof next.value === "object" ? next.value : {},
              revision: next.revision,
              error: undefined
            });
          };
          var rereadRevision = function () {
            return Promise.resolve(ctx.remote.settings.describe()).then(function (doc) {
              var payload = unwrap(doc) || {};
              var rows = toArray(payload.namespaces !== undefined ? payload.namespaces : payload);
              var found = null;
              for (var index = 0; index < rows.length; index += 1) {
                if (rows[index].ns === NS) { found = rows[index]; break; }
              }
              if (found === null) throw new Error("宿主里没有名为 " + NS + " 的配置项");
              return found;
            });
          };
          var attempt = function (revision, allowRetry) {
            return Promise.resolve(ctx.remote.settings.mutate(NS, ops, revision)).then(function (response) {
              if (response && response.ok === true) {
                applyView(response.value || {});
                setNote({ kind: "ok", text: message || "已保存" });
                return;
              }
              if (!allowRetry) {
                var detail = summarizeRejection(response);
                if (response !== null && typeof response === "object" && response.revision !== undefined && String(response.revision) !== String(revision)) {
                  detail += "；宿主当前 revision 是 " + String(response.revision) + "，本次提交的是 " + String(revision);
                }
                setNote({ kind: "err", text: "保存被拒绝：" + detail });
                return;
              }
              rereadRevision().then(function (fresh) {
                applyView({ value: fresh.value, revision: fresh.revision });
                attempt(fresh.revision, false);
              }, function (error) {
                setNote({ kind: "err", text: "保存被拒绝，且重读配置失败：" + (error && error.message ? error.message : String(error)) });
              });
            }, function (error) {
              setNote({ kind: "err", text: "保存失败：" + (error && error.message ? error.message : String(error)) });
            });
          };
          attempt(view.revision, true);
        };

        // ---- 请求可用模型（v0.4.4：同源路由，目录由 host 拉；官方模型页同款协议） ----
        var requestCatalog = function () {
          setLoading(true);
          setNote({ kind: "idle", text: "正在请求可用模型列表…" });
          fetch("/dsh-memory/models", { signal: AbortSignal.timeout(15000) })
            .then(function (res) {
              if (!res.ok) throw new Error("HTTP " + res.status);
              return res.json();
            })
            .then(function (data) {
              if (data && data.error) throw new Error(String(data.error));
              setCatalog({
                ollama: data.ollama || { ok: false, models: [] },
                runtimes: Array.isArray(data.runtimes) ? data.runtimes : [],
                cloud: Array.isArray(data.cloud) ? data.cloud : []
              });
              setLoading(false);
              setNote({ kind: "ok", text: "模型列表已刷新（勾选即保存）" });
            })
            .catch(function (error) {
              setLoading(false);
              setNote({ kind: "err", text: "模型目录请求失败：" + (error && error.message ? error.message : String(error)) });
            });
        };

        // ---- 勾选切换：加入/移出精选列表 ----
        var toggleEntry = function (entry, checked) {
          var next = toggleList(modelList, entry, checked);
          save([{ op: "set", path: ["modelList"], value: JSON.stringify(next) }],
            checked ? "已添加：" + (entry.label || entry.model) : "已移除：" + (entry.label || entry.model));
        };

        var applyChoice = function (encoded) {
          var parts = encoded.split(SEP);
          save(opsForSource(parts[0], parts[1], runtimes), "已切换写入模型");
        };

        var applyManual = function () {
          var model = manual.trim();
          if (!model) return;
          var source = current.source || "ollama";
          save(opsForSource(source, model, runtimes), "已保存模型 id：" + model);
          setManual("");
        };

        var addRuntime = function () {
          var id = rtId.trim();
          var baseUrl = rtUrl.trim().replace(/\/+$/, "");
          if (!id || !/^https?:\/\//.test(baseUrl)) {
            setNote({ kind: "err", text: "端点需要名字和 http(s) 地址（如 http://127.0.0.1:8080 或 https://api.deepseek.com/v1）" });
            return;
          }
          if (runtimes.some(function (rt) { return rt.id === id; })) {
            setNote({ kind: "err", text: "已有同名端点：" + id });
            return;
          }
          var next = runtimes.concat([{ id: id, baseUrl: baseUrl, apiKey: rtKey.trim() }]);
          save([{ op: "set", path: ["localRuntimes"], value: JSON.stringify(next) }], "已添加端点：" + id);
          setRtId("");
          setRtUrl("");
          setRtKey("");
        };

        var removeRuntime = function (id) {
          save([{ op: "set", path: ["localRuntimes"], value: JSON.stringify(runtimes.filter(function (rt) { return rt.id !== id; })) }], "已删除运行时：" + id);
        };

        /** 更新既有端点的 API Key（不影响其它字段；空值忽略）。 */
        var setRuntimeKey = function (id, key) {
          var value = String(key || "").trim();
          if (!value) return;
          var next = runtimes.map(function (rt) {
            return rt.id === id ? { id: rt.id, baseUrl: rt.baseUrl, apiKey: value } : rt;
          });
          save([{ op: "set", path: ["localRuntimes"], value: JSON.stringify(next) }], "已更新 " + id + " 的 API Key");
        };

        var exportDir = display(value.exportDir, "");
        var exportFormat = value.exportFormat === "json" ? "json" : "md";
        var noteClass = note.kind === "ok" ? "dshm-note dshm-ok" : note.kind === "err" ? "dshm-note dshm-err" : note.kind === "warn" ? "dshm-note dshm-warn" : "dshm-note dshm-idle";

        var routeLabel = current.source && current.source.indexOf("dsh:") === 0
          ? "云端 " + display(value.dshProvider, "?") + " / " + display(value.dshModel, "?")
          : current.source && current.source.indexOf("runtime:") === 0
            ? "本地端点 " + display(value.openaiBaseUrl, "?") + " / " + display(value.chatModel, "?")
            : "ollama / " + display(value.chatModel, "qwen3:4b");

        var catalogGroups = catalog
          ? buildCatalog({
              ollama: catalog.ollama,
              runtimes: catalog.runtimes,
              cloud: catalog.cloud
            })
          : null;

        return h("div", { className: "dshm" },
          h("style", null, CSS),
          h("div", null,
            h("div", { className: "dshm-title" }, "记忆"),
            h("div", { className: "dshm-sub" },
              "长期记忆插件的图形化配置：写入用哪个模型大脑、记忆文件导出到哪。",
              "所有改动写回 profile 配置，即时生效，不用重启宿主。"
            )
          ),
          h("div", { className: "dshm-card" },
            h("div", { className: "dshm-cardTitle" }, "模型列表"),
            h("div", { className: "dshm-row" },
              h("div", { className: "dshm-label" }, "当前模型"),
              h("div", { className: "dshm-field" },
                h("select", {
                  className: "dshm-select",
                  value: inList && currentKey ? currentKey : "",
                  disabled: !writable,
                  onChange: function (event) { applyChoice(event.target.value); }
                },
                  !inList ? h("option", { value: "", key: "_current" }, "当前：" + routeLabel) : null,
                  choices.map(function (group) {
                    return h("optgroup", { key: group.source, label: group.label },
                      group.entries.map(function (item) {
                        return h("option", { key: group.source + SEP + item.model, value: group.source + SEP + item.model }, item.label || item.model);
                      })
                    );
                  })
                ),
                h("div", { className: "dshm-hint" },
                  "只显示你勾选添加过的模型（下方「请求可用模型」后勾选）。选中即切换写入模型，路由字段自动写齐。"
                )
              )
            ),
            h("div", { className: "dshm-row" },
              h("div", { className: "dshm-label" }, "手动指定"),
              h("div", { className: "dshm-field" },
                h("div", { className: "dshm-rtRow" },
                  h("input", {
                    className: "dshm-input dshm-mini",
                    value: manual,
                    placeholder: "模型 id（保存到当前来源）",
                    disabled: !writable,
                    onChange: function (event) { setManual(event.target.value); }
                  }),
                  h("button", { className: "dshm-miniBtn", disabled: !writable || !manual.trim(), onClick: applyManual }, "保存")
                ),
                h("div", { className: "dshm-hint" }, "列表拉不到（服务没开/跨域被拦）时，在这里手填模型 id。")
              )
            ),
            h("div", { className: "dshm-row" },
              h("div", { className: "dshm-label" }, "可用模型"),
              h("div", { className: "dshm-field" },
                h("div", { className: "dshm-rtRow" },
                  h("button", { className: "dshm-miniBtn", disabled: !writable || loading, onClick: requestCatalog },
                    loading ? "请求中…" : catalog ? "重新请求" : "请求可用模型"),
                  catalog
                    ? h("span", { className: "dshm-hint" }, "勾选 = 加入上方模型列表，取消勾选 = 移除。")
                    : null
                ),
                catalogGroups
                  ? h("div", { className: "dshm-picker" },
                      catalogGroups.map(function (group) {
                        return h("div", { key: group.kind + SEP + group.key, className: "dshm-checkGroup" },
                          h("div", { className: "dshm-groupTitle" }, group.label + (group.note ? " · " + group.note : "")),
                          group.models.length === 0
                            ? h("div", { className: "dshm-hint" }, "（暂无可用模型）")
                            : group.models.map(function (model) {
                                var source = sourceOf(group.kind, group.key);
                                var entry = { source: source, model: model.id, label: model.label };
                                var checked = modelList.some(function (item) {
                                  return item.source === source && item.model === model.id;
                                });
                                return h("label", { className: "dshm-check", key: model.id },
                                  h("input", {
                                    type: "checkbox",
                                    checked: checked,
                                    disabled: !writable,
                                    onChange: function (event) { toggleEntry(entry, event.target.checked); }
                                  }),
                                  model.label,
                                  model.label !== model.id ? h("span", { className: "dshm-mono" }, model.id) : null
                                );
                              })
                        );
                      })
                    )
                  : h("div", { className: "dshm-hint" },
                      "点击「请求可用模型」拉取三路来源的完整模型清单：ollama、OpenAI 兼容端点（llama.cpp 本地 / DeepSeek 等自定义云端），",
                      "以及「设置 → 模型」里已激活的云端账号。像千问百炼这种聚合服务会在这里完整展开，勾选后只把要用的那几个放进主列表。")
              )
            )
          ),
          h("div", { className: "dshm-card" },
            h("div", { className: "dshm-cardTitle" }, "OpenAI 兼容端点（本地 llama.cpp / 自定义云端如 DeepSeek）"),
            runtimes.length === 0
              ? h("div", { className: "dshm-hint" }, "还没有配置。llama.cpp 填 http://127.0.0.1:8080；DeepSeek 填 https://api.deepseek.com/v1 并粘贴 API Key——它们的模型会出现在「请求可用模型」里。")
              : runtimes.map(function (rt) {
                  return h("div", { className: "dshm-rtRow", key: rt.id },
                    h("span", { className: "dshm-rtId" }, rt.id),
                    h("span", { className: "dshm-hint" }, rt.baseUrl),
                    h("input", {
                      className: "dshm-input dshm-mini",
                      type: "password",
                      defaultValue: "",
                      placeholder: rt.apiKey ? "key 已配置（输入新值替换）" : "填 API Key",
                      disabled: !writable,
                      onBlur: function (e) { setRuntimeKey(rt.id, e.target.value); e.target.value = ""; }
                    }),
                    h("button", { className: "dshm-del", onClick: function () { removeRuntime(rt.id); } }, "删除")
                  );
                }),
            h("div", { className: "dshm-rtRow" },
              h("input", { className: "dshm-input dshm-mini", value: rtId, placeholder: "名字，如 llama.cpp / deepseek", disabled: !writable, onChange: function (e) { setRtId(e.target.value); } }),
              h("input", { className: "dshm-input dshm-mini", value: rtUrl, placeholder: "http://127.0.0.1:8080 或 https://api.deepseek.com/v1", disabled: !writable, onChange: function (e) { setRtUrl(e.target.value); } }),
              h("input", { className: "dshm-input dshm-mini", type: "password", value: rtKey, placeholder: "API Key（可选，云端填）", disabled: !writable, onChange: function (e) { setRtKey(e.target.value); } }),
              h("button", { className: "dshm-miniBtn", disabled: !writable, onClick: addRuntime }, "添加")
            )
          ),
          h("div", { className: "dshm-card" },
            h("div", { className: "dshm-cardTitle" }, "记忆导出"),
            h("div", { className: "dshm-row" },
              h("div", { className: "dshm-label dshm-labelTop" }, "导出目录"),
              h("div", { className: "dshm-field" },
                h("input", {
                  className: "dshm-input",
                  value: exportDir,
                  placeholder: "留空 = 不自动导出；示例：<工作区>\\memory-export",
                  disabled: !writable,
                  onChange: function (event) {
                    save([{ op: "set", path: ["exportDir"], value: event.target.value.trim() }], "已保存导出目录");
                  }
                }),
                h("div", { className: "dshm-hint" }, "每天自动导出一份记忆快照（24h 节流）；留空 = 关闭自动导出。也可在对话里 /memory export 即时导出。")
              )
            ),
            h("div", { className: "dshm-row" },
              h("div", { className: "dshm-label" }, "格式"),
              h("div", { className: "dshm-field" },
                h("select", {
                  className: "dshm-select",
                  value: exportFormat,
                  disabled: !writable,
                  onChange: function (event) {
                    save([{ op: "set", path: ["exportFormat"], value: event.target.value }], "已保存导出格式");
                  }
                },
                  h("option", { value: "md" }, "Markdown（人读，按 桌面/群聊 × 热/温/冷 分节）"),
                  h("option", { value: "json" }, "JSON（机器读，cards.json 同构快照）")
                )
              )
            )
          ),
          h("div", { className: "dshm-card" },
            h("div", { className: "dshm-cardTitle" }, "当前生效值"),
            h("div", { className: "dshm-hint" },
              h("span", { className: "dshm-eff" }, routeLabel),
              "　·　embedding：本地 bge-m3（不随模型切换变）",
              "　·　导出：" + (exportDir === "" ? "关闭" : exportDir + "（" + exportFormat + "）")
            ),
            h("div", { className: "dshm-hint" },
              view.status === "ready"
                ? "写入位置：profile 的 cordis.patch.yml（dsh-memory 行），即时生效，无需重启。"
                : view.status === "loading"
                  ? "正在读取宿主配置…"
                  : "配置通道不可用：" + display(view.error, "未知原因")
            ),
            h("div", { className: "dshm-hint" },
              "管理记忆卡片：对话里 /memory list（列表）/ recall <词>（搜索）/ forget <词>（删除）；",
              "图形化管理面板在后续版本。"
            )
          ),
          h("div", { className: "dshm-foot" },
            h("span", { className: noteClass }, note.text)
          )
        );
      };
    }

    /** 只声明 boot 时就绪的服务（对齐 image-relay 与官方 models 页的 inject 集）。 */
    var inject = ["slots", "remote", "remote.settings", "remote.llm"];

    /** 注册「设置 → 记忆」栏目。 */
    function apply(ctx) {
      try {
        ctx.slots.inject("settings.section", function () {
          var registration = ctx.slots.register({
            name: "settings.section",
            id: SECTION_ID,
            order: 9,
            label: "记忆"
          }, makeSection(ctx));
          console.log("[dsh-memory] 设置栏目已注册（id=" + SECTION_ID + "）");
          return registration;
        });
      } catch (error) {
        console.error("[dsh-memory] 注册设置栏目失败", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    /* 纯函数导出：供 client-smoke 测试锁定精选列表与勾选行为 */
    exports.parseRuntimes = parseRuntimes;
    exports.parseModelList = parseModelList;
    exports.sourceOf = sourceOf;
    exports.sourceLabel = sourceLabel;
    exports.buildCatalog = buildCatalog;
    exports.choiceOfValue = choiceOfValue;
    exports.opsForSource = opsForSource;
    exports.toggleList = toggleList;
    exports.buildChoices = buildChoices;
    return module.exports;
  }
});
