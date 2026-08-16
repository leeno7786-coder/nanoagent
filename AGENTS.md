# AGENTS.md — Working Rules for NanoAgent

Read this file **before making any change** to this repository. It tells any coding
agent (human or AI) what this project is, how to build/test it, and the rules that
must not be broken.

---

## 1. What This Project Is

**NanoAgent** (`@omega3_0/nanoagent`) is an ultra-lightweight CLI/TUI coding agent
optimized for **tiny local models (2B–8B)** served by LM Studio / Ollama, while also
scaling to cloud APIs (OpenAI, OpenRouter, Azure AI Foundry, Alibaba Model Studio / DashScope, Kimi Code, and other OpenAI-compatible providers).

- **Runtime:** Bun (primary) — the published package runs on Node ≥ 18
- **Language:** TypeScript, ESM (`"type": "module"`), strict mode
- **UI:** OpenTUI (React 19 for the terminal) — full-screen TUI is the primary interface
- **State:** zustand stores
- **Published to npm** — keep the dependency footprint small

The design center is: *make small local models reliable*. When in doubt, prefer the
approach that degrades gracefully on a 2B–4B model.

---

## 2. Essential Commands

| Task | Command |
|---|---|
| Run the TUI (dev) | `bun run start` or `nanoagent` (source checkout launcher = bun + `src/main.ts`) |
| Headless run | `bun run src/main.ts run --prompt "task" --workspace .` |
| Tests | `bun test` (npm test aliases it) |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) |
| Lint | `npm run lint` |
| Format | `npm run format` / check with `npm run format:check` |
| Build | `npm run build` (tsc → `dist/`) |
| Linux `.deb` (amd64, bundled Node) | `bun run package:deb` → `dist-packages/nanoagent_<ver>_amd64.deb` |
| Windows zip (x64, bundled Node) | `bun run package:win` → `dist-packages/nanoagent_<ver>_win_x64.zip` |
| Both native packages | `bun run package:native` |
| Full CI gate | `npm run ci` (typecheck + lint + format:check + test + build) |

**Before considering any task done:** `npm run typecheck` and `bun test` must pass.
For larger changes run the full `npm run ci`.

---

## 3. Repository Map

```text
src/
├── main.ts              # CLI entry point & command router
├── agent.ts             # Core agent state machine & loop
├── agent-*.ts           # Loop helpers: messages, todos, subagents, utils, lifecycle
├── config.ts            # .nanogent.json loader (global + project)
├── llm.ts               # LLM client & token compaction
├── providers.ts         # Provider abstraction (LM Studio, Ollama, OpenAI, OpenRouter…)
├── subagents.ts         # Sub-agent pool resolution & dispatch
├── store.ts             # Session/todo persistence (zustand)
├── skills.ts            # Skill definitions & manager
├── context.ts           # Git/workspace context detection
├── security/            # Command validation, path sandbox, output sanitization
├── tools/               # Built-in tools: file, exec, git, search, graph, registry
├── agent-tools/         # Agent-facing tool wiring
├── mcp/                 # Model Context Protocol client manager
├── graph/               # Codebase memory graph
├── llm/                 # LLM internals
├── cli/                 # Headless commands (run, doctor, models, help)
├── opentui/             # TUI: app.tsx, chat-screen.tsx, overlays, status-bar…
└── types.ts             # Shared TypeScript types (add shared interfaces here)

tests/                   # Standalone test/verification scripts
docs/                    # Project docs (incl. CODE_REVIEW_TEMPLATES.md)
scripts/fix-ext.mjs      # Rewrites relative imports to .js for NodeNext ESM output
```

---

## 4. Hard Rules — DO NOT

These exist because breaking them has caused real incidents. Do not violate them.

1. **Never commit `dist/`.** It is gitignored and built by `prepack`. Source lives in `src/`.
2. **Never weaken the MCP trust guard.** Project-local MCP configs must NOT auto-connect.
   Trust = global `~/.nanogent.json`, an explicit config path, or `NANOGENT_TRUST_PROJECT_MCP=1`.
   This is an RCE / API-key-exfiltration guard. (See `src/mcp/`.)
3. **Never bypass the security layer.** Shell commands go through command validation;
   file tools respect workspace path sandboxing (`.env`, `.git` blocked); tool output is
   sanitized for secrets before it reaches the model. Don't add code paths that skip
   `src/security/`. Don't disable `securityEnabled` defaults.
4. **Never commit secrets.** No API keys in code, tests, or docs. `.env` is never committed;
   new env vars go in `.env.example` only.
5. **No git mutations without explicit user approval** — no `commit`, `push`, `reset`,
   `rebase`, branch deletion, or force-push unless the user asks for it in this conversation.
6. **Don't break `bun.lock`.** It's the canonical lockfile. Install with `bun install`;
   CI runs `bun install --frozen-lockfile`. Don't hand-edit it or add a competing lockfile
   (`package-lock.json`, `yarn.lock`).
7. **Don't run tests with `node --test`.** The suite imports `bun:test` — use `bun test`.
8. **Don't regress small-model behavior.** Tool schemas, prompts, and error messages are
   tuned for ≤8B models: keep descriptions short, args simple, errors structured and
   actionable. Don't add sprawling schemas or chatty prompts.
9. **Don't add heavy dependencies.** This ships to npm as a lightweight CLI. Justify every
   new runtime dependency; dev tooling goes in `devDependencies`.
10. **Don't make unrelated changes.** Minimal diffs. No drive-by refactors, no reformatting
    files you didn't touch, no changing test logic to make a refactor pass.

---

## 5. Coding Conventions

- **TypeScript strict.** `noImplicitAny` is on. No `any` — shared shapes go in `src/types.ts`.
- **ESM / NodeNext.** `"module": "NodeNext"`. Relative imports compile to native ESM;
  `scripts/fix-ext.mjs` rewrites specifiers to `.js` for the Node runtime. Follow the
  existing import style in neighboring files.
- **Style.** Prettier + eslint are enforced in CI (`npm run format:check`, `npm run lint`).
  Run them instead of hand-formatting.
- **Errors in the agent loop** must return structured tool-error messages, not thrown
  exceptions that kill the loop. Small models recover from clear error text.
- **Async:** no unhandled promise rejections; no blocking I/O on the TUI render path
  (it freezes the terminal).
- **TUI (`src/opentui/`):** React 19 + `@opentui/react`. State via zustand stores —
  no prop mutation, no DOM assumptions. Clean up keyboard handlers on unmount.
  File-edit output follows the structured `● Update` diff format with line deltas.
- **Comments:** brief, only where logic isn't self-evident. No commented-out code.
- **Naming/files:** match existing patterns (kebab-case module files like `agent-todos.ts`,
  colocated `*.test.ts`).

---

## 6. Sub-Agent Orchestration (how this product works — don't regress it)

- Sub-agent tool: **`explore_subagent`** — dispatch ONE worker with a focused,
  context-rich `prompt` + optional `focus_path`. The old blind "fan to all" tool was
  removed (vague prompts time out on big codebases). Don't reintroduce it.
- Concurrency defaults to **4** (`maxBackgroundSubAgents`, up to 16). Pool capacity is
  endpoints × per-endpoint `concurrency` (parallel prediction slots). The main agent
  synthesizes results itself.
- Sub-agents get the **full local tool set** (read/write/search/shell/git) against the
  shared workspace.
- Pool auto-discovery order (`resolveSubAgentPool`, `src/subagents.ts`): explicit
  `cfg.subagents` → `REMOTE_LMSTUDIO_URL` → local LM Studio Qwen3.5 ≤9B models
  (`isSubAgentModelId`). Discovered models each get `NANOGENT_SUBAGENT_SLOTS`
  workers (default 4, matching LM Studio's "max concurrent predictions").
  Preserve this order.
- OpenRouter sub-agents reuse `OPENROUTER_API_KEY` when the main agent uses OpenRouter.
- Default local backend: LM Studio at `http://127.0.0.1:1234/v1`. Handle unreachable/
  slow endpoints with timeouts and clear user-facing errors — never hang silently.

---

## 7. Testing & Verification

- Framework: **`bun:test`** (`bun test`). Tests are colocated (`src/foo.test.ts`) plus
  integration scripts in `tests/`.
- Add/update tests for any behavior change. Test names describe behavior, not internals.
- Verification ladder:
  1. `npm run typecheck`
  2. `bun test`
  3. `npm run lint && npm run format:check`
  4. Manual smoke: `bun run start` for TUI changes
- `tsconfig` excludes `*.test.ts` from the build — don't import test files from source.

---

## 8. Docs & Housekeeping

- If you change behavior, config keys, commands, workflows, or structure mentioned in
  this file or `README.md`, **update the docs in the same change**.
- New env vars → document + add placeholder to `.env.example`.
- Code review standards live in `docs/CODE_REVIEW_TEMPLATES.md` — use its severity
  labels (🔴 blocking / 🟡 important / 🟢 nit / 💡 suggestion) when reviewing.
- `SECURITY.md` is the canonical security documentation; keep it in sync with `src/security/`.

---

## 9. Learned User Preferences

- Primary interface is the TUI (`bun run start`), not the headless CLI.
- Main agent orchestrates sub-agents: calls `explore_subagent` one at a time (or a few in parallel, capped at 4) with a focused, context-rich prompt for each.
- Sub-agents default to OpenRouter `openrouter/free` (free router with tool calling); override with e.g. `qwen/qwen3-next-80b-a3b-instruct:free` in `~/.nanogent.json` if you want a fixed model.
- When improving local-model workflows, optimize for 8B-and-smaller models with 128k–400k context via LM Studio.
- **Recommended Local Model**: `Jackrong\Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF` for optimal performance.
- Prefers structured diff-style chat output for tool/file edits (● Update headers with line deltas).
- Attach the frontend-design skill for TUI/UI work when polishing panels and layout.
- Prefers native terminal paste (right-click / Ctrl+Shift+V) for TUI inputs including `/connect` API keys; F7 mouse capture blocks paste.
- Keep a wide OpenAI-compatible provider catalog (Azure AI Foundry cloud, Kimi Code, Alibaba Model Studio intl/CN/Coding Plan, plus other coding-agent clouds/locals). Stay on Chat Completions — no native Anthropic/Bedrock/Google SDKs. Qwen catalog models belong on DashScope, not OpenAI.
- Keep public README and shipped docs aligned with the current system, including a WIP notice that some features may be experimental or buggy.

## 10. Learned Workspace Facts

- Bun + OpenTUI agent; TUI code lives in `src/opentui/`; config at `~/.nanogent.json` or `.nanogent.json` (legacy `~/.qwen-agent.json` is still read).
- Default local backend is LM Studio at `http://127.0.0.1:1234/v1`.
- Sub-agent tool: `explore_subagent` (dispatch ONE remote Qwen with a focused `prompt` + optional `focus_path`). The blind "fan to all" tool was removed because vague prompts time out on large codebases.
- Remote sub-agents run on Qwen3.5 model(s) (≤9B, currently the 4B) in this machine's LM Studio. A single
  loaded model with N parallel prediction slots serves N workers (scheduler counts
  per-endpoint slots); LM Studio auto-links to the other device that hosts the models.
  Sub-agents hit `http://127.0.0.1:1234/v1`.
- Sub-agents get the FULL local tool set (read/write/search/shell/git) against the shared workspace, so they can actually investigate and act — not just answer prompts.
- Pool is auto-discovered: `resolveSubAgentPool` (src/subagents.ts) prefers explicit `cfg.subagents`, then `REMOTE_LMSTUDIO_URL`, then local LM Studio's `qwen3.5-2b*` models. No manual config needed.
- Main agent calls `explore_subagent` 1–3× in parallel with narrow, file-specific prompts;
  default concurrency 4 (configurable to 16 via `maxBackgroundSubAgents`). It synthesizes results itself.
- Parallel `code_review` sub-agent mode was removed; main agent crafts per-agent prompts.
- Detects loaded model size and context from LM Studio dynamically.
- OpenRouter sub-agents reuse `OPENROUTER_API_KEY` when the main agent also uses OpenRouter.
- Tests run with `bun test` (`npm test` aliases it; the suite imports `bun:test` and cannot run under plain `node --test`).
- Headless `nanogent run` supports `--yes`/`-y` (auto-approve all permissions) and `--permission-mode <mode>`; without them, permission prompts auto-deny with a stderr hint.
- MCP servers from a PROJECT-LOCAL config are NOT auto-connected (RCE/key-exfil guard). Trust = the exact global config paths in the home dir, an explicit config path, or `NANOGENT_TRUST_PROJECT_MCP=1`. Configs merge (global base + project override); `mcp` maps merge too and project-sourced servers are tracked in `cfg.mcpUntrusted` and blocked individually — global servers still connect. MCP tools use category `mcp` and are auto-allowed except in `read_only` (shell/`execute_command` still asks). Put MCP servers in `~/.nanogent.json`.
- Workspace `.env` files are UNTRUSTED: `NANOGENT_TRUST_PROJECT_MCP`, `QWEN_SECURITY_*`, `QWEN_BASE_URL`, `REMOTE_LMSTUDIO_URL`, `AZURE_OPENAI_ENDPOINT`, `HF_TOKEN`, `QWEN_FALLBACK_MODEL`, `QWEN_FALLBACK_BASE_URL`, `QWEN_FALLBACK_PROVIDER`, and `*_API_KEY` are only honored from the real process environment or the trusted home-dir `.env` — never from a project `.env`. Home `.env` wins over cwd `.env` on conflicts. `getApiKey()` likewise only reads home-dir `.env` files (`~/.qwen-agent-tui/.env` then `~/.env`).
- Project-local skills (workspace `skills/` dir, `.json` and `SKILL.md`) default to `enabled: false` — prompt-injection guard; home-dir skills keep their defaults.
- Main-loop guardrails: default `maxIterations` is 50, and the run loop breaks after 3 consecutive identical tool-call rounds (stuck-loop guard).
- Streaming requests ask for usage (`stream_options.include_usage`, plus `usage.include` on OpenRouter); API-reported usage drives compaction. Context window is resolved dynamically from the loaded runtime (LM Studio instance context / OpenRouter catalog `context_length` / other OpenAI-compat GET `/models` fields `context_length` · `max_model_len` · `max_context_length`, source `openai-compat`). Missing catalog context leaves the heuristic — never invent a smaller window. Auto-compacts at **80%** of that window (~210k on a 262k model — ~50k headroom for the summary). The original user request is pinned across compaction. Compaction summaries merge into the leading system prompt (`system-compaction`) — never as a trailing assistant turn (Bonsai/Qwen Jinja treats that as a finished response and often emits EOS). Mid-loop UI status uses `notice-*` messages excluded from the LLM payload. `enable_thinking` is on for `qwen*` and `bonsai*` model ids unless the catalog explicitly reports no thinking/reasoning. Catalog capability flags (`supportsTools` / `supportsThinking` / `supportsPromptCache`) stay undefined when unknown and do not change request shape. Tools are still sent if the catalog says no tools (warning only). Cloud prompt-cache extras (`prompt_cache_key`, stable per workspace + model) are sent only when the catalog is explicit true; local providers skip; opt out with `promptCache` / `QWEN_PROMPT_CACHE=0`. Default HTTP timeout is 600s for local providers (LM Studio/Ollama) and 120s for remote. Cloud endpoints share a per-`baseURL` limiter: leaky RPM (burst cap 2), optional in-flight cap, Retry-After cooldown that pauses main + sub-agents. Catalog defaults: OpenRouter 20/2, Groq 30/2, Cerebras 30/2, Hugging Face 15/1. Override with `maxRequestsPerMinute` / `maxConcurrentLlmRequests` or `QWEN_MAX_REQUESTS_PER_MINUTE` / `QWEN_MAX_CONCURRENT_LLM` (`QWEN_MAX_RPM` alias). Optional TPM (`maxTokensPerMinute` / `QWEN_MAX_TOKENS_PER_MINUTE`, alias `QWEN_MAX_TPM`) is opt-in with no catalog default; token-mentioned 429s drain/adapt TPM like RPM. Local providers skip pacing. `rateLimitMs` is only an agent-loop pause, not the cloud limiter. Cloud tool results are capped at 8000 tokens by default after `sanitizeOutput` (`maxToolResultTokens` / `QWEN_MAX_TOOL_RESULT_TOKENS`; 0 = off; local default off). Session `$` uses OpenRouter catalog prices or `promptPricePerMillion` / `completionPricePerMillion` (`QWEN_PROMPT_PRICE_PER_MILLION`, `QWEN_COMPLETION_PRICE_PER_MILLION`); never invent prices. `/usage` prints copy-pasteable tokens + estimated USD when known. Explicit failover (`fallbacks` in config, or `QWEN_FALLBACK_MODEL` + optional `QWEN_FALLBACK_BASE_URL` / `QWEN_FALLBACK_PROVIDER`) runs after LLM retries on 429/502/503/504/timeout/connection errors only — never invented, never on 401/403/400/abort, never reuses provider A's key for B. `explore_subagent` workers honor the same `fallbacks` worker-locally (in-memory model/baseURL/client for that run only; they do not mutate the main session or the shared pool). Named `profiles` apply live with `/profile <name>` or `nanogent run --profile`; persist with `--global` / `--local`. `/config show` and `nanogent doctor --json` include fallback + active profile when set, plus resolved context source and known capability flags. On LM Studio, a placeholder configured id (`model-identifier`, the default) resolves to the currently loaded model for doctor/enrich (in-memory only; not written to disk). A real configured id that exists in the catalog is not replaced by a different loaded model. Doctor JSON then reports `model` as the resolved id, `configured_model` when it differs, and a short warning.
- `dist/` is gitignored (`npm run build` / `prepack`). `scripts/run-nanoagent.mjs` is the `nanoagent`/`nanogent` bin: a git checkout with bun runs `src/main.ts` (same as `bun run start`); `.deb` / Windows zip / npm pack have no `src/` and load `dist/main.js`. `bun.lock` is the canonical lockfile (`bun install --frozen-lockfile` must stay green for CI).
- Preferred Linux install is the amd64 `.deb` from GitHub Releases (`scripts/build-deb.sh` / `bun run package:deb`): bundles Node 20 + linux-x64 `node_modules` under `/usr/lib/nanoagent`, wrappers at `/usr/bin/nanogent` and `/usr/bin/nanoagent` → `scripts/run-nanoagent.mjs`. Windows: portable zip (`scripts/build-windows.mjs` / `bun run package:win`); run `nanogent.cmd`. Can be built on Linux via `npm install --os=win32 --cpu=x64`.
- Do not commit `.deb-stage/`, `.deb-cache/`, `.win-stage/`, `.win-cache/`, or `dist-packages/*`. npm and native GitHub Release assets are published by the Release workflow when an annotated `v*` tag is pushed.
