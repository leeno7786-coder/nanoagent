# In-TUI settings overlay and thinking effort

**Date:** 2026-08-16  
**Status:** Draft (awaiting user review)  
**Branch target:** `main`

## Problem

Users need to change live NanoAgent settings from inside the TUI and persist them globally. Thinking is currently binary (`enable_thinking` on for `qwen*` / `bonsai*` unless the catalog says false). There is no user-facing effort ladder, and `/config set … --global` is easy to miss.

## Goals

1. One config key, `effort`, with values `none | low | medium | high | extra-high` (default **`low`**).
2. Change settings **while in the TUI** via a `/settings` overlay **and** `/effort` (plus existing `/config set`).
3. Persist immediately to **`~/.nanogent.json`** (global) and apply live via `agent.reconfigure`.
4. Map `effort` onto Chat Completions extras only — no Anthropic/Bedrock/Google SDKs.
5. Stay small-model friendly: short commands, short overlay labels, structured errors.

## Non-goals (v1)

- Per-workspace effort unless the user later uses `/config set effort …` without `--global` (local file). Overlay and `/effort` always write **global**.
- Native thinking APIs (Anthropic `budget_tokens`, Bedrock, Gemini native).
- A full JSON editor for every `Config` key.
- Auto-raising effort when a model looks “smart.”
- Changing MCP trust, security defaults, or tool schemas.

## Decisions (locked)

| Topic | Choice |
|---|---|
| UX | Overlay **and** slash (`/effort`, `/settings`) |
| Overlay contents | Short list: effort, model, temperature, max tokens, permission mode, RPM, TPM, tool-result cap, prompt cache |
| Persist | Global immediately (`~/.nanogent.json`) |
| Default effort | `low` |

## Config

- `Config.effort?: EffortLevel` where `EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'extra-high'`.
- Unset in file → default `low` at load time (same as other defaults).
- Env: `QWEN_EFFORT`. File wins over env. Invalid env is logged, not applied (same pattern as RPM).
- Aliases accepted on input only: `xhigh`, `extra`, `extrahigh`, `extra_high` → `extra-high`.
- `ModelProfile` may include `effort`. Applying a profile overwrites session + persists if the user already uses `--global` on `/profile`; `/settings` and `/effort` persist global themselves.
- `/config show` and `nanogent doctor --json` include `effort`.
- `.env.example`, README, and AGENTS.md learned facts updated in the same change.

## Request mapping (`src/llm/request.ts`)

Stay on Chat Completions. Never invent a smaller context window. Never send thinking extras when `supportsThinking === false`.

| Effort | `reasoning_effort` (when catalog/OpenRouter `supported_parameters` includes it, or OpenAI-compat cloud that already documents the field) | `enable_thinking` |
|---|---|---|
| `none` | `"none"` if the catalog lists `reasoning_effort`; otherwise **omit** | **omit** |
| `low` | `"low"` | `true` if thinking is otherwise allowed (today’s qwen/bonsai rule or `supportsThinking === true`) |
| `medium` | `"medium"` | same as `low` |
| `high` | `"high"` | same as `low` |
| `extra-high` | `"xhigh"` | same as `low` |

Rules:

- Local providers (`isLocalProvider`): do **not** send `reasoning_effort` (unknown local servers ignore or 400). Only `enable_thinking` on/off as above.
- Unknown catalog + non-qwen/bonsai + not explicit `supportsThinking`: do not add `enable_thinking` (keep today’s heuristic). `reasoning_effort` only when the catalog is explicit.
- `effort: none` wins over the qwen/bonsai default: no thinking extras.
- Do not send both conflicting signals (e.g. `enable_thinking: false` plus `reasoning_effort: high`).

## TUI

### `/settings` overlay

- New overlay, same stack as `/connect` / `/skills` (Esc closes, no mouse required).
- Rows: Effort, Model, Temperature, Max tokens, Permission mode, Max requests/min, Max tokens/min, Max tool-result tokens, Prompt cache.
- Effort and permission mode and prompt cache: Left/Right or Enter cycles allowed values.
- Numeric / model rows: Enter opens a one-line edit (existing input patterns); empty cancel.
- On change: `saveConfigFile({ key: value }, 'global')` then `agent.reconfigure`. Notice: `Saved effort=high to ~/.nanogent.json`.
- Command dropdown + help overlay list `/settings`.

### `/effort`

- `/effort` — print current value and allowed list.
- `/effort <level>` — set, persist global, reconfigure, short confirmation.
- Unknown level: structured error listing allowed values (no throw).

### Status bar

- Show `· low` (or the current effort) next to the model id so the live value is visible without opening the overlay.

## Data flow

1. `loadConfig` resolves `effort` (file → env → default `low`).
2. TUI `/settings` or `/effort` writes global JSON and calls `reconfigure`.
3. `buildChatCompletionsParams` reads `cfg.effort` + catalog flags and sets extras.
4. Headless `nanogent run` uses the same loaded config (no overlay).

## Errors

- Invalid effort: ignore on load (keep previous/default); slash/overlay show allowed values.
- `reconfigure` / disk write failure: keep previous in-memory value; assistant notice with the path and error. Do not crash the TUI.
- Provider 400 on `reasoning_effort`: do not silently retry with a different effort in v1; surface the API error (existing LLM error path). Follow-up if needed: omit `reasoning_effort` after one 400 for that endpoint (out of v1 unless cheap).

## Tests

- Parse/normalize effort aliases; invalid env ignored.
- `buildChatCompletionsParams`: none omits thinking; low on qwen sends `enable_thinking`; extra-high maps to `xhigh` when `reasoning_effort` is supported; local never sends `reasoning_effort`; `supportsThinking === false` omits extras.
- `/effort` and `/config show` include the value (slash-command tests).
- Overlay: cycle effort and persist global (unit-test the cycle/persist helper; no full TUI screenshot).

## Docs

- README: `effort` + `/settings` / `/effort`.
- AGENTS.md learned facts: default `low`, global persist, mapping rules.
- `.env.example`: `QWEN_EFFORT=low`.
