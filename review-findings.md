# Code Review Findings — CWD Diff

**Date:** 2026-05-20  
**Scope:** 18 changed files across `src/agent.ts`, `src/llm.ts`, `src/opentui/app.tsx`, `src/security/`, `src/tools/`, `src/cli/`, `src/config.ts`, `src/types.ts`, and test files.

---

## Critical

No blocking security or correctness bugs were found in the diff.

---

## High

### H1. `checkAndAutoCompact` async change — potential race with `setInterval`
**File:** `src/opentui/app.tsx`  
**Line:** ~340

The function was changed from synchronous to `async`, but it's called in a `setInterval` callback without `await`:

```ts
compactTimerRef.current = setInterval(() => {
  if (agentRef.current) {
    checkAndAutoCompact(agentRef.current, setMessages);
  }
```

The `await` inside `checkAndAutoCompact` is fire-and-forget here. If compaction takes longer than the interval, multiple concurrent compactions could run. While `compactContextIfNeeded` is idempotent, this is a latent race condition.

**Fix:** Either `await` the call (requires making the interval callback async, which `setInterval` doesn't support natively) or add a guard flag (`isCompacting`) to prevent overlapping invocations.

---

### H2. `sleepWithSignal` — potential timer leak on abort
**File:** `src/llm.ts`

When `sleepWithSignal` is aborted, the `onAbort` handler calls `reject(new Error('Aborted'))`, but the `setTimeout` timer is cleared. However, if the signal is aborted *after* the timer fires but *before* the promise resolves, the `resolve` call will still succeed. The `sleepWithSignal` function checks `signal?.aborted` at the start, which handles the already-aborted case, but the race window between timer expiry and resolve is a concern.

**Fix:** Consider using `AbortSignal.timeout()` (Node.js 20+) or a more robust abortable sleep primitive.

---

### H3. `calculateBackoffDelay` jitter formula can return 0 in edge cases
**File:** `src/llm.ts`

The jitter calculation:
```ts
const jitter = Math.floor(Math.random() * (exponential - baseMs / 2) + baseMs / 2);
```
When `exponential` is very close to `baseMs / 2`, the range `(exponential - baseMs / 2)` approaches 0, and `Math.floor(Math.random() * 0 + baseMs / 2)` could return `baseMs / 2` or lower. For `baseMs = 1000`, the minimum is 500ms, which is acceptable but the formula is fragile.

**Fix:** Use a simpler, well-tested jitter formula: `Math.floor(Math.random() * exponential) + 1`.

---

### H4. `executeToolsParallel` — redundant permission re-check branch is dead code
**File:** `src/agent.ts` (~line 1415)

In the parallel execution path, when `decision === undefined` (no `onPermissionRequest` handler), the code re-calls `checkPermission` and denies if the tool isn't allowed and doesn't require confirmation. However, the sequential resolution phase already adds `'deny'` to `permissionResults` for non-allowed tools when `onPermissionRequest` is not set. This makes the `decision === undefined` branch unreachable for those tools.

**Fix:** Remove the dead branch or add a comment explaining the intended behavior.

---

### H5. `endpointRateLimitedUntil` Map grows unboundedly
**File:** `src/llm.ts`

The `endpointRateLimitedUntil` Map stores entries per base URL but never cleans them up. Over time, if many different base URLs are used (e.g., in sub-agents with different endpoints), this Map will grow without bound.

**Fix:** Add periodic cleanup of expired entries, or use a TTL-based map.

---

### H6. `getBackgroundSubAgents` is a thin wrapper that adds no value
**File:** `src/agent.ts`

```ts
getBackgroundSubAgents() {
  return this.getSubAgentSnapshot();
}
```

This method is a no-op alias that creates confusion about which method to use.

**Fix:** Remove `getBackgroundSubAgents` and use `getSubAgentSnapshot` directly, or document the distinction.

---

### H7. `maxToolRoundsBeforeCheckin` default of 12 may be too high
**File:** `src/agent.ts`, `src/config.ts`

The default of 12 continuous tool rounds before a user check-in means the agent can execute 12 tool calls without any user interaction. For complex tasks this is reasonable, but it could lead to long stretches of autonomous execution before the user is consulted.

**Fix:** Consider a lower default (e.g., 5–6) or make the default configurable with a clearer description.

---

## Medium

### M1. `/permissions` command handler is ~130 lines in `app.tsx`
**File:** `src/opentui/app.tsx` (~line 1540)

The permission management command handler is a large inline switch block that should be extracted into a separate function or component file for readability and testability.

**Fix:** Extract to `src/opentui/permissions-handler.tsx` or a helper function.

---

### M2. Permission request UI is rendered inline in the main layout
**File:** `src/opentui/app.tsx` (~line 1910)

The permission request banner is rendered inline in the main flex layout, which means it takes up space in the chat area and may push content down. A modal or overlay pattern would be less disruptive.

**Fix:** Consider rendering the permission banner as an overlay/modal above the chat.

---

### M3. `totalPages` is recalculated on every render
**File:** `src/opentui/chat-screen.tsx`

```ts
const totalPages = paginated ? Math.max(1, Math.ceil(displayMessageCount / MESSAGES_PER_PAGE)) : 1;
```

This is derived state that should be memoized with `useMemo` to avoid unnecessary recalculations.

**Fix:** Wrap in `useMemo(() => ..., [paginated, displayMessageCount])`.

---

### M4. `execute_command` timeout cap is 1200s (20 minutes)
**File:** `src/tools/index.ts`

```ts
const userTimeout = typeof args.timeout === 'number' && args.timeout > 0 ? Math.min(args.timeout, 1200) : defaultTimeout;
```

A 20-minute timeout for user-specified timeouts is very generous. Combined with the 600s default for downloads, a user could theoretically hold a process for 20 minutes.

**Fix:** Lower the cap to 300s (5 minutes) or document the rationale for the 20-minute cap.

---

### M5. `shouldRetry` allows retry on 400 with `attempt < 2`
**File:** `src/llm.ts`

```ts
if (status === 400 && attempt !== undefined && attempt < 2) return true;
```

Retrying a 400 (Bad Request) is generally a bad idea — it will likely fail the same way. The comment says "Some providers return transient 400s under load" but this is an unusual pattern that could mask real client errors.

**Fix:** Remove the 400 retry logic, or add a specific list of transient 400 sub-codes that are safe to retry.

---

### M6. `permissionMode` and `permissionRules` are passed through `Config` but also stored in `SecurityConfig`
**File:** `src/types.ts`, `src/security/index.ts`

The permission configuration is duplicated across `Config` (top-level) and `SecurityConfig` (nested). This creates two places to update when adding new permission fields.

**Fix:** Consider consolidating permission config into a single location, or ensure `SecurityConfig` is the single source of truth and `Config` references it.

---

## Low

### L1. `MAX_REASONING_ONLY` constant moved to module level and increased from 3 to 5
**File:** `src/agent.ts`

The constant was moved from inside the `run()` method to a module-level constant and increased from 3 to 5. This is a behavioral change that allows more reasoning-only loops before erroring.

**Fix:** Document the rationale for the increase in a comment.

---

### L2. `checkAndCompactContext` changed from `private` to `public`
**File:** `src/agent.ts`

Making this method public increases the API surface. It was already accessible from within the class; making it public allows external callers.

**Fix:** This is acceptable given the `checkAndAutoCompact` use case, but consider whether a public `compactContextIfNeeded()` wrapper (already added) is sufficient.

---

### L3. `abortControllerRef` is not reset when a permission request is denied via Escape
**File:** `src/opentui/app.tsx`

When a permission request is pending and the user presses Escape, the permission is denied but the abort controller is not reset. This is fine because the abort controller is only used for the current `agent.run()` call, but it could be confusing if the user expects the controller to be cleared.

---

### L4. `TodoPage` is imported but the `todo` overlay is new
**File:** `src/opentui/app.tsx`

The `TodoPage` component is imported and used for the new `todo` overlay, but the existing `TodoSidebar` and new `TodoPage` serve different purposes. This is a good separation but adds a new file to maintain.

---

### L5. `store.test.ts` wraps `copyToClipboard` in try/catch
**File:** `src/store.test.ts`

This is a reasonable change for headless test environments where `copyToClipboard` may not be available. No action needed.

---

## Summary

| Severity | Count | Key Areas |
|----------|-------|-----------|
| Critical | 0 | — |
| High | 7 | Race conditions in async compaction, timer leaks, dead code, unbounded Map growth |
| Medium | 6 | Code organization, inline UI, recalculation, timeout caps, retry-on-400, config duplication |
| Low | 5 | API surface changes, behavioral tuning, minor cleanup |

### Positive Observations

- The permission system design is sound with its mode + rules + explicit command-level checks.
- The sequential-then-parallel permission resolution in `executeToolsParallel` correctly avoids overlapping UI state.
- The rate-limit backoff with endpoint tracking is a meaningful improvement over the previous simple retry loop.
- The check-in mechanism (`consecutiveToolRounds`) is a good UX pattern for long-running agent tasks.
- The `sleepWithSignal` helper properly respects `AbortSignal` and cleans up timers.
- The `calculateBackoffDelay` function with explicit `Retry-After` header support is well-implemented.
