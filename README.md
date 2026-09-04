# ⚡ NanoAgent (`nanoagent`)

```text
  _  _                 _                    _
 | \| |__ _ _ _  ___  /_\  __ _ ___ _ _ | |_
 | .` / _` | ' \/ _ \/ _ \/ _` / -_) ' \|  _|
 |_|\_\__,_|_||_\___/_/ \_\__, \___|_||_|\__|
                          |___/
      ⚡ NanoAgent — Tiny Models, Scalable Intelligence ⚡
```

Current release: **2.5.3** (`@omega3_0/nanoagent`) — reasoning-only turns now nudge the model instead of silently retrying identical context (small models no longer loop the same analysis invisibly), and wheel scrolling is restored. The workspace defaults to the directory you launched nanoagent from, so tools see your actual project. Includes the 2.5.x TUI polish pass: six themes, a Ctrl+P command palette, quiet tool rows, tinted diffs, inline markdown, width-aware status bar, and normal-terminal copy/paste. Builds on 2.4.0's snapshot/rollback edit surface and 2.3.0's single canonical install root (`NANOAGENT_ROOT`).

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

- **Single install root** — every file the agent owns lives under `NANOAGENT_ROOT` (`config/`, `skills/`, `tools/`, `sessions/`, `workspace/`, `logs/`). One source of truth, no homedir/cwd/legacy fallback search.
- **One boot script** — `nanoagent` / `nanogent` / `nano-agent` all dispatch `scripts/run-nanoagent.mjs`. That script creates the layout, sets `NANOAGENT_ROOT`, and chdirs the child. Nothing else boots the agent.
- **Launch from anywhere** — `nanoagent`, `nanogent`, `nano-agent`, or `npx @omega3_0/nanoagent`
- **Tiny-model first** — compact prompts, context auto-compact (default 80% of the live window), and small-model tool-call resilience
- **OpenTUI dashboard** — streaming chat, tool diffs, todos, skills overlay, connect overlay, six themes, and a Ctrl+P command palette
- **Permissions** — `read_only` / `ask` / `allow_edits` / `always_allow`, plus Shift+Tab to cycle in the TUI
- **Remote sub-agents** — `explore_subagent` workers against a configured pool or `REMOTE_LMSTUDIO_URL`
- **MCP** — local stdio or remote HTTP servers (`/mcp`, `/mcp-add`, `/mcp-remove`); only the canonical global config is trusted by default
- **Skills** — bundled + user skills under `NANOAGENT_ROOT/skills/`, auto-load on triggers, `/skills` overlay (F8)
- **Memory graph** — `/graph build|stats|report` for codebase structure
- **Security defaults** — command checks, workspace path sandboxing, secret redaction (see [SECURITY.md](SECURITY.md))
- **Headless CLI** — `run`, `doctor`, `models`, `todo` for scripts and CI

---

## Install

### Option 1: Global npm (quick start)

```bash
npm install -g @omega3_0/nanoagent
npm install -g @omega3_0/nanoagent@latest   # update
```

Requires **Node ≥ 18** (for `npm` itself). The Bun runtime ships **inside** the package — npm pulls the matching `@oven/*` platform binary automatically, so there is no separate Bun install and no network fetch beyond the registry. If the bundled binary can't run, plain Node ≥ 18 executes everything headless.

### Option 2: Native packages (bundled runtime, no Node required)

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

### Option 3: `npx` (no install)

```bash
npx @omega3_0/nanoagent
```

### Option 4: Build from source

NanoAgent is MIT-licensed open source — cloning and building locally gives you the same thing the packages ship:

```bash
git clone https://github.com/leeno7786-coder/nanoagent.git
cd nanoagent
bun install --frozen-lockfile   # or: npm install
sudo ln -sfn "$(pwd)/scripts/run-nanoagent.mjs" /usr/local/bin/nanogent
sudo ln -sfn "$(pwd)/scripts/run-nanoagent.mjs" /usr/local/bin/nanoagent
```

`scripts/run-nanoagent.mjs` is the **only** entry point. In a source checkout it runs `src/main.ts` via bun (same path as `bun run start`); packaged `.deb` / Windows zip / npm installs have no `src/` and use compiled `dist/main.js`. Either way the launcher creates the canonical layout under `NANOAGENT_ROOT` on first run.

---

## Launch

```bash
nanoagent          # interactive TUI in the current directory
nanogent           # same binary
nanoagent tui      # force TUI
```

The launcher prints the resolved layout on first run, something like:

```text
NanoAgent root : /home/user/.local/share/nanoagent
config/         : /home/user/.local/share/nanoagent/config
skills/         : /home/user/.local/share/nanoagent/skills
tools/          : /home/user/.local/share/nanoagent/tools
sessions/       : /home/user/.local/share/nanoagent/sessions
workspace/      : /home/user/.local/share/nanoagent/workspace
logs/           : /home/user/.local/share/nanoagent/logs
```

Set `NANOAGENT_ROOT` before invoking to point at a different install location (portable, vendored, per-project). There is no other path-resolution knob.

### CLI commands

| Command                       | What it does                                             |
| ----------------------------- | -------------------------------------------------------- |
| `nanoagent` / `nanoagent tui` | Full-screen OpenTUI session                              |
| `nanoagent run --prompt "…"`  | One headless task                                        |
| `nanoagent models`            | List models from the configured runtime                  |
| `nanoagent doctor`            | Config + runtime health check                            |
| `nanoagent todo`              | CLI todo list (`add`, `list`, `done`, `delete`, `clear`) |

`run` flags: `--prompt` / `--stdin`, `--workspace`, `--model`, `--base-url`, `--profile`, `--max-rounds`, `--max-iterations`, `--json`, `--quiet`, `--verbose`, `--yes` (auto-approve permissions), `--permission-mode <read_only\|ask\|allow_edits\|always_allow>`.

---

## Recommended local setup

- **Model**: `Jackrong/Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF` (or another Qwen 3.5 2B–8B)
- **Runtime**: [LM Studio](https://lmstudio.ai/) at `http://127.0.0.1:1234/v1`, or Ollama at `http://127.0.0.1:11434/v1`

When LM Studio has extra Qwen3.5 2B models loaded (up to 4 instances), NanoAgent uses them as an exploration sub-agent pool — one worker per loaded 2B, dispatched with `explore_subagent` (max 4 in parallel). You can also point at a remote pool with `REMOTE_LMSTUDIO_URL` or a `subagents` block in config.

First-run: type `/connect` in the TUI to pick a provider (Local first, then Cloud), enter an API key if needed, and choose a model.

Cloud providers include OpenAI, OpenRouter, Azure AI Foundry (per-resource URL), Alibaba Cloud Model Studio / DashScope (intl, China, and Coding Plan), Kimi Code, Moonshot, DeepSeek, Groq, xAI, Together, Fireworks, Cerebras, MiniMax, NVIDIA NIM, GMI Cloud, Hugging Face, Gemini (OpenAI-compat), and others. Local extras include Foundry Local, SGLang, MLX, KoboldCpp, and Docker Model Runner. All of these speak OpenAI Chat Completions — no extra SDKs.

---

## Configuration

The global config lives at exactly one path: `$NANOAGENT_ROOT/config/nanogent.json`. There is no other global config location — not `~/.nanogent.json`, not `~/.nanoagent.json`, not `~/.nanogent/config.json`, not `~/.qwen-agent.json`. Project overrides live at `<workspace>/nanogent.json` and are only consulted when `--workspace` is passed explicitly (the workspace defaults to `$NANOAGENT_ROOT/workspace`, which is intentionally separate from the harness so the canonical root stays clean).

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
  "effort": "low",
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

**Failover** is explicit only — NanoAgent never invents a cloud backup. After LLM retries are exhausted, a 429 / 502 / 503 / 504, timeout, or connection error retries the same turn on the next `fallbacks[]` entry (or `QWEN_FALLBACK_MODEL` + optional `QWEN_FALLBACK_BASE_URL` / `QWEN_FALLBACK_PROVIDER` when the file omits `fallbacks`). File wins over env; invalid env is logged and ignored. Auth failures (401/403), bad requests (400), and user abort do not fail over. Each fallback is tried once per main-agent turn, and once per `explore_subagent` worker run. The live session or that worker's in-memory client switches — not `$NANOAGENT_ROOT/config/nanogent.json`, and not the shared pool default for other workers. API keys are resolved per fallback provider — the primary key is never sent to a different provider.

**Profiles** are named snapshots in `profiles`. `/profile` lists them; `/profile cloud` applies `cloud` to the live session (rebuilds the LLM client). Persist with `/profile cloud --global`. Headless: `nanogent run --profile local --prompt "status"`. Do not hardcode a paid model id; put your OpenRouter/DashScope model in the `cloud` snapshot.

In the TUI:

- `/config` — open the live config overlay (writes `$NANOAGENT_ROOT/config/nanogent.json` immediately)
- `/config show` — print the config summary in chat
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
- `/settings` — alias for `/config`
- `/effort [none|low|medium|high|extra-high]` — show or set thinking effort

`/config`, `/settings`, and `/effort` write `$NANOAGENT_ROOT/config/nanogent.json` immediately.

---

## Skills

All skills — bundled and user — live at `$NANOAGENT_ROOT/skills/`. There is no `<cwd>/skills`, no `~/.agents/skills`, no `~/.claude/skills` lookup, and no legacy `~/.qwen-agent-tui/skills` fallback. Bundled markdown skills (`SKILL.md` with YAML frontmatter) ship in the package and the launcher installs them to the canonical skills dir on first run. User skills (`*.json` or `<name>/SKILL.md`) dropped into the same directory are auto-enabled.

Toggling:

- `/skills` (F8) — overlay listing every skill with its enabled state; toggle inline
- `/skill <name>` — load a skill into the current session
- `/skill-load <name>` / `/unload <name>` — explicit load/unload
- `enabled: false` in the skill's frontmatter or `config/skill-config.json` keeps it dormant without deleting it

Triggers in the frontmatter or `Use when: ...` clauses in the description auto-load skills on matching user prompts.

---

## Working tree & rollback

Tools **edit the directory you pointed at directly**. `cfg.workspace` is your project; `read_file`, `write_file`, `edit_file`, etc. all read and write inside it. Rollback is the safety net: on first agent init we capture a baseline snapshot of every file in the workspace, and named snapshots record additional checkpoints. `/rollback` reverts to the baseline; `/rollback <name>` reverts to a named one.

```text
<workspace>/                        # your project (--workspace)
├── .nanoagent/                     # agent-owned rollback store
│   └── snapshots/
│       ├── init.json               # baseline (taken at agent init)
│       ├── pre-refactor.json       # /snapshot pre-refactor
│       └── ready-to-ship.json      # /snapshot ready-to-ship
└── … your files                    # tools edit these directly
```

The first time the agent runs against a workspace, `init.json` is written automatically (full capture of every file). Subsequent `/snapshot <name>` calls capture only the diff against the previous named snapshot, so the snapshot store stays small. `/rollback <name>` walks the chain to compose deletions correctly: a file added after a snapshot and then removed after a later one reverts to "exists in the earlier, gone in the later" with the correct outcome.

### Slash commands

| Command                  | What it does                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `/snapshot [name]`       | Capture the current workspace state. Default name: `snap-YYYYMMDD-HHMMSS`. First snapshot is a full capture; later ones are diffs against the previous named snapshot. |
| `/diffs`                  | List every saved snapshot for this workspace, newest first.                                            |
| `/rollback [name]`        | No name: restore the workspace to the baseline (init.json). With name: restore that snapshot, walking the chain so deletions compose correctly. |
| `/rollback ghost`         | Returns "snapshot not found" so the user knows.                                                        |

The startup banner shows the baseline status (`baseline snapshot: <workspace>/.nanoagent/snapshots/init.json`), so you always know what `/rollback` will revert to.

---

## TUI slash commands

| Command                                         | Description                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/help`                                         | Help overlay (F1)                                                                         |
| `/new`                                          | Start a new session                                                                       |
| `/clear`                                        | Clear chat (F2); keeps system messages                                                    |
| `/compact`                                      | Force context compaction                                                                  |
| `/auto <task>`                                  | Autonomous run (F3 prefills `/auto`)                                                      |
| `/config`                                       | Live scalar overlay (global persist). `/config show` prints. `/config set` writes a file. |
| `/settings`                                     | Alias for `/config` overlay                                                               |
| `/effort`                                       | Show or set thinking effort (`none`–`extra-high`; writes global config when set)          |
| `/profile`                                      | List or apply a named model snapshot (`--global` to persist)                              |
| `/connect`                                      | Pick runtime, API key, and model                                                          |
| `/usage`                                        | Session input/output tokens and estimated USD (when prices are known)                     |
| `/doctor`                                       | Health check                                                                              |
| `/models`                                       | Local/remote models and context                                                           |
| `/todo` `/todos`                                | Todo sidebar (F4) / list                                                                  |
| `/clear-todos`                                  | Remove all todos                                                                          |
| `/skills`                                       | Skills overlay (F8)                                                                       |
| `/skill` `/skill-load` `/unload`                | List, load, or unload a skill                                                             |
| `/graph build\|stats\|report`                   | Memory graph                                                                              |
| `/mcp` `/mcp-add` `/mcp-remove`                 | MCP servers                                                                              |
| `/permissions`                                  | `read_only` / `ask` / `allow_edits` / `always_allow`                                      |
| `/cd [path]`                                    | Change tool workspace                                                                     |
| `/allow [path]`                                 | Extra tool path outside the workspace                                                     |
| `/theme [name]`                                 | Switch theme — dark, light, warmDark, coolDark, black (OLED), highContrast (F9 cycles)     |
| `/save` `/load` `/sessions` `/resume` `/rename` | Session persistence                                                                       |
| `/delete-session`                               | Delete a saved session                                                                    |
| `/export`                                       | Export chat to markdown                                                                   |
| `/copy`                                         | Copy selected message                                                                     |
| `/set <key> <val>`                              | Shorthand for `/config set`                                                               |
| `/reload`                                       | Reload config, skills, and runtime metadata                                               |
| `/exit`                                         | Quit and auto-save (F10)                                                                  |

### Shortcuts

| Key         | Action                                              |
| ----------- | --------------------------------------------------- |
| F1          | Help                                                |
| F2          | Clear chat                                          |
| F3          | Prefill `/auto`                                     |
| F4          | Todo sidebar                                        |
| F5          | Save session                                        |
| F6          | Load session                                        |
| F8          | Skills overlay                                      |
| F9          | Cycle theme                                         |
| F10         | Exit                                                |
| Ctrl+P      | Command palette (themes, overlays, session actions) |
| Shift+Tab   | Cycle permission mode                               |
| Shift+Enter | Multi-line input                                    |
| Ctrl+↑/↓    | Select message                                      |
| Ctrl+C      | Copy selected message                               |
| Ctrl+D      | Abort current run                                   |
| Wheel       | Scroll the chat                                     |
| PgUp/PgDn · Shift+↑/↓ | Scroll the chat (keyboard)                |
| Shift+drag  | Select text (bypasses app mouse capture), then Ctrl+Shift+C to copy |
| Right-click / Ctrl+V / Ctrl+Shift+V | Paste — chat keeps line breaks, key fields collapse to one line |

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

- **Command validation** — structural validator (empty check + your custom allow/block lists); the `PermissionManager` policy gate is the safety net
- **Workspace sandboxing** — tools stay in the workspace unless you `/allow` a path
- **Output sanitization** — redacts keys and tokens from tool output
- **Untrusted project configs** — a cloned repo cannot auto-connect its own MCP servers or override trust via a workspace `.env`. The MCP trust check is strictly against `$NANOAGENT_ROOT/config/nanogent.json` (or an explicitly-passed config path); workspace `nanogent.json` MCP servers are tracked in `mcpUntrusted` and blocked from auto-connect.
- **Trust-sensitive env** — `NANOGENT_TRUST_PROJECT_MCP`, `QWEN_SECURITY_*`, `QWEN_BASE_URL`, `REMOTE_LMSTUDIO_URL`, `AZURE_OPENAI_ENDPOINT`, `HF_TOKEN`, `QWEN_FALLBACK_*`, and `*_API_KEY` are honored only from the real process environment or `$NANOAGENT_ROOT/config/.env` (the canonical `getApiKey()` source). Project `.env` files cannot inject them.

Full details: [SECURITY.md](SECURITY.md). These guards are still evolving with the rest of the project.

---

## Project layout

```text
scripts/
└── run-nanoagent.mjs   # The single boot script (resolves NANOAGENT_ROOT, creates the layout, sets env, chdirs, spawns bun or node)

src/
├── main.ts              # Entry point (requires NANOAGENT_ROOT, fails fast otherwise)
├── agent.ts             # AgentCore re-export
├── agent/               # Core state machine: core.ts, run.ts, early-stop.ts
├── agent-messages.ts    # LLM payload, compaction, system-base cache
├── agent-lifecycle.ts   # Init, reconfigure, shutdown
├── agent-subagents.ts   # Sub-agent dispatch wiring
├── agent-todos.ts       # Todo tracking
├── agent-tools.ts       # Agent-facing tool wiring
├── agent-utils.ts       # Shared agent helpers
├── agent-tools/         # Built-in tools exposed to the agent (execute.ts, utils.ts)
├── config/              # defaults.ts, load.ts, validate.ts, profiles.ts, effort.ts, api-keys.ts, paths.ts
├── llm/                 # client.ts, chat.ts, stream.ts, request.ts, rate-limit.ts, failover.ts, cost.ts, tool-result-budget.ts, context.ts
├── context/             # ContextManager (fill, auto-compact)
├── tools/               # file-tools, exec-tools, git-tools, search-tools, graph-tools, mcp-manage, misc, registry
├── tools/file-tools/    # read.ts, write.ts, navigate.ts
├── subagents/           # Pool resolution, dispatch, and worker/ subfolder (loop, scheduler, failover, tool-runner, context)
├── providers/           # catalog.ts, lookup.ts, runtime.ts, qwen-models.ts, index.ts
├── security/            # permissions.ts, patterns.ts, index.ts
├── graph/               # MemoryGraph.ts + tools.ts (build/stats/report)
├── mcp/                 # MCP client (index.ts)
├── skills.ts            # Skill loader (reads only $NANOAGENT_ROOT/skills/)
├── skill-manager.ts     # Skill lifecycle
├── store.ts             # Session persistence (writes only $NANOAGENT_ROOT/sessions/)
├── storage.ts           # Disk I/O for sessions
├── lib/                 # Shared utilities (file-diff.ts, etc.)
├── cli/                 # run.ts, doctor.ts, models.ts, todo.ts, help.ts, reports.ts
├── opentui/             # app.tsx, chat-screen.tsx, overlays, slash-commands/, status-bar, connect-overlay
├── types.ts             # Shared TypeScript interfaces
└── *.test.ts            # Colocated bun:test files
```

`NANOAGENT_ROOT` resolved at startup (no fallback chain):

```text
NANOAGENT_ROOT/
├── config/      nanogent.json · .env · skill-config.json · todos.json · input-history.json
├── skills/      bundled SKILL.md + user skills
├── tools/       bundled/managed tools
├── sessions/    chat session stores
├── workspace/   default agent workspace (separate from the harness)
└── logs/        stderr.log · crash.log · last-run.json
```

---

## Changelog

### 2.5.3 — Reasoning-only loop fix + scroll restore

- **No more invisible analysis loops.** Small thinking models (e.g. Qwen/Bonsai ≤8B) sometimes dump their entire analysis into the reasoning channel and emit no visible reply or tool calls. The harness retried silently with *identical* history — reasoning turns are stripped from the model payload — so the model deterministically regenerated the same analysis until the cap hit, with the context counter never moving. Each reasoning-only turn now injects a hidden nudge ("respond with content or tool calls") so the retry sees new context, and a visible `↻ Model produced thinking only… (n/max)` notice makes the loop transparent.
- **Small models give up sooner.** Reasoning-only retries cap at 3 in ≤8B mode (was the default 5); `/config set maxReasoningOnlyRounds` still overrides.
- **Wheel scrolling restored** — mouse capture re-enabled so the main chat window scrolls again.
- **Tests:** suite 929 pass / 0 fail.

### 2.5.2 — Workspace follows the launch directory

- **Tools see your actual project.** The launcher chdirs the child into the install root (by design), and the config then defaulted the workspace to the canned `<NANOAGENT_ROOT>/workspace` — so the agent could only see placeholder files, not the directory you opened nanoagent in. The launcher now captures your launch directory as `NANOAGENT_LAUNCH_CWD` and the agent's default workspace resolves to it.
- **Precedence:** `--workspace` / `QWEN_WORKSPACE` → launch directory → install-root workspace (fallback for tests/embedded use). `/cd` still switches at runtime.
- **Trust boundary kept:** a `nanogent.json` in the launch directory is *not* read as a config override — opening nanoagent in a cloned repo can't silently reconfigure the agent.
- **Tests:** 4 new workspace-precedence tests; suite 929 pass / 0 fail.

### 2.5.1 — CI green + command surfacing fixes

- **CI pipeline green again** — fixed 7 lint errors, prettier drift across `src/`, and two real bugs the red pipeline was hiding: `--help` now works without the launcher (the `NANOAGENT_ROOT` guard ran before help handling), and `mcp-manage.ts` / `store.ts` no longer resolve install paths at import time (which crashed any direct `bun src/main.ts` invocation).
- **Docker image fixed** — the build stage now copies `scripts/` (the `fix-ext` build step needs it), and the image ships a canonical `NANOAGENT_ROOT` layout with bundled skills so the container actually boots.
- **Rollback system is reachable from the UI** — `/snapshot`, `/diffs`, `/rollback` (plus `/new`, `/sessions`, `/resume`, `/rename`, `/delete-session`, `/copy`, `/clear-todos`, `/skill-load`, `/unload`) now appear in the `/` dropdown and F1 help. The Ctrl+P palette gains Snapshot / List snapshots / Rollback actions; rollback prefills `/rollback ` into the input instead of executing, so a stray Enter can't reset the workspace to baseline.
- **Overlay/focus conflict fixed** — opening Ctrl+P (or any overlay) while the `/` dropdown was open left the dropdown capturing keys and broke chat-bar focus afterward. Overlays now suspend the dropdown and own focus; closing restores the chat input.
- **Tests**: full suite green locally for the first time — 925 pass / 0 fail (env-dependent tests use the bundled bun or skip cleanly).

### 2.5.0 — TUI polish pass

A ground-up visual cleanup of the OpenTUI interface, aimed at a quieter, more polished chat surface.

- **Six themes** — `dark`, `light`, `warmDark`, `coolDark`, `black` (OLED), and `highContrast`, all built on full semantic tokens (diff backgrounds/signs, code background, accent/on-accent pairs, syntax palette). `/theme <name>` to pick, F9 to cycle, live preview from the command palette.
- **Ctrl+P command palette** — opencode-style floating palette with fuzzy filter over app actions (theme, settings, connect, compact, export, sessions, skills, permissions, exit). Theme switching previews live without closing the palette.
- **Quiet tool rows** — muted `→`/`←`/`$` glyphs, accent-highlighted targets, workspace-relative paths, multi-line commands truncated to one line, no per-message token noise.
- **Full-width tinted diffs** with line numbers and colored gutters; code blocks render on a dedicated background; chat text renders inline markdown (`` `code` ``, `**bold**`, `##` headings).
- **Inline slash dropdown** — `/` suggestions render directly above the input with accent-bar selection and right-aligned F-key hints, not as a modal.
- **Normal-terminal copy/paste** — mouse capture removed entirely (the F7 toggle is gone). Drag-select copy and right-click / Ctrl+Shift+V paste work natively; Ctrl+V / Shift+Insert fall back to clipboard tools. Paste heuristics: the chat input preserves interior line breaks, single-line fields (API keys) collapse to one trimmed line.
- **Width-aware status bar** — one compact row that measures itself against the terminal and drops low-priority stats instead of garbling; slim one-line welcome banner.
- **Tests**: 153 TUI tests + clipboard heuristic coverage; suite green (2 pre-existing environment failures unrelated to the TUI).

### 2.4.0 — Snapshots and rollback

Tools edit the user's project directly. `cfg.workspace` IS the directory the user pointed at; `read_file`, `write_file`, `edit_file`, etc. all read and write inside it. Rollback is the safety net: on first agent init, a baseline snapshot of every file in the workspace is captured at `<workspace>/.nanoagent/snapshots/init.json`. Named snapshots (`/snapshot <name>`) record additional checkpoints as diffs against the previous named snapshot, so the store stays small.

- **`/snapshot [name]`** — capture the current workspace state. First snapshot is a full capture; later ones are diffs.
- **`/diffs`** — list every saved snapshot, newest first.
- **`/rollback <name>`** — restore a named snapshot, walking the chain so deletions compose correctly. `new.ts` added after a snapshot and removed after a later one reverts to "gone" when rolling back to the earlier one — the chain walk reconstructs the file set at that point in time.
- **`/rollback`** (no name) — restore the workspace to the baseline (`init.json`). The user's edits are lost unless they were `/snapshotted` first.
- **Startup banner** shows the baseline status, so you always know what `/rollback` will revert to.
- **Files**: `src/snapshots.ts` (capture, list, restore, delete, baseline, restoreBaseline), `src/agent-lifecycle.ts` (take baseline at init), `src/opentui/slash-commands/index.ts` (the four commands), `src/agent-tools/execute.ts` (tools now pass `agent.cfg.workspace` directly — no more working-tree redirect), `src/opentui/app.tsx` (banner).
- **Tests**: 16 new unit tests in `src/snapshots.test.ts` (baseline, named snapshots, diff chain, restore, list), 5 new slash-command tests in `src/opentui/slash-commands.test.ts`. Suite: 921 pass / 2 pre-existing-on-main fail.
- **Removed**: the previous "lazy copy into `<workspace>/.nanoagent/working-tree/`" model — the working tree was the wrong place to put edits. The rollback store lives at `<workspace>/.nanoagent/snapshots/` and tools operate on the source directly.

### 2.3.0 — Single canonical install root

Killed the whole class of "skills / config / sessions disappear depending on cwd" bugs by collapsing every state directory onto one path. **One source of truth, no fallback searching, fail fast on duplicates.**

- **`NANOAGENT_ROOT` is the only state directory.** Resolved once by `scripts/run-nanoagent.mjs` and exported to the child. There is no `~/.nanoagent`, no `~/.qwen-agent-tui`, no `<cwd>/.env` lookup, no `<cwd>/skills` lookup, no legacy read fallback. Set `NANOAGENT_ROOT=/path/to/install` and every other path follows.
- **One boot script.** `nanoagent` / `nanogent` / `nano-agent` / `npx @omega3_0/nanoagent` all dispatch `scripts/run-nanoagent.mjs`. The launcher creates the layout (`config/`, `skills/`, `tools/`, `sessions/`, `workspace/`, `logs/`) on first run, sets `NANOAGENT_ROOT`, and chdirs the child so `process.cwd()` is never an accident. The banner:

  ```text
  NanoAgent root : /home/user/.local/share/nanoagent
  config/         : /home/user/.local/share/nanoagent/config
  skills/         : /home/user/.local/share/nanoagent/skills
  tools/          : /home/user/.local/share/nanoagent/tools
  sessions/       : /home/user/.local/share/nanoagent/sessions
  workspace/      : /home/user/.local/share/nanoagent/workspace
  logs/           : /home/user/.local/share/nanoagent/logs
  ```

- **Skills load from exactly one place.** `$NANOAGENT_ROOT/skills/`. Bundled markdown skills ship in the package and are installed to the canonical skills dir on first run. User `.json` and `<name>/SKILL.md` skills dropped into the same directory are auto-enabled. No more 5-source fan-out.
- **Sessions, scratchpad, .env, todos, history, MCP, crash logs — all canonical.** Each lives at a single absolute path under the install root. `loadConfig()` no longer scans cwd or home for candidates; the global config is `$NANOAGENT_ROOT/config/nanogent.json` and project overrides only when `--workspace` is passed.
- **`src/config/paths.ts` is the new ground truth.** `installRoot()`, `nanoagentPaths()`, `GLOBAL_CONFIG_FILE()`, `SKILLS_DIR()`, `SESSIONS_DIR()`, etc. all read `NANOAGENT_ROOT` and throw on missing subdirs. `configDir` / `legacyConfigDir` / `configFileCandidates` are gone.
- **MCP trust narrows to the canonical global config.** Only `$NANOAGENT_ROOT/config/nanogent.json` (or an explicitly-passed config path) is trusted. Project-local MCP servers are tracked in `mcpUntrusted` and blocked from auto-connect; this was already the rule for 2.x, but now the "trusted path" list is one entry instead of four.
- **`main.ts` refuses to run without `NANOAGENT_ROOT`.** Trying to `bun src/main.ts` directly throws — the launcher is the only supported entry. Removes a class of "why does it work in dev but not in the published package" surprises.
- **Tests rewritten** for the new model: 899 pass / 2 fail, both pre-existing on `main` (the `run_command` lifecycle test and the launcher-help test need `bun` on PATH for the test process; nothing the agent owns at runtime).

### 2.2.6 — Drop the dangerous-pattern blocker, surface disabled skills

Two fixes that unblock agent work:

- **No more dangerous-command blocker.** The built-in `DANGEROUS_COMMAND_PATTERNS` list (`src/security/patterns.ts`) was rejecting commands that small models had to run, with no path through the `ask` / `always_allow` permission flow. `SecurityManager.validateCommand` is now a structural validator (empty check + your custom `blockedCommands` / `allowedCommands` lists); the `PermissionManager` policy gate (`ask` / `allow_edits` / `always_allow` / `read_only`) is the sole safety net for shell commands. Review each command when prompted, then choose `always_allow` for the ones you trust. `SECURITY.md` synced.
- **Disabled skills are visible in `/` autocomplete.** Project-local skills (`./skills/`) correctly default to `enabled: false` (prompt-injection guard), but they were filtered out of the slash-command dropdown entirely, so users thought they didn't exist. `getSkillCommands(skills, { includeDisabled })` now surfaces them marked `[disabled]` and greyed out; toggle via `/skills` (F8) or `/config`. Enabled entries still sort first.

### 2.2.5 — Pre-existing test failures were real bugs

The 7 "flaky" local failures turned out to be two genuine bugs plus a test gap:

- _*GIT_CONFIG_* family stripping_* — environments that inject git config via `GIT_CONFIG_COUNT/KEY_n/VALUE_n` (harnesses, CI) had only the `KEY_n` members stripped by the sensitive-var filter, and git dies on the partial family ("missing config key"). `getSanitizedEnv` now treats the family as all-or-nothing.
- **Config precedence** — `~/.nanogent.json` silently overwrote explicitly-passed options, so an explicit `--base-url` could be replaced by the saved `/connect` selection and the catalog would resolve the wrong provider's API key. Explicit options now win.
- **Test hermeticity** — scrub lists cover every trusted `.env` location via the canonical `config/.env`.

Full suite is green locally for the first time: 909 pass / 0 fail.

### 2.2.4 — Write/edit tool integrity

Fixes the "models mangle files" complaint, three ways:

- **No more silent argument truncation** — tool-call arguments were token-capped (~4000) before execution; for `write_file` that cut the content field itself, and a broken parse made `write_file` empty the target file. File-payload tools are exempt from capping; execution always sees full arguments.
- **Refusal instead of corruption** — `write_file` / `edit_file` / `edit_file_lines` reject truncated or unparseable arguments with an actionable error instead of writing partial/empty content.
- **Line-number echo stripping** — small models copied `read_file`'s `NNNN| ` display prefixes into write/edit payloads; the tools now strip them (only on a strict ≥80%-of-lines, strictly-increasing match) and report `line_number_echo_stripped`.

### 2.2.3 — The "ghost crash" fix

The multi-release hunt for a crash that wasn't a crash. Symptom: accepting a permission prompt garbled the display and the process seemed to vanish. Each release added forensics until the evidence named the culprit:

- **2.1.22** — `crash.log` for uncaught exceptions/rejections. Result: nothing logged — JS handlers never fired.
- **2.2.0** — state dir moved to `~/.nanoagent`, giving diagnostics a stable home.
- **2.2.1** — OpenTUI 0.2.1 → 0.5.9 upgrade + `last-run.json` liveness marker. Result: marker dirty, no `exit` event — looked like a native-level kill.
- **2.2.2** — launcher tees child stderr to the logs dir. **Breakthrough:** the log ended with `Received SIGINT, shutting down gracefully...` — users were Ctrl+C'ing out of a garbled frame, not experiencing a native panic at all.
- **2.2.3** — the actual fix: the agent tool loop passed model args verbatim to `execute_command`, so output mirroring defaulted to ON and child stdout/stderr was written raw into the terminal while the TUI held the alternate screen, corrupting the frame. Mirroring is now suppressed whenever the TUI is active. Also fixed the root of the noise seen in the log: the Windows system prompt claimed "PowerShell" while `execute_command` actually runs Git Bash, so the model emitted PowerShell one-liners bash rejected with syntax errors.

Also fixed along the way: permission banner `[Y]/[A]/[N]` row layout under OpenTUI 0.5.9 (2.2.2), `/connect` provider persistence and OpenRouter key validation (2.1.21).

---

## License

[MIT License](LICENSE)
