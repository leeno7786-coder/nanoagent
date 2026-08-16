import { streamChat } from '../../llm.js';
import type { ChatMessage } from '../../llm.js';
import { tools, toOpenAI } from '../../tools/index.js';
import type { ToolExecutionHooks, SubAgentProgressEvent } from '../../tools/index.js';
import type { SubAgentPoolConfig } from '../../types.js';
import { summarizeToolResult, type SubAgentResult } from '../format.js';
import type { WorkerContext } from './context.js';
import { buildWorkerContext } from './context.js';
import {
  initialWorkerTriedFallbacks,
  switchWorkerToFallback,
  workerFailureToFailoverError,
} from './failover.js';
import { SUBAGENT_TOOLS, runWorkerTool } from './tool-runner.js';
import { scheduler } from './scheduler.js';

const SUBAGENT_SYSTEM_PROMPT = `You are a sub-agent worker assisting the main coding agent.
You have a curated READ-ONLY tool set: read_file, batch_read_files, list_dir, map_project_tree, find_files, stat_path, grep_search, search_and_view.

## YOUR WORKFLOW

1. You have a specific question to answer about a codebase.
2. The FILE TREE is already provided in your context — DO NOT call list_dir, map_project_tree, or stat_path. Pick the relevant file paths directly from the tree.
3. Use batch_read_files to read MULTIPLE files in one call. You have a large context window — read entire files.
4. After reading the key files, write your structured report and STOP.

## RULES

- DO NOT call list_dir, map_project_tree, stat_path, or find_files — the file tree is already in your context.
- BATCH YOUR READS: call batch_read_files ONCE with all paths, not read_file one at a time.
- NEVER call read_file on the same file twice.
- NEVER run the same grep_search twice with minor tweaks. Move on.
- Use EXACT relative paths from the file tree (e.g. "src/agent.ts").
- No shell commands. No git. No writes.

## YOUR REPORT (required)

- **Task**: What you were asked to investigate
- **Key Findings**: Bullet points with file paths and line numbers
- **Issues**: Problems, bugs, or concerns (if unknown)
- **Recommendations**: Actionable next steps

Make it specific. File paths and line numbers are critical.`;

const DEFAULT_TURN_TIMEOUT_MS = 600000;

/**
 * Per-turn inactivity timeout for worker streams. Resolved per dispatch:
 * pool.turnTimeoutMs → NANOGENT_SUBAGENT_TURN_TIMEOUT_MS → 120s default.
 * Resets on every streamed chunk, so it only fires when the server goes
 * quiet (slow hosts need headroom for model load + prefill).
 */
function resolveTurnTimeoutMs(pool?: SubAgentPoolConfig): number {
  if (pool?.turnTimeoutMs && pool.turnTimeoutMs >= 10000) return pool.turnTimeoutMs;
  const env = Number(process.env.NANOGENT_SUBAGENT_TURN_TIMEOUT_MS);
  if (Number.isInteger(env) && env >= 10000) return env;
  return DEFAULT_TURN_TIMEOUT_MS;
}

async function runSingleSubAgent(
  wctx: WorkerContext,
  task: string,
  signal?: AbortSignal,
  hooks?: ToolExecutionHooks,
  turnTimeoutMs: number = DEFAULT_TURN_TIMEOUT_MS
): Promise<SubAgentResult> {
  const emit = (e: SubAgentProgressEvent) => hooks?.onSubAgentProgress?.(e);
  const start = performance.now();
  const messages: ChatMessage[] = [
    { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];
  const toolDefs = toOpenAI(
    tools.filter((t) => SUBAGENT_TOOLS.has(t.name)),
    wctx.cfg
  );
  let toolCallCount = 0;
  let duplicateStrikes = 0;
  const seenSignatures = new Set<string>();
  const readPaths = new Set<string>();
  const toolCallCounts = new Map<string, number>();
  const DISCOVERY_TOOLS = new Set(['list_dir', 'map_project_tree', 'stat_path', 'find_files']);
  const TOOL_BUDGET = 18;
  const triedFallbacks = initialWorkerTriedFallbacks(wctx.cfg);
  const failoverNotices: string[] = [];
  const withNotices = (output: string): string => {
    if (failoverNotices.length === 0) return output;
    const block = failoverNotices.join('\n');
    return output ? `${block}\n\n${output}` : block;
  };

  emit({
    type: 'subagent_start',
    agent: wctx.endpoint.name,
    model: wctx.cfg.model,
    task,
  });

  const maxIter = Math.min(wctx.cfg.maxIterations ?? 12, 24);

  for (let i = 0; i < maxIter; i++) {
    if (signal?.aborted) {
      emit({
        type: 'subagent_done',
        agent: wctx.endpoint.name,
        model: wctx.cfg.model,
        ok: false,
        output: withNotices(''),
        toolCalls: toolCallCount,
      });
      return {
        name: wctx.endpoint.name,
        model: wctx.cfg.model,
        baseURL: wctx.cfg.baseURL,
        ok: false,
        output: withNotices(''),
        durationMs: Math.round(performance.now() - start),
        error: 'aborted',
        toolCalls: toolCallCount,
      };
    }

    if (i === Math.floor(maxIter * 0.6) && toolCallCount > 0) {
      messages.push({
        role: 'user',
        content: `You are on turn ${i + 1} of ${maxIter}. Start writing your final report now. Use batch_read_files if you need to read more files, then summarize.`,
      });
    }
    if (i >= maxIter - 4 && toolCallCount > 0) {
      messages.push({
        role: 'user',
        content: `TURN ${i + 1}/${maxIter}: You are running low on turns. Finish reading and output your full report NOW. Do NOT start new searches.`,
      });
    }

    let accumulatedContent = '';
    let streamedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    const turnController = new AbortController();
    let turnTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      turnController.abort();
    }, turnTimeoutMs);

    const resetTurnTimer = () => {
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = setTimeout(() => {
        turnController.abort();
      }, turnTimeoutMs);
    };

    const onParentAbort = () => turnController.abort();
    if (signal) {
      if (signal.aborted) turnController.abort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }

    let streamError: string | undefined;
    let streamErr: unknown;
    let turnTimedOut = false;
    try {
      const stream = streamChat(wctx.client, wctx.cfg, messages, toolDefs, turnController.signal, {
        enableThinking: false,
        onRetry: (info) => {
          resetTurnTimer();
          emit({
            type: 'subagent_chunk',
            agent: wctx.endpoint.name,
            model: wctx.cfg.model,
            text: `\n[Rate limit retry (${info.status}): waiting ${(info.delayMs / 1000).toFixed(1)}s (attempt ${info.attempt}/${info.maxAttempts})]\n`,
          });
        },
      });

      for await (const chunk of stream) {
        resetTurnTimer();
        if (chunk.content) {
          accumulatedContent += chunk.content;
          emit({
            type: 'subagent_chunk',
            agent: wctx.endpoint.name,
            model: wctx.cfg.model,
            text: chunk.content,
          });
        }
        if (chunk.reasoningContent) {
          emit({
            type: 'subagent_chunk',
            agent: wctx.endpoint.name,
            model: wctx.cfg.model,
            reasoning: chunk.reasoningContent,
          });
        }
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          streamedToolCalls = chunk.toolCalls;
        }
      }
    } catch (e: unknown) {
      streamErr = e;
      if (turnController.signal.aborted) {
        // Per-turn inactivity timeout (or parent abort) fired mid-stream.
        turnTimedOut = true;
      } else {
        streamError = (e as { message?: string }).message || String(e);
      }
    } finally {
      if (turnTimer) clearTimeout(turnTimer);
      signal?.removeEventListener('abort', onParentAbort);
    }

    // An abort can end the stream WITHOUT throwing (the HTTP client unwinds
    // the SSE iterator quietly) — catch that here or a 60s timeout with zero
    // output would fall through as an empty ok:true "success".
    if (turnController.signal.aborted && !turnTimedOut && !streamError) {
      turnTimedOut = true;
    }

    if ((streamError || turnTimedOut) && !signal?.aborted) {
      const failoverErr = workerFailureToFailoverError({
        err: streamErr,
        turnTimedOut,
        parentAborted: false,
      });
      const noticeStart = failoverNotices.length;
      const switched = await switchWorkerToFallback(
        wctx,
        failoverErr,
        triedFallbacks,
        failoverNotices,
        signal
      );
      for (const n of failoverNotices.slice(noticeStart)) {
        emit({
          type: 'subagent_chunk',
          agent: wctx.endpoint.name,
          model: wctx.cfg.model,
          text: `\n[${n}]\n`,
        });
      }
      if (switched) {
        const notice = `Switched to ${switched.model} after ${switched.reason}`;
        failoverNotices.push(notice);
        emit({
          type: 'subagent_chunk',
          agent: wctx.endpoint.name,
          model: wctx.cfg.model,
          text: `\n[${notice}]\n`,
        });
        i -= 1;
        continue;
      }
    }

    if (turnTimedOut && !signal?.aborted) {
      emit({
        type: 'subagent_chunk',
        agent: wctx.endpoint.name,
        model: wctx.cfg.model,
        text: '\n[Sub-agent turn timed out — proceeding with gathered findings]\n',
      });
    } else if (streamError) {
      emit({
        type: 'subagent_chunk',
        agent: wctx.endpoint.name,
        model: wctx.cfg.model,
        text: `\n[Sub-agent stream error: ${streamError}]\n`,
      });
    }

    const msg = {
      role: 'assistant' as const,
      content: accumulatedContent,
      tool_calls: streamedToolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });
      const results = await Promise.all(
        msg.tool_calls.map(async (tc, index) => {
          const currentToolCallCount = toolCallCount + index + 1;
          const parsedArgs = tc.function.arguments;
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(String(parsedArgs));
          } catch {
            args = {};
          }
          const sig = `${tc.function.name}:${JSON.stringify(args)}`;
          const filePath = args?.path || args?.file;

          if (toolCallCount >= TOOL_BUDGET) {
            const budgetResult = JSON.stringify({
              ok: false,
              error: `Tool budget exhausted (${TOOL_BUDGET} calls). You MUST output your final report now using only the information you have already gathered.`,
            });
            emit({
              type: 'subagent_tool_result',
              agent: wctx.endpoint.name,
              model: wctx.cfg.model,
              tool: tc.function.name,
              toolArgs: String(parsedArgs),
              toolResult: `budget exhausted`,
              toolResultRaw: budgetResult,
              toolCalls: currentToolCallCount,
            });
            return { role: 'tool' as const, content: budgetResult, tool_call_id: tc.id };
          }

          if (seenSignatures.has(sig)) {
            duplicateStrikes++;
            const dupResult = JSON.stringify({
              ok: false,
              error: `Duplicate call blocked. You already ran ${tc.function.name} with these exact inputs. Output your final report now.`,
            });
            emit({
              type: 'subagent_tool_result',
              agent: wctx.endpoint.name,
              model: wctx.cfg.model,
              tool: tc.function.name,
              toolArgs: String(parsedArgs),
              toolResult: `${tc.function.name}: duplicate blocked`,
              toolResultRaw: dupResult,
              toolCalls: currentToolCallCount,
            });
            return { role: 'tool' as const, content: dupResult, tool_call_id: tc.id };
          }
          seenSignatures.add(sig);

          if (DISCOVERY_TOOLS.has(tc.function.name)) {
            const prev = toolCallCounts.get(tc.function.name) ?? 0;
            if (prev >= 1) {
              duplicateStrikes++;
              const dupResult = JSON.stringify({
                ok: false,
                error: `You already called ${tc.function.name} ${prev} time(s). You have the results. Do NOT call discovery tools again. Use batch_read_files to read the files you need, then write your report.`,
              });
              emit({
                type: 'subagent_tool_result',
                agent: wctx.endpoint.name,
                model: wctx.cfg.model,
                tool: tc.function.name,
                toolArgs: String(parsedArgs),
                toolResult: `${tc.function.name}: already called`,
                toolResultRaw: dupResult,
                toolCalls: currentToolCallCount,
              });
              return { role: 'tool' as const, content: dupResult, tool_call_id: tc.id };
            }
            toolCallCounts.set(tc.function.name, prev + 1);
          }

          if (tc.function.name === 'read_file' && typeof filePath === 'string') {
            if (readPaths.has(filePath)) {
              duplicateStrikes++;
              const reReadResult = JSON.stringify({
                ok: false,
                error: `File '${filePath}' was already read. Refer to its contents in conversation history and output your final report.`,
              });
              emit({
                type: 'subagent_tool_result',
                agent: wctx.endpoint.name,
                model: wctx.cfg.model,
                tool: tc.function.name,
                toolArgs: String(parsedArgs),
                toolResult: `${tc.function.name}: re-read blocked`,
                toolResultRaw: reReadResult,
                toolCalls: currentToolCallCount,
              });
              return { role: 'tool' as const, content: reReadResult, tool_call_id: tc.id };
            }
            readPaths.add(filePath);
          }
          if (tc.function.name === 'batch_read_files') {
            const batchPaths: string[] = (args?.paths as string[] | undefined) ?? [];
            for (const bp of batchPaths) {
              if (readPaths.has(bp)) {
                duplicateStrikes++;
                const reReadResult = JSON.stringify({
                  ok: false,
                  error: `File '${bp}' in batch_read_files was already read. Include its current content from conversation history.`,
                });
                emit({
                  type: 'subagent_tool_result',
                  agent: wctx.endpoint.name,
                  model: wctx.cfg.model,
                  tool: tc.function.name,
                  toolArgs: String(parsedArgs),
                  toolResult: `${tc.function.name}: re-read blocked`,
                  toolResultRaw: reReadResult,
                  toolCalls: currentToolCallCount,
                });
                return { role: 'tool' as const, content: reReadResult, tool_call_id: tc.id };
              }
            }
            for (const bp of batchPaths) readPaths.add(bp);
          }

          if (duplicateStrikes >= 3) {
            const stuckResult = JSON.stringify({
              ok: false,
              error:
                'You are stuck repeating calls. Stop all tool calls and output your final report NOW.',
            });
            emit({
              type: 'subagent_tool_result',
              agent: wctx.endpoint.name,
              model: wctx.cfg.model,
              tool: tc.function.name,
              toolArgs: String(parsedArgs),
              toolResult: `stuck — forced report`,
              toolResultRaw: stuckResult,
              toolCalls: currentToolCallCount,
            });
            return { role: 'tool' as const, content: stuckResult, tool_call_id: tc.id };
          }

          emit({
            type: 'subagent_tool',
            agent: wctx.endpoint.name,
            model: wctx.cfg.model,
            tool: tc.function.name,
            toolArgs: String(parsedArgs),
            toolCalls: currentToolCallCount,
          });
          const out = await runWorkerTool(wctx, {
            name: tc.function.name,
            arguments: String(parsedArgs),
            id: tc.id,
          });
          emit({
            type: 'subagent_tool_result',
            agent: wctx.endpoint.name,
            model: wctx.cfg.model,
            tool: tc.function.name,
            toolArgs: String(parsedArgs),
            toolResult: summarizeToolResult(tc.function.name, out),
            toolResultRaw: out,
            toolCalls: currentToolCallCount,
          });
          return {
            role: 'tool' as const,
            content: out,
            tool_call_id: tc.id,
          };
        })
      );

      toolCallCount += msg.tool_calls.length;
      messages.push(...results);

      continue;
    }

    const answer = msg.content || '';

    if (!answer) {
      // A worker exists to produce a report — an empty turn is never a
      // success, whether it errored, timed out, or the model quietly
      // returned nothing (e.g. reasoning-only models that burn the whole
      // token budget on reasoning_content and finish with empty content).
      const reason =
        streamError ??
        (turnTimedOut
          ? signal?.aborted
            ? 'aborted'
            : 'turn timed out'
          : 'model returned an empty response');
      emit({
        type: 'subagent_done',
        agent: wctx.endpoint.name,
        model: wctx.cfg.model,
        ok: false,
        output: withNotices(reason),
        toolCalls: toolCallCount,
      });
      return {
        name: wctx.endpoint.name,
        model: wctx.cfg.model,
        baseURL: wctx.cfg.baseURL,
        ok: false,
        output: withNotices(''),
        error: reason,
        durationMs: Math.round(performance.now() - start),
        toolCalls: toolCallCount,
      };
    }

    emit({
      type: 'subagent_done',
      agent: wctx.endpoint.name,
      model: wctx.cfg.model,
      ok: true,
      output: withNotices(answer),
      toolCalls: toolCallCount,
    });
    return {
      name: wctx.endpoint.name,
      model: wctx.cfg.model,
      baseURL: wctx.cfg.baseURL,
      ok: true,
      output: withNotices(answer),
      durationMs: Math.round(performance.now() - start),
      toolCalls: toolCallCount,
    };
  }

  const partial = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n')
    .trim();

  emit({
    type: 'subagent_done',
    agent: wctx.endpoint.name,
    model: wctx.cfg.model,
    ok: partial.length > 0,
    output: withNotices(partial),
    toolCalls: toolCallCount,
  });
  return {
    name: wctx.endpoint.name,
    model: wctx.cfg.model,
    baseURL: wctx.cfg.baseURL,
    ok: partial.length > 0,
    output: withNotices(partial),
    durationMs: Math.round(performance.now() - start),
    error: partial ? undefined : 'max iterations reached without a final answer',
    toolCalls: toolCallCount,
  };
}

/**
 * Run a single remote sub-agent (one endpoint) for a focused investigation.
 */
export async function exploreWithSubAgent(
  base: import('../../types.js').Config,
  pool: SubAgentPoolConfig,
  endpointName: string | undefined,
  task: string,
  signal?: AbortSignal,
  hooks?: ToolExecutionHooks
): Promise<SubAgentResult> {
  const endpoints = pool.endpoints.filter((e) => e.baseURL && e.model);
  if (endpoints.length === 0) {
    return {
      name: 'pool',
      model: '',
      baseURL: '',
      ok: false,
      output: '',
      durationMs: 0,
      error: 'no remote sub-agent endpoints configured',
      toolCalls: 0,
    };
  }
  const ep = await scheduler.acquire(endpoints, endpointName, 60000, signal);
  if (!ep) {
    return {
      name: endpointName || 'pool',
      model: '',
      baseURL: '',
      ok: false,
      output: '',
      durationMs: 0,
      error: 'all sub-agent workers are busy (timed out waiting for endpoint slot)',
      toolCalls: 0,
    };
  }
  try {
    const wctx = buildWorkerContext(ep, base);
    try {
      return await runSingleSubAgent(wctx, task, signal, hooks, resolveTurnTimeoutMs(pool));
    } finally {
      // The per-dispatch ToolCacheManager starts fs.watch handles on cached
      // dependencies — close them so each dispatch doesn't leak watchers.
      wctx.cache.stopAllWatchers();
    }
  } finally {
    scheduler.release(ep.name);
  }
}
