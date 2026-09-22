import type { AgentCore } from './core.js';
import { chat, streamChat, isEndpointRateLimited } from '../llm/index.js';
import { switchSessionToFallback } from '../llm/failover.js';
import { canRunInParallel } from '../tools/index.js';
import { SkillManager } from '../skill-manager.js';
import type { Config, Message } from '../types.js';
import { rnd, now } from '../agent-utils.js';
import { logError } from '../log.js';
import { EARLY_STOP_CONTINUE_NUDGE, looksLikePrematureCheckin } from './early-stop.js';
import { createToolRepeatState, DUPLICATE_TOOL_NUDGE } from './tool-repeat.js';
import {
  capToolArgumentsForLlm,
  resolveToolCallArgumentTokenBudget,
} from '../llm/tool-result-budget.js';
import { parseXmlToolCalls } from '../llm/tool-call-parser.js';
import { isContextOverflowError } from '../llm/overflow.js';
import { maybePromoteProseQuestion } from '../tools/question-prose.js';
import { syncContextManagerMessages } from '../agent-messages.js';

const DEFAULT_MAX_REASONING_ONLY = 5;
/** Small models rarely recover from reasoning-only turns — stop them sooner. */
const SMALL_MODEL_MAX_REASONING_ONLY = 3;
/**
 * Hidden nudge injected after a reasoning-only turn. Without it the retry
 * re-sends identical history (reasoning-only turns are stripped from the
 * payload), so small models deterministically regenerate the same analysis.
 */
const REASONING_ONLY_NUDGE =
  'Your last reply contained only internal reasoning — no visible answer and no tool calls. ' +
  'Respond now with normal message content: either make the tool calls needed to continue ' +
  'the task, or write the actual answer. Do not repeat the analysis.';
/** Only recover when the model barely started (≤ N tool rounds). */
const EARLY_STOP_MAX_TOOL_ROUNDS = 2;
/** Cap auto-continues per run so we never loop forever on check-ins. */
const EARLY_STOP_MAX_CONTINUES = 2;
/**
 * Output-cap escalation ceiling for reasoning-only turns. A thinking model
 * that burns the whole completion budget mid-thought (finish_reason=length,
 * no content) cannot recover from a nudge alone — the retry thinks the same
 * thought and truncates at the same point. Double the budget up to this
 * ceiling instead.
 */
const REASONING_ONLY_OUTPUT_CAP_CEILING = 32768;

/** Remove or trim tool calls that did not receive a result before a run stops. */
function reconcileAssistantToolCalls(agent: AgentCore, assistantMsg: Message): void {
  const calls = assistantMsg.toolCalls;
  if (!calls || calls.length === 0) {
    if (calls) delete assistantMsg.toolCalls;
    return;
  }

  const resultIds = new Set(
    agent.messages
      .filter((message) => message.role === 'tool' && message.toolCallId)
      .map((message) => message.toolCallId as string)
  );
  const completed = calls.filter((call) => resultIds.has(call.id));
  if (completed.length > 0) assistantMsg.toolCalls = completed;
  else delete assistantMsg.toolCalls;

  const tracked = agent.contextManager
    .getMessages()
    .some((message) => message.id === assistantMsg.id);
  if (tracked) {
    if (assistantMsg.toolCalls?.length) agent.contextManager.updateMessage(assistantMsg);
    else if (assistantMsg.content.trim() || assistantMsg.reasoningContent) {
      agent.contextManager.updateMessage(assistantMsg);
    } else {
      agent.messages = agent.messages.filter((message) => message.id !== assistantMsg.id);
      syncContextManagerMessages(agent);
    }
  } else if (
    !assistantMsg.toolCalls?.length &&
    !assistantMsg.content.trim() &&
    !assistantMsg.reasoningContent
  ) {
    agent.messages = agent.messages.filter((message) => message.id !== assistantMsg.id);
  }
}

function finishAbortedRun(agent: AgentCore, assistantMsg?: Message): void {
  if (assistantMsg) reconcileAssistantToolCalls(agent, assistantMsg);
  agent.currentTool = undefined;
  agent.setState('idle');
  agent.onUpdate?.();
}

export async function agentRun(
  agent: AgentCore,
  userText: string,
  signal?: AbortSignal
): Promise<void> {
  agent.setState('thinking');
  agent.roundCounter = 0;

  // Per-turn state. Declared up front so the user-message reset path can
  // clear them safely before the first loop iteration.
  let earlyStopContinues = 0;
  const isOpenEndedInspectionTask =
    /\b(?:review|audit|codebase|repository|repo|inspect|explore|investigate)\b/i.test(userText);

  const maxReasoningOnly =
    agent.cfg.maxReasoningOnlyRounds !== undefined
      ? agent.cfg.maxReasoningOnlyRounds > 0
        ? agent.cfg.maxReasoningOnlyRounds
        : Infinity // explicit 0 = disable reasoning-only cap (never stop for reasoning-only)
      : agent._smallModel
        ? SMALL_MODEL_MAX_REASONING_ONLY
        : DEFAULT_MAX_REASONING_ONLY;
  /** Cumulative cap (streak resets on healthy turns; total does not) so
   *  alternating reasoning-only/tool-call loops still terminate. */
  const maxReasoningOnlyTotal = maxReasoningOnly === Infinity ? Infinity : maxReasoningOnly * 2;

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
    agent.setState('idle');
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
      agent.consecutiveToolRounds = 0;
      agent.toolRepeat = createToolRepeatState();
      earlyStopContinues = 0;
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
    agent.setState('idle');
    return;
  }

  if (trimmed === '/skills' || trimmed === '/skill') {
    const all = sm.getAllWithStatus();
    const lines = ['## Available Skills', ''];
    for (const s of all) {
      lines.push(`- /skill:${s.name} — ${s.description}${s.active ? ' (active)' : ''}`);
    }
    agent.addAssistantMessage(lines.join('\n'));
    agent.setState('idle');
    return;
  }

  if (trimmed === '/subagents') {
    const pool = await agent.getSubAgentPool();
    if (!pool) {
      agent.addAssistantMessage(
        'No remote sub-agent pool configured. Set `subagents` in the canonical config or set REMOTE_LMSTUDIO_URL.'
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
        'No MCP servers configured. Add `mcp` to the canonical config.\n\n' +
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
    agent.toolRepeat = createToolRepeatState();
    earlyStopContinues = 0;
    agent.addUserMessage(userText);
  }

  let iterationCount = 0;
  let toolRoundCount = 0;
  let reasoningOnlyStreak = 0;
  let reasoningOnlyTotal = 0;
  /** Raised only for requests in this user turn; never mutates cfg.maxTokens. */
  let reasoningOutputCapOverride: number | undefined;
  /** Retries after silent context overflow (finish_reason=length, 0 output). */
  let overflowRetries = 0;
  const MAX_OVERFLOW_RETRIES = 2;

  async function compactForActiveRun(): Promise<boolean> {
    const previous = agent._allowRunCompaction;
    agent._allowRunCompaction = true;
    try {
      return await agent.checkAndCompactContext(signal);
    } finally {
      agent._allowRunCompaction = previous;
    }
  }

  async function compactIfWindowFull(): Promise<boolean> {
    if (!agent.contextManager.needsCompaction()) return false;
    return compactForActiveRun();
  }
  /**
   * Force-thinking-off escalation counter. When nudges can't break a
   * reasoning-only loop, the next retry sends `enableThinking: false` so
   * the model can't burn the output budget on a thinking block. Capped at
   * the same ceiling as the nudges so a stuck model still terminates.
   * Reset on any turn that produces content or tool calls.
   */
  let forceThinkingOffRetries = 0;
  const MAX_FORCE_THINKING_OFF_RETRIES = 2;
  /** Stuck-loop guard: consecutive rounds issuing identical tool-call signatures. */
  let lastToolSignature: string | undefined;
  let sameSignatureStreak = 0;
  const MAX_SAME_SIGNATURE_STREAK = 3;
  /** Consecutive rounds where every tool was a duplicate block. */
  let allDuplicateRoundStreak = 0;
  const MAX_ALL_DUPLICATE_ROUNDS = 2;
  let duplicateNudged = false;
  /** Each configured fallback is tried at most once per user turn. */
  const triedFallbacks = new Set<string>();
  const activeFailoverSession = {
    get cfg(): Config {
      return agent.cfg;
    },
    reconfigure: (patch: Partial<Config>) => agent._reconfigureDuringRun(patch),
    addNoticeMessage: (content: string) => agent.addNoticeMessage(content),
  };

  const tryContinueAfterPrematureCheckin = (content: string): boolean => {
    if (earlyStopContinues >= EARLY_STOP_MAX_CONTINUES) return false;
    if (agent.consecutiveToolRounds <= 0 && !isOpenEndedInspectionTask) return false;
    if (agent.consecutiveToolRounds > EARLY_STOP_MAX_TOOL_ROUNDS) return false;
    if (!looksLikePrematureCheckin(content)) return false;
    earlyStopContinues++;
    agent.addRecoveryNotice(
      `↻ Model paused to ask for direction after ${agent.consecutiveToolRounds} tool round(s) — continuing the task…`
    );
    agent.addNudgeMessage(EARLY_STOP_CONTINUE_NUDGE);
    agent.setState('thinking');
    agent.onUpdate?.();
    return true;
  };

  /**
   * Reasoning-only turn (thinking but no visible content or tool calls).
   * Nudges the model so the retry sees new context — re-sending identical
   * history makes small models regenerate the same analysis forever.
   * When the turn was cut off by the output cap (finish_reason=length), the
   * model burned the whole completion budget mid-thought — a nudge alone
   * can't help, so the output cap is doubled first (up to a ceiling).
   *
   * If nudges still don't break the loop after the configured cap, the
   * next retry is escalated with `enableThinking: false` (set on the
   * chat request so the model can't keep thinking — see
   * `streamChat`/`chat` options below). That bypasses any stubborn
   * reasoning-only behavior at the cost of a non-thinking response.
   */
  const handleReasoningOnlyTurn = (finishReason?: string): 'continue' | 'error' | 'stop' => {
    reasoningOnlyStreak++;
    reasoningOnlyTotal++;
    if (finishReason === 'length') {
      const cur = reasoningOutputCapOverride ?? agent.cfg.maxTokens ?? 0;
      if (cur > 0 && cur < REASONING_ONLY_OUTPUT_CAP_CEILING) {
        const next = Math.min(cur * 2, REASONING_ONLY_OUTPUT_CAP_CEILING);
        reasoningOutputCapOverride = next;
        agent.addRecoveryNotice(
          `↻ Model spent its whole ${cur}-token output budget on thinking and never replied. ` +
            `Raised the output cap to ${next} and nudging it to answer (${reasoningOnlyStreak}/${maxReasoningOnly})…`
        );
        agent.addNudgeMessage(REASONING_ONLY_NUDGE);
        agent.setState('thinking');
        agent.onUpdate?.();
        return 'continue';
      }
    }
    if (isEndpointRateLimited(agent.cfg.baseURL)) {
      agent.addNoticeMessage(
        'Model produced a reasoning-only response while the provider is rate-limited — stopping extra retries.'
      );
      return 'stop';
    }
    if (reasoningOnlyStreak >= maxReasoningOnly || reasoningOnlyTotal >= maxReasoningOnlyTotal) {
      if (forceThinkingOffRetries < MAX_FORCE_THINKING_OFF_RETRIES) {
        forceThinkingOffRetries++;
        agent.addRecoveryNotice(
          `↻ Nudges didn't break the reasoning-only loop. ` +
            `Forcing thinking off for the next retry (${forceThinkingOffRetries}/${MAX_FORCE_THINKING_OFF_RETRIES}) so the model can't keep thinking.`
        );
        agent.addNudgeMessage(REASONING_ONLY_NUDGE);
        agent.setState('thinking');
        agent.onUpdate?.();
        return 'continue';
      }
      agent.addNoticeMessage(
        `Model produced ${reasoningOnlyTotal} reasoning-only responses without tool calls ` +
          `and the force-thinking-off retry also failed. ` +
          `Try rephrasing your request, raising maxTokens, or switching to a model that supports tool calling.`
      );
      return 'error';
    }
    agent.addRecoveryNotice(
      `↻ Model produced thinking only — no reply or tool calls. Nudging it to respond (${reasoningOnlyStreak}/${maxReasoningOnly})…`
    );
    agent.addNudgeMessage(REASONING_ONLY_NUDGE);
    agent.setState('thinking');
    agent.onUpdate?.();
    return 'continue';
  };
  while (true) {
    if (signal?.aborted) {
      finishAbortedRun(agent);
      return;
    }

    // Max rounds limits model requests; maxIterations limits executed tool
    // rounds and still permits the follow-up answer after the final round.
    const maxIter = agent.cfg.maxIterations > 0 ? agent.cfg.maxIterations : Infinity;
    const maxRnd = agent.maxRounds > 0 ? agent.maxRounds : Infinity;
    if (Number.isFinite(maxRnd) && iterationCount > maxRnd) {
      const label = `Round limit reached (${maxRnd} rounds)`;
      agent.addNoticeMessage(`${label}. Resuming on your next prompt.`);
      agent.setState('idle');
      agent.onUpdate?.();
      return;
    }

    if (iterationCount > 0 && (agent.cfg.rateLimitMs ?? 0) > 0) {
      await new Promise((r) => setTimeout(r, agent.cfg.rateLimitMs));
    }
    iterationCount++;
    agent.roundCounter++;

    await compactForActiveRun();

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
            // Reasoning-only loop escalation: stop the model from thinking
            // entirely so it can't burn the output budget again. Reset on
            // any turn that produces content or tool calls (see below).
            ...(forceThinkingOffRetries > 0 ? { enableThinking: false as const } : {}),
            ...(reasoningOutputCapOverride !== undefined
              ? { maxTokens: reasoningOutputCapOverride }
              : {}),
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
                // The text after </think> in this chunk may itself open a new
                // think block — re-enter the loop instead of treating it as
                // plain content.
                textToProcess = parts.slice(1).join('</think>');
                if (textToProcess.includes('<think>')) {
                  const inner = textToProcess.split('<think>');
                  assistantMsg.content += inner[0];
                  inThinkTag = true;
                  textToProcess = inner.slice(1).join('<think>');
                } else {
                  assistantMsg.content += textToProcess;
                }
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
                arguments: (() => {
                  const budget = resolveToolCallArgumentTokenBudget(agent.cfg);
                  return budget > 0
                    ? capToolArgumentsForLlm(tc.name, tc.arguments, {
                        maxTokens: budget,
                        modelId: agent.cfg.model,
                      })
                    : tc.arguments;
                })(),
              })
            );
          }

          const parsedFromStream = parseXmlToolCalls(assistantMsg.content || '');
          if (!hasToolCalls && parsedFromStream.toolCalls.length > 0) {
            hasToolCalls = true;
            assistantMsg.content = parsedFromStream.content;
            toolCallBuffers = parsedFromStream.toolCalls.map((tc, idx) => ({
              id: `call_${idx}_${Math.random().toString(36).slice(2, 10)}`,
              name: tc.name,
              arguments: (() => {
                const budget = resolveToolCallArgumentTokenBudget(agent.cfg);
                return budget > 0
                  ? capToolArgumentsForLlm(tc.name, tc.arguments, {
                      maxTokens: budget,
                      modelId: agent.cfg.model,
                    })
                  : tc.arguments;
              })(),
            }));
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
          finishAbortedRun(agent);
          return;
        }

        // A length finish can contain a complete-looking prefix of a tool
        // call. Treat it as an incomplete answer, never as executable work.
        if (finishReason === 'length') {
          hasToolCalls = false;
          toolCallBuffers = [];
          delete assistantMsg.toolCalls;
        }

        if (hasToolCalls && toolCallBuffers.length > 0) {
          const argBudget = resolveToolCallArgumentTokenBudget(agent.cfg);
          if (argBudget > 0) {
            assistantMsg.toolCalls = toolCallBuffers.map((tc) => ({
              ...tc,
              arguments: capToolArgumentsForLlm(tc.name, tc.arguments, {
                maxTokens: argBudget,
                modelId: agent.cfg.model,
              }),
            }));
          } else {
            assistantMsg.toolCalls = toolCallBuffers;
          }
          reasoningOnlyStreak = 0;
          // Successful tool call: stop nudging for the rest of the run,
          // but do NOT clear the force-thinking-off escalation — once
          // triggered, it persists for the rest of this user turn so a
          // stubborn reasoning-only model can't alternate between
          // thinking-only and tool-call turns forever. The escalation
          // resets when the user issues a new prompt (fresh agentRun).
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
            const compacted = await compactIfWindowFull();
            agent.addRecoveryNotice(
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
            silentOverflow && agent.contextManager.needsCompaction()
              ? 'Context window appears full — the model returned an empty `length` finish. Run `/compact` or `/clear`, then try again.'
              : 'Model returned an empty response (no text or tool calls). Try again, or check the LLM server logs.'
          );
          agent.setState('idle');
          agent.onUpdate?.();
          return;
        }

        // Successful non-empty turn — reset overflow streak
        overflowRetries = 0;

        // Route A/B/C chat quizzes through the real question tool (TUI overlay).
        maybePromoteProseQuestion(assistantMsg);

        agent.contextManager.addMessage(assistantMsg);

        if (
          !assistantMsg.toolCalls &&
          assistantMsg.content.trim() === '' &&
          assistantMsg.reasoningContent
        ) {
          const action = handleReasoningOnlyTurn(finishReason);
          if (action !== 'continue') {
            agent.setState(action === 'error' ? 'error' : 'idle');
            agent.onUpdate?.();
            return;
          }
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }

        if (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) {
          reasoningOnlyStreak = 0;
          // Same as the tool-call branch: a visible reply breaks the
          // reasoning-only streak, but the force-thinking-off escalation
          // (if active) persists for the rest of the user turn.
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
          delete assistantMsg.toolCalls;
          if (!assistantMsg.content.trim() && !assistantMsg.reasoningContent) {
            agent.messages = agent.messages.filter((m) => m.id !== assistantMsg.id);
          } else if (!agent.contextManager.getMessages().some((m) => m.id === assistantMsg.id)) {
            agent.contextManager.addMessage(assistantMsg);
          }
          finishAbortedRun(agent);
          return;
        }

        // streamChat may have yielded a partial tool-call snapshot before the
        // final transport error. It is never executable or safe to persist.
        delete assistantMsg.toolCalls;

        const switched = await switchSessionToFallback(
          activeFailoverSession,
          err,
          triedFallbacks,
          signal
        );
        if (switched) {
          agent.messages = agent.messages.filter((m) => m.id !== assistantMsg.id);
          agent.addRecoveryNotice(`Switched to ${switched.model} after ${switched.reason}`);
          iterationCount -= 1;
          agent.setState('thinking');
          agent.onUpdate?.();
          continue;
        }

        const status = e.status || e.status_code;
        const msg = agent.securityManager.sanitizeOutput(
          [e.message, e.providerMessage, e.code, e.type, String(err)].filter(Boolean).join(' '),
          agent.cfg.apiKey ?? undefined
        );
        const overflowHint = isContextOverflowError(msg);
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
          await compactIfWindowFull();
          agent.addRecoveryNotice(
            `Context overflow from API (${status || 'error'}). Compacted and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
          );
          agent.setState('thinking');
          agent.onUpdate?.();
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }

        // C4 recovery: rebuild SDK client on sticky 5xx before surfacing error.
        if (status === 500 || status === 502 || status === 503 || status === 504) {
          const { createClient } = await import('../llm/index.js');
          agent.client = createClient(agent.cfg);
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
          signal,
          forceThinkingOffRetries > 0 || reasoningOutputCapOverride !== undefined
            ? {
                ...(forceThinkingOffRetries > 0 ? { enableThinking: false as const } : {}),
                ...(reasoningOutputCapOverride !== undefined
                  ? { maxTokens: reasoningOutputCapOverride }
                  : {}),
              }
            : undefined
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
          finishAbortedRun(agent);
          return;
        }

        const switched = await switchSessionToFallback(
          activeFailoverSession,
          err,
          triedFallbacks,
          signal
        );
        if (switched) {
          agent.addRecoveryNotice(`Switched to ${switched.model} after ${switched.reason}`);
          iterationCount -= 1;
          agent.setState('thinking');
          agent.onUpdate?.();
          continue;
        }

        const status = e.status || e.status_code;
        const msg = agent.securityManager.sanitizeOutput(
          [e.message, e.providerMessage, e.code, e.type, String(err)].filter(Boolean).join(' '),
          agent.cfg.apiKey ?? undefined
        );
        const overflowHint = isContextOverflowError(msg);
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
          await compactIfWindowFull();
          agent.addRecoveryNotice(
            `Context overflow from API (${status || 'error'}). Compacted and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
          );
          agent.setState('thinking');
          agent.onUpdate?.();
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }

        if (status === 500 || status === 502 || status === 503 || status === 504) {
          const { createClient } = await import('../llm/index.js');
          agent.client = createClient(agent.cfg);
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
          if (agent.contextManager.needsCompaction()) {
            overflowRetries++;
            const compacted = await compactIfWindowFull();
            agent.addRecoveryNotice(
              compacted
                ? `Context overflow detected (empty \`${response.finishReason || 'length'}\` finish). Compacted history and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
                : `Context overflow detected. Retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES})…`
            );
            agent.setState('thinking');
            agent.onUpdate?.();
            await new Promise((r) => setTimeout(r, 0));
            continue;
          }
        }
        agent.addNoticeMessage(
          silentOverflow && agent.contextManager.needsCompaction()
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
      if (msg.tool_calls && msg.tool_calls.length > 0 && response.finishReason !== 'length') {
        const argBudget = resolveToolCallArgumentTokenBudget(agent.cfg);
        assistantMsg.toolCalls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments:
            argBudget > 0
              ? capToolArgumentsForLlm(tc.function.name, tc.function.arguments, {
                  maxTokens: argBudget,
                  modelId: agent.cfg.model,
                })
              : tc.function.arguments,
        }));
      }
      maybePromoteProseQuestion(assistantMsg);
      agent.messages.push(assistantMsg);
      agent.contextManager.addMessage(assistantMsg);

      if (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) {
        if (!msg.content && msg.reasoning_content) {
          const action = handleReasoningOnlyTurn(response.finishReason);
          if (action !== 'continue') {
            agent.setState(action === 'error' ? 'error' : 'idle');
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
      finishAbortedRun(agent, assistantMsg);
      return;
    }

    const tcs = assistantMsg.toolCalls || [];

    if (tcs.length > 0 && Number.isFinite(maxIter) && toolRoundCount >= maxIter) {
      agent.addNoticeMessage(
        `Tool iteration limit reached (${maxIter} iterations). Resuming on your next prompt.`
      );
      reconcileAssistantToolCalls(agent, assistantMsg);
      agent.setState('idle');
      agent.onUpdate?.();
      return;
    }

    if (tcs.length === 0) {
      agent.consecutiveToolRounds = 0;
      sameSignatureStreak = 0;
      lastToolSignature = undefined;
      allDuplicateRoundStreak = 0;
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
        agent.addRecoveryNotice(
          `⚠️ Stuck loop detected: the model issued the identical tool call(s) ${MAX_SAME_SIGNATURE_STREAK} rounds in a row. ` +
            `Stopping here to avoid an infinite loop — rephrase your request or take over manually.`
        );
        reconcileAssistantToolCalls(agent, assistantMsg);
        agent.setState('idle');
        agent.onUpdate?.();
        return;
      }

      const checkinLimit = agent.cfg.maxToolRoundsBeforeCheckin ?? 0;
      if (checkinLimit > 0 && agent.consecutiveToolRounds >= checkinLimit) {
        agent.consecutiveToolRounds = 0;
        reconcileAssistantToolCalls(agent, assistantMsg);
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

    agent.toolRepeat.blockedThisRound = 0;
    // Execute contiguous read-only groups in parallel, but keep group order
    // around sequential tools so tool-result messages match assistant order.
    let parallelBatch: Array<{
      name: string;
      arguments: string;
      index: number;
      id: string;
    }> = [];
    const flushParallel = async (): Promise<void> => {
      if (parallelBatch.length > 0) {
        const batch = parallelBatch;
        parallelBatch = [];
        await agent.executeToolsParallel(batch, signal);
      }
    };

    for (const [index, tc] of tcs.entries()) {
      if (signal?.aborted) {
        finishAbortedRun(agent, assistantMsg);
        return;
      }
      if (canRunInParallel(tc.name)) {
        parallelBatch.push({ ...tc, index });
      } else {
        await flushParallel();
        await agent.executeToolSequential({ ...tc, id: tc.id }, signal);
      }
    }
    await flushParallel();

    if (tcs.length > 0) toolRoundCount++;

    if (signal?.aborted) {
      finishAbortedRun(agent, assistantMsg);
      return;
    }

    if (tcs.length > 0) {
      if (agent.toolRepeat.blockedThisRound > 0 && !duplicateNudged) {
        duplicateNudged = true;
        agent.addRecoveryNotice(
          '↻ Repeated discovery tools blocked — asking the model to write findings…'
        );
        agent.addNudgeMessage(DUPLICATE_TOOL_NUDGE);
      }
      if (agent.toolRepeat.blockedThisRound >= tcs.length) {
        allDuplicateRoundStreak++;
        if (allDuplicateRoundStreak >= MAX_ALL_DUPLICATE_ROUNDS) {
          agent.addRecoveryNotice(
            `⚠️ Stuck loop detected: the model kept re-issuing tools it already ran ` +
              `(git_status / git_diff / the same reads). Stopping here to avoid circling — ` +
              `rephrase your request or take over manually.`
          );
          agent.setState('idle');
          agent.onUpdate?.();
          return;
        }
      } else {
        allDuplicateRoundStreak = 0;
      }
    }

    agent.setState('thinking');
    agent.onUpdate?.();
    // Yield so abort signals and TUI updates can process between tool rounds.
    await new Promise((r) => setTimeout(r, 0));
  }

  agent.setState('idle');
  agent.onUpdate?.();
}
