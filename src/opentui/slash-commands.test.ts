/**
 * Tests for the TUI slash-command handler (extracted from app.tsx).
 * Runs against a stubbed AgentCore — no renderer, no LLM.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentCore } from '../agent.js';
import type { Config, Message, Todo } from '../types.js';
import { PermissionManager } from '../security/permissions.js';
import { handleSlashCommand, type SlashCommandContext } from './slash-commands/index.js';

function makeConfig(ws: string): Config {
  return {
    model: 'test-model',
    baseURL: 'http://localhost:1234/v1',
    apiKey: 'test-key',
    workspace: ws,
    maxIterations: 5,
    temperature: 0.3,
    maxTokens: 4096,
  } as Config;
}

interface AgentStub {
  agent: AgentCore;
  messages: Message[];
  todos: Todo[];
  permissionManager: PermissionManager;
  runCalls: Array<{ text: string; signal?: AbortSignal }>;
  reconfigureCalls: Array<Record<string, unknown>>;
  contextManager: {
    clear: ReturnType<typeof mock>;
    setMessages: ReturnType<typeof mock>;
    getStats: ReturnType<typeof mock>;
  };
  toolCache: {
    clear: ReturnType<typeof mock>;
  };
}

function makeAgent(ws: string): AgentStub {
  const cfg = makeConfig(ws);
  const messages: Message[] = [
    { id: 'system-base', role: 'system', content: 'SYS', timestamp: 0 },
    { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
  ];
  const todos: Todo[] = [];
  const permissionManager = new PermissionManager({ mode: 'ask' });
  const runCalls: AgentStub['runCalls'] = [];
  const reconfigureCalls: AgentStub['reconfigureCalls'] = [];
  const contextManager = {
    clear: mock(() => {}),
    setMessages: mock((msgs: Message[]) => {
      // Mirror the real behaviour: keep the context manager's payload
      // in sync with agent.messages so /cd's system-prompt rebuild
      // observes the new state.
      messages.length = 0;
      messages.push(...msgs);
    }),
    getStats: mock(() => ({
      currentTokens: 1200,
      maxTokens: 262144,
      usagePercent: 1200 / 262144,
      messageCount: 2,
      needsCompaction: false,
      compactionCount: 0,
      tokenSource: 'estimate' as const,
      estimatedTokens: 1200,
      apiPromptTokens: undefined,
    })),
  };
  const toolCache = {
    clear: mock(() => {}),
    get: () => undefined,
    set: () => {},
    stopAllWatchers: () => {},
  };

  const agent = {
    cfg,
    messages,
    todos,
    contextManager,
    isSmallModel: false,
    mcpStates: [],
    mcpManager: { connectedCount: 0, totalTools: 0 },
    skillManager: {
      activeNames: () => [] as string[],
      activeSkills: new Map<string, unknown>(),
      load: mock(() => true),
      unload: mock(() => true),
      onPromptSync: (content: string) => {
        // Match the real SkillManager behaviour: stash the rendered
        // prompt for the context-manager to re-seed on demand.
        agent._systemPromptContent = content;
      },
      syncSkillMessages: mock(() => {}),
    },
    securityManager: { permissionManager },
    totalUsage: { input_tokens: 12345, output_tokens: 678 },
    lastUsage: { input_tokens: 1000, output_tokens: 50 },
    totalCostUsd: 0,
    lastCostUsd: undefined,
    addTodo(text: string) {
      todos.push({ id: 'todo-1', text, done: false, createdAt: Date.now() });
    },
    run: mock(async (text: string, signal?: AbortSignal) => {
      runCalls.push({ text, signal });
    }),
    reconfigure: mock(async (cfgPart: Record<string, unknown>) => {
      reconfigureCalls.push(cfgPart);
      Object.assign(cfg, cfgPart);
    }),
    reloadFromDisk: mock(async () => {}),
    executeToolDirect: mock(async () => JSON.stringify({ ok: true })),
    compactContextIfNeeded: async () => false,
    forceCompactContext: mock(() => false),
    checkAndCompactContext: mock(() => false),
    invalidateToolSchemaCache: mock(() => {}),
    currentTool: undefined,
    toolCache,
    state: 'idle' as const,
    setState(
      s: 'idle' | 'thinking' | 'executing_tool' | 'waiting_for_user' | 'reflecting' | 'error'
    ) {
      (agent as { state: string }).state = s;
    },
    _systemPromptContent: '',
    onUpdate: undefined,
  } as unknown as AgentCore;

  return {
    agent,
    messages,
    todos,
    permissionManager,
    runCalls,
    reconfigureCalls,
    contextManager,
    toolCache,
  };
}

interface CtxHarness {
  ctx: SlashCommandContext;
  messagesSnapshots: Message[][];
  overlays: Array<string | null>;
  todosSnapshots: Todo[][];
  themeCalls: unknown[];
}

function makeCtx(stub: AgentStub, ws: string): CtxHarness {
  const messagesSnapshots: Message[][] = [];
  const overlays: Array<string | null> = [];
  const todosSnapshots: Todo[][] = [];
  const themeCalls: unknown[] = [];

  const ctx: SlashCommandContext = {
    agent: stub.agent,
    signal: new AbortController().signal,
    cfg: makeConfig(ws),
    todos: stub.todos,
    skills: new Map(),
    setMessages: (m) => messagesSnapshots.push(m),
    setToolResults: () => {},
    setTodos: (t) => todosSnapshots.push(t),
    setSessions: () => {},
    setOverlay: (o) => overlays.push(o),
    setShowTodos: () => {},
    setTheme: (t) => themeCalls.push(t),
    setSkills: () => {},
    setSkillCommands: () => {},
    handleSave: () => {},
    handleLoad: async () => {},
    handleRename: () => {},
  };

  return { ctx, messagesSnapshots, overlays, todosSnapshots, themeCalls };
}

function lastAssistantContent(h: CtxHarness): string {
  const snap = h.messagesSnapshots[h.messagesSnapshots.length - 1] ?? [];
  const last = [...snap].reverse().find((m) => m.role === 'assistant');
  return last?.content ?? '';
}

describe('handleSlashCommand', () => {
  let ws: string;
  let stub: AgentStub;
  let h: CtxHarness;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'slash-cmd-test-'));
    stub = makeAgent(ws);
    h = makeCtx(stub, ws);
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('/help opens the help overlay', async () => {
    await handleSlashCommand('/help', h.ctx);
    expect(h.overlays).toEqual(['help']);
  });

  it('/clear keeps only system messages and resets the context manager', async () => {
    await handleSlashCommand('/clear', h.ctx);
    expect(stub.agent.messages.every((m) => m.role === 'system')).toBe(true);
    expect(stub.contextManager.clear).toHaveBeenCalledTimes(1);
    // system-base is re-seeded into the context manager
    expect(stub.contextManager.setMessages).toHaveBeenCalledTimes(1);
    const seeded = stub.contextManager.setMessages.mock.calls[0][0] as Message[];
    expect(seeded[0]?.id).toBe('system-base');
  });

  it('/compact reports when no compaction is needed', async () => {
    await handleSlashCommand('/compact', h.ctx);
    const content = lastAssistantContent(h);
    expect(content).toContain('no compaction needed');
    expect(content).toContain('1200/262144');
  });

  it('/todo <text> adds a todo to the agent', async () => {
    await handleSlashCommand('/todo write more tests', h.ctx);
    expect(stub.todos).toHaveLength(1);
    expect(stub.todos[0].text).toBe('write more tests');
  });

  it('/todos lists current todos in chat', async () => {
    stub.todos.push({ id: 'abc', text: 'first task', done: false, createdAt: 0 });
    h.ctx.todos = stub.todos;
    await handleSlashCommand('/todos', h.ctx);
    expect(lastAssistantContent(h)).toContain('first task');
  });

  it('/clear-todos empties the todo list', async () => {
    stub.todos.push({ id: 'abc', text: 'first task', done: false, createdAt: 0 });
    await handleSlashCommand('/clear-todos', h.ctx);
    expect(stub.agent.todos).toEqual([]);
    expect(lastAssistantContent(h)).toContain('cleared');
  });

  it('/new starts a fresh session', async () => {
    await handleSlashCommand('/new', h.ctx);
    expect(lastAssistantContent(h)).toContain('new session');
    // history cleared: only the announcement remains
    expect(stub.agent.messages.filter((m) => m.role === 'user')).toEqual([]);
  });

  it('/cd with no args shows the current workspace', async () => {
    await handleSlashCommand('/cd', h.ctx);
    expect(lastAssistantContent(h)).toContain(ws);
  });

  it('/cd <dir> switches the workspace, rebuilds the prompt, and clears the cache', async () => {
    const target = mkdtempSync(join(tmpdir(), 'slash-cd-target-'));
    try {
      stub.todos.push({ id: 'x', text: 't', done: false, createdAt: 0 });
      await handleSlashCommand(`/cd "${target}"`, h.ctx);
      // /cd now uses changeAgentWorkspace, which calls agent.reconfigure
      // with the new workspace AND rebuilds the system prompt AND
      // clears the tool cache. All three must happen for the model to
      // actually be able to operate in the new directory.
      expect(stub.reconfigureCalls).toHaveLength(1);
      expect(stub.reconfigureCalls[0].workspace).toBe(target);
      expect(stub.toolCache.clear).toHaveBeenCalled();
      expect(stub.agent.todos).toEqual([]);
      // The new system prompt is the one the model will see on the
      // next turn — it must reflect the new workspace.
      const baseMsg = stub.agent.messages.find((m) => m.id === 'system-base');
      expect(baseMsg).toBeDefined();
      expect((baseMsg as Message).content).toContain(target);
      expect(lastAssistantContent(h)).toContain('Workspace changed to');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('/cd <missing> reports the failure', async () => {
    await handleSlashCommand('/cd /definitely/not/a/real/path-xyz', h.ctx);
    expect(stub.reconfigureCalls).toHaveLength(0);
    expect(lastAssistantContent(h)).toContain('Failed to change workspace');
  });

  it('/auto <task> runs the agent with the abort signal', async () => {
    await handleSlashCommand('/auto fix the bug', h.ctx);
    expect(stub.runCalls).toHaveLength(1);
    expect(stub.runCalls[0].text).toBe('fix the bug');
    expect(stub.runCalls[0].signal).toBeDefined();
  });

  it('/usage prints copy-pasteable token counts', async () => {
    await handleSlashCommand('/usage', h.ctx);
    const content = lastAssistantContent(h);
    expect(content).toContain('input_tokens: 12345');
    expect(content).toContain('output_tokens: 678');
    expect(content).toContain('last_turn_input_tokens: 1000');
    expect(content).not.toContain('estimated_usd');
  });

  it('/config opens the settings overlay', async () => {
    await handleSlashCommand('/config', h.ctx);
    expect(h.overlays).toEqual(['settings']);
    expect(lastAssistantContent(h)).toBe('');
  });

  it('/config show still dumps configuration text', async () => {
    await handleSlashCommand('/config show', h.ctx);
    const content = lastAssistantContent(h);
    expect(content).toContain('test-model');
    expect(content).toContain('Configuration');
    expect(content).toContain('Effort');
    expect(h.overlays).toEqual([]);
  });

  it('/set with no args shows configuration text without opening the overlay', async () => {
    await handleSlashCommand('/set', h.ctx);
    expect(lastAssistantContent(h)).toContain('Configuration');
    expect(h.overlays).toEqual([]);
  });

  it('/settings opens the settings overlay', async () => {
    await handleSlashCommand('/settings', h.ctx);
    expect(h.overlays).toEqual(['settings']);
  });

  it('/effort shows the current and allowed effort values', async () => {
    await handleSlashCommand('/effort', h.ctx);
    const content = lastAssistantContent(h);
    expect(content).toContain('effort: low');
    expect(content).toContain('none|low|medium|high|extra-high');
  });

  it('/effort extra persists and applies extra-high', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slash-cmd-home-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      await handleSlashCommand('/effort extra', h.ctx);
      expect(stub.reconfigureCalls).toEqual([{ effort: 'extra-high' }]);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('/effort rejects unknown values without reconfiguring', async () => {
    await handleSlashCommand('/effort nope', h.ctx);
    expect(stub.reconfigureCalls).toHaveLength(0);
    expect(lastAssistantContent(h)).toContain('none|low|medium|high|extra-high');
  });

  it('/config set writes a local config file and confirms the update', async () => {
    await handleSlashCommand('/config set model new-model-1', h.ctx);
    expect(lastAssistantContent(h)).toContain('Updated `model`');
    // the local workspace config file was written with the new value.
    // The canonical local filename is <workspace>/nanogent.json (no leading dot).
    const localCfg = join(ws, 'nanogent.json');
    expect(existsSync(localCfg)).toBe(true);
    const written = JSON.parse(readFileSync(localCfg, 'utf-8'));
    expect(written.model).toBe('new-model-1');
  });

  it('/config set with bad usage shows help', async () => {
    await handleSlashCommand('/config set', h.ctx);
    expect(lastAssistantContent(h)).toContain('Usage:');
  });

  it('/permissions shows the current mode', async () => {
    await handleSlashCommand('/permissions', h.ctx);
    expect(lastAssistantContent(h)).toContain('ask');
  });

  it('/permissions always_allow sets the mode', async () => {
    await handleSlashCommand('/permissions always_allow', h.ctx);
    expect(stub.permissionManager.getMode()).toBe('always_allow');
  });

  it('/permissions deny <tool> sets a deny rule', async () => {
    await handleSlashCommand('/permissions deny execute_command', h.ctx);
    expect(stub.permissionManager.getRule('execute_command')).toBe('deny');
  });

  it('/permissions reset clears rules and restores ask mode', async () => {
    stub.permissionManager.setMode('always_allow');
    stub.permissionManager.setRule('execute_command', 'allow');
    await handleSlashCommand('/permissions reset', h.ctx);
    expect(stub.permissionManager.getMode()).toBe('ask');
    expect(stub.permissionManager.getRules()).toEqual({});
  });

  it('/mcp with no servers shows setup help', async () => {
    await handleSlashCommand('/mcp', h.ctx);
    expect(lastAssistantContent(h)).toContain('No MCP servers configured');
  });

  it('/skill-load without a name shows usage', async () => {
    await handleSlashCommand('/skill-load', h.ctx);
    expect(lastAssistantContent(h)).toContain('Usage:');
  });

  it('/theme with an unknown name lists available themes', async () => {
    await handleSlashCommand('/theme not-a-theme', h.ctx);
    expect(h.themeCalls).toHaveLength(0);
    expect(lastAssistantContent(h)).toContain('Available themes');
  });

  it('/theme <name> applies a known theme', async () => {
    await handleSlashCommand('/theme dark', h.ctx);
    expect(h.themeCalls).toHaveLength(1);
  });

  it('unknown commands get a helpful error', async () => {
    await handleSlashCommand('/frobnicate', h.ctx);
    expect(lastAssistantContent(h)).toContain('Unknown command: /frobnicate');
  });

  it('/<skill-name> delegates to the agent /skill: activation flow', async () => {
    h.ctx.skills.set('fake-skill', {
      name: 'fake-skill',
      description: 'test skill',
      prompt: 'do things',
      enabled: false,
    } as never);
    await handleSlashCommand('/fake-skill', h.ctx);
    expect(stub.runCalls).toHaveLength(1);
    expect(stub.runCalls[0].text).toBe('/skill:fake-skill');
  });

  it('/skill <name> delegates to the activation flow', async () => {
    await handleSlashCommand('/skill some-tool', h.ctx);
    expect(stub.runCalls).toHaveLength(1);
    expect(stub.runCalls[0].text).toBe('/skill:some-tool');
  });

  it('/skill with no args lists available skills', async () => {
    await handleSlashCommand('/skill', h.ctx);
    expect(stub.runCalls).toHaveLength(0);
    expect(lastAssistantContent(h).length).toBeGreaterThan(0);
  });

  it('/skill-load <name> delegates to the agent activation flow', async () => {
    h.ctx.skills.set('fake-skill', {
      name: 'fake-skill',
      description: 'test skill',
      prompt: 'do things',
      enabled: false,
    } as never);
    await handleSlashCommand('/skill-load fake-skill', h.ctx);
    expect(stub.runCalls).toHaveLength(1);
    expect(stub.runCalls[0].text).toBe('/skill-load fake-skill');
  });

  it('/profile lists configured snapshots and the current name', async () => {
    stub.agent.cfg.profiles = {
      local: { model: 'qwen3.5-4b', baseURL: 'http://127.0.0.1:1234/v1' },
      cloud: { model: 'openrouter/free', baseURL: 'https://openrouter.ai/api/v1' },
    };
    stub.agent.cfg.profile = 'local';
    await handleSlashCommand('/profile', h.ctx);
    const content = lastAssistantContent(h);
    expect(content).toContain('local');
    expect(content).toContain('(current)');
    expect(content).toContain('/profile <name>');
  });

  it('/profile <name> applies the snapshot via reconfigure', async () => {
    stub.agent.cfg.profiles = {
      local: { model: 'qwen3.5-4b', baseURL: 'http://127.0.0.1:1234/v1' },
    };
    await handleSlashCommand('/profile local', h.ctx);
    expect(stub.reconfigureCalls.length).toBeGreaterThan(0);
    expect(stub.agent.cfg.model).toBe('qwen3.5-4b');
    expect(stub.agent.cfg.profile).toBe('local');
    expect(lastAssistantContent(h)).toContain('Applied profile');
  });

  it('/profile unknown prints a usable error', async () => {
    stub.agent.cfg.profiles = {
      local: { model: 'qwen3.5-4b', baseURL: 'http://127.0.0.1:1234/v1' },
    };
    await handleSlashCommand('/profile missing', h.ctx);
    expect(stub.reconfigureCalls).toHaveLength(0);
    expect(lastAssistantContent(h)).toContain('Unknown profile');
  });
});

describe('snapshot / rollback slash commands', () => {
  let ws: string;
  let projectDir: string;
  let stub: AgentStub;
  let h: CtxHarness;

  beforeEach(() => {
    // Tools edit the user's project directly. We seed a baseline snapshot
    // manually so the rollback tests can run without booting the full
    // agent lifecycle.
    ws = mkdtempSync(join(tmpdir(), 'slash-snap-'));
    projectDir = join(ws, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(projectDir, 'README.md'), '# proj\n');
    const { takeBaselineSnapshot } = require('../snapshots.js');
    takeBaselineSnapshot(projectDir);
    stub = makeAgent(projectDir);
    h = makeCtx(stub, projectDir);
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('/snapshot saves the current workspace state and reports files', async () => {
    await handleSlashCommand('/snapshot baseline', h.ctx);
    const content = lastAssistantContent(h);
    expect(content).toContain('baseline');
    expect(content).toContain('Snapshot saved');
  });

  it('/diffs lists saved snapshots', async () => {
    await handleSlashCommand('/snapshot first', h.ctx);
    await handleSlashCommand('/snapshot second', h.ctx);
    await handleSlashCommand('/diffs', h.ctx);
    const content = lastAssistantContent(h);
    expect(content).toContain('first');
    expect(content).toContain('second');
  });

  it('/diffs with no snapshots shows a helpful message', async () => {
    // Wipe the snapshots dir to simulate a brand-new workspace.
    const { rmSync: rm } = require('fs');
    rm(join(projectDir, '.nanoagent', 'snapshots'), { recursive: true, force: true });
    await handleSlashCommand('/diffs', h.ctx);
    expect(lastAssistantContent(h)).toContain('No snapshots yet');
  });

  it('/rollback <name> restores an earlier snapshot and undoes an edit', async () => {
    await handleSlashCommand('/snapshot before', h.ctx);
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 99;\n');
    await handleSlashCommand('/rollback before', h.ctx);
    expect(lastAssistantContent(h)).toContain('before');
    const after = readFileSync(join(projectDir, 'index.ts'), 'utf-8');
    expect(after).toBe('export const x = 1;\n');
  });

  it('/rollback (no name) restores the baseline', async () => {
    // Edit the source so the baseline differs.
    writeFileSync(join(projectDir, 'index.ts'), 'export const x = 99;\n');
    expect(readFileSync(join(projectDir, 'index.ts'), 'utf-8')).toContain('99');
    await handleSlashCommand('/rollback', h.ctx);
    expect(lastAssistantContent(h)).toContain('rolled back to baseline');
    const after = readFileSync(join(projectDir, 'index.ts'), 'utf-8');
    expect(after).toBe('export const x = 1;\n');
  });

  it('/rollback <unknown-name> reports the error', async () => {
    await handleSlashCommand('/snapshot known', h.ctx);
    await handleSlashCommand('/rollback ghost', h.ctx);
    expect(lastAssistantContent(h)).toMatch(/snapshot not found|Failed to rollback/);
  });
});
