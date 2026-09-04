import { loadSkills, getSkill, getSkillCommands } from '../../skills.js';
import { loadConfig, saveConfigFile, applyModelProfile, formatProfileList } from '../../config/index.js';
import { parseEffort, formatEffortAllowed, DEFAULT_EFFORT } from '../../config/effort.js';
import {
  getDoctorReport,
  formatDoctorReport,
  getModelsList,
  formatModelsList,
} from '../../cli/reports.js';
import { tools } from '../../tools/index.js';
import {
  autoSaveSession,
  loadSessions,
  deleteSession,
  resumeSession,
  exportToMarkdown,
} from '../../store.js';
import { copyToClipboard } from '../../clipboard.js';
import { THEMES } from '../theme.js';
import { build_memory_graph, get_graph_stats, get_analysis_report } from '../../graph/tools.js';
export type { SlashCommandContext } from './types.js';
import type { SlashCommandContext } from './types.js';
import { pushAssistant } from './utils.js';
import { handlePermissionsCommand } from './permissions.js';
import { handleMcpCommand, handleMcpAddCommand, handleMcpRemoveCommand } from './mcp.js';
import { formatUsageReport, hasKnownPrices } from '../../llm/cost.js';
import { resolveToolResultTokenBudget } from '../../llm/tool-result-budget.js';

export { checkAndAutoCompact, pushAssistant } from './utils.js';

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
        agent.contextManager.clear();
        const baseMsg = agent.messages.find((m) => m.id === 'system-base');
        if (baseMsg) agent.contextManager.setMessages([baseMsg]);
        setMessages([...agent.messages]);
        setToolResults([]);
      }
      return;
    case 'compact': {
      if (!agent) return;
      // Force so /compact always attempts; checkAndCompactContext already
      // emits a UI notice with ContextManager fill when anything was removed.
      const did = agent.forceCompactContext?.() ?? agent.checkAndCompactContext?.() ?? false;
      setMessages([...agent.messages]);
      if (!did) {
        const stats = agent.contextManager?.getStats?.();
        const fill =
          stats && stats.maxTokens > 0
            ? `${stats.currentTokens}/${stats.maxTokens} (${Math.min(100, Math.round(stats.usagePercent * 100))}%)`
            : '';
        pushAssistant(
          agent,
          fill
            ? `Compact: no compaction needed — ${fill}.`
            : 'Compact: no compaction needed — conversation is within context budget.',
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
    case 'usage': {
      const pricesKnown = hasKnownPrices(agent.cfg);
      pushAssistant(
        agent,
        formatUsageReport({
          total: agent.totalUsage ?? { input_tokens: 0, output_tokens: 0 },
          last: agent.lastUsage,
          totalCostUsd: pricesKnown ? agent.totalCostUsd : undefined,
          lastCostUsd: pricesKnown ? agent.lastCostUsd : undefined,
          pricesKnown,
        }),
        setMessages
      );
      return;
    }
    case 'models': {
      const models = await getModelsList(undefined, agent.cfg);
      const list = formatModelsList(models);
      const profileNames = Object.keys(agent.cfg.profiles ?? {});
      const profileNote =
        profileNames.length > 0
          ? `\n\nProfiles: ${profileNames.join(', ')}${agent.cfg.profile ? ` (current: ${agent.cfg.profile})` : ''}\nUse /profile <name> to switch.`
          : '';
      pushAssistant(agent, `${list}${profileNote}`, setMessages);
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
      setSkillCommands(getSkillCommands(loadedSkills, { includeDisabled: true }));
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
      agent.messages = [];
      agent.todos = [];
      setMessages([]);
      setTodos([]);
      pushAssistant(agent, 'Started a new session. Previous conversation cleared.', setMessages);
      return;
    }
    case 'delete-session': {
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
      const targetId = args?.trim();
      if (!targetId) {
        pushAssistant(
          agent,
          'Usage: /copy [message-id]. Use /copy with a message ID to copy its content to clipboard.',
          setMessages
        );
        return;
      }
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
      agent.todos = [];
      setTodos([]);
      pushAssistant(agent, 'All todos cleared.', setMessages);
      return;
    }
    case 'unload': {
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
    case 'settings':
      setOverlay('settings');
      return;
    case 'effort': {
      const raw = args.trim();
      const current = agent.cfg.effort ?? DEFAULT_EFFORT;
      if (!raw) {
        pushAssistant(
          agent,
          `effort: ${current}\nAllowed: ${formatEffortAllowed()}\nExample: /effort high`,
          setMessages
        );
        return;
      }
      const parsed = parseEffort(raw);
      if (!parsed) {
        pushAssistant(
          agent,
          `Unknown effort "${raw}". Allowed: ${formatEffortAllowed()}`,
          setMessages
        );
        return;
      }
      try {
        const { targetPath } = saveConfigFile({ effort: parsed }, 'global', agent.cfg.workspace);
        await agent.reconfigure({ effort: parsed });
        pushAssistant(agent, `Saved effort=${parsed} to ${targetPath}`, setMessages);
      } catch (err) {
        pushAssistant(
          agent,
          `Failed to save effort: ${err instanceof Error ? err.message : String(err)}`,
          setMessages
        );
      }
      return;
    }
    case 'config':
    case 'set': {
      const trimmedArgs = args.trim();
      if (command === 'config' && !trimmedArgs) {
        setOverlay('settings');
        return;
      }
      const parts = trimmedArgs.split(/\s+/);
      const subCommand = command === 'set' ? 'set' : parts[0]?.toLowerCase() || 'show';

      if (subCommand === 'show' || !trimmedArgs) {
        const currentCfg = agent?.cfg || cfg;
        const info = [
          '### ⚙️ Configuration',
          '',
          `- **Model**: \`${currentCfg.model || 'auto-detect'}\``,
          `- **Base URL**: \`${currentCfg.baseURL || 'http://127.0.0.1:1234/v1'}\``,
          `- **Provider**: \`${currentCfg.baseURL?.includes('openrouter') ? 'OpenRouter' : 'LM Studio / Local'}\``,
          `- **Profile**: \`${currentCfg.profile || '(none)'}\``,
          `- **Fallbacks**: \`${
            currentCfg.fallbacks && currentCfg.fallbacks.length > 0
              ? currentCfg.fallbacks.map((f) => f.model).join(', ')
              : '(none)'
          }\``,
          `- **Workspace**: \`${currentCfg.workspace || process.cwd()}\``,
          `- **API Key**: ${currentCfg.apiKey ? '`••••••••` (set)' : '*(not set)*'}`,
          `- **Temperature**: \`${currentCfg.temperature ?? 0.7}\``,
          `- **Max Tokens**: \`${currentCfg.maxTokens ?? 4096}\``,
          `- **Effort**: \`${currentCfg.effort ?? DEFAULT_EFFORT}\``,
          `- **Max Requests/min**: \`${currentCfg.maxRequestsPerMinute ?? 0}\` (0 = unlimited)`,
          `- **Max Concurrent LLM**: \`${currentCfg.maxConcurrentLlmRequests ?? 0}\` (0 = unlimited)`,
          `- **Max Tokens/min**: \`${currentCfg.maxTokensPerMinute ?? 0}\` (0 = off; no catalog default)`,
          `- **Max tool result tokens**: \`${resolveToolResultTokenBudget(currentCfg)}\`${currentCfg.maxToolResultTokens === undefined ? ' (default)' : ''} (0 = off)`,
          `- **Prompt $/1M**: \`${currentCfg.promptPricePerMillion ?? 'unknown'}\``,
          `- **Completion $/1M**: \`${currentCfg.completionPricePerMillion ?? 'unknown'}\``,
          ...(currentCfg.modelRuntimeSource
            ? [`- **Context source**: \`${currentCfg.modelRuntimeSource}\``]
            : []),
          ...(currentCfg.supportsTools !== undefined
            ? [`- **Supports tools**: \`${currentCfg.supportsTools}\``]
            : []),
          ...(currentCfg.supportsThinking !== undefined
            ? [`- **Supports thinking**: \`${currentCfg.supportsThinking}\``]
            : []),
          ...(currentCfg.supportsPromptCache !== undefined
            ? [`- **Supports prompt cache**: \`${currentCfg.supportsPromptCache}\``]
            : []),
          ...(currentCfg.promptCache !== undefined
            ? [`- **Prompt cache**: \`${currentCfg.promptCache ? 'on' : 'off'}\``]
            : []),
          '',
          '**Configuration Files:**',
          '- Local: `.nanogent.json` in workspace root',
          '- Global: `~/.nanogent.json` in home directory',
          '',
          '**Usage:**',
          '- `/config set model <name>` (set model locally)',
          '- `/config set model <name> --global` (set model globally)',
          '- `/config set baseURL http://localhost:1234/v1`',
          '- `/config set maxRequestsPerMinute 20`',
          '- `/config set maxConcurrentLlmRequests 2`',
          '- `/config set maxTokensPerMinute 200000`',
          '- `/config set maxToolResultTokens 8000`',
          '- `/config set promptCache false`',
          '- `/config reload` (reload from disk)',
          '- `/profile <name>` (apply a named snapshot; add `--global` to persist)',
          '- `/effort <none|low|medium|high|extra-high>` (persists globally)',
          '- `/config` (overlay; persists globally)',
          '- `/settings` (alias for `/config` overlay)',
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
          await agent.reconfigure(newConfig);
        }

        // Never echo secrets into the chat history (it is autosaved to disk).
        const displayVal = /key|token|secret|password/i.test(key) ? '••••••' : String(parsedVal);
        pushAssistant(
          agent,
          `✅ Updated \`${key}\` to \`${displayVal}\` in **${targetPath}** (${scope}). Config reloaded.`,
          setMessages
        );
        return;
      }

      if (subCommand === 'reload') {
        const reloaded = loadConfig(agent?.cfg?.workspace);
        if (agent) await agent.reconfigure(reloaded);
        pushAssistant(agent, '✅ Configuration reloaded from disk.', setMessages);
        return;
      }
      return;
    }
    case 'profile': {
      const profileTokens = args.trim().split(/\s+/).filter(Boolean);
      const persistFlag = profileTokens.find((t) => t === '--global' || t === '--local');
      const name = profileTokens.filter((t) => t !== '--global' && t !== '--local').join(' ');

      if (!name || name === 'list') {
        pushAssistant(agent, formatProfileList(agent.cfg), setMessages);
        return;
      }

      const applied = applyModelProfile(agent.cfg, name);
      if ('error' in applied) {
        pushAssistant(agent, applied.error, setMessages);
        return;
      }

      await agent.reconfigure(applied.patch);
      let persistNote =
        'Session only — persist with `/profile ' +
        (agent.cfg.profile ?? name) +
        ' --global` or `--local`.';
      if (persistFlag === '--global' || persistFlag === '--local') {
        const scope = persistFlag === '--global' ? 'global' : 'local';
        const { targetPath } = saveConfigFile(applied.persist, scope, agent?.cfg?.workspace);
        persistNote = `Saved to **${targetPath}** (${scope}).`;
      }
      const ctxNote = agent.cfg.modelContextLength
        ? ` · ${Math.round(agent.cfg.modelContextLength / 1000)}k ctx`
        : '';
      pushAssistant(
        agent,
        `Applied profile **${agent.cfg.profile ?? name}**: \`${agent.cfg.model}\` @ \`${agent.cfg.baseURL}\`${ctxNote}\n${persistNote}`,
        setMessages
      );
      return;
    }
    case 'exit':
      if (agent) {
        autoSaveSession(agent.messages, agent.todos, cfg.workspace, agent.cfg);
        // Graceful shutdown (same as SIGINT): tear down MCP children etc.
        await agent.shutdown().catch(() => {});
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
    case 'mcp':
      await handleMcpCommand(args, ctx);
      return;
    case 'mcp-add':
      await handleMcpAddCommand(args, ctx);
      return;
    case 'mcp-remove':
      await handleMcpRemoveCommand(args, ctx);
      return;
    case 'permissions':
      await handlePermissionsCommand(args, ctx);
      return;
    default: {
      const cleanSkillName = command.replace(/^skill:/, '');
      const targetSkill =
        getSkill(cleanSkillName) ||
        skills.get(cleanSkillName) ||
        ((command === 'skills' || command === 'skill') && args
          ? getSkill(args.trim().replace(/^skill:/, '')) ||
            skills.get(args.trim().replace(/^skill:/, ''))
          : undefined);

      if (targetSkill) {
        await agent.run(`/skill:${cleanSkillName}`, signal);
        return;
      }

      pushAssistant(
        agent,
        `Unknown command: /${command}. Type /help for available commands.`,
        setMessages
      );
      return;
    }
  }
}
