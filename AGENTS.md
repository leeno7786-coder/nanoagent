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

The design center is: _make small local models reliable_. When in doubt, prefer the
approach that degrades gracefully on a 2B–4B model.

---

## 2. Essential Commands

| Task                               | Command                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Run the TUI                        | `nanoagent` (single boot script = `scripts/run-nanoagent.mjs`)                 |
| Headless run                       | `nanoagent run --prompt "task" --workspace <dir>`                               |
| Tests                              | `bun test` (npm test aliases it)                                                |
| Typecheck                          | `npm run typecheck` (`tsc --noEmit`)                                            |
| Lint                               | `npm run lint`                                                                  |
| Format                             | `npm run format` / check with `npm run format:check`                            |
| Build                              | `npm run build` (tsc → `dist/`)                                                 |
| Linux `.deb` (amd64, bundled Node) | `bun run package:deb` → `dist-packages/nanoagent_<ver>_amd64.deb`               |
| Windows zip (x64, bundled Node)    | `bun run package:win` → `dist-packages/nanoagent_<ver>_win_x64.zip`             |
| Both native packages               | `bun run package:native`                                                        |
| Full CI gate                       | `npm run ci` (typecheck + lint + format:check + test + build)                   |

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
├── store.ts             # Session persistence (project .nanoagent/sessions)
├── workspace-history.ts # Touched-file history: pre-change capture, checkpoints, rollback
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
   Trust = canonical `$NANOAGENT_ROOT/config/nanogent.json`, an explicit config path, or `NANOGENT_TRUST_PROJECT_MCP=1`.
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
  endpoints × per-endpoint `concurrency` (default 1 worker per loaded 2B). The main agent
  synthesizes results itself.
- Sub-agents get the **read-only exploration tool set** against the shared workspace:
  `read_file`, `batch_read_files`, `list_dir`, `stat_path`, `find_files`,
  `map_project_tree`, `grep_search`, `search_and_view` (`SUBAGENT_TOOLS`,
  `src/subagents/worker/tool-runner.ts`). Write/shell/git are deliberately
  excluded — a remote 2B worker runs against the user's real workspace and
  `explore_subagent` is dispatched straight from the model's tool call. Widening
  that is a permissions decision, not a bug fix; keep this list and the
  tool-runner error message in sync (the message is derived from the set).
- Pool resolution is **user configuration only** (`resolveSubAgentPool`,
  `src/subagents/pool.ts`) and is **pure and synchronous** — no HTTP probe, no
  cache, no boot cost. Which model serves sub-agents, at which endpoint, with
  how many parallel lanes is a user decision made in the settings panel
  (`/settings` → Sub-agents) or in `subagents.endpoints`. Do NOT reintroduce
  runtime probing or model-id pattern matching (`qwen3.5-2b`-style regexes) to
  "auto-discover" a model — that was removed deliberately.
- **Parallel lanes, not parallel models.** One endpoint + one model + N lanes
  (`SubAgentEndpoint.concurrency`, surfaced as "Parallel lanes"). N workers run
  against that single model via the endpoint's prediction slots. An earlier
  design recruited one endpoint *per loaded model instance*, which meant the
  advertised model was a hardcoded guess and the pool size depended on what
  happened to be loaded.
- `cfg.subAgentEnabled` gates the `explore_subagent` tool — false means the tool
  is stripped from the schema *and* omitted from the system prompt. Availability
  is derived by `subAgentAvailable(cfg)` from whether the config resolves to at
  least one dispatchable endpoint, so the tool is never advertised for a pool
  that cannot run. `subAgentEnabled: false` (or `subagents.enabled: false`) is an
  explicit opt-out and always wins.
- The settings panel is the **single writer** for sub-agent config. All of
  `subAgentBaseURL` / `subAgentModel` / `subAgentApiKey` /
  `maxBackgroundSubAgents` route through `patchSubAgentEndpoint`
  (`opentui/settings.ts`), which updates the flat fields *and*
  `subagents.endpoints[0]` together. They previously diverged — Endpoint and
  Model wrote flat fields the resolver never read, so a user who filled in every
  row got an endpoint with empty `baseURL`/`model` and every dispatch failed.
  Add new sub-agent fields to that helper, never to one row alone.
- **"Fetch models"** in the Sub-agents section (`listEndpointModels`,
  `src/subagents/catalog.ts`) queries the configured endpoint — LM Studio REST
  (loaded state + context) or OpenAI-compatible `/models` — and the Model row
  then cycles that list. The row stays free-text editable so an unlisted model
  can still be typed.
- **Endpoint URLs are normalized to a `/v1` root** (`normalizeEndpointBaseURL`,
  `src/subagents/catalog.ts`) both when the panel stores them and when the pool
  resolves them. This is load-bearing: a user types the host their runtime UI
  shows (`http://127.0.0.1:1234`), and the un-normalized form posts to
  `/chat/completions` — LM Studio answers **HTTP 200** with
  `{"error":"Unexpected endpoint or method"}`, so nothing throws and the worker
  silently reports an empty response. A path already ending in `/vN` is left
  alone. `lmStudioRestBase` strips `/v1` back off, so the "Fetch models" REST
  catalog still works on a normalized URL.
- **The worker prompt is assembled, not hardcoded** (`buildWorkerSystemPrompt`,
  `src/subagents/worker/prompt.ts`) in four layers: (1) INVARIANT CORE — tool
  allowlist, grounding rules, report shape — which every real run proved
  necessary and which is therefore NOT editable away; (2) ENVIRONMENT — tunes the
  advice by endpoint kind (a small local model gets budget-thrift + "mark the
  gap" guidance; a cloud model gets a precision-first prompt); (3) SCOPE — the
  paths the caller named; (4) CUSTOM — operator instructions, appended last from
  `subagents.instructions` and/or `<NANOAGENT_ROOT>/config/subagent-instructions.md`.
  Keep new rules in the core unless they are genuinely operator-specific.
- **`explore_subagent` takes `paths: string[]`** (max 8, plus the older
  `focus_path`). Each supplied path is **expanded into a real listing** placed
  AHEAD of the root file tree (`expandScopePath`, `context-block.ts`). This fixes
  a silent failure: the root walk is depth-3 and capped at 150 files, so in a
  large repo a focused directory could be truncated away entirely — the worker
  was told to look somewhere it could not enumerate, and small models filled the
  gap with invention. Paths containing `..` are dropped, not normalized, because
  the list is injected verbatim into a prompt.
- **Grounding is reported to the calling agent.** A worker can answer on turn 1
  having read nothing; `ok` means only "the dispatch completed", so
  `formatSubAgentResults` marks those `UNGROUNDED`, counts them in `ungrounded`,
  and adds a directive to verify before citing. Observed in practice: workers
  that read nothing produced a confident table of every tool in a codebase and
  were reported as 1/1 successful. Keep "completed" and "trustworthy" separate.
- **Fan-out and lanes are INDEPENDENT knobs.** `maxBackgroundSubAgents` = fan-out,
  how many avenues the main agent may dispatch per assistant message (strategy).
  `SubAgentEndpoint.concurrency` = parallel lanes, how many workers run
  simultaneously (hardware). They were one value, so tuning lanes down for a
  small machine silently stopped the agent dispatching more than one avenue at
  all — the exact opposite of the intent. Fan-out > lanes is valid and useful:
  the extra dispatches queue and still return in the same turn. Settings rows:
  "Avenues per turn" (fan-out, `maxBackgroundSubAgents`) and "Parallel lanes"
  (`subAgentLanes` → endpoint concurrency). `lanesFor` must never fall back to
  the fan-out value, and the scheduler's global in-flight cap is total LANES.
  The per-message cap is `min(16, fan-out)` (`subAgentDispatchLimit`).
- **Queue waits must be bounded by the worker's own request budget** (was a flat
  60s). A flat timeout was only safe while nothing ever queued; with fan-out above
  lanes, a queued worker can wait longer than any single worker legitimately runs
  and would fail with "all sub-agent workers are busy".
- **Worker model size is the WORKER's, not the main session's.** `buildWorkerContext`
  derives `modelParamBillions` from `endpoint.model` and sets
  `smallModelMode` from the pool override or that classification — it must NEVER
  inherit `base.smallModelMode` / `base.modelParamBillions`, which describe a
  different model. This was hardcoded `smallModelMode: true` for months:
  `isSmallModelFromConfig` short-circuits on that flag, so EVERY sub-agent was
  classified small, `read_file` capped at `SMALL_MODEL_READ_LIMIT` (100 lines)
  instead of `LARGE_MODEL_READ_LIMIT` (2000), and workers reasoned about
  half-read files. Surfaced when a 27B worker reported its reads "came back
  truncated". A 27B sub-agent then took 1 batched read instead of 15 tool calls.
  Set `subagents.smallModelMode` only to override this deliberately.
- **Hallucination here was model capability, not prompt wording.** Measured on the
  same task/prompt/tools: `ibm/granite-4-h-tiny` fabricated a code block with a
  `#L54-L62` citation for code that does not exist; `prism-ml/bonsai-27b` (Q1_0,
  ~4GB) read the files and found a real bug. Prompt rails reduce confabulation but
  cannot create capability — if reports come back plausible and wrong, check the
  configured sub-agent model before touching the prompt.
- Pool limits (`maxIterations`, `toolBudget`, `maxTokens`, `temperature`,
  `timeoutMs`) are read off the **resolved pool** passed into
  `buildWorkerContext(endpoint, base, pool)`, never off `base.subagents` — when
  the pool came from the flat panel fields those are different objects, and
  reading the latter silently falls back to defaults.
- `REMOTE_LMSTUDIO_URL` is only a **default endpoint seed** for the panel. It
  does not enable sub-agents by itself: without a model there is nothing to
  dispatch to.
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
- Sub-agents default to loaded local LM Studio `qwen3.5-2b*` models (one worker each, up to 4 in parallel). Override with an explicit `subagents` block in `$NANOAGENT_ROOT/config/nanogent.json` if you want a fixed cloud model.
- When improving local-model workflows, optimize for 8B-and-smaller models with 128k–400k context via LM Studio.
- **Recommended Local Model**: `Jackrong\Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF` for optimal performance.
- Prefers structured diff-style chat output for tool/file edits (● Update headers with line deltas).
- Attach the frontend-design skill for TUI/UI work when polishing panels and layout.
- Prefers native terminal paste (right-click / Ctrl+Shift+V) for TUI inputs including `/connect` API keys; F7 mouse capture blocks paste.
- Keep a wide OpenAI-compatible provider catalog (Azure AI Foundry cloud, Kimi Code, Alibaba Model Studio intl/CN/Coding Plan, plus other coding-agent clouds/locals). Stay on Chat Completions — no native Anthropic/Bedrock/Google SDKs. Qwen catalog models belong on DashScope, not OpenAI.
- Keep public README and shipped docs aligned with the current system, including a WIP notice that some features may be experimental or buggy.
- Builds the Linux `.deb` on a separate Linux PC; on this Windows machine rebuild the Windows zip (`bun run package:win`) and do not rely on WSL/NTFS for `.deb` builds.

## 10. Learned Workspace Facts

- Bun + OpenTUI agent; TUI code lives in `src/opentui/`; config at `<NANOAGENT_ROOT>/config/nanogent.json`, skills at `<NANOAGENT_ROOT>/skills/`, install-global session fallback at `<NANOAGENT_ROOT>/sessions/`, logs at `<NANOAGENT_ROOT>/logs/`. Per-project history lives in `<workspace>/.nanoagent/` (snapshots, worktree, journal, sessions). There is no `~/.nanogent.json` / `~/.nanoagent.json` / `~/.qwen-agent.json` / `<cwd>/.nanogent.json` / `<cwd>/.env` — install-global state is only under `NANOAGENT_ROOT`.
- Default local backend is LM Studio at `http://127.0.0.1:1234/v1`. Local generation on this Windows PC is slow — wait a minute or more for the first token on live smokes; do not treat 60–90s of silence as a hang.
- Sub-agent tool: `explore_subagent` (dispatch ONE remote Qwen with a focused `prompt` + optional `focus_path`). The blind "fan to all" tool was removed because vague prompts time out on large codebases.
- Remote sub-agents run on loaded Qwen3.5 **2B** models in this machine's LM Studio.
  Load 4 separate 2B instances (one worker each). Sub-agents hit `http://127.0.0.1:1234/v1`.
- Sub-agents get the read-only exploration tool set (see §6 for the exact list) against the shared workspace, so they can actually investigate — not just answer prompts. Write/shell/git are excluded by design; the main agent does the mutating.
- Pool is user-configured, not discovered: `resolveSubAgentPool` (src/subagents/pool.ts) is pure and synchronous, reading `subagents.endpoints[]` or the flat panel fields written by `/settings` → Sub-agents. There is no model-id regex and no runtime probe left. `REMOTE_LMSTUDIO_URL` only seeds the endpoint field.
- Sub-agent model choice is the user's, by memory budget or cloud preference: `/settings` → Sub-agents sets Enabled / Endpoint / Fetch models / Model / API key / Parallel lanes. "Fetch models" hits LM Studio REST (loaded state + context) or OpenAI-compat `/models`; the Model row then cycles that list and stays free-text editable.
- Parallel lanes, not parallel models: N workers run through the ONE chosen model via `SubAgentEndpoint.concurrency` (1–16). On LM Studio, raise the server's max concurrent predictions to match; on a small local model more lanes costs more VRAM and each lane gets slower.
- Main agent calls `explore_subagent` in parallel with narrow, file-specific prompts;
  concurrency default 4 (configurable 1–16 via `maxBackgroundSubAgents`). It synthesizes results itself.
  The per-message cap is the configured lane count (`subAgentDispatchLimit`,
  `src/agent-tools/execute.ts`, ceiling 16); overflow is rejected immediately rather than queued —
  `explore_subagent` is parallel-safe, so extra calls otherwise queued on the scheduler for up
  to 60s each and failed with "all workers busy", stalling the whole tool round. The system
  prompt states the configured number; the tool description points at it rather than hard-coding 4.
- Parallel `code_review` sub-agent mode was removed; main agent crafts per-agent prompts.
- Detects loaded model size and context from LM Studio dynamically.
- OpenRouter sub-agents reuse `OPENROUTER_API_KEY` when the main agent also uses OpenRouter.
- Tests run with `bun test` (`npm test` aliases it; the suite imports `bun:test` and cannot run under plain `node --test`).
- Headless `nanogent run` supports `--yes`/`-y` (auto-approve all permissions) and `--permission-mode <mode>`; without them, permission prompts auto-deny with a stderr hint.
- Tools operate on the user's project directory directly — `cfg.workspace` IS the directory the user pointed at, and tool reads/writes go there. `<workspace>/.nanoagent/` is this NanoAgent workspace's own harness state (sessions, history, worktree copies) — part of this run, not an outside project folder and not a second workspace: `.nanoagent/` is appended to the project's `.gitignore` on first use, discovery/`git_status` hide it, file tools and `change_workspace` block it, and the system prompt names it so the model must not explore, cd into, or commit it. **Nothing is captured at boot** (no baseline, no tree walk, no watcher) — never add a startup scan; boot time must not depend on workspace size. Rollback history lives in `src/workspace-history.ts`: `write_file` / `edit_file` / `edit_file_lines` call `recordModelWrite` immediately before writing (pre-change content → `history/objects/<sha256>`, line in `history/journal.jsonl`); `read_file` / `batch_read_files` call `noteModelRead` (content + size/mtime); `execute_command` / `run_command` / `install_dependencies` are wrapped in `beginShellCapture` / `endShellCapture` (git repos: `git stash create` + `git diff --name-status` + one `git cat-file --batch`; always: stat-check only the read files). The user's own `!` commands pass `captureHistory: false`. A session checkpoint is written on the first journal line of a run; `/rollback` undoes back to it, `/rollback <checkpoint>` and `/rollback <file>` undo part of it, files the model created are deleted, and undone changes are never undone twice. `/snapshot` appends a checkpoint marker (instant). The model's `rollback_changes` tool (write category) calls the same `rollbackChanges`. Shell edits outside git to files the model never read are not captured. Conversation history for the project is stored as 8-hex hashes in `<workspace>/.nanoagent/sessions`; boot with `nanoagent --resume HASH` (unique prefix ok) or list with `nanoagent --sessions` / `/sessions`. Matching older `$NANOAGENT_ROOT/sessions` files are migrated once.
- MCP servers from a PROJECT-LOCAL config are NOT auto-connected (RCE/key-exfil guard). The single trusted source is `<NANOAGENT_ROOT>/config/nanogent.json`, plus an explicit `--config <path>` argument, plus `NANOGENT_TRUST_PROJECT_MCP=1` on the real environment. When `--workspace` is passed, a `<workspace>/nanogent.json` may layer MCP entries on top; project-sourced entries are tracked in `cfg.mcpUntrusted` and blocked from auto-connect. MCP tools use category `mcp` and are auto-allowed except in `read_only` (shell/`execute_command` still asks). Put MCP servers in the canonical global config.
- Workspace `.env` files are UNTRUSTED: `NANOGENT_TRUST_PROJECT_MCP`, `QWEN_SECURITY_*`, `QWEN_BASE_URL`, `REMOTE_LMSTUDIO_URL`, `AZURE_OPENAI_ENDPOINT`, `HF_TOKEN`, `QWEN_FALLBACK_MODEL`, `QWEN_FALLBACK_BASE_URL`, `QWEN_FALLBACK_PROVIDER`, and `*_API_KEY` are only honored from the real process environment or the canonical `<NANOAGENT_ROOT>/config/.env` — never from a project `.env`. `getApiKey()` only reads the canonical `.env`; there is no other read source.
- Skills are read from exactly one place: `<NANOAGENT_ROOT>/skills/`. Bundled markdown skills (`SKILL.md` with YAML frontmatter) are installed to that directory by the launcher on first run; user `.json` and `<name>/SKILL.md` skills dropped in there are auto-enabled. There is no `<cwd>/skills`, no `~/.agents/skills`, no `~/.claude/skills`, no legacy `~/.qwen-agent-tui/skills`.
- The `question` tool is a first-class clarifying picker for ambiguous user requests (missing stack, features, constraints, conflicting requirements). It opens the TUI overlay when the model calls it — not on consecutive tool rounds, stuck-loop, or API errors. If the model lists A/B/C/D in chat instead, the TUI harness promotes that quiz into a real `question` call so the overlay still opens. Headless `nanogent run` has no overlay, so that promotion is skipped. Do not use `question` to stall after `git_status`/`list_dir` on review tasks.
- **The main loop has no turn budget.** There is no `maxIterations`, no `maxRounds`, no `maxToolRoundsBeforeCheckin`, and no CLI flag for any of them (removed in v2.7.20 — they existed but nothing read them). A turn ends when the model **emits no tool calls**: that reply is the answer, and the loop stops. If the model needs a decision, it calls the `question` tool; asking in prose also ends the turn. The harness does **not** override that — there is no auto-continue, no "premature check-in" nudge, no mid-run human check-in. The only guards are liveness ones: 3 consecutive identical tool-call rounds (stuck-loop), 2 fully-duplicate rounds, 6 cumulative duplicate blocks with no mutation, reasoning-only turns (`maxReasoningOnlyRounds`, default 5 / 3 for small models), and abort. `roundCounter` is a TUI display count, not a limit. **Sub-agents are the exception** — a worker is a bounded background task with no user watching, so it keeps a hard ceiling (`pool.maxIterations`, hard-capped at 24) and a `toolBudget`.
- Duplicate `git_status` / `git_diff` / same-read calls are blocked as tool errors. Two consecutive all-duplicate rounds stop the loop with a clear message. Because that streak cannot see a round that mixes a *fresh* read with an already-blocked repeat (every round looks productive), there is also a **cumulative** backstop: 6 duplicate blocks with no mutation trips a second stop. Only a mutation clears that budget — `ToolRepeatState.invalidations` counts every baseline clear, and re-reading after an edit is legitimate progress. Do NOT reset the cumulative counter on a zero-block round; that is exactly the alternation it exists to catch. `git_diff` is `git diff HEAD` plus untracked file contents (not only unstaged tracked hunks). `read_file` without a range returns up to 2000 lines on large/cloud models (100 on ≤8B) and sets `truncated` only when content was actually cut, with `next_start_line`.
- Task-type routing (`src/task-router.ts`) classifies each user turn as `diff-review` / `codebase-review` / `coding` / `debug` / `research` / `chat` and injects focused scaffolding as a hidden `user`-role message (`scaffold-` id prefix, distinct from the `nudge-` recovery prefix, both excluded from the LLM-facing notice filter and the chat panel). It is injected **before** the user message so the real request stays most recent. Review-specific guidance (git scope, report ordering, evidence rules) lives here, NOT in the base system prompt — the base prompt is shared by every task type. `agent.test.ts` asserts no cap fields are reintroduced.
- Streaming requests ask for usage (`stream_options.include_usage`, plus `usage.include` on OpenRouter); API-reported usage drives compaction. Context window is resolved dynamically from the loaded runtime (LM Studio instance context / OpenRouter catalog `context_length` / other OpenAI-compat GET `/models` fields `context_length` · `max_model_len` · `max_context_length`, source `openai-compat`). Missing catalog context leaves the heuristic — never invent a smaller window. Auto-compacts at **80%** of that loaded window: leftover ~20% is a no-tools summary inference, then history is wiped to system prompt + original task + that handoff. Overflow / empty-`length` recovery does not compact below 80%. The original user request is pinned across compaction. Compaction summaries merge into the leading system prompt (`system-compaction`) — never as a trailing assistant turn (Bonsai/Qwen Jinja treats that as a finished response and often emits EOS). Mid-loop UI status uses `notice-*` messages excluded from the LLM payload; recovery notices (`notice-recovery-*`, duplicate-tool blocks, stuck-loop, overflow retry) are also hidden from the main chat panel. `enable_thinking` defaults on for `qwen*` and `bonsai*` model ids unless the catalog explicitly reports no thinking/reasoning; catalog `supportsThinking: true` also enables it for other model ids, while `effort: none` omits it. Catalog capability flags (`supportsTools` / `supportsThinking` / `supportsPromptCache`) stay undefined when unknown and do not change request shape. Tools are still sent if the catalog says no tools (warning only). Cloud prompt-cache extras (`prompt_cache_key`, stable per workspace + model) are sent only when the catalog is explicit true; local providers skip; opt out with `promptCache` / `QWEN_PROMPT_CACHE=0`. Default HTTP timeout is 600s for local providers (LM Studio/Ollama) and 120s for remote. Cloud endpoints share a per-`baseURL` limiter: leaky RPM (burst cap 2), optional in-flight cap, Retry-After cooldown that pauses main + sub-agents. Catalog defaults: OpenRouter 20/2, Groq 30/2, Cerebras 30/2, Hugging Face 15/1. Override with `maxRequestsPerMinute` / `maxConcurrentLlmRequests` or `QWEN_MAX_REQUESTS_PER_MINUTE` / `QWEN_MAX_CONCURRENT_LLM` (`QWEN_MAX_RPM` alias). Optional TPM (`maxTokensPerMinute` / `QWEN_MAX_TOKENS_PER_MINUTE`, alias `QWEN_MAX_TPM`) is opt-in with no catalog default; token-mentioned 429s drain/adapt TPM like RPM. Local providers skip pacing. `rateLimitMs` is only an agent-loop pause, not the cloud limiter. Cloud tool results are capped at 8000 tokens by default after `sanitizeOutput` (`maxToolResultTokens` / `QWEN_MAX_TOOL_RESULT_TOKENS`; 0 = off; local default off). Session `$` uses OpenRouter catalog prices or `promptPricePerMillion` / `completionPricePerMillion` (`QWEN_PROMPT_PRICE_PER_MILLION`, `QWEN_COMPLETION_PRICE_PER_MILLION`); never invent prices. `/usage` prints copy-pasteable tokens + estimated USD when known. Explicit failover (`fallbacks` in config, or `QWEN_FALLBACK_MODEL` + optional `QWEN_FALLBACK_BASE_URL` / `QWEN_FALLBACK_PROVIDER`) runs after LLM retries on 429/502/503/504/timeout/connection errors only — never invented, never on 401/403/400/abort, never reuses provider A's key for B. `explore_subagent` workers honor the same `fallbacks` worker-locally (in-memory model/baseURL/client for that run only; they do not mutate the main session or the shared pool). Named `profiles` apply live with `/profile <name>` or `nanogent run --profile`; persist with `--global` / `--local`. `/config show` and `nanogent doctor --json` include fallback + active profile when set, plus resolved context source and known capability flags. On LM Studio, a placeholder configured id (`model-identifier`, the default) resolves to the currently loaded model for doctor/enrich (in-memory only; not written to disk). A real configured id that exists in the catalog is not replaced by a different loaded model. Doctor JSON then reports `model` as the resolved id, `configured_model` when it differs, and a short warning. `effort` (`none|low|medium|high|extra-high`, default `low`) is set with `/effort` or `/settings` and persisted to `~/.nanogent.json`. `none` omits thinking extras even for qwen/bonsai. `reasoning_effort` goes to BOTH cloud and local endpoints. Cloud sends it only when the catalog lists the parameter (`extra-high` → `xhigh`); LM Studio / llama.cpp are always sent it, because `none` closes the thinking block and without it local thinking models ignore `/effort` entirely (local branch in `llm/request.ts`). Env: `QWEN_EFFORT` (file wins). `/config` and `/settings` open the live scalar overlay and persist globally; `/config show` and `/config set` stay as text. Nested MCP/profiles/fallbacks stay on `/mcp`, `/profile`, `/connect`.
- **Tool-call alternation is a hard Qwen/Bonsai requirement.** Their Jinja tool branch raises `Tool message must be responding to a previous tool call.` unless the message *immediately* before a `tool` message is an assistant. The OpenAI-batched shape `assistant(tool_calls=[a,b]) tool(a) tool(b)` is rejected on the **second** result, so any multi-tool round failed the whole request. `normalizeStrictChatTemplate` (`src/llm/chat-template.ts`) re-interleaves each result behind its own single-call assistant turn; it is applied to the main agent payload (`toChatMessages`) and to the sub-agent worker history before `streamChat`. It also drops tool results orphaned by compaction/session edits and strips tool calls a stopped run never answered. Internal `agent.messages` is unchanged — only the wire payload is normalized. When adding any new path that appends messages, keep this invariant: the normalizer is a safety net, not a licence to emit invalid sequences.
- `dist/` is gitignored (`npm run build` / `prepack`). `scripts/run-nanoagent.mjs` is the **single boot script** — the `nanoagent` / `nanogent` / `nano-agent` / `npx @omega3_0/nanoagent` bin: a git checkout with bun runs `src/main.ts` (same as `bun run start`); `.deb` / Windows zip / npm pack have no `src/` and load `dist/main.js`. The launcher resolves `NANOAGENT_ROOT` (env override → its own `dirname/..`), creates the canonical subdir layout (`config/`, `skills/`, `tools/`, `sessions/`, `workspace/`, `logs/`) on first run, sets `NANOAGENT_ROOT` in the child env, chdirs the child, and prints the resolved layout. The launcher prefers the bundled Bun from the `@oven/bun-*` optionalDependencies (`node_modules/@oven/...`, exec-verified) before any system bun, and falls back to plain Node. There is no network postinstall. `bun.lock` is the canonical lockfile (`bun install --frozen-lockfile` must stay green for CI).
- `src/main.ts` refuses to run unless `NANOAGENT_ROOT` is set in the environment. Trying to `bun src/main.ts` directly throws. The launcher (`scripts/run-nanoagent.mjs`) is the only supported entry point.
- `src/config/paths.ts` is the single source of truth for filesystem paths. `installRoot()` reads `NANOAGENT_ROOT` (no `NANOAGENT_HOME` fallback, no homedir/APPDATA/cwd/legacy lookup) and throws on missing canonical subdirs. All consumers use `GLOBAL_CONFIG_FILE()`, `SKILLS_DIR()`, `SESSIONS_DIR()`, etc. — no `configDir()` / `legacyConfigDir()` / `configFileCandidates()` (gone).
- Preferred Linux install is the amd64 `.deb` from GitHub Releases (`scripts/build-deb.sh` / `bun run package:deb`): bundles Node 20 + linux-x64 `node_modules` (including the `@oven/bun-linux-x64` runtime the TUI needs — the build fails if it is missing) under `/usr/lib/nanoagent`, wrappers at `/usr/bin/nanogent` and `/usr/bin/nanoagent` → `scripts/run-nanoagent.mjs`. Windows: portable zip (`scripts/build-windows.mjs` / `bun run package:win`); run `nanogent.cmd`. Can be built on Linux via `npm install --os=win32 --cpu=x64`.
- Do not commit `.deb-stage/`, `.deb-cache/`, `.win-stage/`, `.win-cache/`, or `dist-packages/*`. npm and native GitHub Release assets are published by the Release workflow when an annotated `v*` tag is pushed.
