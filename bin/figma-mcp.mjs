#!/usr/bin/env node
// fcdm CLI — start / restart / status / stop / run
// 后台模式：spawn 分离进程，状态写入 os.tmpdir()/figma-clipboard-mcp/state.json
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "lib", "server.mjs");
const STATE_FILE = path.join(os.tmpdir(), "figma-clipboard-mcp", "state.json");

const DEFAULTS = { port: 8388, host: "127.0.0.1" };

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

// 探测 pid 是否存活（signal 0）
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// HTTP 探活：服务真的在响应吗
function probe(port, host = DEFAULTS.host, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/api/health", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") args.port = Number(argv[++i]);
    else if (a === "--host") args.host = String(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(`fcdm — Figma 剪贴板解析 + MCP 服务

用法:
  fcdm start   [--port 8388] [--host 127.0.0.1]
                    后台启动服务（分离进程，关终端不退出）
  fcdm run     [同上选项]        前台运行（Ctrl+C 停止，看日志方便）
  fcdm restart [--port ...]      重启（沿用上次或指定配置）
  fcdm status                    查看状态（网页地址 / MCP 地址 / 缓存信息）
  fcdm stop                      停止后台服务

选项:
  --port, -p     端口号（默认 8388）
  --host         监听地址（默认 127.0.0.1，仅本机访问）
  -h, --help     显示帮助`);
}

// 等待服务就绪
async function waitReady(port, host, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port, host)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function cmdStart(opts, { restart = false } = {}) {
  const prev = readState();
  if (restart && prev && isAlive(prev.pid)) {
    try { process.kill(prev.pid); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  } else if (!restart && prev && isAlive(prev.pid) && (await probe(prev.port, prev.host))) {
    // 已有实例在运行：若用户显式指定了不同端口，允许并行启动；否则提示复用
    const explicitPort = opts.port !== undefined;
    const explicitHost = opts.host !== undefined;
    if (!explicitPort && !explicitHost) {
      console.log(`服务已在运行: http://${prev.host}:${prev.port} (pid ${prev.pid})`);
      console.log(`如需换端口请用: fcdm restart --port <新端口>`);
      return;
    }
    console.log(`检测到已有实例 (pid ${prev.pid}, 端口 ${prev.port})，将按指定配置另起实例`);
  }

  const port = opts.port ?? prev?.port ?? DEFAULTS.port;
  const host = opts.host ?? prev?.host ?? DEFAULTS.host;

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      FCM_PORT: String(port),
      FCM_HOST: host,
    },
  });
  child.unref();

  const ok = await waitReady(port, host);
  if (!ok) {
    console.error("启动失败：服务未在预期时间内就绪（端口被占用？换 --port 试试）");
    process.exit(1);
  }
  writeState({ pid: child.pid, port, host, startedAt: new Date().toISOString() });
  printInfo({ pid: child.pid, port, host });
}

function printInfo(state) {
  console.log(`✔ figma-clipboard-mcp 已启动 (pid ${state.pid})`);
  console.log(`  网页:   http://${state.host}:${state.port}/`);
  console.log(`  MCP:    http://${state.host}:${state.port}/mcp        （Streamable HTTP）`);
  console.log(`  健康检查: http://${state.host}:${state.port}/api/health`);
  console.log(`  停止:   fcdm stop | 重启: fcdm restart`);
}

async function cmdStatus() {
  const state = readState();
  if (!state) {
    console.log("状态：未在运行（用 fcdm start 启动）");
    return;
  }
  const alive = isAlive(state.pid) && (await probe(state.port, state.host));
  if (!alive) {
    console.log(`状态：已停止（上次 pid ${state.pid}，端口 ${state.port}）`);
    return;
  }
  console.log(`状态：运行中 (pid ${state.pid})`);
  printInfo(state);
  // 缓存信息
  try {
    const res = await fetch(`http://${state.host}:${state.port}/api/cache-info`);
    const info = await res.json();
    if (info.hasData) {
      console.log(`  缓存:   有数据 · ${info.nodeCount} 节点 · ${info.bytes} 字节 · ${info.savedAt}`);
    } else {
      console.log("  缓存:   空（打开网页粘贴后即有）");
    }
  } catch {}
}

async function cmdStop() {
  const state = readState();
  if (!state || !isAlive(state.pid)) {
    console.log("状态：未在运行");
    clearState();
    return;
  }
  try { process.kill(state.pid); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  if (isAlive(state.pid)) {
    try { process.kill(state.pid, "SIGKILL"); } catch {}
  }
  clearState();
  console.log(`已停止 (pid ${state.pid})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "status";
  if (args.help) { usage(); return; }

  switch (cmd) {
    case "start": await cmdStart(args); break;
    case "run": {
      // 前台运行：直接 exec 服务进程，日志可见
      const child = spawn(process.execPath, [SERVER_ENTRY], {
        stdio: "inherit",
        env: {
          ...process.env,
          FCM_PORT: String(args.port ?? DEFAULTS.port),
          FCM_HOST: String(args.host ?? DEFAULTS.host),
        },
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      break;
    }
    case "restart": await cmdStart(args, { restart: true }); break;
    case "status": await cmdStatus(); break;
    case "stop": await cmdStop(); break;
    default:
      console.error(`未知命令: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
