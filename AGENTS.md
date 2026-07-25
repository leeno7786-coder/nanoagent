## Learned User Preferences

- Primary interface is the TUI (`bun run start`), not the headless CLI.
- Main agent orchestrates sub-agents: calls `explore_subagent` one at a time (or a few in parallel, capped at 3) with a focused, context-rich prompt for each.
- Sub-agents default to OpenRouter `openrouter/free` (free router with tool calling); override with e.g. `qwen/qwen3-next-80b-a3b-instruct:free` in `~/.nanogent.json` if you want a fixed model.
- When improving local-model workflows, optimize for 8B-and-smaller models with 128k–400k context via LM Studio.
- **Recommended Local Model**: `Jackrong\Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF` for optimal performance.
- Prefers structured diff-style chat output for tool/file edits (● Update headers with line deltas).
- Attach the frontend-design skill for TUI/UI work when polishing panels and layout.

## Learned Workspace Facts

- Bun + OpenTUI agent; TUI code lives in `src/opentui/`; config at `~/.nanogent.json` or `.nanogent.json`.
- Default local backend is LM Studio at `http://127.0.0.1:1234/v1`.
- Sub-agent tool: `explore_subagent` (dispatch ONE remote Qwen with a focused `prompt` + optional `focus_path`). The blind "fan to all" tool was removed because vague prompts time out on large codebases.
- Remote sub-agents run on the 3 Qwen3.5-2B models loaded in this machine's LM Studio (`qwen3.5-2b`, `qwen3.5-2b:2`, `qwen3.5-2b:3`). LM Studio auto-links to the other device that actually hosts the models; sub-agents hit `http://127.0.0.1:1234/v1`.
- Sub-agents get the FULL local tool set (read/write/search/shell/git) against the shared workspace, so they can actually investigate and act — not just answer prompts.
- Pool is auto-discovered: `resolveSubAgentPool` (src/subagents.ts) prefers explicit `cfg.subagents`, then `REMOTE_LMSTUDIO_URL`, then local LM Studio's `qwen3.5-2b*` models. No manual config needed.
- Main agent calls `explore_subagent` 1–3× in parallel with narrow, file-specific prompts; concurrency capped at 3. It synthesizes results itself.
- Parallel `code_review` sub-agent mode was removed; main agent crafts per-agent prompts.
- Detects loaded model size and context from LM Studio dynamically.
- OpenRouter sub-agents reuse `OPENROUTER_API_KEY` when the main agent also uses OpenRouter.
