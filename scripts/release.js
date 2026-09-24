#!/usr/bin/env node
/**
 * 自动发布脚本 — npm version bump + publish + git tag
 *
 * 用法:
 *   node scripts/release.js patch   # 0.1.0 → 0.1.1
 *   node scripts/release.js minor   # 0.1.0 → 0.2.0
 *   node scripts/release.js major   # 0.1.0 → 1.0.0
 *   node scripts/release.js patch --dry-run   # 只预演不执行
 *
 * 流程:
 *   1. 前置检查（git 干净、npm 已登录、测试通过）
 *   2. 版本号 bump + package.json 更新
 *   3. npm pack 验证产物（确认无敏感文件）
 *   4. git commit + tag
 *   5. npm publish
 *   6. git push（含 tag）
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DRY_RUN = process.argv.includes("--dry-run");
const bumpType = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  if (!DRY_RUN || opts.dryRunSafe) {
    return execSync(cmd, { cwd: ROOT, stdio: opts.silent ? "pipe" : "inherit" }).toString();
  }
  return "";
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function step(msg) {
  console.log(`\n=== ${msg} ===`);
}

// ---------- 0. 参数检查 ----------
if (!bumpType || !["patch", "minor", "major", "keep"].includes(bumpType)) {
  console.error("用法: node scripts/release.js <patch|minor|major> [--dry-run]");
  process.exit(1);
}

step("1. 前置检查");

// git 仓库
let isGit = false;
try {
  execSync("git rev-parse --is-inside-work-tree", { cwd: ROOT, stdio: "pipe" });
  isGit = true;
} catch {}

// git 干净
if (isGit) {
  const status = execSync("git status --porcelain", { cwd: ROOT, stdio: "pipe" }).toString().trim();
  if (status && !DRY_RUN) {
    fail(`git 工作区不干净，先提交或 stash:\n${status.split("\n").slice(0, 5).join("\n")}`);
  }
  console.log("✓ git 工作区干净");
} else {
  console.log("⚠ 非 git 仓库，跳过 git 相关步骤");
}

// registry 检查（必须在 npmjs 官方源才能发布）
const registry = execSync("npm config get registry", { cwd: ROOT, stdio: "pipe" }).toString().trim();
if (!registry.includes("registry.npmjs.org")) {
  fail(`当前 registry 是 ${registry}，发布需切回官方源: nrm use npm 或 npm config set registry https://registry.npmjs.org/`);
}
console.log("✓ registry: npmjs 官方源");

// npm 登录（dry-run 跳过）
let npmUser = "";
if (DRY_RUN) {
  console.log("（dry-run 跳过登录检查）");
} else {
  try {
    npmUser = execSync("npm whoami", { cwd: ROOT, stdio: "pipe" }).toString().trim();
    console.log(`✓ npm 已登录: ${npmUser}`);
  } catch {
    fail("npm 未登录，请先 npm login");
  }
}

// 包名可用性 / 已发布版本
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
let publishedVersion = "";
try {
  publishedVersion = execSync(`npm view ${pkg.name} version`, { cwd: ROOT, stdio: "pipe" }).toString().trim();
  console.log(`✓ npm 上已有版本: ${publishedVersion}`);
} catch {
  console.log("✓ npm 上尚无此包（首次发布）");
}

// ---------- 1. 版本号计算 ----------
step("2. 版本号 bump");
const current = pkg.version;
const [maj, min, pat] = current.split(".").map(Number);
const next =
  bumpType === "keep" ? current
  : bumpType === "major" ? `${maj + 1}.0.0`
  : bumpType === "minor" ? `${maj}.${min + 1}.0`
  : `${maj}.${min}.${pat + 1}`;

if (publishedVersion && publishedVersion !== current) {
  fail(`本地版本 ${current} 与 npm 上 ${publishedVersion} 不一致，先 pull 或手动对齐`);
}
console.log(`${current} → ${next}${DRY_RUN ? "（dry-run，不写入）" : ""}`);

if (!DRY_RUN) {
  pkg.version = next;
  fs.writeFileSync(path.join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  console.log("✓ package.json 已更新");
}

// ---------- 2. 产物安全验证 ----------
step("3. npm pack 产物安全验证");
const FORBIDDEN = [
  /cache.*\.json/i, /payload/i, /decoded/i, /page\.log/i, /clipboard\.html/i,
  /tokens\.json/i, /components\.json/i, /\.png$/i, /render-check/i,
];
let fileList = [];
let leaked = false;
if (!DRY_RUN) {
  const packJson = execSync("npm pack --dry-run --json 2>nul", { cwd: ROOT, stdio: "pipe" }).toString();
  const packData = JSON.parse(packJson);
  fileList = packData[0].files.map((f) => f.path);
  for (const p of fileList) {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(p)) {
        console.error(`  ✗ 产物含敏感文件: ${p}`);
        leaked = true;
      }
    }
  }
  if (leaked) fail("产物含敏感文件，禁止发布");
  console.log(`✓ 产物安全（${fileList.length} 个文件，无敏感内容）`);
  for (const p of fileList) console.log(`   ${p}`);
} else {
  console.log("（dry-run 跳过）");
}

// ---------- 3. 发布前最终冒烟 ----------
step("4. 冒烟测试（服务启动 + MCP 握手）");
if (!DRY_RUN) {
  const { spawn } = await import("node:child_process");
  const testPort = 8399 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, [path.join(ROOT, "lib", "server.mjs")], {
    env: { ...process.env, FCM_PORT: String(testPort) },
    stdio: "pipe",
  });
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const health = await fetch(`http://127.0.0.1:${testPort}/api/health`).then((r) => r.json());
    if (!health.ok) fail("健康检查失败");
    const tools = await fetch(`http://127.0.0.1:${testPort}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => r.json());
    if (!tools.result?.tools?.length) fail("MCP tools/list 失败");
    console.log(`✓ 服务正常（${tools.result.tools.length} 个工具）`);
  } finally {
    child.kill();
  }
} else {
  console.log("（dry-run 跳过）");
}

// ---------- 4. git commit + tag ----------
step("5. git commit + tag");
if (isGit && !DRY_RUN) {
  run(`git add package.json package-lock.json`);
  run(`git commit -m "release: v${next}"`);
  run(`git tag v${next}`);
  console.log(`✓ 已提交并打 tag v${next}`);
} else {
  console.log(DRY_RUN ? `（将执行: git commit + tag v${next}）` : "⚠ 非 git 仓库，跳过");
}

// ---------- 5. npm publish ----------
step("6. npm publish");
if (!DRY_RUN) {
  run("npm publish");
  console.log(`✓ 已发布 ${pkg.name}@${next}`);
} else {
  console.log(`（将执行: npm publish）`);
}

// ---------- 6. git push ----------
step("7. git push（含 tag）");
if (isGit && !DRY_RUN) {
  try {
    run("git push");
    run("git push --tags");
    console.log("✓ 已推送");
  } catch {
    console.log("⚠ push 失败（无远程或无权限），可稍后手动 git push --tags");
  }
} else {
  console.log(DRY_RUN ? "（将执行: git push --tags）" : "跳过");
}

console.log(`\n🎉 ${DRY_RUN ? "[dry-run] 预演完成" : `发布成功: ${pkg.name}@${next}`}`);
console.log(`   npm: https://www.npmjs.com/package/${pkg.name}`);
