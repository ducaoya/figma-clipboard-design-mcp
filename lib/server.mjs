// figma-clipboard-mcp 服务端 —— 零依赖
// 职责：网页托管 / 日志 / 单份缓存 / MCP (Streamable HTTP)
//
// 安全设计：
//  - 仅监听 127.0.0.1（外部机器无法访问）
//  - 静态文件只服务启动时扫描到的白名单（杜绝路径穿越）
//  - 所有请求体有大小上限；缓存只保留最近一次粘贴
//  - MCP 工具只读内存缓存，不接触文件系统
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const NAME = "figma-clipboard-mcp";
// 版本号唯一来源：package.json（避免与发版时 npm version 的 bump 脱节）
const VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
).version;

const PORT = Number(process.env.FCM_PORT) || 8388;
const HOST = process.env.FCM_HOST || "127.0.0.1";

const DATA_DIR = path.join(os.tmpdir(), NAME, "cache");
const LOG_DIR = path.join(os.tmpdir(), NAME, "logs");
const CACHE_FILE = path.join(DATA_DIR, "latest.json");
const LOG_FILE = path.join(LOG_DIR, "page.log");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const MAX_CACHE_BODY = 25 * 1024 * 1024; // 缓存上传上限 25MB
const MAX_LOG_BODY = 1 * 1024 * 1024;

/* ---------------- 日志（内存环形 + 文件） ---------------- */

const LOG_RING = [];
function log(level, tag, message, data) {
  const entry = { ts: new Date().toISOString(), level, tag, message: String(message), data: data ?? null };
  LOG_RING.push(entry);
  if (LOG_RING.length > 500) LOG_RING.shift();
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n"); } catch {}
  const brief = data ? " " + JSON.stringify(data).slice(0, 160) : "";
  console.log(`[${entry.ts}] [${level}] [${tag}] ${entry.message}${brief}`);
}

/* ---------------- 页面存储（一次粘贴 = 一个页面） ---------------- */
//
// 磁盘布局：
//   cache/pastes/index.json    索引（不含节点数据，列表页 / MCP list 只读它）
//   cache/pastes/<id>.json     单份完整数据（只有按 id 取详情时才读）
//   cache/latest.json          旧版单份缓存（启动时迁移后删除）

const PASTES_DIR = path.join(DATA_DIR, "pastes");
const INDEX_FILE = path.join(PASTES_DIR, "index.json");
fs.mkdirSync(PASTES_DIR, { recursive: true });

const MAX_PASTES = Number(process.env.FCM_MAX_PASTES) || 10;
const MAX_TOTAL_BYTES = Number(process.env.FCM_MAX_TOTAL_BYTES) || 100 * 1024 * 1024;
const MAX_NAME = 40;
const MAX_NOTE = 200;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 截图上限（Figma 复制的 PNG 快照）

/** id -> { id, name, note, fileKey, rootName, savedAt, nodeCount, bytes } */
const index = new Map();
/** 单槽热缓存：AI 连续读同一份时避免反复读盘 */
let hot = { id: null, data: null };

const pasteFile = (id) => path.join(PASTES_DIR, id + ".json");
const pngFile = (id) => path.join(PASTES_DIR, id + ".png");
// 防御性校验：id 只可能是服务端生成的 6 位 base36，避免任何外部输入进入文件路径
const isSafeId = (id) => typeof id === "string" && /^[0-9a-z]{6}$/.test(id);
const entries = () => [...index.values()].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));

function writeAtomic(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // 原子替换，进程被杀也不会留下半截 JSON
}

function writeIndex() {
  writeAtomic(INDEX_FILE, JSON.stringify({ pastes: entries() }));
}

function newId() {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    if (!index.has(id)) return id;
  }
}

// 名称参考：第一个非 DOCUMENT/CANVAS 节点名（通常就是用户在 Figma 里起的 frame 名）
function rootNameOf(nodes) {
  const pick = nodes.find((n) => n.type !== "DOCUMENT" && n.type !== "CANVAS" && n.name);
  return pick?.name || null;
}

function indexEntry(data, bytes, imageBytes) {
  return {
    id: data.id,
    name: data.name,
    note: data.note || "",
    fileKey: data.meta?.fileKey || null,
    rootName: rootNameOf(data.nodes),
    savedAt: data.savedAt,
    nodeCount: data.nodeCount,
    bytes,
    hasImage: imageBytes > 0,
    imageBytes: imageBytes || 0,
  };
}

// 截图单独存成 <id>.png（不塞进 JSON，列表页只靠 hasImage 决定要不要拉图）
function writeImage(id, b64) {
  if (!b64) return 0;
  try {
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) return 0;
    if (buf.length > MAX_IMAGE_BYTES) {
      log("warn", "paste", "截图超过上限，已跳过", { bytes: buf.length, limit: MAX_IMAGE_BYTES });
      return 0;
    }
    fs.writeFileSync(pngFile(id), buf);
    return buf.length;
  } catch (e) {
    log("warn", "paste", "截图写入失败", { error: e.message });
    return 0;
  }
}

function totalBytes() {
  let sum = 0;
  for (const e of index.values()) sum += e.bytes;
  return sum;
}

function evict() {
  const removed = [];
  while (index.size > 1 && (index.size > MAX_PASTES || totalBytes() > MAX_TOTAL_BYTES)) {
    const victim = [...index.values()].sort((a, b) => (a.savedAt > b.savedAt ? 1 : -1))[0];
    index.delete(victim.id);
    try { fs.unlinkSync(pasteFile(victim.id)); } catch {}
    try { fs.unlinkSync(pngFile(victim.id)); } catch {}
    if (hot.id === victim.id) hot = { id: null, data: null };
    removed.push(victim.id);
  }
  if (removed.length) log("info", "paste", "超出上限，已淘汰旧页面", { removed });
}

function savePaste({ name, note, meta, savedAt, nodes, image }) {
  const id = newId();
  const data = { id, name, note: note || "", meta: meta || null, savedAt, nodeCount: nodes.length, nodes };
  const text = JSON.stringify(data);
  writeAtomic(pasteFile(id), text);
  const imageBytes = writeImage(id, image);
  index.set(id, indexEntry(data, Buffer.byteLength(text), imageBytes));
  hot = { id, data };
  evict();
  writeIndex();
  log("info", "paste", "页面已保存", { id, name, nodes: data.nodeCount, imageBytes });
  return data;
}

function getPasteData(id) {
  if (!id || !index.has(id)) return null;
  if (hot.id === id && hot.data) return hot.data;
  try {
    const data = JSON.parse(fs.readFileSync(pasteFile(id), "utf8"));
    hot = { id, data };
    return data;
  } catch (e) {
    log("error", "paste", "读取页面失败", { id, error: e.message });
    return null;
  }
}

function updatePaste(id, patch) {
  const data = getPasteData(id);
  if (!data) return null;
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.note !== undefined) data.note = patch.note;
  const text = JSON.stringify(data);
  writeAtomic(pasteFile(id), text);
  hot = { id, data };
  index.set(id, indexEntry(data, Buffer.byteLength(text)));
  writeIndex();
  log("info", "paste", "页面信息已更新", { id, name: data.name });
  return data;
}

function deletePaste(id) {
  if (!index.has(id)) return false;
  index.delete(id);
  try { fs.unlinkSync(pasteFile(id)); } catch {}
  try { fs.unlinkSync(pngFile(id)); } catch {}
  if (hot.id === id) hot = { id: null, data: null };
  writeIndex();
  log("info", "paste", "页面已删除", { id });
  return true;
}

function storeInfo() {
  const list = entries();
  return {
    hasData: index.size > 0,
    count: index.size,
    nodeCount: list.reduce((s, e) => s + e.nodeCount, 0),
    bytes: totalBytes(),
    latestId: list[0]?.id || null,
    savedAt: list[0]?.savedAt || null,
    limits: { maxPastes: MAX_PASTES, maxTotalBytes: MAX_TOTAL_BYTES },
  };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    for (const e of raw.pastes || []) index.set(e.id, e);
  } catch {}
  // 索引与磁盘一致性兜底：文件丢了的条目移除，截图丢失则清掉标记
  for (const id of [...index.keys()]) {
    if (!fs.existsSync(pasteFile(id))) { index.delete(id); continue; }
    const e = index.get(id);
    e.hasImage = fs.existsSync(pngFile(id));
    if (!e.hasImage) e.imageBytes = 0;
  }
  migrateLegacy();
  log("info", "store", "载入页面索引", { count: index.size });
}

// 旧版单份缓存 → 迁移为一个页面
function migrateLegacy() {
  if (!fs.existsSync(CACHE_FILE)) return;
  try {
    const old = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (index.size === 0 && Array.isArray(old.nodes) && old.nodes.length) {
      savePaste({
        name: "页面 1", note: "",
        meta: old.meta, savedAt: old.savedAt || new Date().toISOString(), nodes: old.nodes,
      });
      log("info", "store", "旧版缓存已迁移为页面", { nodes: old.nodes.length });
    }
    fs.unlinkSync(CACHE_FILE);
  } catch (e) {
    log("warn", "store", "旧缓存迁移失败", { error: e.message });
  }
}

/* ---------------- MCP 工具实现（只读内存缓存） ---------------- */

function buildTree(nodes, maxDepth) {
  const byGuid = new Map(nodes.map((n) => [n.guid, n]));
  const childrenOf = new Map();
  const roots = [];
  for (const n of nodes) {
    if (n.parent && byGuid.has(n.parent)) {
      if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
      childrenOf.get(n.parent).push(n);
    } else {
      roots.push(n);
    }
  }
  function toTreeNode(n, depth) {
    const t = {
      guid: n.guid, type: n.type, name: n.name,
      size: n.size, visible: n.visible, childCount: childrenOf.get(n.guid)?.length || 0,
    };
    if (depth < maxDepth && childrenOf.has(n.guid)) {
      t.children = childrenOf.get(n.guid).map((c) => toTreeNode(c, depth + 1));
    }
    return t;
  }
  return { roots: roots.map((r) => toTreeNode(r, 0)), total: nodes.length };
}

function searchNodes(nodes, query, type, limit) {
  const q = (query || "").toLowerCase();
  const out = [];
  for (const n of nodes) {
    if (type && n.type !== type) continue;
    if (q && !n.name.toLowerCase().includes(q) && n.type.toLowerCase() !== q) continue;
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

function getNode(nodes, guid) {
  return nodes.find((n) => n.guid === guid) || null;
}

function getStats(data) {
  const hist = {};
  for (const n of data.nodes) hist[n.type] = (hist[n.type] || 0) + 1;
  return {
    id: data.id, name: data.name, note: data.note || "",
    savedAt: data.savedAt, nodeCount: data.nodeCount,
    fileKey: data.meta?.fileKey || null,
    typeHistogram: Object.fromEntries(Object.entries(hist).sort((a, b) => b[1] - a[1])),
  };
}

const PASTE_ID_PROP = {
  type: "string",
  description: "页面 id（必填）。先用 figma_list_pastes 获取，再按名称/简介语义匹配目标页面。",
};

const MCP_TOOLS = [
  {
    name: "figma_list_pastes",
    description: "列出所有已保存的页面（id、名称、简介、节点数、保存时间）。这是唯一不需要 pasteId 的工具：先调用它，按名称/简介的语义挑出目标页面 id，其余工具都必须带该 id。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_get_meta",
    description: "获取指定页面的元信息（id、名称、简介、fileKey、保存时间、节点数）。",
    inputSchema: {
      type: "object",
      properties: { pasteId: PASTE_ID_PROP },
      required: ["pasteId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_tree",
    description: "获取指定页面的图层树（层级结构）。返回从根节点开始的树，可控制深度。",
    inputSchema: {
      type: "object",
      properties: {
        pasteId: PASTE_ID_PROP,
        maxDepth: { type: "number", description: "最大展开深度，默认 6", default: 6 },
      },
      required: ["pasteId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_search_nodes",
    description: "在指定页面内按名称/类型搜索节点。query 匹配名称（不区分大小写）或精确类型名（如 FRAME、TEXT）。",
    inputSchema: {
      type: "object",
      properties: {
        pasteId: PASTE_ID_PROP,
        query: { type: "string", description: "名称关键字或类型名" },
        type: { type: "string", description: "按类型精确过滤（如 FRAME / TEXT / INSTANCE）" },
        limit: { type: "number", description: "返回上限，默认 20", default: 20 },
      },
      required: ["pasteId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_node",
    description: "在指定页面内按 guid 获取单个节点完整信息（位置、尺寸、填充、描边、文本内容、约束等）。",
    inputSchema: {
      type: "object",
      properties: {
        pasteId: PASTE_ID_PROP,
        guid: { type: "string", description: "节点 guid，形如 1234:5678" },
      },
      required: ["pasteId", "guid"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_screenshot",
    description: "获取指定页面的截图（Figma 复制时附带的 PNG 快照）。用于让模型看到视觉参考并做像素级对比；若用户复制时未附带位图则返回错误。",
    inputSchema: {
      type: "object",
      properties: { pasteId: PASTE_ID_PROP },
      required: ["pasteId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_stats",
    description: "获取指定页面的统计信息：节点类型分布直方图、总数、来源文件。",
    inputSchema: {
      type: "object",
      properties: { pasteId: PASTE_ID_PROP },
      required: ["pasteId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_raw",
    description: "获取指定页面全部节点的原始 JSON（数据大时建议用 maxNodes 截断）。",
    inputSchema: {
      type: "object",
      properties: {
        pasteId: PASTE_ID_PROP,
        maxNodes: { type: "number", description: "最多返回多少节点，默认全部" },
      },
      required: ["pasteId"],
      additionalProperties: false,
    },
  },
];

function availableText() {
  const list = entries();
  if (!list.length) return "（当前没有任何页面，请先在网页粘贴并保存）";
  return list.map((e) => `- ${e.id} · ${e.name}${e.note ? " · " + e.note : ""}`).join("\n");
}

// 所有读工具唯一入口：页面数据只能通过 id 获取
function requirePaste(args) {
  const id = typeof args?.pasteId === "string" ? args.pasteId.trim() : "";
  if (!id) return { err: "缺少 pasteId。请先调用 figma_list_pastes 选择页面。\n当前可用页面：\n" + availableText() };
  const data = getPasteData(id);
  if (!data) return { err: "未找到页面: " + id + "\n当前可用页面：\n" + availableText() };
  return { data };
}

function callTool(name, args) {
  if (name === "figma_list_pastes") {
    const list = entries();
    if (!list.length) {
      return { content: [{ type: "text", text: "当前没有任何页面：请在网页粘贴 Figma 数据并保存后重试。" }], isError: true };
    }
    const out = list.map((e) => ({
      id: e.id, name: e.name, note: e.note, savedAt: e.savedAt,
      nodeCount: e.nodeCount, rootName: e.rootName, fileKey: e.fileKey,
      hasScreenshot: !!e.hasImage,
    }));
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }

  const { data, err } = requirePaste(args);
  if (err) return { content: [{ type: "text", text: err }], isError: true };

  switch (name) {
    case "figma_get_screenshot": {
      const entry = index.get(data.id);
      if (!entry?.hasImage || !fs.existsSync(pngFile(data.id))) {
        return {
          content: [{ type: "text", text: "该页面没有截图：保存时剪贴板里没有位图快照（Figma 复制时通常会自动带一张 PNG）。" }],
          isError: true,
        };
      }
      return {
        content: [
          { type: "image", data: fs.readFileSync(pngFile(data.id)).toString("base64"), mimeType: "image/png" },
          { type: "text", text: `页面「${data.name}」的截图（${data.id}）` },
        ],
      };
    }
    case "figma_get_meta":
      return {
        content: [{ type: "text", text: JSON.stringify({
          id: data.id, name: data.name, note: data.note || "",
          savedAt: data.savedAt, nodeCount: data.nodeCount, meta: data.meta,
          hasScreenshot: !!index.get(data.id)?.hasImage,
        }, null, 2) }],
      };
    case "figma_get_tree":
      return { content: [{ type: "text", text: JSON.stringify(buildTree(data.nodes, Math.min(args?.maxDepth ?? 6, 20)), null, 2) }] };
    case "figma_search_nodes":
      return {
        content: [{ type: "text", text: JSON.stringify(
          searchNodes(data.nodes, args?.query, args?.type, Math.min(args?.limit ?? 20, 200)), null, 2) }],
      };
    case "figma_get_node": {
      const n = getNode(data.nodes, args?.guid);
      if (!n) return { content: [{ type: "text", text: "未找到节点: " + args?.guid }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(n, null, 2) }] };
    }
    case "figma_get_stats":
      return { content: [{ type: "text", text: JSON.stringify(getStats(data), null, 2) }] };
    case "figma_get_raw": {
      const max = Math.min(args?.maxNodes ?? data.nodes.length, data.nodes.length);
      return { content: [{ type: "text", text: JSON.stringify({ ...data, nodes: data.nodes.slice(0, max) }) }] };
    }
    default:
      return { content: [{ type: "text", text: "未知工具: " + name }], isError: true };
  }
}

/* ---------------- MCP 协议（Streamable HTTP，无状态） ---------------- */

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function handleRpcMessage(msg) {
  if (!msg || typeof msg !== "object") return jsonRpcError(null, -32600, "Invalid Request");
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
        instructions:
          "Figma 剪贴板数据服务，一次粘贴会保存为一个独立页面。工作流程：" +
          "① 先调用 figma_list_pastes 拿到全部页面的 id / 名称 / 简介；" +
          "② 按用户描述与名称、简介的语义匹配，挑出目标页面的 id；" +
          "③ 其余工具都必须带 pasteId，未传会返回可用页面列表。" +
          "页面数据只能通过 pasteId 获取，不存在\"默认页面\"。",
      });
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const result = callTool(params?.name, params?.arguments);
      return jsonRpcResult(id, result);
    }
    default:
      if (id === undefined || id === null) return null; // 通知，忽略
      return jsonRpcError(id, -32601, "Method not found: " + method);
  }
}

function handleMcp(req, res, body) {
  let parsed;
  try { parsed = JSON.parse(body || "{}"); } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses = [];
  let hasNotificationOnly = true;
  for (const m of messages) {
    const r = handleRpcMessage(m);
    if (r && m.id !== undefined && m.id !== null) {
      responses.push(r);
      hasNotificationOnly = false;
    }
  }
  if (hasNotificationOnly) {
    res.writeHead(202); res.end(); return;
  }
  const payload = Array.isArray(parsed) ? responses : responses[0];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/* ---------------- HTTP 基础设施 ---------------- */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("body too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 解析并校验粘贴负载；requireName=true 时名称必填（/api/pastes），否则自动命名（/cache 旧接口）
async function readPastePayload(req, requireName) {
  const body = await readBody(req, MAX_CACHE_BODY);
  const data = JSON.parse(body);
  if (!data || !Array.isArray(data.nodes)) {
    throw Object.assign(new Error("invalid payload: nodes 必须是数组"), { code: 400 });
  }
  let name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) {
    if (requireName) throw Object.assign(new Error("name 不能为空"), { code: 400 });
    name = "页面 " + (index.size + 1);
  }
  const note = typeof data.note === "string" ? data.note.trim().slice(0, MAX_NOTE) : "";
  return {
    name: name.slice(0, MAX_NAME),
    note,
    meta: data.meta || null,
    savedAt: data.savedAt || new Date().toISOString(),
    nodes: data.nodes,
    image: typeof data.image === "string" ? data.image : null,
  };
}

// 静态白名单：启动时扫描 public/，只服务列出来的文件
const STATIC_FILES = new Map(); // pathname -> {file, type}
{
  const pubDir = path.join(__dirname, "..", "public");
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  function scan(dir, urlPrefix) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) scan(full, urlPrefix + name + "/");
      else {
        const ext = path.extname(name);
        if (types[ext]) {
          STATIC_FILES.set(urlPrefix + name, { file: full, type: types[ext] });
          // 根路径映射到 index.html
          if (urlPrefix + name === "/index.html") {
            STATIC_FILES.set("/", { file: full, type: types[ext] });
          }
        }
      }
    }
  }
  scan(pubDir, "/");
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  // 注：script-src 需允许 unsafe-eval —— kiwi-schema 的 compileSchema 会把 schema
  // 编译成 JS 源码字符串并用 new Function 求值（schema 来自粘贴数据，必须运行时编译）。
  // 本服务仅监听回环地址 + 页面动态内容全部 HTML 转义，风险可控。
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'",
};

const server = http.createServer(async (req, res) => {
  // 安全响应头（所有响应）
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  const u = new URL(req.url, "http://localhost");
  const pathname = u.pathname;

  try {
    /* ---- 健康检查（供 CLI 探活） ---- */
    if (req.method === "GET" && pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true, name: NAME, version: VERSION,
        host: HOST, mcpPath: "/mcp",
        cache: storeInfo(),
      }));
      return;
    }

    /* ---- 页面截图（PNG，按需拉取） ---- */
    const imgMatch = pathname.match(/^\/api\/pastes\/([^/]+)\/image$/);
    if (imgMatch && req.method === "GET") {
      const id = decodeURIComponent(imgMatch[1]);
      if (!isSafeId(id) || !index.has(id) || !fs.existsSync(pngFile(id))) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no screenshot: " + id }));
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(pngFile(id)));
      return;
    }

    /* ---- 页面 API（一次粘贴 = 一个页面） ---- */
    const pasteMatch = pathname.match(/^\/api\/pastes(?:\/([^/]+))?$/);
    if (pasteMatch) {
      const id = pasteMatch[1] ? decodeURIComponent(pasteMatch[1]) : null;
      if (id && !isSafeId(id)) return json(404, { error: "not found: " + id });
      const json = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (!id) {
        if (req.method === "GET") return json(200, entries());
        if (req.method === "POST") {
          const payload = await readPastePayload(req, true);
          const data = savePaste(payload);
          return json(200, { ok: true, id: data.id, name: data.name });
        }
        return json(405, { error: "method not allowed" });
      }

      if (req.method === "GET") {
        const data = getPasteData(id);
        if (!data) return json(404, { error: "not found: " + id });
        return json(200, { ...data, hasImage: !!index.get(id)?.hasImage });
      }
      if (req.method === "PATCH") {
        const body = JSON.parse(await readBody(req, MAX_LOG_BODY));
        const patch = {};
        if (body.name !== undefined) {
          const name = String(body.name).trim();
          if (!name) return json(400, { error: "name 不能为空" });
          patch.name = name.slice(0, MAX_NAME);
        }
        if (body.note !== undefined) patch.note = String(body.note).trim().slice(0, MAX_NOTE);
        const data = updatePaste(id, patch);
        if (!data) return json(404, { error: "not found: " + id });
        return json(200, { ok: true, id, name: data.name, note: data.note });
      }
      if (req.method === "DELETE") {
        if (!deletePaste(id)) return json(404, { error: "not found: " + id });
        return json(200, { ok: true, id });
      }
      return json(405, { error: "method not allowed" });
    }

    /* ---- 旧接口：/cache 等价于新建一个页面（名称缺省自动生成） ---- */
    if (req.method === "POST" && pathname === "/cache") {
      const payload = await readPastePayload(req, false);
      const data = savePaste(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: data.id, name: data.name, nodeCount: data.nodeCount }));
      return;
    }
    if (req.method === "GET" && pathname === "/api/cache-info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(storeInfo()));
      return;
    }
    if (req.method === "GET" && pathname === "/api/cache") {
      const latestId = entries()[0]?.id;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(latestId ? getPasteData(latestId) : null));
      return;
    }
    if (req.method === "GET" && pathname === "/api/logs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(LOG_RING.slice(-Number(u.searchParams.get("n") || 100))));
      return;
    }

    /* ---- 页面日志 ---- */
    if (req.method === "POST" && pathname === "/log") {
      const body = await readBody(req, MAX_LOG_BODY);
      const data = JSON.parse(body);
      for (const e of Array.isArray(data) ? data : [data]) {
        log(e.level || "info", e.tag || "page", e.message ?? "", e.data);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    /* ---- MCP ---- */
    if (pathname === "/mcp") {
      if (req.method === "POST") {
        const body = await readBody(req, 2 * 1024 * 1024);
        handleMcp(req, res, body);
        return;
      }
      // 无状态服务不提供 SSE 流
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    /* ---- 静态文件（白名单） ---- */
    if (req.method === "GET" && STATIC_FILES.has(pathname)) {
      const entry = STATIC_FILES.get(pathname);
      res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-store" });
      res.end(fs.readFileSync(entry.file));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    const code = err.code && Number.isInteger(err.code) ? err.code : 500;
    log("error", "http", `${req.method} ${pathname} → ${code}`, { error: err.message });
    if (!res.headersSent) {
      res.writeHead(code, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: err.message }));
  }
});

loadStore();
server.listen(PORT, HOST, () => {
  log("info", "server", `${NAME} v${VERSION} 已启动`, {
    url: `http://${HOST}:${PORT}/`,
    mcp: `http://${HOST}:${PORT}/mcp`,
    cacheDir: PASTES_DIR,
  });
  console.log(`${NAME} v${VERSION}`);
  console.log(`  网页: http://${HOST}:${PORT}/`);
  console.log(`  MCP:  http://${HOST}:${PORT}/mcp   (Streamable HTTP)`);
  console.log(`  监听: ${HOST}（仅本机可访问）`);
  console.log(`  页面: ${PASTES_DIR}（最多 ${MAX_PASTES} 份）`);
});
