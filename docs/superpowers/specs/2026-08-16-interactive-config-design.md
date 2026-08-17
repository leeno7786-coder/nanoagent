# Interactive `/config` overlay (full user-facing scalars)

**Date:** 2026-08-16  
**Status:** Draft (awaiting user review)  
**Branch:** `feat/settings-effort`

This spec extends `docs/superpowers/specs/2026-08-16-settings-effort-design.md`. Effort mapping, `/effort`, global persist, and the overlay shell are already implemented. This change replaces the **short** overlay catalog with a **sectioned** catalog of all user-facing scalar config keys, and makes bare `/config` open that overlay.

## Problem

`/settings` only exposes nine keys. `/config` dumps a markdown summary into chat. Users want to inspect and change the live config from inside the TUI without memorizing `/config set key val --global`.

## Goals

1. Bare `/config` and `/settings` open the **same** overlay: a scrollable, sectioned list of user-facing scalar keys.
2. Every listed change persists **immediately** to `~/.nanogent.json` and applies via `agent.reconfigure`.
3. `/config show` and `/config set key val [--global]` remain as text commands (headless + small-model friendly).
4. Nested maps, secrets, runtime catalog flags, and security-layer toggles stay out of the overlay.

## Non-goals

- A raw JSON editor.
- Nested editors for `mcp`, `profiles`, `fallbacks`, `permissionRules`, `subagents` (keep `/mcp`, `/profile`, `/connect`, `/config set`).
- Editing `apiKey` / `subAgentApiKey` in the overlay (keep `/connect`).
- Changing `workspace` here (keep `/cd`).
- Weakening `securityEnabled` / `securityValidate*` from the TUI.
- Mouse-capture row clicking (keyboard-first; F7 still blocks paste).
- Changing Chat Completions / effort request mapping (already shipped on this branch).

## Decisions (locked)

| Topic | Choice |
|---|---|
| Entry | Bare `/config` and `/settings` open the overlay |
| `/config show` / `/config set` | Keep as text commands |
| Layout | One scrollable list with non-selectable section headers |
| Persist | Global immediately (`saveConfigFile(..., 'global')` then `reconfigure`) |
| Scope | User-facing scalars only (catalog below) |

## Catalog

Section headers are labels only. Up/down skips them.

### Model

| Key | Mode | Notes |
|---|---|---|
| `provider` | edit | string |
| `baseURL` | edit | must be a valid URL |
| `model` | edit | non-empty; changing model clears catalog capability flags (already implemented) |
| `temperature` | edit | 0–2 |
| `maxTokens` | edit | non-negative integer |
| `effort` | cycle | `none\|low\|medium\|high\|extra-high` |
| `promptCache` | cycle | boolean; unset displays `auto` |
| `smallModelMode` | cycle | boolean |
| `timeout` | edit | 1000–900000 ms (`validateConfig`) |
| `retryCount` | edit | 0–10 |

### Limits

| Key | Mode | Bounds |
|---|---|---|
| `maxIterations` | edit | 0–10000 |
| `maxToolRoundsBeforeCheckin` | edit | non-negative integer |
| `maxReasoningOnlyRounds` | edit | 1–50 |
| `rateLimitMs` | edit | non-negative integer |
| `maxRequestsPerMinute` | edit | 0–10000 |
| `maxConcurrentLlmRequests` | edit | 0–100 |
| `maxTokensPerMinute` | edit | 0–10000000 |
| `maxToolResultTokens` | edit | 0–1000000 |
| `promptPricePerMillion` | edit | 0–10000 |
| `completionPricePerMillion` | edit | 0–10000 |

### Permissions

| Key | Mode | Notes |
|---|---|---|
| `permissionMode` | cycle | `read_only\|ask\|allow_edits\|always_allow` |

### Context

| Key | Mode | Bounds |
|---|---|---|
| `contextManagementEnabled` | cycle | boolean |
| `contextCompactThreshold` | edit | 0–1 |
| `contextSummaryReservedPercent` | edit | 0–1 |
| `contextKeepCount` | edit | 1–100 |
| `contextMaxHistoryTokens` | edit | 100–1000000 |

### Tools

| Key | Mode | Bounds |
|---|---|---|
| `toolCacheEnabled` | cycle | boolean |
| `toolCacheTtlMs` | edit | 0–300000 |
| `toolCacheMaxSize` | edit | 1–10000 |
| `commandTimeoutSeconds` | edit | non-negative integer |

### Sub-agents

| Key | Mode | Bounds |
|---|---|---|
| `subAgentModel` | edit | string |
| `subAgentBaseURL` | edit | valid URL if non-empty |
| `maxBackgroundSubAgents` | edit | 1–16 (warning range in validate; overlay treats 1–16 as the allowed set) |

### UI

| Key | Mode | Notes |
|---|---|---|
| `theme` | cycle | keys of `THEMES` |

### Out of the overlay

- Secrets: `apiKey`, `subAgentApiKey`
- Workspace: `workspace` (`/cd`)
- Nested: `mcp`, `profiles`, `fallbacks`, `permissionRules`, `allowedPaths`, `subagents`, `securityAllowedPaths`, `securityBlockedPaths`
- Runtime/catalog: `supportsTools`, `supportsThinking`, `supportsReasoningEffort`, `supportsPromptCache`, `modelContextLength`, `modelMaxContextLength`, `modelParamBillions`, `modelRuntimeSource`, `configFilePath`, `configPathExplicit`, `mcpUntrusted`, `subAgentEnabled`, `profile`
- Managers: `permissionManager`, `securityManager`
- Security layer: `securityEnabled`, `securityValidateCommands`, `securityValidateFileAccess`, `securitySanitizeOutput`, `securityMaxFileSize`, `securityMaxBatchFiles`
- Long text: `systemPrompt` (still `/config set`)

## Interaction

- Keys: up/down move among rows (skip headers); left/right cycle; Enter starts edit or cycles; Esc cancels edit or closes.
- Footer notice: `Saved <key>=<value> to <actual path>` or `Error: …`. Use the path returned by `persistGlobalSetting`.
- Invalid edit: structured error, stay on the row, do not persist, previous value remains.
- Overlay title: `Config`. Short labels (same style as today’s `Effort`, `RPM`, `Temp`).
- Status bar still shows current effort.

## Architecture

- `src/opentui/settings.ts`: replace the flat `SETTINGS_ROWS` list with `SETTINGS_SECTIONS` (header + rows). Keep `cycleSettingsValue`, `applySettingsPatch`, `displaySettingsValue`, `persistGlobalSetting`. Extend parse/cycle/bounds to the new keys. Navigation helper: `nextSelectableIndex(items, current, delta)`.
- `src/opentui/settings-overlay.tsx`: render headers + rows; reuse keyboard + persist.
- `src/opentui/slash-commands/index.ts`: bare `/config` (no args) calls `setOverlay('settings')`. `/config show` and `/config set` unchanged.
- Help + command dropdown: `/config` opens the live panel; `/settings` is an alias; `/config show` prints; `/config set` writes a file.
- README / AGENTS.md: one-sentence update. Do not regress effort mapping docs.

## Testing

Renderer-free unit tests in `src/opentui/settings-overlay.test.ts`:

- Every catalog key appears once; excluded keys do not.
- `nextSelectableIndex` skips headers and wraps.
- Cycle: effort, permissionMode, booleans, theme.
- `applySettingsPatch` rejects out-of-range numbers using `validateConfig` bounds.
- URL keys reject invalid URLs.

Slash tests:

- Bare `/config` opens overlay (`setOverlay('settings')`).
- `/config show` still includes Effort and does not open the overlay.
- `/config set` still writes a local file when `--global` is omitted.

## Docs

- README command table: `/config` opens the panel; `/config show`; `/config set`.
- Help overlay: same three lines.
- AGENTS.md: `/config` and `/settings` open the live scalar overlay and persist globally; nested MCP/profiles stay on their commands.
