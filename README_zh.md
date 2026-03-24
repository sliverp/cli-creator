<div align="center">
  <h1>clix</h1>
  <p><strong>一条命令，从 API 文档或可执行文件生成可安装的 CLI。</strong></p>
  <p>
    <img src="https://img.shields.io/badge/node-≥20-blue" alt="Node">
    <a href="https://www.npmjs.com/package/@cli-creator/clix"><img src="https://img.shields.io/npm/v/@cli-creator/clix" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  </p>
  <p>
    <a href="README.md">English</a> | <a href="README_zh.md">中文</a>
  </p>
</div>

给 `clix` 一份 API 文档（Markdown、HTML、PDF 或 URL），它会自动解析接口、提取参数、生成完整可用的 CLI 并安装到 PATH。也可以直接指向一个可执行文件，立即得到一个全参数透传的 CLI 封装。无需模板，无需维护代码生成逻辑。

**文档模式：** `clix build tencentcloud --from ./api.md` — 导入 → 提取 → 草稿 → 审查 → 生成 CLI → 安装到 PATH

**命令模式：** `clix build ai-tools --from /bin/codex` — 检测可执行文件 → 创建封装 → 所有参数原封不动透传

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [命令模式](#命令模式)
- [工作原理](#工作原理)
- [命令参考](#命令参考)
- [生成的 CLI](#生成的-cli)
- [导入模式](#导入模式)
- [配置](#配置)
- [LLM 服务商](#llm-服务商)
- [项目结构](#项目结构)
- [开发](#开发)
- [许可证](#许可证)

---

## 特性

<table align="center">
  <tr align="center">
    <th>📄 多格式输入</th>
    <th>🔍 智能提取</th>
    <th>🏗️ 一键构建</th>
  </tr>
  <tr align="center">
    <td>Markdown、HTML、PDF、URL、stdin</td>
    <td>接口、参数、示例、认证信息 — 全部自动识别</td>
    <td><code>clix build foo --from doc.md</code> 一步到位</td>
  </tr>
  <tr align="center">
    <th>🌳 层级帮助</th>
    <th>🤖 AI 辅助解析</th>
    <th>🔐 默认安全</th>
  </tr>
  <tr align="center">
    <td>逐层 <code>--help</code> 导航</td>
    <td>规则优先，AI 兜底处理非结构化文档</td>
    <td>凭证走环境变量，日志脱敏，无明文密钥</td>
  </tr>
  <tr align="center">
    <th>📦 npm 就绪</th>
    <th>🔄 增量操作</th>
    <th>🧪 内置诊断</th>
  </tr>
  <tr align="center">
    <td>生成的 CLI 可直接发布为 npm 包</td>
    <td>向已有 CLI 增量添加新服务/action</td>
    <td><code>clix doctor</code> 检查 Node、PATH、配置</td>
  </tr>
  <tr align="center">
    <th>⚡ 命令模式</th>
    <th>🔀 参数透传</th>
    <th>🧩 混合使用</th>
  </tr>
  <tr align="center">
    <td>封装任意可执行文件：<code>--from /bin/codex</code></td>
    <td>所有参数直接传给内部命令，包括 <code>--help</code></td>
    <td>API action 与命令封装可共存于同一 CLI</td>
  </tr>
</table>

---

## 快速开始

### 安装

```bash
npm install -g @cli-creator/clix
```

或从源码运行：

```bash
git clone <repo-url> && cd cli-creator
npm install
npm run build
```

### 初始化

```bash
clix init
```

交互式向导 — 选择 LLM 服务商、模型、API Key 来源、npm scope 和发布配置。配置保存在 `~/.clix/config.json`。

### 从文档构建 CLI

```bash
clix build tencentcloud --from ./docs/cdb-start-cpu-expand.md
```

执行后会：

1. 解析文档并提取 API 元数据
2. 引导你确认命令层级、HTTP 方法、Host、参数
3. 生成 CLI 包（manifest + 入口脚本）
4. 安装 shim 使 `tencentcloud` 可在 PATH 中直接使用

### 使用生成的 CLI

```bash
# 顶层帮助 — 列出可用服务
tencentcloud --help

# 服务级帮助 — 列出该服务下的 action
tencentcloud cdb --help

# Action 级帮助 — 列出参数
tencentcloud cdb StartCpuExpand --help

# 执行
tencentcloud cdb StartCpuExpand \
  --InstanceId cdb-himitj11 \
  --Type manual \
  --ExpandCpu 4
```

### 增量添加 Action

再次运行 `build` 并指向另一份文档，新 action 会合并到已有 CLI：

```bash
clix build tencentcloud --from ./docs/cdb-stop-cpu-expand.md
```

---

## 命令模式

当 `--from` 指向一个可执行文件而非文档时，`clix` 进入**命令模式** — 将该可执行文件封装为 CLI action，所有参数原封不动透传。

### 封装可执行文件

```bash
clix build ai-tools --from /usr/local/bin/codex --yes
```

`clix` 自动检测 `/usr/local/bin/codex` 是可执行文件（通过 `access(X_OK)` + `which` 兜底），创建 command 类型 action。无需文档解析，无需 LLM。

### 使用封装后的 CLI

```bash
# 所有参数直接传给 codex
ai-tools codex --model o3 --full-auto

# --help 也会转发给内部命令
ai-tools codex --help
```

### 添加更多命令

文档模式的 API action 和命令模式的可执行文件封装可以混合存在于同一 CLI：

```bash
# 添加另一个可执行文件
clix update ai-tools add --from /bin/curl --yes

# 现在 ai-tools 同时有两个命令
ai-tools --help
#   codex  [cmd]
#   curl   [cmd]

ai-tools curl https://example.com -s
```

### 编辑命令属性

```bash
# 修改封装的可执行文件路径
clix update ai-tools edit codex --bin /usr/local/bin/codex-new

# 修改描述
clix update ai-tools edit codex --description "AI 编码助手"
```

### 与文档模式的对比

| | 文档模式 | 命令模式 |
|---|---|---|
| **输入** | Markdown、HTML、PDF、URL | 可执行文件路径 |
| **检测方式** | 内容解析 | `access(X_OK)` + `which` |
| **是否需要 LLM** | 可选（hybrid/ai 模式） | 不需要 |
| **参数处理** | 从文档提取 | 全部透传 |
| **`--help`** | 由 clix 生成 | 转发给内部命令 |
| **帮助标记** | （无） | 命令树中标记 `[cmd]` |

---

## 工作原理

### 处理流水线

```
文档 → 标准化 → 提取 → 草稿 → 审查 → 批准 → 规范化 Spec → 生成 CLI
```

| 阶段 | 说明 |
|---|---|
| **标准化** | 清理原始内容，拆分为段落、代码块、表格。去除 HTML 标签，统一换行。 |
| **提取** | 基于规则提取 HTTP 方法、Host、Action 名、参数。解析 JSON 示例。 |
| **草稿** | 创建 `ExtractedActionDraft`，包含置信度和证据片段。 |
| **审查** | 生成阻断/警告问题（缺少 Host、未知参数类型等）。 |
| **批准** | 草稿提升为 `CanonicalSpec`，保存到 `specs/` 目录。 |
| **生成** | 写入 CLI 入口脚本 + manifest，安装 PATH shim。 |

### 草稿/审查/批准流程

产物存储在 `.clix-artifacts/`：

```
.clix-artifacts/
  imports/
    tencentcloud/
      cdb/
        StartCpuExpand.draft.json
        StartCpuExpand.review.json
  specs/
    tencentcloud/
      cdb/
        StartCpuExpand.spec.json
```

---

## 命令参考

### `clix init`

交互式向导，配置 LLM 服务商、模型、API Key、npm scope 和发布设置。

```bash
clix init
clix init --json    # 以 JSON 格式输出结果
```

### `clix build <name>`

从文档解析或封装可执行文件来生成 CLI。

```bash
# 文档模式
clix build tencentcloud --from ./api.md
clix build tencentcloud --from https://example.com/api-doc.html
clix build tencentcloud --from ./api.md --yes      # 跳过交互确认
clix build tencentcloud --from ./api.md --verbose   # 调试日志
clix build tencentcloud --from ./api.md --to ./out  # 自定义输出目录

# 命令模式（封装可执行文件）
clix build ai-tools --from /usr/local/bin/codex --yes
clix build devtools --from /bin/curl --yes
```

当 `--from` 指向可执行文件时，`clix` 自动进入命令模式 — 无需文档解析或 LLM 配置。

### `clix update <name> [add|delete|move|edit]`

管理已有 CLI 中的 action。

```bash
# 添加 action（从文档或可执行文件）
clix update myapi add --from ./docs/api.md
clix update myapi add --from /bin/curl --yes

# 删除 action
clix update myapi delete cdb/StartCpuExpand

# 移动 action 到新路径
clix update myapi move cdb/StartCpuExpand --to mysql/StartCpuExpand

# 编辑 action 配置
clix update myapi edit cdb/StartCpuExpand --description "新描述" --method GET
clix update myapi edit codex --bin /usr/local/bin/codex-new   # 命令模式：修改可执行文件路径
```

### `clix config`

管理全局配置。

```bash
clix config list                 # 列出所有配置
clix config get llm.model        # 读取单个配置项
clix config set llm.model gpt-5  # 写入配置项
```

### `clix paths`

查看 clix 运行与配置路径。

```bash
clix paths
clix paths --json
```

### `clix doctor`

检查运行环境健康状态。

```bash
clix doctor
clix doctor --json
```

检查项：Node 版本、clix 主目录、配置文件、registry、npm prefix、全局 bin 是否在 PATH 中。

---

## 生成的 CLI

生成的 CLI 包含两种类型的 action：

### Request Action（文档模式）

标准 API action，支持完整参数：

| Flag | 说明 |
|---|---|
| `-h`, `--help` | 在任意命令层级显示帮助 |
| `--dry-run` | 打印 HTTP 请求但不发送 |
| `--verbose` | 发送前打印请求详情 |
| `--header K=V` | 追加自定义 HTTP Header |
| `--<ParamName>` | 设置参数值 |

### Command Action（命令模式）

可执行文件封装，全参数透传 — 在帮助输出中标记为 `[cmd]`：

```bash
ai-tools --help
#   codex  [cmd]    AI coding assistant
#   curl   [cmd]    /bin/curl

# 所有参数直接传给内部命令
ai-tools codex --model o3 --full-auto
ai-tools curl -s https://example.com
```

对于 command action，`-h`/`--help` **不会**被 clix 拦截 — 会直接转发给内部命令。

### 层级帮助系统

生成的 CLI 基于 manifest 构建命令树，帮助信息逐层展示：

```bash
tencentcloud --help                    # 列出服务（cdb, cbs, ...）
tencentcloud cdb --help                # 列出 cdb 下的 action
tencentcloud cdb StartCpuExpand --help # 显示该 action 的参数
```

### 执行生命周期

**Request action：**
```
解析 argv → 匹配 action → 解析 flags → 校验必填参数
  → 构建 HTTP 请求（路径参数、query、body、headers）
  → 通过 fetch 发送 → 打印 JSON 响应
```

**Command action：**
```
解析 argv → 匹配 action（完整 argv 优先匹配）
  → spawn(bin, subcommands + restArgs, { stdio: 'inherit' })
  → 以子进程退出码退出
```

---

## 导入模式

| 模式 | 行为 |
|---|---|
| `strict` | 仅使用规则解析。缺少关键字段时失败。 |
| `hybrid` | 规则优先，AI 补充缺失部分。 |
| `ai` | AI 提取，输出结构化 JSON。需要 `CLIX_AI_EXTRACTOR` 环境变量指向提取器模块。 |

通过 `clix config set defaults.importMode hybrid` 或构建时指定。

---

## 配置

配置文件位于 `~/.clix/config.json`：

```jsonc
{
  "version": 1,
  "defaults": {
    "importMode": "ai",
    "outputDir": ".clix-artifacts",
    "publishTag": "latest",
    "npmAccess": "public",
    "packageScope": "@your-scope"
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-5",
    "baseUrl": "",
    "apiKeyEnvName": "OPENAI_API_KEY"
  }
}
```

| 配置项 | 说明 |
|---|---|
| `defaults.importMode` | `strict` / `hybrid` / `ai` |
| `defaults.outputDir` | 草稿/审查/spec 产物的输出目录 |
| `defaults.publishTag` | npm 发布 tag |
| `defaults.npmAccess` | `public` 或 `restricted` |
| `defaults.packageScope` | npm scope，如 `@your-scope` |
| `llm.provider` | LLM 服务商名称 |
| `llm.model` | 模型名称 |
| `llm.baseUrl` | 自定义 API 地址 |
| `llm.apiKeyEnvName` | API Key 的环境变量名 |
| `llm.apiKey` | 直接填写 API Key（不建议在生产环境使用） |

设置 `CLIX_HOME` 环境变量可修改主目录（默认 `~/.clix`）。

---

## LLM 服务商

`clix init` 内置支持以下服务商：

| 服务商 | 默认模型 | 接口地址 |
|---|---|---|
| OpenAI | `gpt-5` | 官方 API |
| Anthropic | `claude-sonnet-4-6` | 官方 API |
| Azure OpenAI | `gpt-5` | 你的 Azure 端点 |
| OpenRouter | `openai/gpt-5` | `openrouter.ai/api/v1` |
| Google Gemini | `gemini-2.5-pro` | Gemini OpenAI 兼容接口 |
| DeepSeek | `deepseek-chat` | `api.deepseek.com` |
| 通义千问 | `qwen-max` | DashScope |
| Moonshot / Kimi | `kimi-k2` | `api.moonshot.cn/v1` |
| 智谱 GLM | `glm-4.5` | `open.bigmodel.cn` |
| Ollama | `qwen2.5:14b` | `localhost:11434/v1` |
| 自定义 | — | 任意 OpenAI 兼容端点 |

---

## 项目结构

```
cli-creator/
├── src/
│   ├── index.ts              # 入口
│   ├── cli.ts                # Commander.js 命令定义
│   ├── generated-cli.ts      # CLI 生成引擎 + 运行时模板
│   ├── import-workflow.ts     # 文档导入、标准化、提取、审查
│   ├── init-workflow.ts       # 交互式初始化向导
│   ├── config-store.ts        # 配置与注册表持久化
│   ├── self-management.ts     # doctor、paths
│   ├── tui.ts                 # 终端 UI 适配器（readline + 光标选择）
│   ├── types.ts               # 核心 TypeScript 接口
│   └── utils.ts               # 文件 I/O、参数工具
├── tests/                     # Vitest 测试套件
├── fixtures/
│   └── sample-api.md          # 测试用 API 文档示例
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 核心模块

| 模块 | 职责 |
|---|---|
| `cli.ts` | 定义 `clix` 命令：`init`、`build`、`update`（add/delete/move/edit）、`config`、`paths`、`doctor` |
| `generated-cli.ts` | 生成 CLI 运行时入口脚本。支持两种 action 类型：request（HTTP）和 command（可执行文件透传）。包含树状层级帮助、参数解析、`fetch` 请求执行和 `spawn` 命令转发。 |
| `import-workflow.ts` | 完整导入流水线：源加载（文件/URL/stdin/PDF）、文档标准化、段落/代码块/表格提取、规则草稿提取、AI 补丁钩子、审查生成、批准/拒绝、规范化 spec 输出。 |
| `init-workflow.ts` | TUI 向导：服务商选择、模型选择、API Key 配置、npm 默认值。 |
| `config-store.ts` | 管理 `~/.clix/config.json` 和 `~/.clix/registry.json`，读写、默认值、路径解析。 |
| `tui.ts` | 基于 readline 的 TUI，TTY 下光标键选择，非 TTY 下数字列表回退。 |

---

## 开发

```bash
# 安装依赖
npm install

# 源码调试（无需构建）
npm run clix -- build tencentcloud --from ./fixtures/sample-api.md --yes

# 构建
npm run build

# 类型检查
npm run typecheck

# 运行测试
npm test
```

### 技术栈

| 工具 | 用途 |
|---|---|
| TypeScript | 语言 |
| Commander.js | CLI 框架 |
| Zod | 输入校验 |
| pdf-parse | PDF 文本提取 |
| tsup | 构建打包 |
| Vitest | 测试 |
| tsx | 开发时 TypeScript 执行 |

---

## 许可证

[MIT](LICENSE)
