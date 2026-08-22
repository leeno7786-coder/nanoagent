# Code Review Templates & Checklists

Tailored for **nanoagent** — Bun + TypeScript (ESM) + OpenTUI coding agent.
Based on the `code-review-excellence` skill methodology.

---

## Severity Labels

Use these prefixes on every review comment:

| Label | Meaning | Merge impact |
|---|---|---|
| 🔴 `[blocking]` | Must fix — bug, security hole, broken behavior | Blocks merge |
| 🟡 `[important]` | Should fix — discuss if you disagree | Blocks unless justified |
| 🟢 `[nit]` | Nice to have — naming, style, small cleanup | Non-blocking |
| 💡 `[suggestion]` | Alternative approach to consider | Non-blocking |
| 📚 `[learning]` | Educational, no action needed | Non-blocking |
| 🎉 `[praise]` | Good work worth calling out | — |

---

## PR Review Comment Template

```markdown
## Summary
[One paragraph: what this PR does, what I reviewed]

## Strengths
- [What was done well]
- [Good patterns or approaches]

## Required Changes
🔴 [Blocking issue — file:line, why it breaks, suggested fix]

## Suggestions
💡 [Improvement with brief rationale]
🟢 [nit] [Small polish item]

## Questions
❓ [Clarification needed on X]

## Verdict
✅ Approve | 💬 Approve with comments | 🔄 Request changes
```

---

## Review Process (per PR)

1. **Context (2–3 min)** — Read PR description; check size (>400 lines → ask to split); CI green?
2. **High-level (5–10 min)** — Does the approach fit? Consistent with existing patterns? Right files touched?
3. **Line-by-line (10–20 min)** — Logic, security, performance, maintainability (checklists below).
4. **Summary (2–3 min)** — Decision + offer to pair on complex issues.

---

## General Checklist (every PR)

### Correctness
- [ ] Edge cases handled (empty arrays, null/undefined, zero, large inputs)
- [ ] No off-by-one errors in loops/slices
- [ ] Async errors caught and surfaced (no unhandled promise rejections)
- [ ] No race conditions in shared state (zustand stores, agent loop state)

### Security
- [ ] No hardcoded secrets / API keys (use env vars or `~/.nanogent.json`)
- [ ] User/LLM-supplied input validated before use in shell commands or file paths
- [ ] No `eval` / dynamic `Function()` on untrusted input
- [ ] Error messages don't leak keys, tokens, or full filesystem paths to the model
- [ ] New dependencies justified and from trusted sources

### Maintainability
- [ ] No `any` types (use proper interfaces from `src/types.ts`)
- [ ] Functions do one thing; complex logic has brief comments
- [ ] Minimal diff — no unrelated refactors or reformatting
- [ ] Follows existing code style (prettier-clean: `npm run format:check`)

### Tests
- [ ] Tests added/updated for behavior changes
- [ ] Tests use `bun:test` imports (suite **cannot** run under `node --test`)
- [ ] Test names describe behavior, not implementation
- [ ] `bun test` passes locally; `npm run ci` is green

---

## Project-Specific Checklists

### 🤖 Agent loop / tools (`src/agent*.ts`, `src/agent-tools/`, `src/tools/`)
- [ ] Tool schemas have clear, small-model-friendly descriptions (optimize for ≤8B local models)
- [ ] Tool execution validates args before touching the filesystem/shell
- [ ] Write/exec tools respect the permission/approval system (`read_only` mode still asks for shell)
- [ ] Errors return structured tool-error messages (not thrown exceptions that kill the loop)
- [ ] No unbounded loops — max-iteration guards intact
- [ ] New tools registered in the tool registry with the right category (`mcp` category auto-allowed except `read_only`)

### 🔌 MCP (`src/mcp/`)
- [ ] Project-local MCP configs are **not** auto-connected (RCE/key-exfil guard) — trust only via global home config, explicit path, or `NANOGENT_TRUST_PROJECT_MCP=1`
- [ ] MCP tool results sanitized before entering model context (no secret leakage)
- [ ] Server lifecycle cleaned up (no leaked child processes on shutdown)

### 🧠 LLM / providers / subagents (`src/llm*.ts`, `src/providers*.ts`, `src/subagents*.ts`)
- [ ] Sub-agent dispatch stays focused (narrow, file-specific prompts; concurrency capped at 4)
- [ ] Pool resolution order preserved: explicit `cfg.subagents` → `REMOTE_LMSTUDIO_URL` → local LM Studio `qwen3.5-2b*`
- [ ] Timeouts and retries handle slow local models (LM Studio at `http://127.0.0.1:1234/v1`)
- [ ] Token counting (tiktoken) failures degrade gracefully, not crash
- [ ] Streaming code handles partial/malformed chunks

### 🖥️ TUI (`src/opentui/`)
- [ ] React 19 + `@opentui/react` patterns — no direct DOM assumptions
- [ ] State via zustand stores, not prop-drilling or mutated props
- [ ] No blocking I/O in render paths (terminal UI freezes)
- [ ] Keyboard handlers cleaned up on unmount
- [ ] Diff/edit output follows the structured `● Update` format with line deltas

### ⚙️ Config / storage (`src/config*.ts`, `src/storage.ts`)
- [ ] Config read from `~/.nanogent.json` / `.nanogent.json` with schema validation (ajv)
- [ ] Missing/invalid config falls back to sane defaults, never crashes on startup
- [ ] Secrets in config never logged or echoed into prompts

### 📦 Build / CI / packaging
- [ ] `dist/` changes are NOT committed (built by `prepack`; gitignored)
- [ ] `bun.lock` updated via `bun install` (canonical lockfile — `bun install --frozen-lockfile` must stay green)
- [ ] `npm run typecheck` (`tsc --noEmit`) clean
- [ ] New runtime deps go in `dependencies`, not `devDependencies`; keep the package light (it's published to npm)
- [ ] Changes to workflows/skills/structures documented in `AGENTS.md` if applicable

### 📝 Docs
- [ ] README/AGENTS.md updated if behavior, config keys, or commands changed
- [ ] New env vars documented (and added to `.env.example` — never commit real `.env`)

---

## Quick Review Snippets

**Requesting a fix:**
```markdown
🔴 [blocking] `src/tools/shell.ts:42` — this interpolates LLM output directly
into the shell command. A crafted model response could run arbitrary commands.
Please pass args as an array / validate against an allowlist instead.
```

**Suggesting an alternative:**
```markdown
💡 [suggestion] This retry loop could reuse the backoff helper in
`src/agent-utils.ts` instead of reimplementing it. What do you think?
```

**Asking instead of telling:**
```markdown
❓ What happens here if LM Studio is unreachable — does the agent loop
surface a clear error to the user, or hang waiting on the socket?
```

**Praising:**
```markdown
🎉 [praise] Nice — validating the tool args at the schema level catches
bad small-model output before it hits the filesystem.
```
