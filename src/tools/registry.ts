import type { Config } from '../types.js';

import type { Tool } from './shared.js';
import { checkSmallModel } from './shared.js';
import {
  changeWorkspaceTool,
  batchReadFilesTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  editFileLinesTool,
  listDirTool,
  statPathTool,
} from './file-tools/index.js';
import {
  mapProjectTreeTool,
  searchAndViewTool,
  findFilesTool,
  grepSearchTool,
} from './search-tools.js';
import { gitDiffTool, gitStatusTool, gitCommitTool } from './git-tools.js';
import {
  executeCommandTool,
  runTestsTool,
  installDependenciesTool,
  runCommandTool,
  typecheckTool,
} from './exec-tools.js';
import {
  buildMemoryGraphTool,
  queryMemoryGraphTool,
  getGraphStatsTool,
  searchNodesByTypeTool,
  searchNodesByNameTool,
  searchNodesByPathTool,
  findDependenciesTool,
  findPathTool,
  patternSearchTool,
  getFileInfoTool,
  getCommunitiesTool,
  getGodNodesTool,
  getSurprisingConnectionsTool,
  getAnalysisReportTool,
} from './graph-tools.js';
import { manageTodosTool, exploreSubagentTool } from './misc-tools.js';
import { manageMcpTool } from './mcp-manage.js';

/** Shorter tool descriptions for ≤8B models (full params stay in JSON schema). */
export const SMALL_TOOL_DESCRIPTIONS: Record<string, string> = {
  read_file:
    'Read file; use start_line/end_line (1-indexed). Lines are numbered for edit_file_lines.',
  write_file: 'Create or overwrite a file.',
  edit_file: 'Replace exact old_text once (read file first).',
  edit_file_lines: 'Replace lines start_line–end_line (1-based, from read_file).',
  list_dir: 'List directory entries.',
  stat_path: 'File exists? size, modified time.',
  find_files: 'Find paths by name substring or regex.',
  search_and_view: 'Search code; returns matching lines with context.',
  execute_command: 'Run shell/bash command in workspace (Git Bash enabled on Windows).',
  git_status: 'Short git status.',
  git_diff: 'Uncommitted diff.',
  git_commit: 'git add -A and commit with message.',
  change_workspace: 'Change working directory.',
  manage_todos: 'add | complete | remove | list subtasks.',
  manage_mcp: 'add | remove | list MCP servers in the global config.',
  // Short descriptions for tools excluded from small models (kept for reference)
  grep_search: 'Search text patterns across files.',
  map_project_tree: 'Project structure tree.',
  batch_read_files: 'Read multiple files at once.',
  typecheck: 'Run tsc --noEmit.',
  run_tests: 'Run project test suite.',
  run_command: 'Run a build/lint/format script.',
  install_dependencies: 'Install project dependencies.',
};

/** Built-in tools available to the agent. */
export const tools: Tool[] = [
  changeWorkspaceTool,
  batchReadFilesTool,
  gitDiffTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  editFileLinesTool,
  listDirTool,
  mapProjectTreeTool,
  statPathTool,
  searchAndViewTool,
  findFilesTool,
  grepSearchTool,
  gitStatusTool,
  gitCommitTool,
  executeCommandTool,
  runTestsTool,
  installDependenciesTool,
  runCommandTool,
  typecheckTool,
  manageTodosTool,
  manageMcpTool,
  buildMemoryGraphTool,
  queryMemoryGraphTool,
  getGraphStatsTool,
  searchNodesByTypeTool,
  searchNodesByNameTool,
  searchNodesByPathTool,
  findDependenciesTool,
  findPathTool,
  patternSearchTool,
  getFileInfoTool,
  getCommunitiesTool,
  getGodNodesTool,
  getSurprisingConnectionsTool,
  getAnalysisReportTool,
  exploreSubagentTool,
];

// Tools excluded for ≤8B models — fewer choices, less wrong-tool drift
export const SMALL_MODEL_EXCLUDED = new Set([
  'install_dependencies',
  'run_command',
  'run_tests',
  'map_project_tree',
  'batch_read_files',
  'grep_search',
  // Graph tools — too complex/heavy for ≤8B models
  'build_memory_graph',
  'query_memory_graph',
  'get_graph_stats',
  'search_nodes_by_type',
  'search_nodes_by_name',
  'search_nodes_by_path',
  'find_dependencies',
  'find_path',
  'pattern_search',
  'get_file_info',
  'get_communities',
  'get_god_nodes',
  'get_surprising_connections',
  'get_analysis_report',
]);

// Tools that can be executed in parallel (read-only, non-blocking)
export const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'list_dir',
  'stat_path',
  'find_files',
  'grep_search',
  'search_and_view',
  'git_status',
  'git_diff',
  'map_project_tree',
  'batch_read_files',
  // NOTE: memory-graph query tools are deliberately NOT parallel-safe — they
  // can trigger full graph rebuilds, so they must run sequentially.
  // Remote sub-agent dispatch — each call hits a free 2B worker; running
  // multiple in one message fans them out to up to 4 concurrent workers.
  'explore_subagent',
]);

// Tools that must run sequentially (write operations, state changes)
export const SEQUENTIAL_ONLY_TOOLS = new Set([
  'edit_file',
  'edit_file_lines',
  'execute_command',
  'git_commit',
  'install_dependencies',
  'run_tests',
  'run_command',
  'typecheck',
  'change_workspace',
  'manage_todos',
  'manage_mcp',
  'write_file',
  // Graph build is expensive and mutates state
  'build_memory_graph',
]);

/**
 * Whether the remote sub-agent pool is available for the given config.
 * Used by the agent to decide whether to advertise sub-agents in the system
 * prompt. A pool is available when an explicit `subagents` config is enabled
 * with endpoints, or a remote LM Studio URL is set for auto-discovery.
 */
export function subAgentAvailable(cfg?: Config): boolean {
  if (!cfg) return false;
  const pool = (cfg as Config & { subagents?: { enabled?: boolean; endpoints?: unknown[] } })
    .subagents;
  if (pool?.enabled && pool.endpoints && pool.endpoints.length > 0) {
    return true;
  }
  return Boolean(cfg.subAgentEnabled);
}

export const GRAPH_TOOLS = new Set([
  'build_memory_graph',
  'query_memory_graph',
  'get_graph_stats',
  'search_nodes_by_type',
  'search_nodes_by_name',
  'search_nodes_by_path',
  'find_dependencies',
  'find_path',
  'pattern_search',
  'get_file_info',
  'get_communities',
  'get_god_nodes',
  'get_surprising_connections',
  'get_analysis_report',
]);

export function toolsForConfig(all: Tool[], cfg?: Config, activeSkills?: Set<string>): Tool[] {
  let filtered = all;
  if (cfg && checkSmallModel(cfg)) {
    filtered = filtered.filter((t) => {
      if (activeSkills?.has('memory-graph') && GRAPH_TOOLS.has(t.name)) return true;
      return !SMALL_MODEL_EXCLUDED.has(t.name);
    });
  }
  return filtered;
}

// The remote sub-agent tool (explore_subagent) IS exposed to the LLM as a
// function call so the main agent can actually invoke it. The agent loop
// handles it like any other tool (see src/subagents.ts).

export function toOpenAI(allTools: Tool[], cfg?: Config, activeSkills?: Set<string>) {
  const filtered = toolsForConfig(allTools, cfg, activeSkills);
  const small = cfg && checkSmallModel(cfg);
  return filtered.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: (small && SMALL_TOOL_DESCRIPTIONS[t.name]) || t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Check if a tool can be executed in parallel with others.
 */
export function canRunInParallel(toolName: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(toolName);
}

/**
 * Check if a tool must run sequentially.
 */
export function mustRunSequentially(toolName: string): boolean {
  return SEQUENTIAL_ONLY_TOOLS.has(toolName);
}

/**
 * Group tool calls into parallel and sequential batches.
 */
export function groupToolsForParallelExecution(
  toolCalls: Array<{ name: string; arguments: string; id: string }>
): {
  parallel: Array<{ name: string; arguments: string; index: number; id: string }>;
  sequential: Array<{ name: string; arguments: string; index: number; id: string }>;
} {
  const parallel: Array<{ name: string; arguments: string; index: number; id: string }> = [];
  const sequential: Array<{ name: string; arguments: string; index: number; id: string }> = [];

  toolCalls.forEach((tc, index) => {
    if (canRunInParallel(tc.name)) {
      parallel.push({ ...tc, index });
    } else {
      sequential.push({ ...tc, index });
    }
  });

  return { parallel, sequential };
}

let externalTools: Tool[] = [];

export function registerExternalTools(tools: Tool[]): void {
  externalTools = tools;
}

export function getAllTools(): Tool[] {
  return [...tools, ...externalTools];
}

export function findTool(name: string): Tool | undefined {
  return getAllTools().find((t) => t.name === name);
}
