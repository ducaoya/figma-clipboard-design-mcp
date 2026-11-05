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
const MAX_ASSET_BYTES = 6 * 1024 * 1024;  // 单张图片资源上限
const MAX_ASSETS = 40;                    // 单页最多保留多少张图片资源

const ASSET_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

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
const VISUAL_TYPES = new Set(["FRAME", "SECTION", "COMPONENT", "COMPONENT_SET", "SYMBOL", "GROUP"]);
function rootNameOf(nodes) {
  // 优先取看得见的容器节点（VARIABLE / VARIABLE_SET 不是页面内容）
  const pick = nodes.find((n) => VISUAL_TYPES.has(n.type) && n.name)
    || nodes.find((n) => n.type !== "DOCUMENT" && n.type !== "CANVAS" && !String(n.type).startsWith("VARIABLE") && n.name);
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
    assets: (data.assets || []).map((a) => ({ ref: a.ref, mime: a.mime, bytes: a.bytes })),
  };
}

// 图片资源的第二来源：剪贴板 meta.imageHashes 里是签名 URL（优先，因为 blob 的 SHA-1 常常对不上）
const ASSET_URL_HOSTS = /(^|\.)figma\.com$/i;

async function fetchAsset(url, timeoutMs = 10000) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" || !ASSET_URL_HOSTS.test(u.hostname)) return null; // 只允许 Figma 域名，防 SSRF
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // redirect:error —— 避免被 302 到非 Figma 域名绕过白名单
    const res = await fetch(url, { signal: ctrl.signal, redirect: "error" });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_ASSET_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_ASSET_BYTES) return null;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (ct && !ASSET_EXT[ct]) return null; // 只接受图片类型
    return { buf, mime: ASSET_EXT[ct] ? ct : "image/png" };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function attachAssetsFromUrls(id, pairs) {
  const saved = [];
  const deadline = Date.now() + 25000; // 整体预算：不让保存请求因下载卡住
  for (const p of (pairs || []).slice(0, 12)) {
    if (Date.now() > deadline) { log("warn", "paste", "图片下载超时，剩余已跳过", { ref: p && p.ref }); break; }
    if (!p || typeof p.ref !== "string" || typeof p.url !== "string") continue;
    if (!/^[0-9a-f]{6,20}$/i.test(p.ref)) continue;
    const got = await fetchAsset(p.url);
    if (!got) { log("warn", "paste", "图片下载失败", { ref: p.ref }); continue; }
    try {
      fs.writeFileSync(assetFile(id, p.ref, got.mime), got.buf);
      saved.push({ ref: p.ref, mime: got.mime, bytes: got.buf.length });
    } catch (e) {
      log("warn", "paste", "图片资源写入失败", { ref: p.ref, error: e.message });
    }
  }
  return saved;
}

// 把两路来源（blob / 签名 URL）的图片资源合并进索引
function mergeAssets(id, data, extra) {
  if (!extra || !extra.length) return;
  const seen = new Set((data.assets || []).map((a) => a.ref));
  data.assets = [...(data.assets || []), ...extra.filter((a) => !seen.has(a.ref))];
  const entry = index.get(id);
  if (entry) { entry.assets = data.assets; index.set(id, entry); writeIndex(); }
}

const assetFile = (id, ref, mime) => path.join(PASTES_DIR, id + "." + ref + "." + (ASSET_EXT[mime] || "bin"));

// 图片资源（节点里 IMAGE 填充的实际像素）：<pasteId>.<ref>.png
function writeAssets(id, assets) {
  const saved = [];
  for (const a of (assets || []).slice(0, MAX_ASSETS)) {
    if (!a || typeof a.ref !== "string" || typeof a.data !== "string") continue;
    if (!/^[0-9a-f]{6,20}$/i.test(a.ref)) continue;
    const mime = ASSET_EXT[a.mime] ? a.mime : "image/png";
    let buf;
    try { buf = Buffer.from(a.data, "base64"); } catch { continue; }
    if (!buf.length || buf.length > MAX_ASSET_BYTES) continue;
    try {
      fs.writeFileSync(assetFile(id, a.ref, mime), buf);
      saved.push({ ref: a.ref, mime, bytes: buf.length });
    } catch (e) {
      log("warn", "paste", "图片资源写入失败", { ref: a.ref, error: e.message });
    }
  }
  return saved;
}

function dropAssets(id) {
  const entry = index.get(id);
  for (const a of entry?.assets || []) {
    try { fs.unlinkSync(assetFile(id, a.ref, a.mime)); } catch {}
  }
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
    dropAssets(victim.id);
    index.delete(victim.id);
    try { fs.unlinkSync(pasteFile(victim.id)); } catch {}
    try { fs.unlinkSync(pngFile(victim.id)); } catch {}
    if (hot.id === victim.id) hot = { id: null, data: null };
    removed.push(victim.id);
  }
  if (removed.length) log("info", "paste", "超出上限，已淘汰旧页面", { removed });
}

function savePaste({ name, note, meta, savedAt, nodes, image, assets }) {
  const id = newId();
  const data = { id, name, note: note || "", meta: meta || null, savedAt, nodeCount: nodes.length, nodes };
  const text = JSON.stringify(data);
  writeAtomic(pasteFile(id), text);
  const imageBytes = writeImage(id, image);
  data.assets = writeAssets(id, assets); // 先把文件写完，索引才能记录正确的资源列表
  index.set(id, indexEntry(data, Buffer.byteLength(text), imageBytes));
  hot = { id, data };
  evict();
  writeIndex();
  log("info", "paste", "页面已保存", { id, name, nodes: data.nodeCount, imageBytes, assets: data.assets.length });
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
  dropAssets(id);
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

// 从某节点开始的子树（含自身），用于「只细化某个节点」
function collectSubtree(nodes, rootGuid, maxDepth, maxNodes) {
  const byGuid = new Map(nodes.map((n) => [n.guid, n]));
  const root = byGuid.get(rootGuid);
  if (!root) return null;
  const childrenOf = new Map();
  for (const n of nodes) {
    if (n.parent && byGuid.has(n.parent)) {
      if (!childrenOf.has(n.parent)) childrenOf.set(n.parent, []);
      childrenOf.get(n.parent).push(n);
    }
  }
  const out = [];
  const queue = [{ n: root, d: 0 }];
  while (queue.length && out.length < maxNodes) {
    const { n, d } = queue.shift();
    out.push(n);
    if (d < maxDepth) for (const c of childrenOf.get(n.guid) || []) queue.push({ n: c, d: d + 1 });
  }
  return { root, nodes: out, truncated: out.length >= maxNodes };
}

// 批量展开实例：guid → componentId → 组件子树；默认递归展开组件里嵌套的实例
function expandInstances(nodes, guids, maxDepth, opts) {
  const recursive = opts?.recursive !== false;
  const maxComponents = Math.min(Number(opts?.maxComponents ?? 80) || 80, 100);
  const byGuid = new Map(nodes.map((n) => [n.guid, n]));
  const instances = [];
  const missing = [];
  const components = [];
  const seen = new Set();
  const queue = [];
  for (const g of guids) {
    const n = byGuid.get(g);
    if (!n) { missing.push(g); continue; }
    const cid = n.componentId || null;
    instances.push({ guid: n.guid, name: n.name, type: n.type, componentId: cid });
    if (cid) queue.push(cid);
    else missing.push(g + "（无 componentId）");
  }
  let budget = 3000;
  while (queue.length && budget > 0 && components.length < maxComponents) {
    const cid = queue.shift();
    if (seen.has(cid)) continue;
    seen.add(cid);
    const sub = collectSubtree(nodes, cid, maxDepth, Math.min(400, budget));
    if (!sub) { missing.push(cid + "（组件不存在）"); continue; }
    budget -= sub.nodes.length;
    components.push({
      guid: cid, name: sub.root.name, type: sub.root.type,
      nodeCount: sub.nodes.length, truncated: sub.truncated, nodes: sub.nodes,
    });
    if (recursive) {
      for (const n of sub.nodes) {
        if (n.componentId && !seen.has(n.componentId)) queue.push(n.componentId);
      }
    }
  }
  return { instances, components, missing, recursive, truncated: queue.length > 0 };
}

// 扫描全页 IMAGE 填充，返回每个 ref 被哪些节点使用（不用展开实例也能定位到图）
function listAssets(nodes) {
  const byGuid = new Map(nodes.map((n) => [n.guid, n]));
  const pathOf = (g) => {
    const segs = [];
    let cur = byGuid.get(g);
    let guard = 0;
    while (cur && guard++ < 40) {
      segs.unshift(cur.name || cur.type);
      cur = cur.parent ? byGuid.get(cur.parent) : null;
    }
    return segs.join(" > ");
  };
  const map = new Map();
  for (const n of nodes) {
    for (const f of n.fills || []) {
      if (!f || f.type !== "IMAGE" || !f.image || !f.image.ref) continue;
      const ref = f.image.ref;
      if (!map.has(ref)) map.set(ref, []);
      map.get(ref).push({ guid: n.guid, type: n.type, name: n.name, path: pathOf(n.guid) });
    }
  }
  return [...map.entries()].map(([ref, used]) => ({ ref, used }));
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
  {
    name: "figma_get_subtree",
    description: "只取某个节点下面的子树（含自身）。用于「只细化某个节点」，比 figma_get_tree 精准，不会拉全页。guid 可从 Figma 的 Copy link to selection（node-id=11851-217125 → 11851:217125）得到。",
    inputSchema: {
      type: "object",
      properties: {
        pasteId: PASTE_ID_PROP,
        guid: { type: "string", description: "子树的根节点 guid，形如 11851:217125" },
        maxDepth: { type: "number", description: "最大展开深度，默认 6", default: 6 },
        maxNodes: { type: "number", description: "节点数上限，默认 400", default: 400 },
      },
      required: ["pasteId", "guid"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_expand_instances",
    description: "批量展开 INSTANCE：根据节点上的 componentId 找到本页的组件定义（SYMBOL），返回组件子树，默认递归展开组件里嵌套的实例。还原时必须用它把实例画成真实内容，否则只能画出空壳。",
    inputSchema: {
      type: "object",
      properties: {
        pasteId: PASTE_ID_PROP,
        guids: { type: "array", items: { type: "string" }, description: "实例节点 guid 列表，最多 50 个" },
        maxDepth: { type: "number", description: "单个组件子树展开深度，默认 8", default: 8 },
        recursive: { type: "boolean", description: "是否递归展开嵌套实例，默认 true", default: true },
        maxComponents: { type: "number", description: "最多展开多少个组件，默认 80（上限 100）", default: 80 },
      },
      required: ["pasteId", "guids"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_list_assets",
    description: "列出页面里所有图片（IMAGE 填充）及其使用位置：ref、mime、占用字节、被哪些节点引用（含节点路径）。还原前先调它，再按 ref 用 figma_get_assets 取图。不需要展开实例就能知道页面用了哪些图。",
    inputSchema: {
      type: "object",
      properties: { pasteId: PASTE_ID_PROP },
      required: ["pasteId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_assets",
    description: "取页面里的图片资源（节点 IMAGE 填充的真实像素），返回 MCP image 内容块。节点里 fills[].image.ref 就是这里的 ref。不传 refs 则取全部（上限 20 张 / 4MB）。",
    inputSchema: {
      type: "object",
      properties: {
        pasteId: PASTE_ID_PROP,
        refs: { type: "array", items: { type: "string" }, description: "指定资源 ref 列表，不传取全部" },
        limit: { type: "number", description: "最多返回张数，默认 8", default: 8 },
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
    case "figma_get_subtree": {
      const guid = typeof args?.guid === "string" ? args.guid.trim() : "";
      if (!guid) return { content: [{ type: "text", text: "缺少 guid（形如 11851:217125）" }], isError: true };
      const maxDepth = Math.min(Number(args?.maxDepth ?? 6) || 6, 20);
      const maxNodes = Math.min(Number(args?.maxNodes ?? 400) || 400, 1200);
      const sub = collectSubtree(data.nodes, guid, maxDepth, maxNodes);
      if (!sub) {
        const near = data.nodes.filter((n) => n.guid === guid || n.name.includes(guid)).slice(0, 5);
        return {
          content: [{ type: "text", text: "未找到节点: " + guid + (near.length ? "\n名字接近的节点：\n" + near.map((n) => `- ${n.guid} · ${n.type} · ${n.name}`).join("\n") : "") }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          root: { guid: sub.root.guid, type: sub.root.type, name: sub.root.name },
          nodeCount: sub.nodes.length, truncated: sub.truncated, maxDepth, nodes: sub.nodes,
        }, null, 2) }],
      };
    }
    case "figma_expand_instances": {
      const guids = Array.isArray(args?.guids) ? args.guids.filter((g) => typeof g === "string").slice(0, 50) : [];
      if (!guids.length) {
        return { content: [{ type: "text", text: "缺少 guids：传入实例节点 guid 列表（最多 50 个）" }], isError: true };
      }
      const maxDepth = Math.min(Number(args?.maxDepth ?? 8) || 8, 20);
      const res = expandInstances(data.nodes, guids, maxDepth, {
        recursive: args?.recursive !== false,
        maxComponents: args?.maxComponents,
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    case "figma_list_assets": {
      const entry = index.get(data.id);
      const saved = new Map((entry?.assets || []).map((a) => [a.ref, a]));
      const used = listAssets(data.nodes);
      const out = used.map((u) => ({
        ref: u.ref,
        mime: saved.get(u.ref)?.mime || null,
        bytes: saved.get(u.ref)?.bytes || 0,
        available: saved.has(u.ref),
        usedBy: u.used.slice(0, 6),
        usedCount: u.used.length,
      }));
      if (!out.length) {
        return { content: [{ type: "text", text: "该页面没有 IMAGE 填充节点。" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          total: out.length,
          availableCount: out.filter((a) => a.available).length,
          assets: out,
        }, null, 2) }],
      };
    }
    case "figma_get_assets": {
      const entry = index.get(data.id);
      const all = entry?.assets || [];
      if (!all.length) {
        return { content: [{ type: "text", text: "该页面没有可用的图片资源（节点里 IMAGE 填充的像素没拿到，可能是复制时未包含）。" }], isError: true };
      }
      const wanted = Array.isArray(args?.refs) ? args.refs.filter((r) => typeof r === "string") : null;
      const limit = Math.min(Number(args?.limit ?? 8) || 8, 20);
      const picked = (wanted ? all.filter((a) => wanted.includes(a.ref)) : all).slice(0, limit);
      if (!picked.length) {
        return { content: [{ type: "text", text: "未找到指定 ref。可用 ref：" + all.map((a) => a.ref).join(", ") }], isError: true };
      }
      const content = [];
      let total = 0;
      const sent = [];
      for (const a of picked) {
        if (total + a.bytes > 4 * 1024 * 1024) break;
        try {
          const buf = fs.readFileSync(assetFile(data.id, a.ref, a.mime));
          content.push({ type: "image", data: buf.toString("base64"), mimeType: a.mime });
          content.push({ type: "text", text: `asset ref=${a.ref} (${a.mime}, ${a.bytes} bytes)` });
          total += a.bytes;
          sent.push(a.ref);
        } catch { /* 文件缺失则跳过 */ }
      }
      if (!content.length) {
        return { content: [{ type: "text", text: "资源文件缺失，可能是旧版本保存的页面。" }], isError: true };
      }
      return { content };
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
          "页面数据只能通过 pasteId 获取，不存在\"默认页面\"。" +
          "还原页面时：先用 figma_get_screenshot 看视觉基线，再用 figma_get_subtree 只拉目标子树；" +
          "遇到 INSTANCE 必须用 figma_expand_instances 展开成真实组件，不要只画外壳；" +
          "节点 fills 里 type=IMAGE 时，用 figma_get_assets 取真实图片再嵌入，不要画色块代替。",
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
    assets: Array.isArray(data.assets) ? data.assets : [],
    assetUrls: Array.isArray(data.assetUrls) ? data.assetUrls : [],
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

    /* ---- 节点图片资源（IMAGE 填充的实际像素） ---- */
    const assetMatch = pathname.match(/^\/api\/pastes\/([^/]+)\/assets\/([0-9a-fA-F]{6,20})$/);
    if (assetMatch && req.method === "GET") {
      const id = decodeURIComponent(assetMatch[1]);
      const ref = assetMatch[2].toLowerCase();
      const entry = isSafeId(id) ? index.get(id) : null;
      const meta = entry?.assets?.find((a) => a.ref === ref);
      if (!meta) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no asset: " + ref }));
        return;
      }
      try {
        const buf = fs.readFileSync(assetFile(id, ref, meta.mime));
        res.writeHead(200, { "Content-Type": meta.mime, "Cache-Control": "no-store" });
        res.end(buf);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "asset file missing: " + ref }));
      }
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
          if (payload.assetUrls.length) {
            mergeAssets(data.id, data, await attachAssetsFromUrls(data.id, payload.assetUrls));
          }
          return json(200, { ok: true, id: data.id, name: data.name, assets: (data.assets || []).length });
        }
        return json(405, { error: "method not allowed" });
      }

      if (req.method === "GET") {
        const data = getPasteData(id);
        if (!data) return json(404, { error: "not found: " + id });
        const entry = index.get(id);
        return json(200, { ...data, hasImage: !!entry?.hasImage, assets: entry?.assets || [] });
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
      if (payload.assetUrls.length) {
        mergeAssets(data.id, data, await attachAssetsFromUrls(data.id, payload.assetUrls));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: data.id, name: data.name, nodeCount: data.nodeCount, assets: (data.assets || []).length }));
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
