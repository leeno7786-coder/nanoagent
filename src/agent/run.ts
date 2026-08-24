import type { AgentCore } from './core.js';
import { chat, streamChat, isEndpointRateLimited } from '../llm.js';
import { switchSessionToFallback } from '../llm/failover.js';
import { groupToolsForParallelExecution } from '../tools/index.js';
import { SkillManager } from '../skill-manager.js';
import type { Message } from '../types.js';
import { rnd, now } from '../agent-utils.js';
import { logError } from '../log.js';
import { EARLY_STOP_CONTINUE_NUDGE, looksLikePrematureCheckin } from './early-stop.js';

const DEFAULT_MAX_REASONING_ONLY = 5;
/** Only recover when the model barely started (≤ N tool rounds). */
const EARLY_STOP_MAX_TOOL_ROUNDS = 2;
/** Cap auto-continues per run so we never loop forever on check-ins. */
const EARLY_STOP_MAX_CONTINUES = 2;

export async function agentRun(
  agent: AgentCore,
  userText: string,
  signal?: AbortSignal
): Promise<void> {
  agent.setState('thinking');

  const maxReasoningOnly =
    agent.cfg.maxReasoningOnlyRounds && agent.cfg.maxReasoningOnlyRounds > 0
      ? agent.cfg.maxReasoningOnlyRounds
      : DEFAULT_MAX_REASONING_ONLY;

  // Auto-load skills matching user input triggers
  if (!userText.trim().startsWith('/')) {
    const autoLoaded = agent.skillManager.autoLoad(
      userText,
      agent.messages,
      agent._smallModel,
      agent.onUpdate
    );
    if (autoLoaded.length > 0) {
      const names = autoLoaded.map((s) => s.name).join(', ');
      agent.addAssistantMessage(`Auto-loaded skills: ${names} — these are now active in context.`);
    }
  }

  // Guided skill creation
  if (userText.trim().startsWith('/create-skill')) {
    agent.addAssistantMessage(
      agent._smallModel
        ? "Let's create a custom skill. Provide:\n1. What the skill does\n2. Slash command (e.g. /py-format)\n3. Which tools it needs\n4. Description and prompt"
        : "🔧 Let's create a custom skill together.\n" +
            "1. What should the skill do? (e.g., 'format Python code', 'review PRs')\n" +
            '2. What slash command should users type? (e.g., `/py-format`, `/pr-review`)\n' +
            '3. Which tools does it need? (e.g., `write_file`, `bash`, `grep_search`)\n' +
            '4. Give me a short description and example prompt.\n' +
            "I'll generate a complete, ready-to-use `.json` skill file for you."
    );
    return;
  }

  // Handle skill commands
  const trimmed = userText.trim();
  const sm = agent.skillManager;

  let skipUserMessage = false;

  if (trimmed.startsWith('/skill:') || trimmed.startsWith('/skill-load ')) {
    const isLoad = trimmed.startsWith('/skill-load ');
    const prefixLength = isLoad ? '/skill-load '.length : '/skill:'.length;
    const skillName = trimmed.substring(prefixLength).trim().split(/\s+/)[0];
    const skill = SkillManager.getByName(skillName);
    if (skill && sm.load(skill, agent.messages, agent._smallModel, agent.onUpdate)) {
      agent.addUserMessage(userText);
      agent.addUserMessage(
        `[System Notice: The skill "${skill.name}" has just been activated. Please review its context, introduce yourself according to this skill's persona or capabilities, summarize what you can do, and proceed to work or ask the user for clarifying questions.]`
      );
      skipUserMessage = true;
    } else if (skill) {
      agent.addAssistantMessage(`Skill "${skillName}" is already loaded.`);
      agent.setState('idle');
      return;
    } else {
      agent.addAssistantMessage(`Skill "${skillName}" not found.`);
      agent.setState('idle');
      return;
    }
  }

  if (trimmed.startsWith('/unload ')) {
    const name = trimmed.replace('/unload ', '').trim().split(/\s+/)[0];
    const unloaded =
      sm.unload(name, agent.messages, agent._smallModel, agent.onUpdate) ||
      sm.unload(`skill:${name}`, agent.messages, agent._smallModel, agent.onUpdate);
    agent.addAssistantMessage(
      unloaded ? `Skill "${name}" unloaded.` : `Skill "${name}" not found in active skills.`
    );
    return;
  }

  if (trimmed === '/skills' || trimmed === '/skill') {
    const all = sm.getAllWithStatus();
    const lines = ['## Available Skills', ''];
    for (const s of all) {
      lines.push(`- /skill:${s.name} — ${s.description}${s.active ? ' (active)' : ''}`);
    }
    agent.addAssistantMessage(lines.join('\n'));
    return;
  }

  if (trimmed === '/subagents') {
    const pool = await agent.getSubAgentPool();
    if (!pool) {
      agent.addAssistantMessage(
        'No remote sub-agent pool configured. Set `subagents` in ~/.nanogent.json or set REMOTE_LMSTUDIO_URL.'
      );
    } else {
      const lines = [
        `## Remote Sub-agents (${pool.endpoints.length} endpoints)`,
        '',
        ...pool.endpoints.map(
          (e) =>
            `- ${e.name}: \`${e.model}\` @ ${e.baseURL}${(e.concurrency ?? 1) > 1 ? ` (${e.concurrency} slots)` : ''}`
        ),
        '',
        `Concurrency cap: ${agent.maxBackgroundSubAgents}`,
      ];
      if (agent.backgroundSubAgents.size > 0) {
        lines.push(
          '',
          `Running: ${[...agent.backgroundSubAgents.values()]
            .map((h) => `${h.id} (${h.status})`)
            .join(', ')}`
        );
      }
      agent.addAssistantMessage(lines.join('\n'));
    }
    agent.setState('idle');
    return;
  }

  if (trimmed === '/mcp') {
    if (agent.mcpStates.length === 0) {
      agent.addAssistantMessage(
        'No MCP servers configured. Add `mcp` to ~/.nanogent.json.\n\n' +
          'Example:\n```json\n"mcp": {\n  "filesystem": {\n    "type": "local",\n    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]\n  },\n  "remote": {\n    "type": "remote",\n    "url": "https://mcp.example.com/sse"\n  }\n}\n```\n\nYou can also ask me to add an MCP server — just describe what you need and I\'ll use manage_mcp to configure it.'
      );
    } else {
      const lines = [
        `## MCP Servers (${agent.mcpManager.connectedCount} connected, ${agent.mcpManager.totalTools} tools)`,
        '',
        ...agent.mcpStates.map((s) => {
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
      agent.addAssistantMessage(lines.join('\n'));
    }
    agent.setState('idle');
    return;
  }

  if (trimmed === '/mcp-add' || trimmed.startsWith('/mcp-add ')) {
    const input = trimmed.slice('/mcp-add'.length).trim();
    if (!input) {
      agent.addAssistantMessage(
        'Usage: `/mcp-add <name> <type> <connection>`\n\n' +
          'Examples:\n' +
          '- `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /home/user/docs`\n' +
          '- `/mcp-add github remote https://mcp.github.com/sse`\n\n' +
          'Or just ask me in natural language: "Add an MCP server for reading files in /tmp"'
      );
    } else {
      const parts = input.split(/\s+/);
      const name = parts[0];
      const type = parts[1];
      if (type === 'local') {
        const command = parts.slice(2);
        if (command.length === 0) {
          agent.addAssistantMessage(
            'Local servers need a command. Example: `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /path`'
          );
        } else {
          const toolResult = await agent.executeToolDirect('manage_mcp', {
            action: 'add',
            name,
            type: 'local',
            command,
          });
          agent.addAssistantMessage(toolResult ?? 'Added. Restart to connect.');
        }
      } else if (type === 'remote') {
        const url = parts[2];
        if (!url) {
          agent.addAssistantMessage(
            'Remote servers need a URL. Example: `/mcp-add api remote https://mcp.example.com/sse`'
          );
        } else {
          const toolResult = await agent.executeToolDirect('manage_mcp', {
            action: 'add',
            name,
            type: 'remote',
            url,
          });
          agent.addAssistantMessage(toolResult ?? 'Added. Restart to connect.');
        }
      } else {
        agent.addAssistantMessage(
          "Type must be 'local' or 'remote'. Example: `/mcp-add filesystem local npx -y ...`"
        );
      }
    }
    agent.setState('idle');
    return;
  }

  if (trimmed === '/mcp-remove' || trimmed.startsWith('/mcp-remove ')) {
    const name = trimmed.slice('/mcp-remove'.length).trim();
    if (!name) {
      agent.addAssistantMessage(
        'Usage: `/mcp-remove <server-name>` — e.g. `/mcp-remove filesystem`'
      );
    } else {
      const toolResult = await agent.executeToolDirect('manage_mcp', { action: 'remove', name });
      agent.addAssistantMessage(toolResult ?? 'Removed. Restart to apply.');
    }
    agent.setState('idle');
    return;
  }

  if (!skipUserMessage) {
    agent.consecutiveToolRounds = 0;
    agent.addUserMessage(userText);
  }

  let iterationCount = 0;
  let reasoningOnlyStreak = 0;
  /** Retries after silent context overflow (finish_reason=length, 0 output). */
  let overflowRetries = 0;
  const MAX_OVERFLOW_RETRIES = 2;
  /** Auto-continues after shallow tool work + clarifying-question exit. */
  let earlyStopContinues = 0;
  /** Stuck-loop guard: consecutive rounds issuing identical tool-call signatures. */
  let lastToolSignature: string | undefined;
  let sameSignatureStreak = 0;
  const MAX_SAME_SIGNATURE_STREAK = 3;
  /** Each configured fallback is tried at most once per user turn. */
  const triedFallbacks = new Set<string>();

  const tryContinueAfterPrematureCheckin = (content: string): boolean => {
    if (earlyStopContinues >= EARLY_STOP_MAX_CONTINUES) return false;
    if (agent.consecutiveToolRounds <= 0) return false;
    if (agent.consecutiveToolRounds > EARLY_STOP_MAX_TOOL_ROUNDS) return false;
    if (!looksLikePrematureCheckin(content)) return false;
    earlyStopContinues++;
    agent.addNoticeMessage(
      `↻ Model paused to ask for direction after ${agent.consecutiveToolRounds} tool round(s) — continuing the task…`
    );
    agent.addNudgeMessage(EARLY_STOP_CONTINUE_NUDGE);
    agent.setState('thinking');
    agent.onUpdate?.();
    return true;
  };
  while (true) {
    if (signal?.aborted) {
      agent.setState('idle');
      agent.onUpdate?.();
      return;
    }

    // Effective turn limit: whichever positive cap is stricter.
    const maxIter = agent.cfg.maxIterations > 0 ? agent.cfg.maxIterations : Infinity;
    const maxRnd = agent.maxRounds > 0 ? agent.maxRounds : Infinity;
    const turnLimit = Math.min(maxIter, maxRnd);
    if (Number.isFinite(turnLimit) && iterationCount >= turnLimit) {
      const label =
        turnLimit === maxRnd && maxRnd < maxIter
          ? `Round limit reached (${maxRnd} rounds)`
          : `Turn limit reached (${turnLimit} iterations)`;
      agent.addNoticeMessage(`${label}. Resuming on your next prompt.`);
      agent.setState('idle');
      agent.onUpdate?.();
      return;
    }

    if (iterationCount > 0 && (agent.cfg.rateLimitMs ?? 0) > 0) {
      await new Promise((r) => setTimeout(r, agent.cfg.rateLimitMs));
    }
    iterationCount++;

    agent.checkAndCompactContext();

    let assistantMsg: Message;

    if (agent.streaming) {
      assistantMsg = {
        id: rnd(),
        role: 'assistant',
        content: '',
        timestamp: now(),
      };
      agent.messages.push(assistantMsg);

      try {
        const activeSkills = new Set(
          agent.skillManager
            .getAllWithStatus()
            .filter((s) => s.active)
            .map((s) => s.name)
        );
        const stream = streamChat(
          agent.client,
          agent.cfg,
          agent.toChatMessages(),
          agent.buildToolSchemas(activeSkills),
          signal,
          {
            onRetry: () => {
              assistantMsg.content = '';
              assistantMsg.reasoningContent = undefined;
              delete assistantMsg.toolCalls;
              hasToolCalls = false;
              toolCallBuffers = [];
              finishReason = undefined;
              inThinkTag = false;
              thinkCarry = '';
            },
          }
        );

        let hasToolCalls = false;
        let toolCallBuffers: Array<{ id: string; name: string; arguments: string }> = [];
        let finishReason: string | undefined;

        let inThinkTag = false;
        let thinkCarry = '';
        const iter = stream[Symbol.asyncIterator]();
        let iterResult = await iter.next();
        while (!iterResult.done) {
          const chunk = iterResult.value;
          if (signal?.aborted) {
            // Tear down the SSE stream so the server connection is released.
            await iter.return?.({});
            break;
          }

          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }

          if (process.env.QWEN_DEBUG_LLM) {
            logError(
              '[QWEN_DEBUG] agent chunk:',
              JSON.stringify(chunk.content),
              'reasoning:',
              JSON.stringify(chunk.reasoningContent),
              'toolCalls:',
              chunk.toolCalls?.length,
              'finish:',
              chunk.finishReason
            );
          }

          if (chunk.reasoningContent) {
            assistantMsg.reasoningContent =
              (assistantMsg.reasoningContent || '') + chunk.reasoningContent;
          }

          const rawChunkText = chunk.content || '';
          if (rawChunkText || thinkCarry) {
            let textToProcess = thinkCarry + rawChunkText;
            thinkCarry = '';

            const lt = textToProcess.lastIndexOf('<');
            if (lt >= 0) {
              const tail = textToProcess.slice(lt);
              if ('<think>'.startsWith(tail) || '</think>'.startsWith(tail)) {
                thinkCarry = tail;
                textToProcess = textToProcess.slice(0, lt);
              }
            }

            if (!inThinkTag && textToProcess.includes('<think>')) {
              const parts = textToProcess.split('<think>');
              assistantMsg.content += parts[0];
              inThinkTag = true;
              textToProcess = parts.slice(1).join('<think>');
            }

            if (inThinkTag) {
              if (textToProcess.includes('</think>')) {
                const parts = textToProcess.split('</think>');
                assistantMsg.reasoningContent = (assistantMsg.reasoningContent || '') + parts[0];
                inThinkTag = false;
                assistantMsg.content += parts.slice(1).join('</think>');
              } else {
                assistantMsg.reasoningContent =
                  (assistantMsg.reasoningContent || '') + textToProcess;
              }
            } else {
              assistantMsg.content += textToProcess;
            }
          }

          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            hasToolCalls = true;
            toolCallBuffers = chunk.toolCalls.map(
              (tc: { id: string; name: string; arguments: string }) => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              })
            );
          }

          agent.emitUpdateThrottled();
          iterResult = await iter.next();
        }

        if (thinkCarry) {
          if (inThinkTag) {
            assistantMsg.reasoningContent = (assistantMsg.reasoningContent || '') + thinkCarry;
          } else {
            assistantMsg.content += thinkCarry;
          }
          thinkCarry = '';
        }

        const streamUsage = (
          iterResult.value as { usage?: { input_tokens: number; output_tokens: number } }
        )?.usage;
        if (streamUsage) {
          agent.recordUsage(streamUsage);
          agent.contextManager.reportApiUsage(streamUsage);
        }

        if (signal?.aborted) {
          // Aborted mid-stream: never persist tool calls that were never
          // executed — dangling tool_calls poison the next request.
          delete assistantMsg.toolCalls;
          if (!assistantMsg.content.trim() && !assistantMsg.reasoningContent) {
            agent.messages = agent.messages.filter((m) => m.id !== assistantMsg.id);
          } else {
            agent.contextManager.addMessage(assistantMsg);
          }
          agent.setState('idle');
          agent.onUpdate?.();
          return;
        }

        if (hasToolCalls && toolCallBuffers.length > 0) {
          assistantMsg.toolCalls = toolCallBuffers;
          reasoningOnlyStreak = 0;
        }

        if (
          assistantMsg.toolCalls?.length &&
          assistantMsg.content.trim() === '' &&
          !assistantMsg.reasoningContent
        ) {
          const first = assistantMsg.toolCalls[0];
          const toolNames = assistantMsg.toolCalls
            .map((t) => t.name)
            .slice(0, 3)
            .join(', ');
          assistantMsg.content =
            toolNames.length > 0
              ? `I will use ${toolNames} to gather the needed context.`
              : `I will use a tool (${first?.name || 'tool'}) to gather the needed context.`;
        }

        const emptyOutput =
          !assistantMsg.toolCalls &&
          assistantMsg.content.trim() === '' &&
          !assistantMsg.reasoningContent;
        // OpenRouter/OpenAI silent overflow: finish_reason=length with 0 output tokens.
        // Without recovery, every subsequent turn stays empty and the agent looks "idle".
        // Only treat 0 completion tokens as overflow when usage was actually reported —
        // a missing usage block is not evidence of overflow.
        const zeroOut = streamUsage !== undefined && streamUsage.output_tokens === 0;
        const silentOverflow =
          emptyOutput && (finishReason === 'length' || (finishReason !== 'stop' && zeroOut));

        if (emptyOutput) {
          agent.messages = agent.messages.filter((m) => m.id !== assistantMsg.id);

          if (silentOverflow && overflowRetries < MAX_OVERFLOW_RETRIES) {
            if (isEndpointRateLimited(agent.cfg.baseURL)) {
              agent.addNoticeMessage(
                'Context overflow detected, but the provider is rate-limited — skipping extra retry. Wait a moment, then `/compact` or retry.'
              );
              agent.setState('idle');
              agent.onUpdate?.();
              return;
            }
            overflowRetries++;
            const compacted = agent.forceCompactContext();
            // Notice (not assistant): mid-loop assistant text poisons Bonsai/Qwen
            // chat templates and makes the retry return empty / stop.
            agent.addNoticeMessage(
              compacted
                ? `Context overflow detected (empty \`${finishReason || 'length'}\` finish). Compacted history and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
                : `Context overflow detected (empty \`${finishReason || 'length'}\` finish). Retrying with current history (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
            );
            agent.setState('thinking');
            agent.onUpdate?.();
            await new Promise((r) => setTimeout(r, 0));
            continue;
          }

          agent.addNoticeMessage(
            silentOverflow
              ? 'Context window appears full — the model returned an empty `length` finish. Run `/compact` or `/clear`, then try again.'
              : 'Model returned an empty response (no text or tool calls). Try again, or check the LLM server logs.'
          );
          agent.setState('idle');
          agent.onUpdate?.();
          return;
        }

        // Successful non-empty turn — reset overflow streak
        overflowRetries = 0;

        agent.contextManager.addMessage(assistantMsg);

        if (
          !assistantMsg.toolCalls &&
          assistantMsg.content.trim() === '' &&
          assistantMsg.reasoningContent
        ) {
          reasoningOnlyStreak++;
          if (reasoningOnlyStreak >= maxReasoningOnly) {
            agent.addNoticeMessage(
              `Model produced ${maxReasoningOnly} reasoning-only responses without tool calls. ` +
                `Try rephrasing your request or switching to a model that supports tool calling.`
            );
            agent.setState('error');
            agent.onUpdate?.();
            return;
          }
          if (isEndpointRateLimited(agent.cfg.baseURL)) {
            agent.addNoticeMessage(
              'Model produced a reasoning-only response while the provider is rate-limited — stopping extra retries.'
            );
            agent.setState('idle');
            agent.onUpdate?.();
            return;
          }
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }

        if (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) {
          reasoningOnlyStreak = 0;
          if (
            !isEndpointRateLimited(agent.cfg.baseURL) &&
            tryContinueAfterPrematureCheckin(assistantMsg.content)
          ) {
            await new Promise((r) => setTimeout(r, 0));
            continue;
          }
          agent.setState('idle');
          agent.onUpdate?.();
          return;
        }
      } catch (err: unknown) {
        const e = err as {
          status?: number;
          status_code?: number;
          message?: string;
          name?: string;
          providerMessage?: string;
          code?: string;
          type?: string;
        };
        const isAborted =
          signal?.aborted ||
          e.name === 'AbortError' ||
          e.message === 'Aborted' ||
          e.message?.toLowerCase().includes('abort');

        if (isAborted) {
          if (!assistantMsg.content.trim() && !assistantMsg.reasoningContent) {
            agent.messages = agent.messages.filter((m) => m.id !== assistantMsg.id);
          }
          agent.setState('idle');
          agent.onUpdate?.();
          return;
        }

        const switched = await switchSessionToFallback(agent, err, triedFallbacks, signal);
        if (switched) {
          agent.messages = agent.messages.filter((m) => m.id !== assistantMsg.id);
          agent.addNoticeMessage(`Switched to ${switched.model} after ${switched.reason}`);
          iterationCount -= 1;
          agent.setState('thinking');
          agent.onUpdate?.();
          continue;
        }

        const status = e.status || e.status_code;
        const msg = [e.message, e.providerMessage, e.code, e.type, String(err)].filter(Boolean).join(' ');
        const overflowHint =
          /context[\s_-]*(?:length|window|size)|maximum[\s_-]*(?:context|sequence)|too many tokens|prompt[\s_-]*(?:is\s*)?too long|input[\s_-]*(?:is\s*)?too long|token limit|context_length_exceeded/i.test(msg);
        if (overflowHint && overflowRetries < MAX_OVERFLOW_RETRIES) {
          if (isEndpointRateLimited(agent.cfg.baseURL)) {
            agent.messages = agent.messages.filter((m) => m.id !== assistantMsg.id);
            agent.addNoticeMessage(
              `Context overflow from API (${status || 'error'}), but the provider is rate-limited — skipping extra retry.`
            );
            agent.setState('idle');
            agent.onUpdate?.();
            return;
          }
          agent.messages = agent.messages.filter((m) => m.id !== assistantMsg.id);
          overflowRetries++;
          agent.forceCompactContext();
          agent.addNoticeMessage(
            `Context overflow from API (${status || 'error'}). Compacted and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
          );
          agent.setState('thinking');
          agent.onUpdate?.();
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }

        if (status === 401) {
          const envVar = agent.cfg.baseURL?.includes('mistral.ai')
            ? 'MISTRAL_API_KEY'
            : agent.cfg.baseURL?.includes('openrouter.ai')
              ? 'OPENROUTER_API_KEY'
              : 'your API key';
          assistantMsg.content = `${msg}\n\nMake sure ${envVar} is set correctly in your environment or use /connect to update it.`;
        } else {
          assistantMsg.content = `API error (${status || 'unknown'}): ${msg}`;
        }
        agent.contextManager.addMessage(assistantMsg);
        agent.setState('error');
        agent.onUpdate?.();
        return;
      }
    } else {
      // Non-streaming mode (context was already compact-checked at the top of the loop)
      let response: Awaited<ReturnType<typeof chat>>;

      try {
        const activeSkills = new Set(
          agent.skillManager
            .getAllWithStatus()
            .filter((s) => s.active)
            .map((s) => s.name)
        );
        response = await chat(
          agent.client,
          agent.cfg,
          agent.toChatMessages(),
          agent.buildToolSchemas(activeSkills),
          signal
        );
      } catch (err: unknown) {
        const e = err as {
          status?: number;
          status_code?: number;
          message?: string;
          name?: string;
          providerMessage?: string;
          code?: string;
          type?: string;
        };
        const isAborted =
          signal?.aborted ||
          e.name === 'AbortError' ||
          e.message === 'Aborted' ||
          e.message?.toLowerCase().includes('abort');

        if (isAborted) {
          agent.setState('idle');
          agent.onUpdate?.();
          return;
        }

        const switched = await switchSessionToFallback(agent, err, triedFallbacks, signal);
        if (switched) {
          agent.addNoticeMessage(`Switched to ${switched.model} after ${switched.reason}`);
          iterationCount -= 1;
          agent.setState('thinking');
          agent.onUpdate?.();
          continue;
        }

        const status = e.status || e.status_code;
        const msg = [e.message, e.providerMessage, e.code, e.type, String(err)].filter(Boolean).join(' ');
        const overflowHint =
          /context[\s_-]*(?:length|window|size)|maximum[\s_-]*(?:context|sequence)|too many tokens|prompt[\s_-]*(?:is\s*)?too long|input[\s_-]*(?:is\s*)?too long|token limit|context_length_exceeded/i.test(msg);
        if (overflowHint && overflowRetries < MAX_OVERFLOW_RETRIES) {
          if (isEndpointRateLimited(agent.cfg.baseURL)) {
            agent.addNoticeMessage(
              `Context overflow from API (${status || 'error'}), but the provider is rate-limited — skipping extra retry.`
            );
            agent.setState('idle');
            agent.onUpdate?.();
            return;
          }
          overflowRetries++;
          agent.forceCompactContext();
          agent.addNoticeMessage(
            `Context overflow from API (${status || 'error'}). Compacted and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
          );
          agent.setState('thinking');
          agent.onUpdate?.();
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }

        if (status === 401) {
          const envVar = agent.cfg.baseURL?.includes('mistral.ai')
            ? 'MISTRAL_API_KEY'
            : agent.cfg.baseURL?.includes('openrouter.ai')
              ? 'OPENROUTER_API_KEY'
              : 'your API key';
          agent.addNoticeMessage(
            `${msg}\n\nMake sure ${envVar} is set correctly in your environment or use /connect to update it.`
          );
        } else {
          agent.addNoticeMessage(`API error (${status || 'unknown'}): ${msg}`);
        }
        agent.setState('error');
        agent.onUpdate?.();
        return;
      }

      const msg = response.message;
      if (response.usage) {
        agent.recordUsage(response.usage);
        agent.contextManager.reportApiUsage(response.usage);
      }

      const emptyNonStream =
        (!msg.tool_calls || msg.tool_calls.length === 0) && !msg.content && !msg.reasoning_content;
      const zeroOut = response.usage !== undefined && response.usage.output_tokens === 0;
      const silentOverflow =
        emptyNonStream &&
        (response.finishReason === 'length' || (response.finishReason !== 'stop' && zeroOut));

      if (emptyNonStream) {
        if (silentOverflow && overflowRetries < MAX_OVERFLOW_RETRIES) {
          if (isEndpointRateLimited(agent.cfg.baseURL)) {
            agent.addNoticeMessage(
              'Context overflow detected, but the provider is rate-limited — skipping extra retry. Wait a moment, then `/compact` or retry.'
            );
            agent.setState('idle');
            agent.onUpdate?.();
            return;
          }
          overflowRetries++;
          const compacted = agent.forceCompactContext();
          agent.addNoticeMessage(
            compacted
              ? `Context overflow detected (empty \`${response.finishReason || 'length'}\` finish). Compacted history and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
              : `Context overflow detected. Retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
          );
          agent.setState('thinking');
          agent.onUpdate?.();
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }
        agent.addNoticeMessage(
          silentOverflow
            ? 'Context window appears full — the model returned an empty `length` finish. Run `/compact` or `/clear`, then try again.'
            : 'Model returned an empty response (no text or tool calls). Try again, or check the LLM server logs.'
        );
        agent.setState('idle');
        agent.onUpdate?.();
        return;
      }

      overflowRetries = 0;
      assistantMsg = {
        id: rnd(),
        role: 'assistant',
        content: msg.content || '',
        reasoningContent: msg.reasoning_content || undefined,
        timestamp: now(),
      };
      if (msg.tool_calls) {
        assistantMsg.toolCalls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
      }
      agent.messages.push(assistantMsg);
      agent.contextManager.addMessage(assistantMsg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (!msg.content && msg.reasoning_content) {
          reasoningOnlyStreak++;
          if (reasoningOnlyStreak >= maxReasoningOnly) {
            agent.addNoticeMessage(
              `Model produced ${maxReasoningOnly} reasoning-only responses without tool calls. ` +
                `Try rephrasing your request or switching to a model that supports tool calling.`
            );
            agent.setState('error');
            agent.onUpdate?.();
            return;
          }
          if (isEndpointRateLimited(agent.cfg.baseURL)) {
            agent.addNoticeMessage(
              'Model produced a reasoning-only response while the provider is rate-limited — stopping extra retries.'
            );
            agent.setState('idle');
            agent.onUpdate?.();
            return;
          }
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }
        if (
          !isEndpointRateLimited(agent.cfg.baseURL) &&
          tryContinueAfterPrematureCheckin(msg.content || '')
        ) {
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }
        agent.setState('idle');
        agent.onUpdate?.();
        return;
      }
    }

    if (signal?.aborted) {
      agent.setState('idle');
      agent.onUpdate?.();
      return;
    }

    const tcs = assistantMsg.toolCalls || [];

    if (tcs.length === 0) {
      agent.consecutiveToolRounds = 0;
      sameSignatureStreak = 0;
      lastToolSignature = undefined;
    } else {
      agent.consecutiveToolRounds++;

      // Stuck-loop guard: break when the model keeps issuing the exact same
      // tool calls round after round (mirrors the sub-agent worker guard).
      const signature = tcs.map((tc) => `${tc.name}(${tc.arguments})`).join('|');
      if (signature === lastToolSignature) {
        sameSignatureStreak++;
      } else {
        sameSignatureStreak = 1;
        lastToolSignature = signature;
      }
      if (sameSignatureStreak >= MAX_SAME_SIGNATURE_STREAK) {
        agent.addNoticeMessage(
          `⚠️ Stuck loop detected: the model issued the identical tool call(s) ${MAX_SAME_SIGNATURE_STREAK} rounds in a row. ` +
            `Stopping here to avoid an infinite loop — rephrase your request or take over manually.`
        );
        agent.setState('idle');
        agent.onUpdate?.();
        return;
      }

      const checkinLimit = agent.cfg.maxToolRoundsBeforeCheckin ?? 0;
      if (checkinLimit > 0 && agent.consecutiveToolRounds >= checkinLimit) {
        agent.consecutiveToolRounds = 0;
        const todoSummary =
          agent.todos.length > 0
            ? '\n\n**Task status:**\n' +
              agent.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')
            : '';
        agent.addAssistantMessage(
          `🔄 **Check-in with User** (${checkinLimit} continuous tool rounds completed):\n` +
            `I've completed several execution steps on your request.${todoSummary}\n\n` +
            `Pausing to confer with you before continuing. Would you like me to keep going, or do you have any feedback/adjustments?`
        );
        agent.setState('idle');
        agent.onUpdate?.();
        return;
      }
    }

    const { parallel, sequential } = groupToolsForParallelExecution(tcs);

    if (parallel.length > 0) {
      await agent.executeToolsParallel(parallel, signal);
    }

    for (const tc of sequential) {
      await agent.executeToolSequential(tc, signal);
    }

    // Yield so abort signals and TUI updates can process between tool rounds.
    await new Promise((r) => setTimeout(r, 0));
  }

  agent.setState('idle');
  agent.onUpdate?.();
}
