/**
 * Slash-command handling for the TUI, extracted from app.tsx.
 * The command switch is a verbatim move — behavior is unchanged.
 */

import type { AgentCore } from '../agent.js';
import type { Config, Message, Todo, ToolResult, Skill, SkillCommand, Session } from '../types.js';
import { loadSkills, getSkill, getSkillCommands } from '../skills.js';
import { loadConfig, saveConfigFile } from '../config.js';
import {
  getDoctorReport,
  formatDoctorReport,
  getModelsList,
  formatModelsList,
} from '../cli/reports.js';
import { tools } from '../tools/index.js';
import {
  autoSaveSession,
  loadSessions,
  deleteSession,
  resumeSession,
  copyToClipboard,
  exportToMarkdown,
} from '../store.js';
import { THEMES, type Theme } from './theme.js';
import { build_memory_graph, get_graph_stats, get_analysis_report } from '../graph/tools.js';
import { logError } from '../log.js';

type Overlay = 'help' | 'history' | 'skills' | 'connect' | 'todo' | null;

/** Everything the command switch needs from the App component. */
export interface SlashCommandContext {
  agent: AgentCore;
  signal: AbortSignal;
  cfg: Config;
  todos: Todo[];
  skills: Map<string, Skill>;
  setMessages: (msgs: Message[]) => void;
  setToolResults: (r: ToolResult[]) => void;
  setTodos: (t: Todo[]) => void;
  setSessions: (s: Session[]) => void;
  setOverlay: (o: Overlay) => void;
  setShowTodos: (fn: (s: boolean) => boolean) => void;
  setTheme: (t: Theme) => void;
  setSkills: (s: Map<string, Skill>) => void;
  setSkillCommands: (c: SkillCommand[]) => void;
  handleSave: () => void;
  handleLoad: (session: Session) => Promise<void>;
  handleRename: (name: string) => void;
}

/**
 * Check if the conversation needs auto-compaction and perform it if necessary.
 * Uses rolling window approach: keeps recent messages and summarizes older ones.
 */
let isCompacting = false;
export async function checkAndAutoCompact(
  agent: AgentCore,
  setMessages: (msgs: Message[]) => void
) {
  if (isCompacting) return;
  isCompacting = true;
  try {
    const compacted = await agent.compactContextIfNeeded();
    if (compacted) {
      // Clone the last assistant message so React.memo in MessageItem can
      // detect in-place streaming mutations via identity change.
      const msgs = agent.messages;
      const last = msgs[msgs.length - 1];
      setMessages(
        last && last.role === 'assistant' ? [...msgs.slice(0, -1), { ...last }] : [...msgs]
      );
    }
  } catch (err) {
    logError('[auto-compact] compaction failed:', err);
  } finally {
    isCompacting = false;
  }
}

function pushAssistant(agent: AgentCore, content: string, setMessages: (m: Message[]) => void) {
  agent.messages.push({
    id: Math.random().toString(36).slice(2, 10),
    role: 'assistant',
    content,
    timestamp: Date.now(),
  });
  setMessages([...agent.messages]);
}

/** Handle a `/command` input line. Only called when text starts with '/'. */
export async function handleSlashCommand(text: string, ctx: SlashCommandContext): Promise<void> {
  const {
    agent,
    signal,
    cfg,
    todos,
    skills,
    setMessages,
    setToolResults,
    setTodos,
    setSessions,
    setOverlay,
    setShowTodos,
    setTheme,
    setSkills,
    setSkillCommands,
    handleSave,
    handleLoad,
    handleRename,
  } = ctx;

  const command = text.trim().substring(1).split(' ')[0];
  const args = text
    .trim()
    .substring(1 + command.length)
    .trim();

  switch (command) {
    case 'help':
      setOverlay('help');
      return;
    case 'clear':
      if (agent) {
        agent.messages = agent.messages.filter((m) => m.role === 'system');
        // Also reset the context manager (keeping the system prompt),
        // otherwise cleared messages resurrect after the next compaction.
        agent.contextManager.clear();
        const baseMsg = agent.messages.find((m) => m.id === 'system-base');
        if (baseMsg) agent.contextManager.setMessages([baseMsg]);
        setMessages([...agent.messages]);
        setToolResults([]);
      }
      return;
    case 'compact': {
      if (!agent) return;
      const before = agent.messages.length;
      checkAndAutoCompact(agent, setMessages);
      const compacted = before - agent.messages.length;
      if (compacted > 0) {
        pushAssistant(agent, `Manually compacted: ${compacted} messages removed.`, setMessages);
      } else {
        pushAssistant(
          agent,
          'Compact: no compaction needed — conversation is within context budget.',
          setMessages
        );
      }
      return;
    }
    case 'connect':
      setOverlay('connect');
      return;
    case 'doctor': {
      const report = await getDoctorReport(agent.cfg);
      pushAssistant(agent, formatDoctorReport(report), setMessages);
      return;
    }
    case 'models': {
      const models = await getModelsList(undefined, agent.cfg);
      pushAssistant(agent, formatModelsList(models), setMessages);
      return;
    }
    case 'auto': {
      const task = args.trim();
      if (task) {
        pushAssistant(
          agent,
          'Autonomous mode enabled. You may iterate tools freely to complete the task.',
          setMessages
        );
        // Strip /auto and run the task (pass the abort signal so Escape cancels)
        await agent.run(task, signal);
      } else {
        pushAssistant(
          agent,
          'Usage: /auto [task description] — runs the agent in autonomous mode.',
          setMessages
        );
      }
      return;
    }
    case 'todo':
      if (args) {
        agent.addTodo(args);
      } else {
        setShowTodos((s) => !s);
      }
      return;
    case 'skill': {
      const skillName = args.trim().replace(/^skill:/, '');
      if (skillName) {
        // Activate via the agent's built-in /skill: flow (loads + notifies
        // the model in-conversation so it actually adopts the skill)
        await agent.run(`/skill:${skillName}`, signal);
        return;
      }
      const allSkills = loadSkills();
      const content =
        allSkills.size > 0
          ? `Available skills: ${Array.from(allSkills.keys()).join(', ')}`
          : 'No skills loaded.';
      pushAssistant(agent, content, setMessages);
      return;
    }
    case 'save':
      handleSave();
      return;
    case 'load':
      setSessions(loadSessions());
      setOverlay('history');
      return;
    case 'cd': {
      let target = args.trim();
      if (
        (target.startsWith('"') && target.endsWith('"')) ||
        (target.startsWith("'") && target.endsWith("'"))
      ) {
        target = target.slice(1, -1).trim();
      }
      if (!target) {
        pushAssistant(agent, `Current workspace: ${agent.cfg.workspace}`, setMessages);
        return;
      }

      // Use the change_workspace tool instead of direct reconfigure
      // This ensures consistent workspace handling across all tools
      const changeWorkspaceTool = tools.find((t) => t.name === 'change_workspace');
      if (!changeWorkspaceTool) {
        pushAssistant(agent, `change_workspace tool not found`, setMessages);
        return;
      }
      const toolResult = agent.cfg.allowedPaths?.length
        ? changeWorkspaceTool.execute({ path: target }, agent.cfg.workspace, agent.cfg)
        : changeWorkspaceTool.execute({ path: target }, agent.cfg.workspace);

      try {
        const result = JSON.parse(toolResult);
        if (result.ok && result.workspace) {
          void agent.reconfigure({ workspace: result.workspace });
          agent.todos = [];
          setTodos([]);
          pushAssistant(agent, `Workspace changed to ${result.workspace}`, setMessages);
          return;
        } else {
          pushAssistant(
            agent,
            `Failed to change workspace: ${result.error || 'Unknown error'}`,
            setMessages
          );
          return;
        }
      } catch {
        pushAssistant(agent, `Failed to parse workspace change result: ${toolResult}`, setMessages);
        return;
      }
    }

    case 'theme': {
      const tname = args.trim() || '';
      const next = THEMES[tname];
      if (next) {
        setTheme(next);
        pushAssistant(agent, `Theme set to ${next.name}.`, setMessages);
      } else {
        const names = Object.keys(THEMES).join(', ');
        pushAssistant(agent, `Available themes: ${names}`, setMessages);
      }
      return;
    }
    case 'export': {
      if (!agent) return;
      try {
        const filePath = exportToMarkdown(agent.messages, args || undefined);
        pushAssistant(agent, `Chat exported to ${filePath}`, setMessages);
      } catch (err) {
        pushAssistant(agent, `Failed to export chat: ${err}`, setMessages);
      }
      return;
    }
    case 'skills':
      setOverlay('skills');
      return;
    case 'reload': {
      await agent.reloadFromDisk();
      const loadedSkills = loadSkills();
      setSkills(loadedSkills);
      setSkillCommands(getSkillCommands(loadedSkills));
      const ctxNote = agent.cfg.modelContextLength
        ? ` · ${Math.round(agent.cfg.modelContextLength / 1000)}k ctx`
        : '';
      pushAssistant(
        agent,
        `Reloaded config, skills, and LM Studio metadata.\n` +
          `model: ${agent.cfg.model}${ctxNote} · small_model_mode: ${agent.cfg.smallModelMode ?? false}\n` +
          `${loadedSkills.size} skills loaded. Use /doctor for full health report.`,
        setMessages
      );
      return;
    }
    case 'sessions': {
      // List available sessions
      const sessions = loadSessions().filter((s) => !s.id.startsWith('autosave-'));
      if (sessions.length > 0) {
        const list = sessions
          .map((s) => `${new Date(s.updatedAt).toLocaleDateString()} - ${s.id}`)
          .join('\n');
        pushAssistant(
          agent,
          `Available sessions:\n${list}\n\nTo resume: /resume [id]`,
          setMessages
        );
      } else {
        pushAssistant(
          agent,
          'No saved sessions found. Your current session will be auto-saved on exit.',
          setMessages
        );
      }
      return;
    }
    case 'new': {
      // Start a new session - clear messages and todos
      agent.messages = [];
      agent.todos = [];
      setMessages([]);
      setTodos([]);
      pushAssistant(agent, 'Started a new session. Previous conversation cleared.', setMessages);
      return;
    }
    case 'delete-session': {
      // Delete a saved session
      const id = args?.trim();
      if (!id) {
        pushAssistant(
          agent,
          'Usage: /delete-session [id]. List sessions with /sessions.',
          setMessages
        );
        return;
      }
      const sessions = loadSessions();
      const sessionExists = sessions.some((s) => s.id === id);
      if (sessionExists) {
        deleteSession(id);
        setSessions(loadSessions());
        pushAssistant(agent, `Session '${id}' deleted.`, setMessages);
      } else {
        pushAssistant(
          agent,
          `Session '${id}' not found. Use /sessions to list available sessions.`,
          setMessages
        );
      }
      return;
    }
    case 'resume': {
      // Resume latest or specific session
      const session = resumeSession(args?.trim());
      if (session) {
        await handleLoad(session);
      } else {
        pushAssistant(
          agent,
          args?.trim() ? `Session '${args.trim()}' not found.` : 'No sessions to resume.',
          setMessages
        );
      }
      return;
    }
    case 'rename': {
      handleRename(args || '');
      return;
    }
    case 'copy': {
      // Copy message content to clipboard by message ID
      const targetId = args?.trim();
      if (!targetId) {
        pushAssistant(
          agent,
          'Usage: /copy [message-id]. Use /copy with a message ID to copy its content to clipboard.',
          setMessages
        );
        return;
      }

      // Find message by ID (full or partial match)
      const message = agent.messages.find((m) => m.id.includes(targetId) || m.id === targetId);

      if (message) {
        const success = copyToClipboard(message.content);
        pushAssistant(
          agent,
          success
            ? `Copied message ${message.id.slice(0, 8)} to clipboard.`
            : `Failed to copy to clipboard. Content:\n${message.content.slice(0, 500)}${message.content.length > 500 ? '...' : ''}`,
          setMessages
        );
      } else {
        pushAssistant(
          agent,
          `Message with ID '${targetId}' not found. Use the full message ID or a unique partial match.`,
          setMessages
        );
      }
      return;
    }
    case 'todos': {
      // Show current todos in chat
      if (todos.length > 0) {
        const todoList = todos.map((t) => `${t.done ? '✓' : '✗'} ${t.id}: ${t.text}`).join('\n');
        pushAssistant(
          agent,
          `Current Todos:\n${todoList}\n\nUse /todo [text] to add, /clear-todos to remove all.`,
          setMessages
        );
      } else {
        pushAssistant(agent, 'No todos. Add one with /todo [description].', setMessages);
      }
      return;
    }
    case 'clear-todos': {
      // Clear all todos
      agent.todos = [];
      setTodos([]);
      pushAssistant(agent, 'All todos cleared.', setMessages);
      return;
    }
    case 'unload': {
      // Unload a skill: /unload [name]
      const unloadName = args.trim();
      if (!unloadName) {
        const active = agent.skillManager.activeNames();
        if (active.length > 0) {
          pushAssistant(
            agent,
            `Active skills: ${active.join(', ')}\nUsage: /unload [skill-name]`,
            setMessages
          );
        } else {
          pushAssistant(agent, 'No active skills to unload.', setMessages);
        }
        return;
      }
      const unloaded =
        agent.skillManager.unload(unloadName, agent.messages, agent.isSmallModel, undefined) ||
        agent.skillManager.unload(
          `skill:${unloadName}`,
          agent.messages,
          agent.isSmallModel,
          undefined
        );
      pushAssistant(
        agent,
        unloaded
          ? `Skill "${unloadName}" unloaded.`
          : `Skill "${unloadName}" not found in active skills.`,
        setMessages
      );
      return;
    }
    case 'skill-load': {
      // Load a skill: /skill-load [name]
      const loadName = args.trim();
      if (!loadName) {
        pushAssistant(
          agent,
          'Usage: /skill-load [skill-name]. Use /skills to see available skills.',
          setMessages
        );
        return;
      }
      const skill = getSkill(loadName) || skills.get(loadName);
      if (skill) {
        // Delegate to the agent's built-in /skill-load flow: loads the skill
        // AND injects a system notice so the model acknowledges + activates it
        await agent.run(text, signal);
        return;
      } else {
        pushAssistant(
          agent,
          `Skill "${loadName}" not found. Use /skills to see available skills.`,
          setMessages
        );
      }
      return;
    }

    case 'config':
    case 'set': {
      const trimmedArgs = args.trim();
      const parts = trimmedArgs.split(/\s+/);
      const subCommand = command === 'set' ? 'set' : parts[0]?.toLowerCase() || 'show';

      if (subCommand === 'show' || !trimmedArgs) {
        const currentCfg = agent?.cfg || cfg;
        const info = [
          '### ⚙️ nanogent Configuration',
          '',
          `- **Model**: \`${currentCfg.model || 'auto-detect'}\``,
          `- **Base URL**: \`${currentCfg.baseURL || 'http://127.0.0.1:1234/v1'}\``,
          `- **Provider**: \`${currentCfg.baseURL?.includes('openrouter') ? 'OpenRouter' : 'LM Studio / Local'}\``,
          `- **Workspace**: \`${currentCfg.workspace || process.cwd()}\``,
          `- **API Key**: ${currentCfg.apiKey ? '`••••••••` (set)' : '*(not set)*'}`,
          `- **Temperature**: \`${currentCfg.temperature ?? 0.7}\``,
          `- **Max Tokens**: \`${currentCfg.maxTokens ?? 4096}\``,
          '',
          '**Configuration Files:**',
          '- Local: `.nanogent.json` in workspace root',
          '- Global: `~/.nanogent.json` in home directory',
          '',
          '**Usage:**',
          '- `/config set model <name>` (set model locally)',
          '- `/config set model <name> --global` (set model globally)',
          '- `/config set baseURL http://localhost:1234/v1`',
          '- `/config reload` (reload from disk)',
        ].join('\n');

        pushAssistant(agent, info, setMessages);
        return;
      }

      if (subCommand === 'set') {
        const setTokens = command === 'set' ? parts : parts.slice(1);
        const isGlobal = setTokens.includes('--global');
        const cleanTokens = setTokens.filter((t) => t !== '--global');
        const key = cleanTokens[0];
        const valueStr = cleanTokens.slice(1).join(' ');

        if (!key || !valueStr) {
          pushAssistant(
            agent,
            'Usage: `/config set <key> <value> [--global]`\nExample: `/config set model qwen3.5-2b` or `/set baseURL http://127.0.0.1:1234/v1`',
            setMessages
          );
          return;
        }

        let parsedVal: unknown = valueStr;
        if (valueStr === 'true') parsedVal = true;
        else if (valueStr === 'false') parsedVal = false;
        else if (!isNaN(Number(valueStr))) parsedVal = Number(valueStr);

        const scope = isGlobal ? 'global' : 'local';
        const { targetPath, config: newConfig } = saveConfigFile(
          { [key]: parsedVal },
          scope,
          agent?.cfg?.workspace
        );

        if (agent) {
          agent.cfg = newConfig;
        }

        pushAssistant(
          agent,
          `✅ Updated \`${key}\` to \`${String(parsedVal)}\` in **${targetPath}** (${scope}). Config reloaded.`,
          setMessages
        );
        return;
      }

      if (subCommand === 'reload') {
        const reloaded = loadConfig(agent?.cfg?.workspace);
        if (agent) agent.cfg = reloaded;
        pushAssistant(agent, '✅ Configuration reloaded from disk.', setMessages);
        return;
      }
      return;
    }
    case 'exit':
      // Auto-save before exiting
      if (agent) {
        autoSaveSession(agent.messages, agent.todos, cfg.workspace);
      }
      process.exit(0);
      return;
    case 'graph': {
      const sub = args.split(' ')[0].toLowerCase();
      const ws = agent?.cfg?.workspace || process.cwd();
      if (sub === 'build') {
        const result = await build_memory_graph({ workspace: ws });
        pushAssistant(
          agent,
          `**Memory Graph — Build**\n\n${result.message}\n- **Nodes:** ${result.nodes ?? '—'}\n- **Edges:** ${result.edges ?? '—'}\n- **Time:** ${result.time != null ? `${result.time}ms` : '—'}`,
          setMessages
        );
      } else if (sub === 'stats') {
        const stats = await get_graph_stats({ workspace: ws });
        const byType = Object.entries(stats.nodesByType)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        const byLang = Object.entries(stats.nodesByLanguage)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        pushAssistant(
          agent,
          `**Memory Graph — Stats**\n\n- **Nodes:** ${stats.nodeCount}\n- **Edges:** ${stats.edgeCount}\n\n**By Type:**\n${byType || '  —'}\n\n**By Language:**\n${byLang || '  —'}`,
          setMessages
        );
      } else if (sub === 'report') {
        const result = await get_analysis_report({ workspace: ws });
        if (result.ok && result.report) {
          pushAssistant(agent, result.report, setMessages);
        } else {
          pushAssistant(agent, `Graph report error: ${result.error || 'unknown'}`, setMessages);
        }
      } else {
        pushAssistant(
          agent,
          `**Memory Graph**\n\nUsage:\n  \`/graph build\`   — Build/rebuild the memory graph from codebase\n  \`/graph stats\`   — Show node/edge counts by type and language\n  \`/graph report\`  — Full analysis report with communities, god nodes, and surprising connections`,
          setMessages
        );
      }
      return;
    }
    case 'mcp': {
      const states = agent.mcpStates;
      const mgr = agent.mcpManager;
      if (!states || states.length === 0) {
        pushAssistant(
          agent,
          'No MCP servers configured. Add `mcp` to ~/.qwen-agent.json.\n\nExample:\n```json\n"mcp": {\n  "filesystem": {\n    "type": "local",\n    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]\n  },\n  "remote": {\n    "type": "remote",\n    "url": "https://mcp.example.com/sse"\n  }\n}\n```\n\nYou can also ask me to add an MCP server — just describe what you need and I\'ll use manage_mcp to configure it.',
          setMessages
        );
      } else {
        const connected = mgr?.connectedCount ?? 0;
        const totalTools = mgr?.totalTools ?? 0;
        const lines = [
          `## MCP Servers (${connected} connected, ${totalTools} tools)`,
          '',
          ...states.map((s) => {
            const icon = s.status === 'connected' ? '+' : s.status === 'error' ? '!' : '-';
            const info = s.serverInfo
              ? ` (${s.serverInfo.name}${s.serverInfo.version ? ` v${s.serverInfo.version}` : ''})`
              : '';
            const err = s.error ? ` - ${s.error}` : '';
            return `- [${icon}] ${s.name}${info}: ${s.status}, ${s.toolCount} tools${err}`;
          }),
          '',
          'Commands: `/mcp-add`, `/mcp-remove`, or ask me to manage MCP servers.',
        ];
        pushAssistant(agent, lines.join('\n'), setMessages);
      }
      return;
    }
    case 'mcp-add': {
      if (!args) {
        pushAssistant(
          agent,
          'Usage: `/mcp-add <name> <type> <connection>`\n\nExamples:\n- `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /home/user/docs`\n- `/mcp-add github remote https://mcp.github.com/sse`\n\nOr just ask me in natural language: "Add an MCP server for reading files in /tmp"',
          setMessages
        );
        return;
      }
      const parts = args.split(/\s+/);
      const name = parts[0];
      const type = parts[1];
      if (type === 'local') {
        const cmdParts = parts.slice(2);
        if (cmdParts.length === 0) {
          pushAssistant(
            agent,
            'Local servers need a command. Example: `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /path`',
            setMessages
          );
          return;
        }
        const result = await agent.executeToolDirect('manage_mcp', {
          action: 'add',
          name,
          type: 'local',
          command: cmdParts,
        });
        pushAssistant(agent, result ?? 'Added. Restart to connect.', setMessages);
      } else if (type === 'remote') {
        const url = parts[2];
        if (!url) {
          pushAssistant(
            agent,
            'Remote servers need a URL. Example: `/mcp-add api remote https://mcp.example.com/sse`',
            setMessages
          );
          return;
        }
        const result = await agent.executeToolDirect('manage_mcp', {
          action: 'add',
          name,
          type: 'remote',
          url,
        });
        pushAssistant(agent, result ?? 'Added. Restart to connect.', setMessages);
      } else {
        pushAssistant(
          agent,
          "Type must be 'local' or 'remote'. Example: `/mcp-add filesystem local npx -y ...`",
          setMessages
        );
      }
      return;
    }
    case 'mcp-remove': {
      if (!args) {
        pushAssistant(
          agent,
          'Usage: `/mcp-remove <server-name>` — e.g. `/mcp-remove filesystem`',
          setMessages
        );
        return;
      }
      const result = await agent.executeToolDirect('manage_mcp', {
        action: 'remove',
        name: args.trim(),
      });
      pushAssistant(agent, result ?? 'Removed. Restart to apply.', setMessages);
      return;
    }

    case 'permissions': {
      const pm = agent.securityManager.permissionManager;
      const trimmedArgs = args ? args.trim() : '';

      if (!trimmedArgs) {
        const mode = pm.getMode();
        const rules = pm.getRules();
        const ruleEntries = Object.entries(rules);
        const rulesText =
          ruleEntries.length > 0
            ? ruleEntries.map(([t, l]) => `- \`${t}\`: ${l}`).join('\n')
            : 'None';

        pushAssistant(
          agent,
          `## Tool & Command Permissions\n\n` +
            `- **Current Global Mode**: \`${mode}\`\n` +
            `- **Category Defaults**:\n` +
            `  - Read tools (read_file, list_dir, grep_search, etc.): ALWAYS ALLOWED\n` +
            `  - Write tools (write_file, edit_file, etc.): ${
              mode === 'read_only'
                ? 'DENIED'
                : mode === 'allow_edits' || mode === 'always_allow'
                  ? 'ALLOWED'
                  : 'ASK'
            }\n` +
            `  - Commands (execute_command, run_tests, etc.): ${
              mode === 'read_only' ? 'DENIED' : mode === 'always_allow' ? 'ALLOWED' : 'ASK'
            }\n\n` +
            `### Custom Rules\n${rulesText}\n\n` +
            `### Commands\n` +
            `- Set Mode: \`/permissions read_only\` | \`/permissions ask\` | \`/permissions allow_edits\` | \`/permissions always_allow\`\n` +
            `- Set Rule: \`/permissions <allow|ask|deny> <tool_or_command>\` (e.g. \`/permissions allow execute_command\`)\n` +
            `- Reset Rules: \`/permissions reset\``,
          setMessages
        );
        return;
      }

      const parts = trimmedArgs.split(/\s+/);
      const sub = parts[0].toLowerCase();
      const target = parts.slice(1).join(' ').trim();

      if (sub === 'read_only' || sub === 'readonly') {
        pm.setMode('read_only');
        pushAssistant(
          agent,
          'Permission mode set to **read_only**. Write tools and command execution are now blocked.',
          setMessages
        );
      } else if (sub === 'ask') {
        if (target) {
          pm.setRule(target, 'ask');
          pushAssistant(agent, `Permission rule for \`${target}\` set to **ask**.`, setMessages);
        } else {
          pm.setMode('ask');
          pushAssistant(
            agent,
            'Permission mode set to **ask**. Write tools and commands will ask for confirmation.',
            setMessages
          );
        }
      } else if (sub === 'allow_edits' || sub === 'allowedits') {
        pm.setMode('allow_edits');
        pushAssistant(
          agent,
          'Permission mode set to **allow_edits**. Read and write tools are allowed; commands will ask for confirmation.',
          setMessages
        );
      } else if (sub === 'always_allow' || sub === 'alwaysallow') {
        pm.setMode('always_allow');
        pushAssistant(
          agent,
          'Permission mode set to **always_allow**. All read, write, and command operations are auto-allowed.',
          setMessages
        );
      } else if (sub === 'allow') {
        if (!target) {
          pushAssistant(agent, 'Usage: `/permissions allow <tool_or_command>`', setMessages);
        } else {
          pm.setRule(target, 'allow');
          pushAssistant(
            agent,
            `Permission rule for \`${target}\` set to **allow** (auto-approved).`,
            setMessages
          );
        }
      } else if (sub === 'deny') {
        if (!target) {
          pushAssistant(agent, 'Usage: `/permissions deny <tool_or_command>`', setMessages);
        } else {
          pm.setRule(target, 'deny');
          pushAssistant(
            agent,
            `Permission rule for \`${target}\` set to **deny** (blocked).`,
            setMessages
          );
        }
      } else if (sub === 'reset') {
        pm.setMode('ask');
        pm.clearRules();
        pushAssistant(
          agent,
          'Permission mode reset to **ask** and all custom rules cleared.',
          setMessages
        );
      } else {
        pushAssistant(
          agent,
          `Unknown permission mode/command: \`${sub}\`. Options: read_only, ask, allow_edits, always_allow, allow <target>, deny <target>, reset`,
          setMessages
        );
      }
      return;
    }
    default: {
      // Handle skill loading by name: /<skill-name>, /skill:name, /skill [name], or /skills [name]
      const cleanSkillName = command.replace(/^skill:/, '');
      const targetSkill =
        getSkill(cleanSkillName) ||
        skills.get(cleanSkillName) ||
        ((command === 'skills' || command === 'skill') && args
          ? getSkill(args.trim().replace(/^skill:/, '')) ||
            skills.get(args.trim().replace(/^skill:/, ''))
          : undefined);

      if (targetSkill) {
        // Delegate to the agent's built-in /skill: activation flow — loads
        // the skill AND tells the model in-conversation (system notice),
        // so it actually starts behaving per the skill's guidance
        await agent.run(`/skill:${cleanSkillName}`, signal);
        return;
      }

      // Unknown command
      pushAssistant(
        agent,
        `Unknown command: /${command}. Type /help for available commands.`,
        setMessages
      );
      return;
    }
  }
}
