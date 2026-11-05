# figma-clipboard-mcp

把 Figma 剪贴板里的完整设计数据（场景图）变成 **AI 可读的 MCP 服务**。零依赖，纯 Node。

```text
Figma 复制(Ctrl+C) → 网页粘贴(Ctrl+V) → 浏览器解码 → 保存为页面 → AI 通过 MCP 按 id 读取
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

# 2. 打开网页，从 Figma 复制图层后按 Ctrl+V，解析完成后填名称点「保存为页面」
#    → http://127.0.0.1:8388/

# 3. AI 客户端连接 MCP
#    → http://127.0.0.1:8388/mcp   (Streamable HTTP)
```

粘贴后网页自动完成全部解码（base64 → 解压 → Kiwi 反序列化），确认无误后填入名称保存；每次粘贴都是一份独立页面，互不覆盖。

> 截图是**另一份数据**：Figma 的 `Ctrl+C` 只复制设计数据，需要截图时在 Figma 里再按一次 `Ctrl+Shift+C`（右键 → Copy as → Copy as PNG），然后回到网页再 `Ctrl+V` 一次；这张图会自动附加到当前解析结果上，不重新解码。

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
| `figma_list_pastes` | 列出全部页面（id / 名称 / 简介 / 节点数）。**唯一不需要 pasteId 的工具** |
| `figma_get_meta` | 指定页面的元信息（id、名称、简介、fileKey、节点数） |
| `figma_get_tree` | 指定页面的图层树（可控制深度） |
| `figma_get_screenshot` | 指定页面的截图（Figma 复制时附带的 PNG 快照，MCP image 内容块） |
| `figma_search_nodes` | 在指定页面内按名称/类型搜索节点 |
| `figma_get_node` | 在指定页面内按 guid 取单个节点完整信息（位置/填充/描边/文本/约束） |
| `figma_get_stats` | 指定页面的类型分布直方图等统计 |
| `figma_get_raw` | 指定页面的全量原始 JSON（可截断） |
| `figma_get_subtree` | 只取某个节点下的子树（含自身），用于「只细化某个节点」 |
| `figma_expand_instances` | 批量展开 INSTANCE：按 `componentId` 找到组件定义（递归展开嵌套实例），把空壳变成真实内容 |
| `figma_get_assets` | 取页面里的图片资源（IMAGE 填充的真实像素，MCP image 内容块） |

除 `figma_list_pastes` 外，所有工具都必须传 `pasteId` —— 页面数据不存在「默认页面」，只能按 id 取。id 缺失时会返回当前可用页面列表，便于 AI 自我纠正。

推荐 AI 使用顺序：`figma_list_pastes` → 按名称/简介的语义匹配目标 id → 带 `pasteId` 调 `figma_get_screenshot`（先看视觉基线）→ `figma_get_subtree`（只拉目标子树）→ 遇到 INSTANCE 用 `figma_expand_instances` 展开成真实组件 → 遇 `fills[].image.ref` 用 `figma_get_assets` 取原图。

还原设计时最容易踩的两个坑（已由工具解决）：

1. 实例不展开就只能画出空壳 —— 322 个 INSTANCE 背后是 148 个组件定义，走 `figma_expand_instances` 一次拿到；
2. 图片填充不取就只能画色块 —— 节点 `fills` 里 `type: IMAGE` 时，`image.ref` 就是 `figma_get_assets` 的入参。

## 网页功能

粘贴后浏览器内完成全量解码（服务端零解码逻辑），分三个页面：

- **新建**：粘贴入口 + 解析流水线 + 结果条（填名称/简介后「保存为页面」）+ Step 1~5 折叠面板（本次粘贴的诊断信息，刷新即失效）
- **页面列表**：已保存页面的卡片网格（含截图缩略图）。**点卡片主体 = 复制「项目内实现」提示词**（分四阶段：摸项目 → 取数 → 映射表 → 验收；含 pasteId）；卡片上的「复制」= 复制「名称 · id」，「ID」= 只复制 id；可改名/改简介、查看详情、删除
- **MCP 服务**：端点、客户端配置示例、实时工具列表、存储用量

## 数据流与缓存策略

- 浏览器解码后，把**投影后的节点数组**（guid/parent/type/name/size/transform/fills/strokes/text/约束/自动布局…）POST 到 `/api/pastes`，**只有点「保存为页面」才写服务端**；
- 服务端按页面分别存储：`index.json`（索引，列表页与 MCP list 只读它）+ `<id>.json`（单份完整数据，按 id 取详情时才读），位于 `os.tmpdir()/figma-clipboard-mcp/cache/`；
- 节点 IMAGE 填充引用的原图存为 `pastes/<id>.<ref>.png`（单张≤ 6MB，单页≤ 40 张），通过 `GET /api/pastes/:id/assets/:ref` 或 MCP `figma_get_assets` 取；
- 截图单独存为 `pastes/<id>.png`（来自 Figma 复制时附带的 PNG 快照，单张上限 8MB）；不存在时相关工具返回明确错误；
- 截图来源：Figma 的 `Ctrl+C` 不带位图，需在 Figma 里额外按 `Ctrl+Shift+C` 复制为 PNG，网页里再粘贴一次即自动附加到当前结果；
- 写入走临时文件 + `rename` 原子替换；最多保留 **10 份 / 100MB**（`FCM_MAX_PASTES`、`FCM_MAX_TOTAL_BYTES` 可调），超出按保存时间淘汰最旧；
- 矢量二进制 blob 不入存储（体积从 ~22MB 降到 ~2MB），节点保留 `vectorBlobIndex` 引用；
- 节点投影保留设计与代码对接所需的结构：`componentId` / `componentSetId`（实例 → 组件）、`styles`（fill/stroke/text/effect 样式 ID）、`variable` / `variableSet`（变量名、类型、valuesByMode）、`autoLayout`（含 HUG/FILL/FIXED sizing 与对齐、内边距）、`layoutGrids`、`interactions`（原型交互）、`codeSyntax`（Figma Code Syntax，如 `var(--kd-color-primary)`）；未识别的字段进入 `extra`（单字段上限 1200 字符）；
- 旧版单份缓存（`cache/latest.json`）在启动时自动迁移为一份页面。

## 安全设计

- 仅监听 `127.0.0.1`，外部机器无法访问；
- 静态文件只服务**启动时扫描的白名单**，无路径穿越可能；
- 所有请求体有大小上限；MCP 工具只读本地页面存储，**不接触任意文件路径**；
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
- 最多保存 10 份页面，超出按时间淘汰最旧的一份；
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
