# ⚡ NanoAgent (`nanoagent`)

```text
  _  _                 _                    _   
 | \| |__ _ _ _  ___  /_\  __ _ ___ _ _ | |_ 
 | .` / _` | ' \/ _ \/ _ \/ _` / -_) ' \|  _|
 |_|\_\__,_|_||_\___/_/ \_\__, \___|_||_|\__|
                          |___/              
      ⚡ NanoAgent — Tiny Models, Scalable Intelligence ⚡
```

An ultra-lightweight, scalable CLI/TUI coding agent built from the ground up to empower **tiny local models** (2B–8B parameter models like Qwen 2.5/3.5, Phi-3, Llama 3) while scaling seamlessly to cloud APIs (OpenAI, Anthropic, OpenRouter). Run locally, think globally.

---

## 🌟 Key Features

- **⚡ Instant Execution**: Launch directly by typing `nanoagent` (or `nanogent`, `npx nanoagent`, `nano-agent`).
- **🎯 Tiny-Model First Optimization**: Specialized prompt formatting, compact token management, and small-model tool calling resilience.
- **🖥️ Rich OpenTUI Terminal Interface**: Full-screen interactive dashboard featuring real-time response streaming, tool diff views, task sidebars, and keyboard overlays.
- **⚙️ Dynamic Dual-Level Configuration**: Global defaults in `~/.nanogent.json` merge with per-project overrides in `.nanogent.json` (project keys win; MCP servers merge with per-server trust). Editable directly in the TUI using `/config` and `/set` slash commands.
- **🤖 Autonomous Sub-Agent Swarm**: Dispatches multi-agent codebase exploration and search tasks concurrently to worker models.
- **🛡️ Enterprise Security Hardening**: Built-in command validation, workspace path sandboxing, and automatic secret/API-key redaction.
- **🔌 Model Context Protocol (MCP)**: Native MCP integration to connect filesystem servers, web search engines, and remote API tools.
- **🧠 Codebase Memory Graph**: Build, query, and generate deep analysis reports on codebase architecture (`/graph`).

---

## 🚀 Quick Start & Installation

### Option 1: Install Globally via NPM (Recommended)
Run this single command on any machine:
```bash
npm install -g @omega3_0/nanoagent
```

### Option 2: Direct GitHub One-Liner Install
Install directly from the GitHub repository on any PC:
```bash
npm install -g https://github.com/leeno7786-coder/nanoagent.git
```

### Option 3: Zero-Install via `npx`
```bash
npx @omega3_0/nanoagent
```

### Option 4: Build & Link from Source
```bash
git clone https://github.com/leeno7786-coder/nanoagent.git
cd qwen-agent-tui
npm install
npm run build
npm link --force
```

---

## ⚡ Launch Command (`nanoagent`)

Once installed, launch NanoAgent from **any directory or terminal window** on your machine using the single command word:

```bash
nanoagent
```

### CLI Command Options
- **`nanoagent`** — Launch interactive TUI coding session in your current directory
- **`nanoagent tui`** — Force interactive TUI mode
- **`nanoagent run --prompt "your task"`** — Run headless non-interactive task
- **`nanoagent models`** — List available local & remote LLM models
- **`nanoagent doctor`** — Run environment & runtime health check

---

## 💻 Recommended Local Model Setup

NanoAgent is designed to deliver maximum coding performance with small local LLM runtimes:

- **Recommended Local Model**: `Jackrong\Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF`
- **Recommended Local Runtime**: LM Studio (`http://127.0.0.1:1234/v1`) or Ollama (`http://127.0.0.1:11434/v1`)

> **Multi-Agent Local Pooling**: When running LM Studio, NanoAgent auto-detects additional small loaded models (`qwen3.5-2b`, etc.) to automatically populate an exploration sub-agent pool.

---

## ⚙️ Configuration (`.nanogent.json`)

Configuration is stored in `.nanogent.json` (workspace) or `~/.nanogent.json` (global user defaults):

```json
{
  "model": "Jackrong/Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF",
  "baseURL": "http://127.0.0.1:1234/v1",
  "workspace": "./",
  "subAgentEnabled": true,
  "maxBackgroundSubAgents": 4,
  "securityEnabled": true,
  "securityValidateCommands": true,
  "securitySanitizeOutput": true
}
```

### Interactive Config Slash Commands
Modify settings directly inside the TUI without leaving your workspace:

- `/config` or `/config show` — View active configuration & loaded files
- `/config set model <model-name>` — Update model for current project
- `/config set baseURL http://127.0.0.1:1234/v1 --global` — Set machine-wide base URL
- `/config reload` — Reload configuration from disk

---

## ⌨️ TUI Slash Commands

| Command | Description |
|---|---|
| `/help` | Open interactive help & shortcut reference overlay (F1) |
| `/config` | View or modify `.nanogent.json` configuration |
| `/set <key> <val>` | Quick-set configuration options (`model`, `baseURL`, etc.) |
| `/connect` | Connect provider — select runtimes, enter API keys, pick models |
| `/doctor` | Run system health check (verify LM Studio / OpenAI endpoints) |
| `/models` | List loaded models, context limits, and availability |
| `/todo` | Toggle task todo sidebar panel (F4) |
| `/skills` | Manage skills (F8) — enable, disable, create custom skills |
| `/graph` | Build or query memory graph (`/graph build`, `/graph stats`, `/graph report`) |
| `/mcp` | List connected Model Context Protocol servers |
| `/mcp-add` | Add local or remote MCP server (`/mcp-add fs local npx ...`) |
| `/mcp-remove` | Remove connected MCP server |
| `/compact` | Compact conversation history to free context tokens |
| `/clear` | Clear chat history (F2) |
| `/new` | Start new session |
| `/export` | Export chat transcript to markdown file |
| `/exit` | Gracefully quit and save session (F10) |

---

## 🤖 Headless CLI Mode

NanoAgent can also run headlessly for scripts, CI pipelines, and agent automations:

```bash
# Run a single task non-interactively
nanoagent run --prompt "Refactor index.ts to use async/await" --workspace .

# Pipe prompt via stdin
cat task.txt | nanoagent run --stdin --workspace . --quiet

# Machine-readable JSON output
nanoagent run --prompt "check test coverage" --json

# Run health check or query models
nanoagent doctor --json
nanoagent models
```

---

## 🛡️ Enterprise Security Hardening

NanoAgent includes security hardening enabled by default:

- 🛡️ **Command Validation**: Whitelists safe shell commands and blocks dangerous execution patterns (`rm -rf`, `sudo`, `dd`).
- 📁 **Workspace Path Sandboxing**: Restricts tool file access to the active workspace and blocks sensitive paths (`.env`, `.git`).
- 🔒 **Output Sanitization**: Automatically redacts API keys, JWT tokens, AWS credentials, and secrets from tool outputs.

*Read [SECURITY.md](SECURITY.md) for full security documentation.*

---

## 🏗️ Project Architecture

```text
src/
├── main.ts              # CLI entry point & command router (nanoagent)
├── config.ts            # Configuration loader & .nanogent.json manager
├── agent.ts             # Core Agent state machine & loop
├── types.ts             # TypeScript definitions
├── store.ts             # Session and todo persistence
├── skills.ts            # Skill definitions & manager
├── context.ts           # Git workspace & repository context detection
├── llm.ts               # LLM client & token compaction logic
├── security/            # Security manager & output sanitizer
├── graph/               # Codebase Memory Graph engine
├── mcp/                 # Model Context Protocol client manager
├── tools/               # Built-in tool definitions & execution engine
├── cli/                 # Headless CLI commands (run, doctor, models, help)
└── opentui/             # Full-screen OpenTUI terminal interface
    ├── index.tsx        # TUI root launcher
    ├── app.tsx          # OpenTUI App & command handler
    ├── chat-screen.tsx  # Interactive chat screen & streaming display
    ├── status-bar.tsx   # Top status bar & context indicator
    └── overlays.tsx     # Help, history, and configuration overlays
```

---

## 📄 License

[MIT License](LICENSE)
