<div align="center">
  <h1>clix</h1>
  <p><strong>Build installable CLIs from API documents or executables. In one command.</strong></p>
  <p>
    <img src="https://img.shields.io/badge/node-≥20-blue" alt="Node">
    <a href="https://www.npmjs.com/package/@cli-creator/clix"><img src="https://img.shields.io/npm/v/@cli-creator/clix" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  </p>
</div>

Give `clix` an API document — Markdown, HTML, PDF, or a URL — and it will parse the endpoints, extract parameters, generate a fully working CLI, and install it to your PATH. Or point it at any executable binary and get an instant wrapper CLI with full flag passthrough. No boilerplate, no code generation templates to maintain.

**Document Mode:** `clix build tencentcloud --from ./api.md` — Import → Extract → Draft → Review → Generate CLI → Install to PATH

**Command Mode:** `clix build ai-tools --from /bin/codex` — Detect executable → Create wrapper → All flags passthrough to inner binary

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Command Mode](#command-mode)
- [How It Works](#how-it-works)
- [Commands](#commands)
- [Generated CLI](#generated-cli)
- [Import Modes](#import-modes)
- [Configuration](#configuration)
- [LLM Providers](#llm-providers)
- [Project Structure](#project-structure)
- [Development](#development)
- [License](#license)

---

## Features

<table align="center">
  <tr align="center">
    <th>📄 Multi-Format Input</th>
    <th>🔍 Smart Extraction</th>
    <th>🏗️ One-Command Build</th>
  </tr>
  <tr align="center">
    <td>Markdown, HTML, PDF, URL, stdin</td>
    <td>Endpoints, params, examples, auth hints — all auto-detected</td>
    <td><code>clix build foo --from doc.md</code> does everything</td>
  </tr>
  <tr align="center">
    <th>🌳 Hierarchical Help</th>
    <th>🤖 AI-Assisted Parsing</th>
    <th>🔐 Secure by Default</th>
  </tr>
  <tr align="center">
    <td>Level-by-level <code>--help</code> navigation</td>
    <td>Rule-first, AI fallback for unstructured docs</td>
    <td>Credential env vars, log masking, no plaintext secrets</td>
  </tr>
  <tr align="center">
    <th>📦 npm-Ready Packages</th>
    <th>🔄 Incremental Actions</th>
    <th>🧪 Built-in Doctor</th>
  </tr>
  <tr align="center">
    <td>Generated CLIs are publishable npm packages</td>
    <td>Add new services/actions to existing CLIs</td>
    <td><code>clix doctor</code> checks Node, PATH, config</td>
  </tr>
  <tr align="center">
    <th>⚡ Command Mode</th>
    <th>🔀 Flag Passthrough</th>
    <th>🧩 Mix & Match</th>
  </tr>
  <tr align="center">
    <td>Wrap any executable: <code>--from /bin/codex</code></td>
    <td>All flags pass directly to the inner binary, including <code>--help</code></td>
    <td>Combine API actions and command wrappers in one CLI</td>
  </tr>
</table>

---

## Quick Start

### Install

```bash
npm install -g @cli-creator/clix
```

Or run from source:

```bash
git clone <repo-url> && cd cli-creator
npm install
npm run build
```

### Initialize

```bash
clix init
```

Interactive setup wizard — pick your LLM provider, model, API key source, npm scope, and publish defaults. Config is saved to `~/.clix/config.json`.

### Build a CLI from a Document

```bash
clix build tencentcloud --from ./docs/cdb-start-cpu-expand.md
```

This will:

1. Parse the document and extract API metadata
2. Walk you through confirming the command hierarchy, HTTP method, host, params
3. Generate a CLI package with a manifest and entry script
4. Install a shim so `tencentcloud` is available on your PATH

### Use the Generated CLI

```bash
# Top-level help — shows available services
tencentcloud --help

# Service-level help — shows available actions
tencentcloud cdb --help

# Action-level help — shows parameters
tencentcloud cdb StartCpuExpand --help

# Execute
tencentcloud cdb StartCpuExpand \
  --InstanceId cdb-himitj11 \
  --Type manual \
  --ExpandCpu 4
```

### Add More Actions

Run `build` again with a different document — new actions are merged into the existing CLI:

```bash
clix build tencentcloud --from ./docs/cdb-stop-cpu-expand.md
```

---

## Command Mode

When `--from` points to an executable binary instead of a document, `clix` enters **Command Mode** — it wraps the binary as a CLI action with full flag passthrough.

### Wrap an Executable

```bash
clix build ai-tools --from /usr/local/bin/codex --yes
```

`clix` auto-detects that `/usr/local/bin/codex` is an executable (via `access(X_OK)` + `which` fallback) and creates a command-type action. No document parsing or LLM involved.

### Use the Wrapped CLI

```bash
# All flags are passed directly to codex
ai-tools codex --model o3 --full-auto

# --help is also forwarded to the inner binary
ai-tools codex --help
```

### Add More Commands

You can mix document-based API actions and executable wrappers in the same CLI:

```bash
# Add another executable
clix update ai-tools add --from /bin/curl --yes

# Now ai-tools has both commands
ai-tools --help
#   codex  [cmd]
#   curl   [cmd]

ai-tools curl https://example.com -s
```

### Edit Command Properties

```bash
# Change the wrapped binary path
clix update ai-tools edit codex --bin /usr/local/bin/codex-new

# Change the description
clix update ai-tools edit codex --description "AI coding assistant"
```

### How It Differs from Document Mode

| | Document Mode | Command Mode |
|---|---|---|
| **Input** | Markdown, HTML, PDF, URL | Executable binary path |
| **Detection** | Content parsing | `access(X_OK)` + `which` |
| **LLM needed** | Optional (hybrid/ai mode) | No |
| **Params** | Extracted from doc | All passthrough |
| **`--help`** | Generated by clix | Forwarded to inner binary |
| **Help marker** | (none) | `[cmd]` in command tree |

---

## How It Works

### Pipeline

```
Document → Normalize → Extract → Draft → Review → Approve → Canonical Spec → Generate CLI
```

| Stage | What Happens |
|---|---|
| **Normalize** | Raw content is cleaned, split into sections, code blocks, and tables. HTML tags stripped, newlines unified. |
| **Extract** | Rule-based extractors pull HTTP method, host, action name, params from code blocks and tables. JSON examples are parsed. |
| **Draft** | An `ExtractedActionDraft` is created with confidence score and evidence snippets. |
| **Review** | Blocking/warning issues are generated (missing host, unknown param types, etc.). |
| **Approve** | Draft is promoted to a `CanonicalSpec` and saved under `specs/`. |
| **Generate** | A CLI entry script + manifest are written. A PATH shim is installed. |

### Draft/Review/Approve Flow

Artifacts are stored in `.clix-artifacts/`:

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

## Commands

### `clix init`

Interactive wizard to configure LLM provider, model, API key, npm scope, and publish settings.

```bash
clix init
clix init --json    # Output result as JSON
```

### `clix build <name>`

Parse a document or wrap an executable to generate a CLI.

```bash
# Document mode
clix build tencentcloud --from ./api.md
clix build tencentcloud --from https://example.com/api-doc.html
clix build tencentcloud --from ./api.md --yes      # Skip interactive prompts
clix build tencentcloud --from ./api.md --verbose   # Debug logging
clix build tencentcloud --from ./api.md --to ./out  # Custom output dir

# Command mode (executable wrapping)
clix build ai-tools --from /usr/local/bin/codex --yes
clix build devtools --from /bin/curl --yes
```

When `--from` points to an executable file, `clix` automatically enters command mode — no document parsing or LLM configuration needed.

### `clix update <name> [add|delete|move|edit]`

Manage actions in an existing CLI.

```bash
# Add actions (from document or executable)
clix update myapi add --from ./docs/api.md
clix update myapi add --from /bin/curl --yes

# Delete actions
clix update myapi delete cdb/StartCpuExpand

# Move actions to a new path
clix update myapi move cdb/StartCpuExpand --to mysql/StartCpuExpand

# Edit action config
clix update myapi edit cdb/StartCpuExpand --description "New description" --method GET
clix update myapi edit codex --bin /usr/local/bin/codex-new   # Command mode: change binary
```

### `clix config`

Manage global configuration.

```bash
clix config list                 # Show all config
clix config get llm.model        # Read a single key
clix config set llm.model gpt-5  # Write a key
```

### `clix paths`

Print all clix directory paths.

```bash
clix paths
clix paths --json
```

### `clix doctor`

Check runtime environment health.

```bash
clix doctor
clix doctor --json
```

Checks: Node version, clix home, config file, registry, npm prefix, global bin in PATH.

---

## Generated CLI

Generated CLIs have two types of actions:

### Request Actions (Document Mode)

Standard API actions with full parameter support:

| Flag | Description |
|---|---|
| `-h`, `--help` | Hierarchical help at any command level |
| `--dry-run` | Print the HTTP request without sending |
| `--verbose` | Print request details before sending |
| `--header K=V` | Append custom HTTP header |
| `--<ParamName>` | Set parameter value |

### Command Actions (Command Mode)

Executable wrappers with full passthrough — marked with `[cmd]` in help output:

```bash
ai-tools --help
#   codex  [cmd]    AI coding assistant
#   curl   [cmd]    /bin/curl

# All arguments pass directly to the inner binary
ai-tools codex --model o3 --full-auto
ai-tools curl -s https://example.com
```

For command actions, `-h`/`--help` is **not** intercepted by clix — it is forwarded to the inner binary.

### Hierarchical Help System

The generated CLI builds a command tree from the manifest. Help is level-aware:

```bash
tencentcloud --help                    # List services (cdb, cbs, ...)
tencentcloud cdb --help                # List actions under cdb
tencentcloud cdb StartCpuExpand --help # Show params for this action
```

### Execution Lifecycle

**Request actions:**
```
Parse argv → Match action → Parse flags → Validate required params
  → Build HTTP request (path params, query, body, headers)
  → Send via fetch → Print JSON response
```

**Command actions:**
```
Parse argv → Match action (full argv match first)
  → spawn(bin, subcommands + restArgs, { stdio: 'inherit' })
  → Exit with child process exit code
```

---

## Import Modes

| Mode | Behavior |
|---|---|
| `strict` | Rule-based parsing only. Fails if key fields are missing. |
| `hybrid` | Rules first, AI fills gaps. |
| `ai` | AI extraction with structured JSON output. Requires `CLIX_AI_EXTRACTOR` env var pointing to an extractor module. |

Set via `clix config set defaults.importMode hybrid` or at build time.

---

## Configuration

Config lives at `~/.clix/config.json`:

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

| Key | Description |
|---|---|
| `defaults.importMode` | `strict` / `hybrid` / `ai` |
| `defaults.outputDir` | Where draft/review/spec artifacts go |
| `defaults.publishTag` | npm publish tag |
| `defaults.npmAccess` | `public` or `restricted` |
| `defaults.packageScope` | npm scope like `@your-scope` |
| `llm.provider` | LLM provider name |
| `llm.model` | Model name |
| `llm.baseUrl` | Custom API endpoint |
| `llm.apiKeyEnvName` | Env var name for API key |
| `llm.apiKey` | Direct API key (not recommended for production) |

Override `CLIX_HOME` env var to change the home directory from `~/.clix`.

---

## LLM Providers

`clix init` supports these providers out of the box:

| Provider | Default Model | Base URL |
|---|---|---|
| OpenAI | `gpt-5` | Official API |
| Anthropic | `claude-sonnet-4-6` | Official API |
| Azure OpenAI | `gpt-5` | Your Azure endpoint |
| OpenRouter | `openai/gpt-5` | `openrouter.ai/api/v1` |
| Google Gemini | `gemini-2.5-pro` | Gemini OpenAI-compatible |
| DeepSeek | `deepseek-chat` | `api.deepseek.com` |
| Qwen | `qwen-max` | DashScope |
| Moonshot / Kimi | `kimi-k2` | `api.moonshot.cn/v1` |
| Zhipu GLM | `glm-4.5` | `open.bigmodel.cn` |
| Ollama | `qwen2.5:14b` | `localhost:11434/v1` |
| Custom | — | Any OpenAI-compatible endpoint |

---

## Project Structure

```
cli-creator/
├── src/
│   ├── index.ts              # Entry point
│   ├── cli.ts                # Commander.js command definitions
│   ├── generated-cli.ts      # CLI generation engine + runtime template
│   ├── import-workflow.ts     # Document import, normalize, extract, review
│   ├── init-workflow.ts       # Interactive init wizard
│   ├── config-store.ts        # Config & registry persistence
│   ├── self-management.ts     # doctor, paths
│   ├── tui.ts                 # Terminal UI adapter (readline + cursor select)
│   ├── types.ts               # Core TypeScript interfaces
│   └── utils.ts               # File I/O, param helpers
├── tests/                     # Vitest test suite
├── fixtures/
│   └── sample-api.md          # Example API document for testing
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Key Modules

| Module | Responsibility |
|---|---|
| `cli.ts` | Defines `clix` commands: `init`, `build`, `update` (add/delete/move/edit), `config`, `paths`, `doctor` |
| `generated-cli.ts` | Generates the runtime entry script for built CLIs. Supports two action types: request (HTTP) and command (executable passthrough). Includes tree-based hierarchical help, arg parsing, `fetch`-based execution, and `spawn`-based command forwarding. |
| `import-workflow.ts` | Full import pipeline: source loading (file/URL/stdin/PDF), document normalization, section/code-block/table extraction, rule-based draft extraction, AI patch hook, review generation, approval/rejection, canonical spec output. |
| `init-workflow.ts` | TUI wizard for provider selection, model choice, API key configuration, npm defaults. |
| `config-store.ts` | Manages `~/.clix/config.json` and `~/.clix/registry.json`. Handles read/write, defaults, path resolution. |
| `tui.ts` | Readline-based TUI with cursor-key selection for TTY, numbered-list fallback for non-TTY. |

---

## Development

```bash
# Install dependencies
npm install

# Source-code debugging (no build needed)
npm run clix -- build tencentcloud --from ./fixtures/sample-api.md --yes

# Build
npm run build

# Type check
npm run typecheck

# Run tests
npm test
```

### Tech Stack

| Tool | Purpose |
|---|---|
| TypeScript | Language |
| Commander.js | CLI framework |
| Zod | Input validation |
| pdf-parse | PDF text extraction |
| tsup | Build & bundle |
| Vitest | Testing |
| tsx | Dev-time TypeScript execution |

---

## License

[MIT](LICENSE)
