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
const VERSION = "0.1.0";
const NAME = "figma-clipboard-mcp";

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

/* ---------------- 缓存（仅最近一次粘贴） ---------------- */

let cache = null; // { meta, savedAt, nodeCount, nodes: [...] }

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    cache = JSON.parse(raw);
    log("info", "cache", "启动时载入缓存", { nodes: cache.nodeCount, savedAt: cache.savedAt });
  } catch {
    cache = null;
  }
}

function setCache(obj) {
  cache = obj;
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
    log("info", "cache", "缓存已更新", { nodes: obj.nodeCount, bytes: fs.statSync(CACHE_FILE).size });
  } catch (e) {
    log("error", "cache", "缓存写盘失败", { error: e.message });
  }
}

function cacheInfo() {
  if (!cache) return { hasData: false, nodeCount: 0, bytes: 0, savedAt: null };
  let bytes = 0;
  try { bytes = fs.statSync(CACHE_FILE).size; } catch {}
  return { hasData: true, nodeCount: cache.nodeCount, bytes, savedAt: cache.savedAt };
}

/* ---------------- MCP 工具实现（只读内存缓存） ---------------- */

function buildTree(maxDepth) {
  if (!cache) return null;
  const byGuid = new Map(cache.nodes.map((n) => [n.guid, n]));
  const childrenOf = new Map();
  const roots = [];
  for (const n of cache.nodes) {
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
  return { roots: roots.map((r) => toTreeNode(r, 0)), total: cache.nodeCount };
}

function searchNodes(query, type, limit) {
  if (!cache) return [];
  const q = (query || "").toLowerCase();
  const out = [];
  for (const n of cache.nodes) {
    if (type && n.type !== type) continue;
    if (q && !n.name.toLowerCase().includes(q) && n.type.toLowerCase() !== q) continue;
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

function getNode(guid) {
  if (!cache) return null;
  return cache.nodes.find((n) => n.guid === guid) || null;
}

function getStats() {
  if (!cache) return null;
  const hist = {};
  for (const n of cache.nodes) hist[n.type] = (hist[n.type] || 0) + 1;
  return {
    savedAt: cache.savedAt, nodeCount: cache.nodeCount,
    fileKey: cache.meta?.fileKey || null,
    typeHistogram: Object.fromEntries(Object.entries(hist).sort((a, b) => b[1] - a[1])),
  };
}

const MCP_TOOLS = [
  {
    name: "figma_get_meta",
    description: "获取最近一次粘贴的 Figma 数据元信息（fileKey、pasteID、保存时间、节点数）。先调用此工具确认缓存可用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_get_tree",
    description: "获取 Figma 图层树（层级结构）。返回从 DOCUMENT 开始的树，可控制深度。",
    inputSchema: {
      type: "object",
      properties: { maxDepth: { type: "number", description: "最大展开深度，默认 6", default: 6 } },
      additionalProperties: false,
    },
  },
  {
    name: "figma_search_nodes",
    description: "按名称/类型搜索节点。query 匹配名称（不区分大小写）或精确类型名（如 FRAME、TEXT）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "名称关键字或类型名" },
        type: { type: "string", description: "按类型精确过滤（如 FRAME / TEXT / INSTANCE）" },
        limit: { type: "number", description: "返回上限，默认 20", default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_node",
    description: "按 guid 获取单个节点完整信息（位置、尺寸、填充、描边、文本内容、约束等）。",
    inputSchema: {
      type: "object",
      properties: { guid: { type: "string", description: "节点 guid，形如 1234:5678" } },
      required: ["guid"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_get_stats",
    description: "获取统计信息：节点类型分布直方图、总数、来源文件。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_get_raw",
    description: "获取全部缓存节点的原始 JSON（数据大时建议用 maxNodes 截断）。",
    inputSchema: {
      type: "object",
      properties: { maxNodes: { type: "number", description: "最多返回多少节点，默认全部" } },
      additionalProperties: false,
    },
  },
];

function callTool(name, args) {
  if (!cache) {
    return { content: [{ type: "text", text: "缓存为空：请先打开网页粘贴 Figma 数据（Ctrl+V）。" }], isError: true };
  }
  switch (name) {
    case "figma_get_meta":
      return { content: [{ type: "text", text: JSON.stringify({ meta: cache.meta, ...cacheInfo() }, null, 2) }] };
    case "figma_get_tree":
      return { content: [{ type: "text", text: JSON.stringify(buildTree(Math.min(args?.maxDepth ?? 6, 20)), null, 2) }] };
    case "figma_search_nodes":
      return {
        content: [{ type: "text", text: JSON.stringify(
          searchNodes(args?.query, args?.type, Math.min(args?.limit ?? 20, 200)), null, 2) }],
      };
    case "figma_get_node": {
      const n = getNode(args?.guid);
      if (!n) return { content: [{ type: "text", text: "未找到节点: " + args?.guid }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(n, null, 2) }] };
    }
    case "figma_get_stats":
      return { content: [{ type: "text", text: JSON.stringify(getStats(), null, 2) }] };
    case "figma_get_raw": {
      const max = Math.min(args?.maxNodes ?? cache.nodes.length, cache.nodes.length);
      return { content: [{ type: "text", text: JSON.stringify({ ...cache, nodes: cache.nodes.slice(0, max) }) }] };
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
          "Figma 剪贴板数据服务。用户在网页粘贴 Figma 复制的内容后，这里缓存最近一次的完整场景图。" +
          "先用 figma_get_meta 确认有数据，再用 figma_get_tree / figma_search_nodes / figma_get_node 探索设计。",
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
    if (req.method === "GET" && (pathname === "/api/health" || pathname === "/api/cache-info")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true, name: NAME, version: VERSION,
        host: HOST, mcpPath: "/mcp",
        cache: cacheInfo(),
      }));
      return;
    }

    /* ---- 缓存 API ---- */
    if (req.method === "POST" && pathname === "/cache") {
      const body = await readBody(req, MAX_CACHE_BODY);
      const data = JSON.parse(body);
      if (!data || !Array.isArray(data.nodes)) throw Object.assign(new Error("invalid payload"), { code: 400 });
      setCache({
        meta: data.meta || null,
        savedAt: data.savedAt || new Date().toISOString(),
        nodeCount: data.nodes.length,
        nodes: data.nodes,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, nodeCount: data.nodes.length }));
      return;
    }
    if (req.method === "GET" && pathname === "/api/cache-info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cacheInfo()));
      return;
    }
    if (req.method === "GET" && pathname === "/api/cache") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cache));
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

loadCache();
server.listen(PORT, HOST, () => {
  log("info", "server", `${NAME} v${VERSION} 已启动`, {
    url: `http://${HOST}:${PORT}/`,
    mcp: `http://${HOST}:${PORT}/mcp`,
    cacheFile: CACHE_FILE,
  });
  console.log(`${NAME} v${VERSION}`);
  console.log(`  网页: http://${HOST}:${PORT}/`);
  console.log(`  MCP:  http://${HOST}:${PORT}/mcp   (Streamable HTTP)`);
  console.log(`  监听: ${HOST}（仅本机可访问）`);
  console.log(`  缓存: ${CACHE_FILE}`);
});
