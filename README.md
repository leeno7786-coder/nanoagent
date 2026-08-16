# ⚡ NanoAgent (`nanoagent`)

```text
  _  _                 _                    _   
 | \| |__ _ _ _  ___  /_\  __ _ ___ _ _ | |_ 
 | .` / _` | ' \/ _ \/ _ \/ _` / -_) ' \|  _|
 |_|\_\__,_|_||_\___/_/ \_\__, \___|_||_|\__|
                          |___/              
      ⚡ NanoAgent — Tiny Models, Scalable Intelligence ⚡
```

Current release: **2.1.7** (`@omega3_0/nanoagent`)

An ultra-lightweight CLI/TUI coding agent built for **tiny local models** (2B–8B, especially Qwen 2.5/3.5) that also scales to cloud APIs (OpenAI, Anthropic, OpenRouter, DashScope). Run locally, think globally.

---

## ⚠️ Work in progress

NanoAgent is **actively developed and still a WIP**. The core loop, TUI, and install paths work, but this is not a finished product.

If you clone this repo or install the npm / GitHub release packages, expect:

- Some features to be **experimental, incomplete, or buggy** (sub-agents, memory graph, MCP, skills, native packages, and small-model edge cases in particular)
- Config, slash commands, and behavior to **change between versions**
- Occasional rough edges on Windows and with local runtimes (LM Studio / Ollama)

Please file issues at [github.com/leeno7786-coder/nanoagent/issues](https://github.com/leeno7786-coder/nanoagent/issues). Do not treat this as production-ready without testing it on your own workload.

---

## Key features

- **Launch from anywhere** — `nanoagent`, `nanogent`, `nano-agent`, or `npx @omega3_0/nanoagent`
- **Tiny-model first** — compact prompts, context auto-compact (default 80% of the live window), and small-model tool-call resilience
- **OpenTUI dashboard** — streaming chat, tool diffs, todos, skills overlay, connect overlay, and keyboard shortcuts
- **Dual-level config** — `~/.nanogent.json` (or `~/.nanoagent.json`) merged with a project `.nanogent.json` (project keys win; MCP servers merge with per-server trust)
- **Permissions** — `read_only` / `ask` / `allow_edits` / `always_allow`, plus Shift+Tab to cycle in the TUI
- **Remote sub-agents** — `explore_subagent` workers against a configured pool or `REMOTE_LMSTUDIO_URL`
- **MCP** — local stdio or remote HTTP servers (`/mcp`, `/mcp-add`, `/mcp-remove`)
- **Skills** — bundled + custom skills, auto-load on triggers, `/skills` overlay (F8)
- **Memory graph** — `/graph build|stats|report` for codebase structure
- **Security defaults** — command checks, workspace path sandboxing, secret redaction (see [SECURITY.md](SECURITY.md))
- **Headless CLI** — `run`, `doctor`, `models`, `todo` for scripts and CI

---

## Install

### Option 1: Native packages (recommended)

**Linux (Ubuntu/Debian amd64)** — self-contained `.deb` with bundled Node 20:

```bash
# Download the latest nanoagent_*_amd64.deb from GitHub Releases, then:
sudo apt install ./nanoagent_*_amd64.deb
nanogent --help
```

**Windows (x64)** — portable zip with bundled Node 20 (no installer required):

```text
Download nanoagent_*_win_x64.zip from GitHub Releases
Extract → run nanogent.cmd  (or nanoagent.cmd)
```

Latest assets: [github.com/leeno7786-coder/nanoagent/releases](https://github.com/leeno7786-coder/nanoagent/releases)

Build both locally from this repo:

```bash
bun install --frozen-lockfile   # or: npm install
bun run package:deb             # → dist-packages/nanoagent_<version>_amd64.deb
bun run package:win             # → dist-packages/nanoagent_<version>_win_x64.zip
# or: bun run package:native    # both
```

Remove Linux package: `sudo apt remove nanoagent`

### Option 2: Global npm

```bash
npm install -g @omega3_0/nanoagent
npm install -g @omega3_0/nanoagent@latest   # update
```

Requires **Node ≥ 18**. On Linux/Windows, prefer the native packages if a global npm install misses `dist/` or native deps.

### Option 3: `npx` (no install)

```bash
npx @omega3_0/nanoagent
```

### Option 4: Build from source

```bash
git clone https://github.com/leeno7786-coder/nanoagent.git
cd nanoagent
bun install --frozen-lockfile   # or: npm install
sudo ln -sfn "$(pwd)/scripts/run-nanoagent.mjs" /usr/local/bin/nanogent
sudo ln -sfn "$(pwd)/scripts/run-nanoagent.mjs" /usr/local/bin/nanoagent
```

The launcher runs `src/main.ts` via bun (same as `bun run start`) in a git checkout. Packaged `.deb` / Windows zip / npm installs have no `src/` and use compiled `dist/`.

---

## Launch

```bash
nanoagent          # interactive TUI in the current directory
nanogent           # same binary
nanoagent tui      # force TUI
```

### CLI commands

| Command | What it does |
|---|---|
| `nanoagent` / `nanoagent tui` | Full-screen OpenTUI session |
| `nanoagent run --prompt "…"` | One headless task |
| `nanoagent models` | List models from the configured runtime |
| `nanoagent doctor` | Config + runtime health check |
| `nanoagent todo` | CLI todo list (`add`, `list`, `done`, `delete`, `clear`) |

`run` flags: `--prompt` / `--stdin`, `--workspace`, `--model`, `--base-url`, `--profile`, `--max-rounds`, `--max-iterations`, `--json`, `--quiet`, `--verbose`, `--yes` (auto-approve permissions), `--permission-mode <read_only\|ask\|allow_edits\|always_allow>`.

---

## Recommended local setup

- **Model**: `Jackrong/Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF` (or another Qwen 3.5 2B–8B)
- **Runtime**: [LM Studio](https://lmstudio.ai/) at `http://127.0.0.1:1234/v1`, or Ollama at `http://127.0.0.1:11434/v1`

When LM Studio has extra small models loaded (`qwen3.5-2b`, etc.), NanoAgent can use them as an exploration sub-agent pool. You can also point at a remote pool with `REMOTE_LMSTUDIO_URL` or a `subagents` block in config.

First-run: type `/connect` in the TUI to pick a provider (Local first, then Cloud), enter an API key if needed, and choose a model.

Cloud providers include OpenAI, OpenRouter, Azure AI Foundry (per-resource URL), Alibaba Cloud Model Studio / DashScope (intl, China, and Coding Plan), Kimi Code, Moonshot, DeepSeek, Groq, xAI, Together, Fireworks, Cerebras, MiniMax, NVIDIA NIM, Hugging Face, Gemini (OpenAI-compat), and others. Local extras include Foundry Local, SGLang, MLX, KoboldCpp, and Docker Model Runner. All of these speak OpenAI Chat Completions — no extra SDKs.

---

## Configuration

Global defaults live in `~/.nanogent.json` or `~/.nanoagent.json`. Project overrides live in `.nanogent.json` (or `.nanoagent.json`) in the workspace. Project keys win; MCP server maps merge (project-local MCP does **not** auto-connect unless the source is trusted — see [SECURITY.md](SECURITY.md)).

```json
{
  "model": "Jackrong/Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF",
  "baseURL": "http://127.0.0.1:1234/v1",
  "workspace": "./",
  "permissionMode": "ask",
  "contextCompactThreshold": 0.8,
  "maxRequestsPerMinute": 20,
  "maxConcurrentLlmRequests": 2,
  "maxTokensPerMinute": 200000,
  "maxToolResultTokens": 8000,
  "profiles": {
    "local": {
      "model": "Jackrong/Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF",
      "baseURL": "http://127.0.0.1:1234/v1",
      "maxToolResultTokens": 0
    },
    "cloud": {
      "model": "openrouter/free",
      "baseURL": "https://openrouter.ai/api/v1",
      "provider": "openrouter",
      "maxRequestsPerMinute": 20,
      "maxConcurrentLlmRequests": 2,
      "maxToolResultTokens": 8000
    }
  },
  "fallbacks": [
    {
      "model": "openrouter/free",
      "baseURL": "https://openrouter.ai/api/v1",
      "provider": "openrouter"
    }
  ],
  "subAgentEnabled": true,
  "maxBackgroundSubAgents": 4,
  "securityEnabled": true,
  "securityValidateCommands": true,
  "securitySanitizeOutput": true
}
```

Paid/cloud pacing (local runtimes stay unlimited): `maxRequestsPerMinute` and `maxConcurrentLlmRequests` in config, or:

```bash
QWEN_MAX_REQUESTS_PER_MINUTE=20 QWEN_MAX_CONCURRENT_LLM=2 nanogent run --prompt "status" --workspace .
QWEN_MAX_TOKENS_PER_MINUTE=200000 QWEN_MAX_TOOL_RESULT_TOKENS=8000 nanogent doctor --json
nanogent doctor --json
```

Catalog defaults when unset: OpenRouter 20 RPM / 2 in-flight, Groq 30/2, Cerebras 30/2, Hugging Face 15/1. `0` is unlimited. File/env always win over catalog. `rateLimitMs` is an optional extra pause between agent iterations (default 0; do not use it for cloud 429s). `QWEN_MAX_RPM` is an alias for `QWEN_MAX_REQUESTS_PER_MINUTE`.

Optional TPM (`maxTokensPerMinute` / `QWEN_MAX_TOKENS_PER_MINUTE`, alias `QWEN_MAX_TPM`) is off unless you set it — there is no catalog TPM default. Cloud tool results are capped at 8000 tokens by default after secrets sanitize (`maxToolResultTokens` / `QWEN_MAX_TOOL_RESULT_TOKENS`; `0` = off; local stays uncapped unless you set a value). Session `$` estimates use OpenRouter catalog prices when available, or `promptPricePerMillion` / `completionPricePerMillion` (`QWEN_PROMPT_PRICE_PER_MILLION`, `QWEN_COMPLETION_PRICE_PER_MILLION`). Prices are never invented; `/usage` and the status bar show tokens only when rates are unknown.

Context windows come from the live runtime when the catalog reports them: LM Studio loaded instance, OpenRouter `context_length`, or a cached GET `/models` on other OpenAI-compatible clouds (`context_length` / `max_model_len` / `max_context_length`). Missing fields stay on the existing heuristic — NanoAgent never invents a smaller window. Catalog capability flags (`supportsTools`, `supportsThinking`, `supportsPromptCache`) are opt-in only when the provider is explicit; unknown keeps today's request shape (`enable_thinking` for `qwen*` / `bonsai*`, tools always sent). Cloud endpoints that advertise prompt cache get a stable `prompt_cache_key` (workspace + model). Opt out with `"promptCache": false` or `QWEN_PROMPT_CACHE=0`. Local providers skip cache hints. `/config show` and `nanogent doctor --json` include the resolved context source and known flags when set.

**Failover** is explicit only — NanoAgent never invents a cloud backup. After LLM retries are exhausted, a 429 / 502 / 503 / 504, timeout, or connection error retries the same turn on the next `fallbacks[]` entry (or `QWEN_FALLBACK_MODEL` + optional `QWEN_FALLBACK_BASE_URL` / `QWEN_FALLBACK_PROVIDER` when the file omits `fallbacks`). File wins over env; invalid env is logged and ignored. Auth failures (401/403), bad requests (400), and user abort do not fail over. Each fallback is tried once per main-agent turn, and once per `explore_subagent` worker run. The live session or that worker's in-memory client switches — not `~/.nanogent.json`, and not the shared pool default for other workers. API keys are resolved per fallback provider — the primary key is never sent to a different provider.

**Profiles** are named snapshots in `profiles`. `/profile` lists them; `/profile cloud` applies `cloud` to the live session (rebuilds the LLM client). Persist with `/profile cloud --global`. Headless: `nanogent run --profile local --prompt "status"`. Do not hardcode a paid model id; put your OpenRouter/DashScope model in the `cloud` snapshot.

In the TUI:

- `/config` or `/config show` — active config and loaded files
- `/config set model <name>` — project-local
- `/config set baseURL http://127.0.0.1:1234/v1 --global` — machine-wide
- `/config set maxRequestsPerMinute 20`
- `/config set maxConcurrentLlmRequests 2`
- `/config set maxTokensPerMinute 200000`
- `/config set maxToolResultTokens 8000`
- `/config set promptCache false`
- `/config reload` or `/reload` — reload from disk
- `/set <key> <val>` — same as `/config set`
- `/profile` / `/profile list` — named snapshots
- `/profile <name>` — apply live (`--global` / `--local` to persist)

---

## TUI slash commands

| Command | Description |
|---|---|
| `/help` | Help overlay (F1) |
| `/new` | Start a new session |
| `/clear` | Clear chat (F2); keeps system messages |
| `/compact` | Force context compaction |
| `/auto <task>` | Autonomous run (F3 prefills `/auto`) |
| `/config` `/set` | View or edit `.nanogent.json` |
| `/profile` | List or apply a named model snapshot (`--global` to persist) |
| `/connect` | Pick runtime, API key, and model |
| `/usage` | Session input/output tokens and estimated USD (when prices are known) |
| `/doctor` | Health check |
| `/models` | Local/remote models and context |
| `/todo` `/todos` | Todo sidebar (F4) / list |
| `/skills` | Skills overlay (F8) |
| `/skill` `/skill-load` `/unload` | List, load, or unload a skill |
| `/graph build\|stats\|report` | Memory graph |
| `/mcp` `/mcp-add` `/mcp-remove` | MCP servers |
| `/permissions` | `read_only` / `ask` / `allow_edits` / `always_allow` |
| `/cd [path]` | Change tool workspace |
| `/allow [path]` | Extra tool path outside the workspace |
| `/theme [name]` | Switch theme (F9 cycles) |
| `/save` `/load` `/sessions` `/resume` `/rename` | Session persistence |
| `/export` | Export chat to markdown |
| `/copy` | Copy selected message |
| `/reload` | Reload config, skills, and runtime metadata |
| `/exit` | Quit and auto-save (F10) |

### Shortcuts

| Key | Action |
|---|---|
| F1 | Help |
| F2 | Clear chat |
| F3 | Prefill `/auto` |
| F4 | Todo sidebar |
| F5 | Save session |
| F6 | Load session |
| F7 | Toggle mouse capture |
| F8 | Skills overlay |
| F9 | Cycle theme |
| F10 | Exit |
| Shift+Tab | Cycle permission mode |
| Shift+Enter | Multi-line input |
| Ctrl+↑/↓ | Select message |
| Ctrl+C | Copy selected message |
| Ctrl+D | Abort current run |
| Shift+drag | Select and copy (or turn mouse capture off with F7) |

---

## Headless examples

```bash
nanoagent run --prompt "Refactor index.ts to use async/await" --workspace .
cat task.txt | nanoagent run --stdin --workspace . --quiet
nanoagent run --prompt "check test coverage" --json
nanoagent run -p "run tests and fix failures" -y --permission-mode allow_edits
nanoagent run --profile local --prompt "status" --workspace .
nanoagent doctor --json
nanoagent models --base-url http://127.0.0.1:1234/v1
nanoagent todo add "Write the README"
nanoagent todo list
```

---

## Security

Enabled by default:

- **Command validation** — blocks dangerous shell patterns
- **Workspace sandboxing** — tools stay in the workspace unless you `/allow` a path
- **Output sanitization** — redacts keys and tokens from tool output
- **Untrusted project configs** — a cloned repo cannot auto-connect its own MCP servers or override trust via a workspace `.env`

Full details: [SECURITY.md](SECURITY.md). These guards are still evolving with the rest of the project.

---

## Project layout

```text
src/
├── main.ts              # CLI entry (nanoagent / nanogent)
├── agent.ts             # AgentCore re-export
├── agent/               # Run loop, early-stop, core state
├── agent-messages.ts    # LLM payload, compaction, system-base cache
├── agent-lifecycle.ts   # Init, reconfigure, shutdown
├── config/              # .nanogent.json load / validate / merge
├── llm/                 # Chat, stream, rate limit, context sizing
├── context/             # ContextManager (fill, auto-compact)
├── tools/               # Files, shell, git, search, graph, MCP
├── subagents/           # Remote explore-subagent pool + workers
├── providers/           # Runtime catalog (LM Studio, OpenRouter, …)
├── security/            # Permissions, command/path checks, redaction
├── graph/               # Memory graph
├── mcp/                 # MCP client
├── skills.ts            # Skill loader
├── cli/                 # run, doctor, models, todo, help
└── opentui/             # TUI, slash commands, overlays
```

---

## License

[MIT License](LICENSE)
