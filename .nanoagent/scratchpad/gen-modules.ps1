$ErrorActionPreference = 'Stop'
$root = 'G:\AIagent\qwen-agent-tui'
$src = Get-Content "$root/src/agent.ts"

function Extract([int]$start, [int]$end) {
  $chunk = $src[($start - 1)..($end - 1)]
  # dedent one class-member level (2 spaces)
  $chunk = $chunk | ForEach-Object { $_ -replace '^  ', '' }
  # retarget implicit receiver
  $chunk = $chunk -replace 'this\.', 'agent.'
  return ($chunk -join "`n")
}

function Save($path, $text) {
  [IO.File]::WriteAllText($path, $text.TrimEnd() + "`n")
  Write-Output "wrote $path ($($text.Length) chars)"
}

# ---------------------------------------------------------------- agent-utils
$utils = @'
/** Random short id generator (shared by agent modules). */
export function rnd() {
  return Math.random().toString(36).slice(2, 10);
}

/** Current timestamp in ms (shared by agent modules). */
export function now() {
  return Date.now();
}
'@
Save "$root/src/agent-utils.ts" $utils

# --------------------------------------------------------------- agent-todos
$todosHeader = @'
/**
 * Todo-list helpers for AgentCore. Each function takes the agent instance as
 * its first parameter; the class keeps thin delegate methods so the public
 * API is unchanged.
 */
import type { AgentCore } from './agent.js';
import type { Message } from './types.js';
import { rnd, now } from './agent-utils.js';
'@
$todos = @(
  (Extract 1879 1894),
  (Extract 1896 1916),
  (Extract 2052 2057),
  (Extract 2059 2067),
  (Extract 2069 2074)
) -join "`n`n"
$todos = $todos -replace 'private buildTodoContext\(\)', 'export function buildTodoContext(agent: AgentCore)'
$todos = $todos -replace 'private syncTodoMessage\(\)', 'export function syncTodoMessage(agent: AgentCore)'
$todos = $todos -replace 'agent\.buildTodoContext\(\)', 'buildTodoContext(agent)'
$todos = $todos -replace '(?m)^addTodo\(text', 'export function addTodo(agent: AgentCore, text'
$todos = $todos -replace '(?m)^toggleTodo\(id', 'export function toggleTodo(agent: AgentCore, id'
$todos = $todos -replace '(?m)^removeTodo\(id', 'export function removeTodo(agent: AgentCore, id'
$todos = $todos -replace 'agent\.syncTodoMessage\(\)', 'syncTodoMessage(agent)'
Save "$root/src/agent-todos.ts" ($todosHeader + "`n`n" + $todos)

# ------------------------------------------------------------ agent-messages
$msgHeader = @'
/**
 * Conversation-message helpers for AgentCore (message construction, chat
 * conversion, and context compaction). Each function takes the agent
 * instance as its first parameter.
 */
import type { ChatMessage } from './llm.js';
import type { Message } from './types.js';
import type { AgentCore } from './agent.js';
import { rnd, now } from './agent-utils.js';
import { syncTodoMessage } from './agent-todos.js';
'@
$msg = @(
  (Extract 1918 1960),
  (Extract 1962 1973),
  (Extract 1975 1988),
  (Extract 1990 2004),
  (Extract 2006 2040)
) -join "`n`n"
$msg = $msg -replace 'private toChatMessages\(\)', 'export function toChatMessages(agent: AgentCore)'
$msg = $msg -replace 'private addAssistantMessage\(content', 'export function addAssistantMessage(agent: AgentCore, content'
$msg = $msg -replace 'private addUserMessage\(content', 'export function addUserMessage(agent: AgentCore, content'
$msg = $msg -replace 'private addToolMessage\(content', 'export function addToolMessage(agent: AgentCore, content'
$msg = $msg -replace 'public checkAndCompactContext\(\)', 'export function checkAndCompactContext(agent: AgentCore)'
$msg = $msg -replace 'agent\.syncTodoMessage\(\)', 'syncTodoMessage(agent)'
$msg = $msg -replace 'agent\.addAssistantMessage\(', 'addAssistantMessage(agent, '
Save "$root/src/agent-messages.ts" ($msgHeader + "`n`n" + $msg)

# ----------------------------------------------------------- agent-lifecycle
$lifeHeader = @'
/**
 * Lifecycle logic for AgentCore: construction-time reconfiguration, runtime
 * profile detection, disk reload, initialisation, and shutdown. Each
 * function takes the agent instance as its first parameter; the class keeps
 * thin delegate methods so the public API is unchanged.
 */
import { createClient, isLocalProvider } from './llm.js';
import {
  createToolCacheManager,
  registerExternalTools,
  subAgentAvailable,
} from './tools/index.js';
import { detectContext } from './context.js';
import { SkillManager } from './skill-manager.js';
import { loadSkills } from './skills.js';
import { buildSystemPrompt } from './prompt.js';
import { enrichConfigWithRuntime, isSmallModelFromConfig } from './model-runtime.js';
import { loadConfig, applySubAgentDefaults } from './config.js';
import type { Config } from './types.js';
import { autoSaveSession } from './store.js';
import type { AgentCore } from './agent.js';
import { now } from './agent-utils.js';
import { syncTodoMessage } from './agent-todos.js';
'@
$life = @(
  (Extract 215 277),
  (Extract 279 286),
  (Extract 288 323),
  (Extract 325 445),
  (Extract 2076 2093)
) -join "`n`n"
$life = $life -replace 'async reconfigure\(newCfg', 'export async function reconfigureAgent(agent: AgentCore, newCfg'
$life = $life -replace 'async applyRuntimeProfile\(\) \{', 'export async function applyRuntimeProfile(agent: AgentCore) {'
$life = $life -replace 'async reloadFromDisk\(\) \{', 'export async function reloadAgentFromDisk(agent: AgentCore) {'
$life = $life -replace 'async init\(\) \{', 'export async function initAgent(agent: AgentCore) {'
$life = $life -replace 'async shutdown\(\): Promise<void> \{', 'export async function shutdownAgent(agent: AgentCore): Promise<void> {'
$life = $life -replace 'agent\.syncTodoMessage\(\)', 'syncTodoMessage(agent)'
Save "$root/src/agent-lifecycle.ts" ($lifeHeader + "`n`n" + $life)

# ----------------------------------------------------------- agent-subagents
$subHeader = @'
/**
 * Background sub-agent machinery for AgentCore: detached dispatch handles,
 * progress hooks, batch awaiting, and TUI snapshots. Each function takes the
 * agent instance as its first parameter; the class keeps thin delegate
 * methods so the public API is unchanged.
 */
import type { ToolExecutionHooks, SubAgentProgressEvent } from './tools/index.js';
import {
  exploreWithSubAgent,
  formatSubAgentResults,
  type SubAgentResult,
} from './subagents.js';
import type { Message } from './types.js';
import type { AgentCore } from './agent.js';
import { rnd, now } from './agent-utils.js';
'@
$interfaceChunk = (Extract 36 55) -replace 'interface BackgroundSubAgent \{', 'export interface BackgroundSubAgent {'
$snapshot = @'

/** Snapshot of a live background sub-agent handle (plain object for the TUI). */
export interface SubAgentSnapshot {
  id: string;
  prompt: string;
  focusPath?: string;
  status: 'running' | 'done' | 'error';
  log?: SubAgentProgressEvent[];
  result?: SubAgentResult;
}

/**
 * Snapshot of the live background sub-agent handles for the TUI. Returns a
 * plain array (not the internal Map) so React state updates correctly.
 */
export function getSubAgentSnapshot(agent: AgentCore): SubAgentSnapshot[] {
  return [...agent.backgroundSubAgents.values()].map((h) => ({
    id: h.id,
    prompt: h.prompt,
    focusPath: h.focusPath,
    status: h.status,
    log: h.log || [],
    result: h.result,
  }));
}
'@
$sub = @(
  $interfaceChunk,
  $snapshot.Trim(),
  (Extract 1072 1183),
  (Extract 1185 1198),
  (Extract 1200 1249)
) -join "`n`n"
$sub = $sub -replace '(?m)^spawnBackgroundSubAgent\(prompt', 'export function spawnBackgroundSubAgent(agent: AgentCore, prompt'
$sub = $sub -replace 'agent\.buildSubAgentHooks\(', 'buildSubAgentHooks(agent, '
$sub = $sub -replace 'private buildSubAgentHooks\(id', 'export function buildSubAgentHooks(agent: AgentCore, id'
$sub = $sub -replace 'async awaitAllBackgroundSubAgents\(_signal', 'export async function awaitAllBackgroundSubAgents(agent: AgentCore, _signal'
Save "$root/src/agent-subagents.ts" ($subHeader + "`n`n" + $sub)

# --------------------------------------------------------------- agent-tools
$toolsHeader = @'
/**
 * Tool-execution logic for AgentCore: argument parsing, permission checks,
 * sequential/parallel execution, direct dispatch, and post-result state
 * syncing. Each function takes the agent instance as its first parameter;
 * the class keeps thin delegate methods so the public API is unchanged.
 */
import { findTool } from './tools/index.js';
import type { ToolExecutionHooks } from './tools/index.js';
import type { AgentCore } from './agent.js';
import { rnd, now } from './agent-utils.js';
import { syncTodoMessage } from './agent-todos.js';
import { addToolMessage } from './agent-messages.js';
'@
$tools = @(
  (Extract 1254 1284),
  (Extract 1286 1310),
  (Extract 1312 1355),
  (Extract 1357 1569),
  (Extract 1571 1807),
  (Extract 1809 1877)
) -join "`n`n"
$tools = $tools -replace 'private async checkSubAgentConsent\(tcId', 'export async function checkSubAgentConsent(agent: AgentCore, tcId'
$tools = $tools -replace 'private parseToolArgs\(tc', 'export function parseToolArgs(tc'
$tools = $tools -replace '(?m)^async executeToolDirect\(toolName', 'export async function executeToolDirect(agent: AgentCore, toolName'
$tools = $tools -replace 'private async executeToolSequential\(\r?\n', "export async function executeToolSequential(`n  agent: AgentCore,`n"
$tools = $tools -replace 'private async executeToolsParallel\(\r?\n', "export async function executeToolsParallel(`n  agent: AgentCore,`n"
$tools = $tools -replace 'private handleSpecialToolResults\(toolName', 'export function handleSpecialToolResults(agent: AgentCore, toolName'
$tools = $tools -replace 'agent\.parseToolArgs\(', 'parseToolArgs('
$tools = $tools -replace 'agent\.checkSubAgentConsent\(', 'checkSubAgentConsent(agent, '
$tools = $tools -replace 'agent\.addToolMessage\(', 'addToolMessage(agent, '
$tools = $tools -replace 'agent\.handleSpecialToolResults\(', 'handleSpecialToolResults(agent, '
$tools = $tools -replace 'agent\.syncTodoMessage\(\)', 'syncTodoMessage(agent)'
Save "$root/src/agent-tools.ts" ($toolsHeader + "`n`n" + $tools)
