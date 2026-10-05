import { resolve } from 'path';

import { streamChat } from '../../llm/index.js';
import type { ChatMessage } from '../../llm/index.js';
import { normalizeStrictChatTemplate } from '../../llm/chat-template.js';
import { tools, toOpenAI } from '../../tools/index.js';
import type { ToolExecutionHooks, SubAgentProgressEvent } from '../../tools/index.js';
import type { SubAgentPoolConfig } from '../../types.js';
import { summarizeToolResult, type SubAgentResult } from '../format.js';
import { totalLanes } from '../pool.js';
import type { WorkerContext } from './context.js';
import { buildWorkerContext } from './context.js';
import {
  initialWorkerTriedFallbacks,
  switchWorkerToFallback,
  workerFailureToFailoverError,
} from './failover.js';
import { SUBAGENT_TOOLS, parseWorkerToolArguments, runWorkerTool } from './tool-runner.js';
import { buildWorkerSystemPrompt } from './prompt.js';
import { scheduler } from './scheduler.js';

const DEFAULT_TURN_TIMEOUT_MS = 600000;

/** Hard ceiling on worker turns regardless of what the pool configures. */
const MAX_WORKER_ITERATIONS = 24;

/** Canonicalize nested argument objects without dropping nested keys. */
export function canonicalizeToolArguments(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (input !== null && typeof input === 'object') {
      const source = input as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) result[key] = visit(source[key]);
      return result;
    }
    return input;
  };
  return JSON.stringify(visit(value)) ?? String(value);
}

/**
 * Canonical identity for the worker's "already read" set.
 *
 * Only used as a dedupe key — the raw argument is still what reaches the tool.
 * Resolving against the workspace collapses `src/a.ts`, `./src/a.ts`,
 * `a/../src/a.ts` and the absolute form onto one entry, which the raw string
 * did not. Normalization is pure string work, so this adds no I/O to the turn.
 */
export function readDedupKey(workspace: string, p: string): string {
  return resolve(workspace || process.cwd(), p.replace(/\\/g, '/'));
}

/**
 * Per-turn inactivity timeout for worker streams. Resolved per dispatch:
 * pool.turnTimeoutMs → NANOGENT_SUBAGENT_TURN_TIMEOUT_MS → 600s default
 * (matching the 600s local-provider HTTP timeout).
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
  turnTimeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
  scope: string[] = []
): Promise<SubAgentResult> {
  const emit = (e: SubAgentProgressEvent) => hooks?.onSubAgentProgress?.(e);
  const start = performance.now();
  // Assembled per dispatch: the endpoint kind, the model, and the caller's
  // scope all change what the worker should be told.
  const systemPrompt = buildWorkerSystemPrompt({
    model: wctx.cfg.model,
    baseURL: wctx.cfg.baseURL,
    scope,
    pool: wctx.pool,
  });
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];
  const toolDefs = toOpenAI(
    tools.filter((t) => SUBAGENT_TOOLS.has(t.name)),
    // The worker already applies its own read-only allowlist. Do not let the
    // main model-size filter remove batch_read_files and grep_search.
    { ...wctx.cfg, smallModelMode: false }
  );
  let toolCallCount = 0;
  let duplicateStrikes = 0;
  const seenSignatures = new Set<string>();
  const readPaths = new Set<string>();
  const toolCallCounts = new Map<string, number>();
  const DISCOVERY_TOOLS = new Set(['list_dir', 'map_project_tree', 'stat_path', 'find_files']);
  // Budgets live on the RESOLVED pool, not base.subagents — on the
  // auto-discovery path those are different objects.
  const TOOL_BUDGET = wctx.pool?.toolBudget ?? 18;
  // A worker is a bounded background task, not an autonomous turn: it MUST
  // have a hard iteration ceiling or a looping model would run forever with
  // no user watching. This is the one place a turn budget belongs.
  const maxIter = Math.min(wctx.pool?.maxIterations ?? 24, MAX_WORKER_ITERATIONS);
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

  let nudgedSummarize = false;

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

    // Two nudges can land on the same turn (e.g. maxIter 10 puts both the 60%
    // and the last-4 triggers on turn 7), which stacked two identical `user`
    // messages into the worker's history. Fire each at most once.
    if (!nudgedSummarize && i === Math.floor(maxIter * 0.6) && toolCallCount > 0) {
      nudgedSummarize = true;
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
    let streamFinishReason: string | undefined;

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
      // A batched worker round appends assistant(tool_calls=[a,b]) then
      // tool(a) tool(b). Qwen2.5/3.x Jinja only accepts a `tool` message whose
      // immediate predecessor is an assistant, so re-interleave before sending.
      const stream = streamChat(
        wctx.client,
        wctx.cfg,
        normalizeStrictChatTemplate(messages),
        toolDefs,
        turnController.signal,
        {
          enableThinking: false,
          onRetry: (info) => {
            resetTurnTimer();
            accumulatedContent = '';
            streamedToolCalls = [];
            streamFinishReason = undefined;
            emit({
              type: 'subagent_chunk',
              agent: wctx.endpoint.name,
              model: wctx.cfg.model,
              text: `\n[Rate limit retry (${info.status}): waiting ${(info.delayMs / 1000).toFixed(1)}s (attempt ${info.attempt}/${info.maxAttempts})]\n`,
            });
          },
        }
      );

      for await (const chunk of stream) {
        resetTurnTimer();
        if (chunk.finishReason) streamFinishReason = chunk.finishReason;
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

    // A timeout, transport failure, parent abort, or length finish can leave
    // only a prefix of a tool call. Never execute that partial invocation.
    if (streamError || turnTimedOut || signal?.aborted || streamFinishReason === 'length') {
      streamedToolCalls = [];
    }

    const msg: ChatMessage = {
      role: 'assistant' as const,
      content: accumulatedContent,
    };
    if (streamedToolCalls.length > 0) {
      msg.tool_calls = streamedToolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
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
          const args = parseWorkerToolArguments(parsedArgs);
          const canonicalArgs = canonicalizeToolArguments(args);
          const sig = `${tc.function.name}:${canonicalArgs}`;
          const filePath = args?.path || args?.file;

          if (toolCallCount + index >= TOOL_BUDGET) {
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

          // Key re-read detection on the RESOLVED path, not the raw argument string.
          // `src/a.ts`, `./src/a.ts` and the absolute form are one file but
          // three strings, so the raw-string key let a worker re-read a file it
          // already had — burning budget on a duplicate and confusing a 2B
          // model that is told it never re-reads.
          const readFileKey =
            typeof filePath === 'string' ? readDedupKey(wctx.cfg.workspace, filePath) : undefined;
          if (tc.function.name === 'read_file' && readFileKey) {
            if (readPaths.has(readFileKey)) {
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
            readPaths.add(readFileKey);
          }
          if (tc.function.name === 'batch_read_files') {
            const batchPaths: string[] = (args?.paths as string[] | undefined) ?? [];
            const batchKeys = batchPaths
              .filter((bp): bp is string => typeof bp === 'string')
              .map((bp) => readDedupKey(wctx.cfg.workspace, bp));
            for (let i = 0; i < batchKeys.length; i++) {
              if (readPaths.has(batchKeys[i]!)) {
                duplicateStrikes++;
                const reReadResult = JSON.stringify({
                  ok: false,
                  error: `File '${batchPaths[i]}' in batch_read_files was already read. Include its current content from conversation history.`,
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
            for (const key of batchKeys) readPaths.add(key);
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

      toolCallCount = Math.min(TOOL_BUDGET, toolCallCount + msg.tool_calls.length);
      messages.push(...results);

      continue;
    }

    const answer = msg.content || '';

    if (turnTimedOut || streamError) {
      const reason = streamError ?? (signal?.aborted ? 'aborted' : 'turn timed out');
      emit({
        type: 'subagent_done',
        agent: wctx.endpoint.name,
        model: wctx.cfg.model,
        ok: false,
        output: withNotices(`${answer}\n[Incomplete: ${reason}]`.trim()),
        toolCalls: toolCallCount,
      });
      return {
        name: wctx.endpoint.name,
        model: wctx.cfg.model,
        baseURL: wctx.cfg.baseURL,
        ok: false,
        output: withNotices(answer),
        error: reason,
        durationMs: Math.round(performance.now() - start),
        toolCalls: toolCallCount,
      };
    }

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

/** Per-dispatch options that shape the worker's prompt. */
export interface ExploreOptions {
  /**
   * Concrete paths the caller named. They are already expanded into the task
   * context; they are repeated in the system prompt's SCOPE section so the
   * worker reads them first rather than treating them as one more sentence.
   */
  scope?: string[];
}

/**
 * How long a dispatch waits for a free lane.
 *
 * This used to be a flat 60s, which was fine only while fan-out equalled the
 * lane count — nothing ever queued. Now that the main agent may dispatch more
 * avenues than there are lanes, a queued worker can wait longer than any single
 * worker legitimately runs, and the flat 60s failed it with "all sub-agent
 * workers are busy". The wait is therefore bounded by the worker's own request
 * budget: you should never wait longer for a slot than the work you are waiting
 * for is allowed to take.
 */
function resolveQueueWaitMs(pool: SubAgentPoolConfig | undefined): number {
  const configured = pool?.timeoutMs ?? 900_000;
  return Math.max(60_000, configured);
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
  hooks?: ToolExecutionHooks,
  options?: ExploreOptions
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
  // Global in-flight cap is the pool's TOTAL LANES (hardware), never the
  // fan-out count. Passing fan-out here would let N avenues exceed the lanes
  // and re-introduce the "queued workers time out" problem.
  const lanes = Math.max(1, totalLanes(pool));
  const ep = await scheduler.acquire(
    endpoints,
    endpointName,
    resolveQueueWaitMs(pool),
    signal,
    lanes
  );
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
    const wctx = buildWorkerContext(ep, base, pool);
    try {
      return await runSingleSubAgent(
        wctx,
        task,
        signal,
        hooks,
        resolveTurnTimeoutMs(pool),
        options?.scope ?? []
      );
    } finally {
      // The per-dispatch ToolCacheManager starts fs.watch handles on cached
      // dependencies — close them so each dispatch doesn't leak watchers.
      wctx.cache.stopAllWatchers();
    }
  } finally {
    scheduler.release(ep);
  }
}
