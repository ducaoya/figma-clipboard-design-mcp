# figma-clipboard-mcp

把 Figma 剪贴板里的完整设计数据（场景图）变成 **AI 可读的 MCP 服务**。零依赖，纯 Node。

```text
Figma 复制(Ctrl+C) → 网页粘贴(Ctrl+V) → 浏览器解码 → 本地缓存 → AI 通过 MCP 读取
```

## 为什么需要它

Figma 官方 REST API 与 MCP 服务对查看者权限（view seat）的配额极其严格（每月个位数次），无法支撑 AI 编码场景的高频读取。

本工具换个思路：**你在 Figma 里能复制（Ctrl+C），数据就完整地在你的剪贴板里**——包括图层树、位置尺寸、填充描边、文本内容、矢量路径引用。本工具把这些数据解析出来，通过标准 MCP 协议喂给 AI。

- ✅ view 权限即可用（能复制就能解析，数据范围 = 权限范围）
- ✅ 零 API 配额消耗（数据来自剪贴板，不走 Figma API）
- ✅ 零依赖（纯 Node 内置模块，安装体积 < 50KB）
- ✅ 本地运行（仅监听 127.0.0.1，数据不出机器）

## 安装

```bash
npm install -g figma-clipboard-design-mcp
```

## 快速开始

```bash
# 1. 后台启动（默认 127.0.0.1:8388）
fcdm start

# 2. 打开网页，从 Figma 复制图层后按 Ctrl+V
#    → http://127.0.0.1:8388/

# 3. AI 客户端连接 MCP
#    → http://127.0.0.1:8388/mcp   (Streamable HTTP)
```

粘贴后网页自动完成全部解码（base64 → 解压 → Kiwi 反序列化），数据进入本地缓存，AI 即可通过 MCP 读取。

## CLI

```bash
fcdm start   [--port 8388] [--host 127.0.0.1]
fcdm run     [同上]        # 前台运行，日志可见
fcdm restart [--port ...]  # 重启（沿用或更新配置）
fcdm status                # 打印网页地址 / MCP 地址 / 缓存状态
fcdm stop                  # 停止
```

- `start` 后台分离进程运行，关终端不退出
- 已有实例运行时，显式指定 `--port` 可并行启动多实例
- 服务仅监听 `127.0.0.1`（本机回环），外部机器无法访问

## MCP 客户端配置

Claude Code / Cursor 等支持 Streamable HTTP 的客户端：

```json
{
  "mcpServers": {
    "figma-clipboard": { "url": "http://127.0.0.1:8388/mcp" }
  }
}
```

### 工具列表

| 工具 | 说明 |
|---|---|
| `figma_get_meta` | 元信息（fileKey、pasteID、节点数、保存时间） |
| `figma_get_tree` | 图层树（可控制深度） |
| `figma_search_nodes` | 按名称/类型搜索节点 |
| `figma_get_node` | 按 guid 取单个节点完整信息（位置/填充/描边/文本/约束） |
| `figma_get_stats` | 类型分布直方图等统计 |
| `figma_get_raw` | 全量原始 JSON（可截断） |

推荐 AI 使用顺序：`figma_get_meta` 确认有数据 → `figma_get_tree` 了解结构 → `figma_search_nodes` 定位目标 → `figma_get_node` 取细节。

## 网页功能

粘贴后浏览器内完成全部解码（服务端零解码逻辑），分 Tab 展示：

- **总览**：解析流水线状态
- **MCP 服务**：端点、客户端配置示例、实时工具列表、缓存状态
- **Step 1~5**：原始数据 → base64 → 解压 → Kiwi → 节点树（学习/排障用）

## 数据流与缓存策略

- 浏览器解码后，把**投影后的节点数组**（guid/parent/type/name/size/transform/fills/strokes/text/约束/自动布局…）POST 到 `/cache`；
- 服务端**只保留最近一次粘贴**：内存 + 单个磁盘文件覆盖写（位于 `os.tmpdir()/figma-clipboard-mcp/cache/`），新粘贴自动覆盖旧数据，不会膨胀；
- 矢量二进制 blob 不入缓存（体积从 ~22MB 降到 ~2MB），节点保留 `vectorBlobIndex` 引用。

## 安全设计

- 仅监听 `127.0.0.1`，外部机器无法访问；
- 静态文件只服务**启动时扫描的白名单**，无路径穿越可能；
- 所有请求体有大小上限；MCP 工具只读内存缓存，**不接触文件系统**；
- CSP / nosniff 等安全响应头。

## 技术原理

Figma 复制时把完整场景图（Kiwi 二进制序列化）藏进剪贴板 `text/html` 的
`<!--(figma)base64(/figma)-->` 标记中。解析链路：

```
text/html → 提取标记 → base64 → fig-kiwi 归档（魔数+版本+分块）
  ├─ 块0: deflate-raw → Kiwi schema（自描述格式定义）
  └─ 块1: zstd        → NODE_CHANGES 消息（完整节点树）
```

解析器不硬编码版本号与压缩格式（魔数探测 + 多格式降级），对 Figma 格式演化有一定兼容性。

## 法律声明

- 使用本工具即表示您理解并遵守 Figma 服务条款；本工具仅处理您有权访问的内容（复制动作本身需要文件查看权限），因使用方式不当导致的账号风险由使用者自行承担
- 本工具不收集、不上传任何数据，所有解析均在本地完成
- 请勿将解析到的设计数据对外分发

## 已知边界

- 需要 Figma **view 及以上权限**；
- 私有格式无兼容性承诺：归档版本、压缩格式可能随 Figma 升级变化（已做魔数探测 + 多格式降级，但不保证永远可用）；
- 仅供个人开发使用。

## 开发

```bash
# 本地运行（仓库根目录）
node lib/server.mjs
```

## 发布

发布由 GitHub Actions 完成，走 npm Trusted Publishing（OIDC），**无需任何长期 token**。

**触发条件**（`.github/workflows/publish.yml`，两者同时满足才发布）

1. 推送到 **`master`** 分支；
2. 该次推送**最新一条提交的标题（首行）以 `[release]` 开头**——用 `startsWith` 只匹配首行，正文里出现 `[release]` 不会误触发。

**发版步骤**

```bash
# 1) bump 版本，生成提交与 vX.Y.Z tag（提交标题自动带 [release] 前缀）
npm version patch -m "[release] %s"   # 或 minor / major

# 2) 推送分支与 tag（--follow-tags 会带上刚生成的 tag）
git push origin master --follow-tags
```

推送后 GitHub 在 `master` 上触发 `Publish` 工作流：升级 npm → 读取 `package.json` 版本 → 发布到 npm（`--provenance --access public`）。

**内置的防误发保护**

- 仓库判断：仅 `ducaoya/figma-clipboard-design-mcp` 会执行，fork 里推送不会发布；
- 版本去重：该版本号已存在于 npm 时整个 job 跳过（不报错）；
- 并发锁：`concurrency: npm-publish` + `cancel-in-progress: false`，多次发布不会互相覆盖。

> 一次性前置配置（npm 网页，无法用代码完成）：npm 包页 → Settings → Trusted Publisher → GitHub Actions，填 `ducaoya` / `figma-clipboard-design-mcp` / `publish.yml`。绑定的是**仓库 + 工作流文件名**，与分支名无关。

## License

MIT
