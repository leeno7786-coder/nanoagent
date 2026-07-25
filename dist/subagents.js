/**
 * Remote sub-agent pool executor.
 *
 * The main agent can fan out work to a pool of remote models (e.g. three
 * Qwen3.5-2B instances loaded on another device's LM Studio). Each endpoint
 * becomes one parallel worker that gets the FULL local tool set (file read /
 * write, search, shell) against the same workspace, so sub-agents can actually
 * investigate and act — not just answer prompts.
 *
 * Results are collected in parallel and returned to the main agent as a single
 * tool result it can synthesise.
 */
import { createClient, streamChat } from './llm.js';
import { tools, toOpenAI, findTool, } from './tools/index.js';
import { createSecurityManager } from './security/index.js';
import { createToolCacheManager } from './tools/cache.js';
import { fetchLMStudioModels } from './model-runtime.js';
import { access, readdir } from 'fs/promises';
import { resolve, join, normalize } from 'path';
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
/**
 * Build a shared context block for a sub-agent: the absolute workspace root
 * and a recursive file tree so they can skip list_dir entirely and go
 * straight to batch_read_files with the correct paths.
 */
export async function buildSubAgentContext(cfg) {
    const ws = cfg.workspace || process.cwd();
    const lines = [];
    lines.push(`WORKSPACE ROOT (absolute): ${ws}`);
    lines.push(`Use paths RELATIVE to the workspace root. Example: "src/agent.ts" not "G:\\project\\src\\agent.ts".`);
    lines.push(`DO NOT call list_dir, git_status, or stat_path — the file tree is provided below. Go straight to batch_read_files.`);
    const SKIP = new Set([
        'node_modules',
        'dist',
        '.git',
        '__pycache__',
        '.next',
        '.cache',
        'bun.lock',
        'skills',
        'prerelease',
        'dist-opentui',
    ]);
    const files = [];
    const MAX_FILES = 150;
    async function walk(dir, prefix, depth) {
        if (depth > 3 || files.length >= MAX_FILES)
            return;
        try {
            const entries = (await readdir(dir, { withFileTypes: true }))
                .filter((e) => !SKIP.has(e.name) && !e.name.startsWith('.'))
                .sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory())
                    return -1;
                if (!a.isDirectory() && b.isDirectory())
                    return 1;
                return a.name.localeCompare(b.name);
            });
            for (const e of entries) {
                if (files.length >= MAX_FILES)
                    break;
                const rel = prefix ? `${prefix}/${e.name}` : e.name;
                if (e.isDirectory()) {
                    files.push(`${rel}/`);
                    await walk(join(dir, e.name), rel, depth + 1);
                }
                else {
                    files.push(rel);
                }
            }
        }
        catch {
            /* permission denied or similar */
        }
    }
    try {
        await walk(ws, '', 0);
    }
    catch {
        /* ignore */
    }
    if (files.length > 0) {
        lines.push(`\nFILE TREE (${files.length} files):`);
        lines.push(files.join('\n'));
    }
    else {
        lines.push(`\n(could not enumerate files — use list_dir if needed)`);
    }
    return lines.join('\n');
}
/** Prepend shared context to a sub-agent task so it isn't dispatched blind. */
export async function enrichTaskWithContext(task, cfg, focusPath) {
    const ctx = await buildSubAgentContext(cfg);
    const focus = focusPath ? `\n\nFOCUS PATH (prefer this area): ${focusPath}` : '';
    return `=== SHARED CONTEXT ===\n${ctx}\n=== END CONTEXT ===\n\n${task}${focus}`;
}
function buildWorkerContext(endpoint, base) {
    const cfg = {
        ...base,
        baseURL: endpoint.baseURL,
        model: endpoint.model,
        apiKey: endpoint.apiKey ?? '',
        maxTokens: base.subagents?.maxTokens ?? base.maxTokens ?? 1500,
        temperature: base.subagents?.temperature ?? base.temperature ?? 0.3,
        // Give sub-agents generous headroom — big codebases need many reads.
        // The prompt enforces batching and a structured report format.
        maxIterations: base.subagents?.maxIterations ?? 24,
        // Always treat remote small models as small model mode for concise output.
        smallModelMode: true,
        // Remote small models over a device link are slow, and exploring a large
        // codebase can chain many tool calls. Give each request generous headroom.
        timeout: base.subagents?.timeoutMs ?? 900000,
    };
    const security = createSecurityManager({
        enabled: base.securityEnabled,
        validateCommands: base.securityValidateCommands,
        validateFileAccess: base.securityValidateFileAccess,
        sanitizeOutput: base.securitySanitizeOutput,
        maxFileSize: base.securityMaxFileSize,
        maxBatchFiles: base.securityMaxBatchFiles,
        allowedPaths: base.securityAllowedPaths,
        blockedPaths: base.securityBlockedPaths,
    }, base.workspace);
    const cache = createToolCacheManager(base, base.workspace);
    return { endpoint, cfg, client: createClient(cfg), security, cache };
}
function parseArgs(tc) {
    if (typeof tc.arguments !== 'string')
        return tc.arguments;
    try {
        return JSON.parse(tc.arguments);
    }
    catch {
        const m = tc.arguments.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                return JSON.parse(m[0]);
            }
            catch {
                /* fall through */
            }
        }
        return { raw_input: tc.arguments };
    }
}
/**
 * Build a one-line result summary for a sub-agent tool call, shown in the live
 * stream (e.g. "grep: Found 100 matches" or "read_file: Read from x.ts (111
 * lines)"). Kept short so the panel stays readable.
 */
function summarizeToolResult(tool, raw) {
    if (!tool)
        return '';
    let parsed = undefined;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        /* not JSON */
    }
    const ok = parsed && parsed.ok !== false;
    if (!ok) {
        const err = parsed?.error || raw.slice(0, 80);
        return `${tool}: error ${err}`;
    }
    // grep / search style: "Found N matches"
    const _res = parsed?.result;
    const matchCount = parsed?.matches ??
        _res?.matches ??
        parsed?.count ??
        parsed?.total ??
        (Array.isArray(parsed?.results) ? parsed.results.length : undefined) ??
        (Array.isArray(_res?.results) ? _res.results.length : undefined);
    if (matchCount != null && /grep|search|find|pattern|rgit|rg/i.test(tool)) {
        return `${tool}: Found ${matchCount} matches`;
    }
    // read_file: report file + line count
    if (/read_file|batch_read|read/i.test(tool)) {
        const _r = parsed?.result;
        const path = parsed?.path ?? parsed?.file ?? _r?.path ?? '';
        const lines = parsed?.line_count ?? parsed?.lines ?? parsed?.lineCount ?? _r?.line_count;
        const tail = lines != null ? ` (${lines} lines)` : '';
        const p = typeof path === 'string' && path ? path.split(/[\\/]/).pop() : '';
        return p ? `${tool}: Read from ${p}${tail}` : `${tool}: read ${raw.length} bytes`;
    }
    // list_dir
    if (/list_dir|map_project|tree/i.test(tool)) {
        const n = parsed?.entries?.length ??
            parsed?.count ??
            parsed?.files?.length;
        return n != null ? `${tool}: listed ${n} entries` : `${tool}: ok`;
    }
    // git
    if (/git_/.test(tool)) {
        return `${tool}: ok`;
    }
    // Fallback: file + byte size
    const fp = parsed?.path ?? parsed?.file;
    if (typeof fp === 'string') {
        return `${tool}: ${fp.split(/[\\/]/).pop()}`;
    }
    return `${tool}: ok (${raw.length} bytes)`;
}
/** Read-only exploration tools exposed to sub-agents. */
const SUBAGENT_TOOLS = new Set([
    'read_file',
    'batch_read_files',
    'list_dir',
    'map_project_tree',
    'find_files',
    'stat_path',
    'grep_search',
    'search_and_view',
    'search_files',
]);
/**
 * 2B models often prepend a workspace segment that's already implied by the
 * root (e.g. pass `src/agent.ts` when the root IS the project, or
 * `src/src.ts` from misreading a list_dir entry). If the literal path doesn't
 * exist but a normalized variant does, return the working one. Keeps the small
 * agents from spamming "File not found" on every read.
 */
async function normalizeSubAgentPath(p, ws) {
    if (typeof p !== 'string' || !p)
        return p;
    const original = resolve(ws, normalize(p).replace(/\\/g, '/'));
    try {
        await access(original);
        return p;
    }
    catch {
        /* original path not accessible */
    }
    const segs = normalize(p).replace(/\\/g, '/').split('/').filter(Boolean);
    for (let drop = 1; drop <= Math.min(2, segs.length - 1); drop++) {
        const cand = resolve(ws, segs.slice(drop).join('/'));
        try {
            await access(cand);
            return segs.slice(drop).join('/');
        }
        catch {
            /* candidate path not accessible */
        }
    }
    return p;
}
async function runWorkerTool(wctx, tc) {
    // Hard gate: never run anything outside the read-only set, even if the model
    // emits a disallowed tool name (e.g. from a stale cached schema).
    if (!SUBAGENT_TOOLS.has(tc.name)) {
        return JSON.stringify({
            ok: false,
            error: `Tool '${tc.name}' is not available to sub-agents. Use read_file, list_dir, or grep_search.`,
        });
    }
    const tool = findTool(tc.name);
    const args = parseArgs(tc);
    // Fix 2B path guesses before the real tool runs.
    if (typeof args?.path === 'string') {
        args.path = (await normalizeSubAgentPath(args.path, wctx.cfg.workspace)) ?? args.path;
    }
    if (Array.isArray(args?.paths)) {
        args.paths = await Promise.all(args.paths.map(async (p) => (await normalizeSubAgentPath(p, wctx.cfg.workspace)) ?? p));
    }
    const configWithSecurity = {
        ...wctx.cfg,
        securityManager: wctx.security,
    };
    try {
        let out;
        if (tool?.executeAsync) {
            out = await tool.executeAsync(args, wctx.cfg.workspace, configWithSecurity, undefined, undefined);
        }
        else if (tool) {
            out = tool.execute(args, wctx.cfg.workspace, configWithSecurity);
        }
        else {
            out = JSON.stringify({ ok: false, error: `Unknown tool: ${tc.name}` });
        }
        const sanitized = wctx.security.sanitizeOutput(out);
        // Sub-agent file read truncation: 256k context models can ingest full files (up to ~80k chars / ~2000 lines)
        if ((tc.name === 'read_file' || tc.name === 'batch_read_files') && sanitized.length > 80000) {
            const lines = sanitized.split('\n');
            if (lines.length > 2000) {
                const head = lines.slice(0, 1500).join('\n');
                const tail = lines.slice(-200).join('\n');
                return `${head}\n\n... [${lines.length - 1700} middle lines omitted for sub-agent context budget] ...\n\n${tail}`;
            }
        }
        return sanitized;
    }
    catch (e) {
        return JSON.stringify({
            ok: false,
            error: e?.message || String(e),
        });
    }
}
/**
 * Run a single sub-agent to completion: it may chain tool calls until it
 * produces a final text answer (no tool calls).
 */
async function runSingleSubAgent(wctx, task, signal, hooks) {
    const emit = (e) => hooks?.onSubAgentProgress?.(e);
    const start = performance.now();
    const messages = [
        { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
        { role: 'user', content: task },
    ];
    // Sub-agents are small (2B) models that botch shell commands. Give them a
    // curated READ/EXPLORE tool set only — no execute_command, no writes, no git
    // mutations. This keeps them fast, safe, and on-task.
    const toolDefs = toOpenAI(tools.filter((t) => SUBAGENT_TOOLS.has(t.name)), wctx.cfg);
    let toolCallCount = 0;
    let duplicateStrikes = 0;
    const seenSignatures = new Set();
    const readPaths = new Set();
    // Track per-tool call counts to block wasteful repeated discovery calls
    const toolCallCounts = new Map();
    // Discovery-only tools that should NOT be called more than once
    const DISCOVERY_TOOLS = new Set(['list_dir', 'map_project_tree', 'stat_path', 'find_files']);
    // Hard budget: after this many total tool calls, force the model to report
    const TOOL_BUDGET = 18;
    emit({
        type: 'subagent_start',
        agent: wctx.endpoint.name,
        model: wctx.cfg.model,
        task,
    });
    const maxIter = Math.min(wctx.cfg.maxIterations ?? 12, 12);
    for (let i = 0; i < maxIter; i++) {
        if (signal?.aborted) {
            emit({
                type: 'subagent_done',
                agent: wctx.endpoint.name,
                model: wctx.cfg.model,
                ok: false,
                output: '',
                toolCalls: toolCallCount,
            });
            return {
                name: wctx.endpoint.name,
                model: wctx.cfg.model,
                baseURL: wctx.cfg.baseURL,
                ok: false,
                output: '',
                durationMs: Math.round(performance.now() - start),
                error: 'aborted',
                toolCalls: toolCallCount,
            };
        }
        // Wrap-up nudges — remind the model to report before it runs out of turns.
        if (i === 14 && toolCallCount > 0) {
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
        let streamedToolCalls = [];
        // Per-turn activity timeout (60s) to prevent sub-agent hangs on stalled endpoints
        const turnController = new AbortController();
        let turnTimer = setTimeout(() => {
            turnController.abort();
        }, 60000);
        const resetTurnTimer = () => {
            if (turnTimer)
                clearTimeout(turnTimer);
            turnTimer = setTimeout(() => {
                turnController.abort();
            }, 60000);
        };
        if (signal) {
            if (signal.aborted)
                turnController.abort();
            else
                signal.addEventListener('abort', () => turnController.abort());
        }
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
        }
        catch (e) {
            if (turnController.signal.aborted) {
                emit({
                    type: 'subagent_chunk',
                    agent: wctx.endpoint.name,
                    model: wctx.cfg.model,
                    text: '\n[Sub-agent turn timed out — proceeding with gathered findings]\n',
                });
            }
        }
        finally {
            if (turnTimer)
                clearTimeout(turnTimer);
        }
        const msg = {
            role: 'assistant',
            content: accumulatedContent,
            tool_calls: streamedToolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
            })),
        };
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            // Record assistant message with tool calls, then run them.
            messages.push({
                role: 'assistant',
                content: msg.content || '',
                tool_calls: msg.tool_calls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                })),
            });
            const results = await Promise.all(msg.tool_calls.map(async (tc, index) => {
                const currentToolCallCount = toolCallCount + index + 1;
                const parsedArgs = parseArgs(tc.function);
                const sig = `${tc.function.name}:${JSON.stringify(parsedArgs)}`;
                const filePath = parsedArgs?.path || parsedArgs?.file;
                // --- GUARD 1: Hard tool budget ---
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
                        toolArgs: tc.function.arguments,
                        toolResult: `budget exhausted`,
                        toolResultRaw: budgetResult,
                        toolCalls: currentToolCallCount,
                    });
                    return { role: 'tool', content: budgetResult, tool_call_id: tc.id };
                }
                // --- GUARD 2: Exact duplicate signature ---
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
                        toolArgs: tc.function.arguments,
                        toolResult: `${tc.function.name}: duplicate blocked`,
                        toolResultRaw: dupResult,
                        toolCalls: currentToolCallCount,
                    });
                    return { role: 'tool', content: dupResult, tool_call_id: tc.id };
                }
                seenSignatures.add(sig);
                // --- GUARD 3: Discovery tools called more than once ---
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
                            toolArgs: tc.function.arguments,
                            toolResult: `${tc.function.name}: already called`,
                            toolResultRaw: dupResult,
                            toolCalls: currentToolCallCount,
                        });
                        return { role: 'tool', content: dupResult, tool_call_id: tc.id };
                    }
                    toolCallCounts.set(tc.function.name, prev + 1);
                }
                // --- GUARD 4: Re-reading the exact same file ---
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
                            toolArgs: tc.function.arguments,
                            toolResult: `${tc.function.name}: re-read blocked`,
                            toolResultRaw: reReadResult,
                            toolCalls: currentToolCallCount,
                        });
                        return { role: 'tool', content: reReadResult, tool_call_id: tc.id };
                    }
                    readPaths.add(filePath);
                }
                // --- GUARD 5: More than 3 duplicate strikes = stuck ---
                if (duplicateStrikes >= 3) {
                    const stuckResult = JSON.stringify({
                        ok: false,
                        error: 'You are stuck repeating calls. Stop all tool calls and output your final report NOW.',
                    });
                    emit({
                        type: 'subagent_tool_result',
                        agent: wctx.endpoint.name,
                        model: wctx.cfg.model,
                        tool: tc.function.name,
                        toolArgs: tc.function.arguments,
                        toolResult: `stuck — forced report`,
                        toolResultRaw: stuckResult,
                        toolCalls: currentToolCallCount,
                    });
                    return { role: 'tool', content: stuckResult, tool_call_id: tc.id };
                }
                emit({
                    type: 'subagent_tool',
                    agent: wctx.endpoint.name,
                    model: wctx.cfg.model,
                    tool: tc.function.name,
                    toolArgs: tc.function.arguments,
                    toolCalls: currentToolCallCount,
                });
                const out = await runWorkerTool(wctx, {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                    id: tc.id,
                });
                // Emit a result summary so the TUI can show e.g. "grep: Found 100 matches".
                emit({
                    type: 'subagent_tool_result',
                    agent: wctx.endpoint.name,
                    model: wctx.cfg.model,
                    tool: tc.function.name,
                    toolArgs: tc.function.arguments,
                    toolResult: summarizeToolResult(tc.function.name, out),
                    toolResultRaw: out,
                    toolCalls: currentToolCallCount,
                });
                return {
                    role: 'tool',
                    content: out,
                    tool_call_id: tc.id,
                };
            }));
            toolCallCount += msg.tool_calls.length;
            messages.push(...results);
            continue;
        }
        // Final text answer.
        const answer = msg.content || '';
        emit({
            type: 'subagent_done',
            agent: wctx.endpoint.name,
            model: wctx.cfg.model,
            ok: true,
            output: answer,
            toolCalls: toolCallCount,
        });
        return {
            name: wctx.endpoint.name,
            model: wctx.cfg.model,
            baseURL: wctx.cfg.baseURL,
            ok: true,
            output: answer,
            durationMs: Math.round(performance.now() - start),
            toolCalls: toolCallCount,
        };
    }
    emit({
        type: 'subagent_done',
        agent: wctx.endpoint.name,
        model: wctx.cfg.model,
        ok: false,
        output: '',
        toolCalls: toolCallCount,
    });
    return {
        name: wctx.endpoint.name,
        model: wctx.cfg.model,
        baseURL: wctx.cfg.baseURL,
        ok: false,
        output: '',
        durationMs: Math.round(performance.now() - start),
        error: 'max iterations reached without a final answer',
        toolCalls: toolCallCount,
    };
}
/** Format a list of sub-agent results into a single tool result string. */
export function formatSubAgentResults(results) {
    const blocks = results.map((r) => {
        const header = `### ${r.name} (${r.model} @ ${r.baseURL}) — ${r.ok ? 'ok' : 'failed'} [${r.toolCalls} tool calls, ${r.durationMs}ms]`;
        const body = r.ok ? r.output : `ERROR: ${r.error || 'unknown'}\n${r.output}`;
        return `${header}\n\n${body}`.trim();
    });
    const summary = `Sub-agent pool returned ${results.filter((r) => r.ok).length}/${results.length} successful.`;
    return JSON.stringify({
        ok: true,
        summary,
        batch_status: 'COMPLETED',
        directive: 'All sub-agents have finished execution. Do NOT wait for any agents. Synthesize the findings above immediately.',
        agents: results.length,
        successful: results.filter((r) => r.ok).length,
        results: blocks.join('\n\n---\n\n'),
    });
}
/**
 * Concurrency cap for parallel sub-agent dispatch. The pool can run at most
 * this many sub-agents at once; the scheduler below enforces it.
 */
export const MAX_CONCURRENT_SUBAGENTS = 3;
/**
 * Endpoint allocator for parallel dispatch.
 *
 * When the main agent emits several `explore_subagent` calls in one message,
 * the agent loop runs them concurrently. Without coordination they would all
 * resolve to `endpoints[0]` and pile onto the same remote model. This allocator
 * hands out a distinct idle endpoint per concurrent call (round-robin over the
 * pool, capped at MAX_CONCURRENT_SUBAGENTS) so the calls fan out across the
 * available workers.
 */
class SubAgentScheduler {
    inUse = new Set();
    cursor = 0;
    queue = [];
    /** Acquire an endpoint asynchronously, queuing if all workers are currently busy. */
    async acquire(endpoints, preferred, timeoutMs = 60000) {
        const usable = endpoints.filter((e) => e.baseURL && e.model);
        if (usable.length === 0)
            return undefined;
        let ep = this.tryAcquire(usable, preferred);
        if (ep)
            return ep;
        // Queue call until an endpoint frees up or timeout expires
        const start = Date.now();
        while (!ep) {
            const elapsed = Date.now() - start;
            if (elapsed >= timeoutMs)
                return undefined;
            await new Promise((res) => {
                const timer = setTimeout(res, Math.min(1000, timeoutMs - elapsed));
                this.queue.push(() => {
                    clearTimeout(timer);
                    res();
                });
            });
            ep = this.tryAcquire(usable, preferred);
        }
        return ep;
    }
    tryAcquire(usable, preferred) {
        if (preferred) {
            const p = usable.find((e) => e.name === preferred);
            if (p && !this.inUse.has(p.name)) {
                this.inUse.add(p.name);
                return p;
            }
        }
        const free = usable.filter((e) => !this.inUse.has(e.name));
        if (free.length === 0)
            return undefined;
        const ep = free[this.cursor % free.length];
        this.cursor++;
        this.inUse.add(ep.name);
        return ep;
    }
    release(name) {
        this.inUse.delete(name);
        const next = this.queue.shift();
        if (next)
            next();
    }
}
const scheduler = new SubAgentScheduler();
/**
 * Run a single remote sub-agent (one endpoint) for a focused investigation.
 */
export async function exploreWithSubAgent(base, pool, endpointName, task, signal, hooks) {
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
    // Acquire a free endpoint, queuing if workers are currently busy.
    const ep = await scheduler.acquire(endpoints, endpointName);
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
        return await runSingleSubAgent(wctx, task, signal, hooks);
    }
    finally {
        scheduler.release(ep.name);
    }
}
/**
 * Default base URL for sub-agents: this machine's LM Studio, which proxies to
 * the other device's models automatically. The three Qwen3.5-2B instances are
 * loaded here as qwen3.5-2b, qwen3.5-2b:2, qwen3.5-2b:3.
 */
const LOCAL_LMSTUDIO_URL = 'http://127.0.0.1:1234/v1';
/**
 * Discover loaded Qwen3.5-2B sub-agent models from a given LM Studio base URL.
 */
async function discoverQwen2BEndpoints(baseURL) {
    try {
        const models = await fetchLMStudioModels(baseURL);
        const qwen2b = models
            .filter((m) => /qwen3\.5[-.]?2b/i.test(m.id))
            .map((m, i) => ({
            name: `qwen-remote-${i + 1}`,
            baseURL: baseURL.replace(/\/+$/, '').replace(/\/v1\/?$/i, '') + '/v1',
            model: m.id,
        }));
        return qwen2b.length > 0 ? qwen2b : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve a pool config from the base config.
 *
 * Priority:
 *   1. Explicit `cfg.subagents` (enabled + endpoints) — user-tuned.
 *   2. `REMOTE_LMSTUDIO_URL` env var — auto-discover Qwen3.5-2B models there.
 *   3. This machine's LM Studio (127.0.0.1:1234) — auto-discover the three
 *      qwen3.5-2b* instances. LM Studio forwards to the linked device.
 */
export async function resolveSubAgentPool(base) {
    if (base.subagents) {
        if (base.subagents.enabled && base.subagents.endpoints.length > 0) {
            return base.subagents;
        }
        if (base.subagents.enabled === false) {
            return undefined;
        }
    }
    const candidates = [process.env.REMOTE_LMSTUDIO_URL, LOCAL_LMSTUDIO_URL].filter(Boolean);
    for (const url of candidates) {
        const endpoints = await discoverQwen2BEndpoints(url);
        if (endpoints && endpoints.length > 0) {
            return { enabled: true, endpoints, maxIterations: 12 };
        }
    }
    return undefined;
}
