import { parseArgs } from 'util';
import { resolve } from 'path';
import { AgentCore } from '../agent.js';
import { loadConfig } from '../config.js';
import { printRunHelp, cliError } from './help.js';

export interface RunResult {
  ok: boolean;
  answer: string;
  state: string;
  tool_calls: Array<{ name: string; duration_ms?: number }>;
  usage: { input_tokens: number; output_tokens: number };
  rounds: number;
}

export async function cmdRun(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompt: { type: 'string', short: 'p' },
      stdin: { type: 'boolean', default: false },
      workspace: { type: 'string', short: 'w' },
      model: { type: 'string', short: 'm' },
      'base-url': { type: 'string' },
      'max-rounds': { type: 'string' },
      'max-iterations': { type: 'string' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    printRunHelp();
    return 0;
  }

  let prompt = values.prompt;
  if (values.stdin) {
    const chunks: Buffer[] = [];
    // Bun exposes Bun.stdin.stream(); on Node we read process.stdin instead.
    const bunGlobal = (globalThis as Record<string, unknown>).Bun as
      { stdin?: { stream?: () => AsyncIterable<Uint8Array> } } | undefined;
    if (bunGlobal?.stdin?.stream) {
      for await (const chunk of bunGlobal.stdin.stream()) {
        chunks.push(Buffer.from(chunk));
      }
    } else {
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }
    const fromStdin = Buffer.concat(chunks).toString('utf-8').trim();
    if (fromStdin) prompt = prompt ? `${prompt}\n${fromStdin}` : fromStdin;
  }

  if (!prompt?.trim()) {
    cliError(
      'No prompt provided.',
      '  nanogent run --prompt "your task here"\n' +
        '  echo "your task" | nanogent run --stdin --workspace .'
    );
  }

  const cfg = loadConfig();
  if (values.workspace) cfg.workspace = resolve(values.workspace);
  if (values.model) cfg.model = values.model;
  if (values['base-url']) cfg.baseURL = values['base-url'];
  if (values['max-iterations']) {
    const n = parseInt(values['max-iterations'], 10);
    if (!Number.isNaN(n)) cfg.maxIterations = n;
  }

  const agent = new AgentCore(cfg);
  if (values['max-rounds']) {
    const n = parseInt(values['max-rounds'], 10);
    if (!Number.isNaN(n)) agent.maxRounds = n;
  }
  agent.streaming = false;

  const toolCalls: RunResult['tool_calls'] = [];

  if (values.verbose) {
    agent.onToolResult = (r) => {
      toolCalls.push({ name: r.name, duration_ms: Math.round(r.duration) });
      console.error(`[tool] ${r.name} (${Math.round(r.duration)}ms)`);
    };
  }

  await agent.init();
  try {
    await agent.run(prompt);
  } finally {
    // Tear down MCP child processes and cache watchers so the process can exit
    await agent.shutdown();
  }

  const lastAssistant = [...agent.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.content.trim());

  const answer = lastAssistant?.content?.trim() || '';
  const ok = agent.state !== 'error' && answer.length > 0;

  const result: RunResult = {
    ok,
    answer,
    state: agent.state,
    tool_calls: toolCalls,
    usage: { ...agent.totalUsage },
    rounds: agent.roundCounter,
  };

  if (values.json) {
    console.log(JSON.stringify(result, null, 0));
  } else if (values.quiet) {
    console.log(answer);
  } else {
    if (!ok) {
      console.error(`state: ${agent.state}`);
    }
    console.log(answer);
    if (values.verbose && result.usage.input_tokens + result.usage.output_tokens > 0) {
      console.error(
        `tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out · rounds: ${result.rounds}`
      );
    }
  }

  return ok ? 0 : 1;
}
