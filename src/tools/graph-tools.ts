import * as MemoryGraphTools from '../graph/tools.js';

import type { Tool } from './shared.js';

// Memory Graph
export const buildMemoryGraphTool: Tool = {
  name: 'build_memory_graph',
  description:
    'Build a memory graph from the codebase for better understanding and querying of code structure. Use when you need to understand the codebase architecture or find related code.',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(await MemoryGraphTools.build_memory_graph({ workspace: ws })),
};

export const queryMemoryGraphTool: Tool = {
  name: 'query_memory_graph',
  description:
    "Query the memory graph for nodes, edges, and paths. Supported query types: 'node' (by type/name/path), 'edge' (by type/from/to), 'path' (shortest path between nodes), 'pattern' (regex search across all data), 'semantic' (related nodes).",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'object',
        description:
          "Query object with type ('node'|'edge'|'path'|'pattern'|'semantic') and query parameters",
      },
    },
    required: ['query'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) => {
    try {
      await MemoryGraphTools.build_memory_graph({ workspace: ws });
      return JSON.stringify(
        await MemoryGraphTools.query_memory_graph({ workspace: ws, query: args.query })
      );
    } catch (e: unknown) {
      return JSON.stringify({ error: (e as { message?: string }).message });
    }
  },
};

export const getGraphStatsTool: Tool = {
  name: 'get_graph_stats',
  description: 'Get statistics about the memory graph (node counts by type and language).',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(await MemoryGraphTools.get_graph_stats({ workspace: ws })),
};

export const searchNodesByTypeTool: Tool = {
  name: 'search_nodes_by_type',
  description:
    'Search for nodes in the memory graph by type (file, function, class, type, variable, import, export, interface, enum, module).',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Node type to search for' },
      limit: { type: 'number', description: 'Max results' },
    },
    required: ['type'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(
      await MemoryGraphTools.search_nodes_by_type({
        workspace: ws,
        type: args.type,
        limit: args.limit,
      })
    ),
};

export const searchNodesByNameTool: Tool = {
  name: 'search_nodes_by_name',
  description:
    'Search for nodes in the memory graph by name (function name, class name, variable name, etc.).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name to search for' },
      limit: { type: 'number', description: 'Max results' },
    },
    required: ['name'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(
      await MemoryGraphTools.search_nodes_by_name({
        workspace: ws,
        name: args.name,
        limit: args.limit,
      })
    ),
};

export const searchNodesByPathTool: Tool = {
  name: 'search_nodes_by_path',
  description: 'Search for nodes in the memory graph by file path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to search for' },
      limit: { type: 'number', description: 'Max results' },
    },
    required: ['path'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(
      await MemoryGraphTools.search_nodes_by_path({
        workspace: ws,
        path: args.path,
        limit: args.limit,
      })
    ),
};

export const findDependenciesTool: Tool = {
  name: 'find_dependencies',
  description: 'Find dependencies of a node in the memory graph by node ID.',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to find dependencies for' },
      maxDepth: { type: 'number', description: 'Max depth to traverse' },
    },
    required: ['nodeId'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(
      await MemoryGraphTools.find_dependencies({
        workspace: ws,
        nodeId: args.nodeId,
        maxDepth: args.maxDepth,
      })
    ),
};

export const findPathTool: Tool = {
  name: 'find_path',
  description: 'Find the shortest path between two nodes in the memory graph.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Starting node ID' },
      to: { type: 'string', description: 'Target node ID' },
      maxDepth: { type: 'number', description: 'Max search depth' },
    },
    required: ['from', 'to'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(
      await MemoryGraphTools.find_path({
        workspace: ws,
        from: args.from,
        to: args.to,
        maxDepth: args.maxDepth,
      })
    ),
};

export const patternSearchTool: Tool = {
  name: 'pattern_search',
  description:
    'Search the memory graph using a regex pattern across all node data (name, path, type, code).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search' },
      limit: { type: 'number', description: 'Max results' },
    },
    required: ['pattern'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(
      await MemoryGraphTools.pattern_search({
        workspace: ws,
        pattern: args.pattern,
        limit: args.limit,
      })
    ),
};

export const getFileInfoTool: Tool = {
  name: 'get_file_info',
  description: 'Get all nodes in a file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' } },
    required: ['path'],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(await MemoryGraphTools.get_file_info({ workspace: ws, path: args.path })),
};

export const getCommunitiesTool: Tool = {
  name: 'get_communities',
  description: 'Detect community clusters using Louvain modularity algorithm.',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(await MemoryGraphTools.get_communities({ workspace: ws })),
};

export const getGodNodesTool: Tool = {
  name: 'get_god_nodes',
  description: 'Find the most-connected hub nodes (highest degree).',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'Max results' } },
    required: [],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(await MemoryGraphTools.get_god_nodes({ workspace: ws, limit: args.limit })),
};

export const getSurprisingConnectionsTool: Tool = {
  name: 'get_surprising_connections',
  description: 'Find cross-community edges (architectural boundary violations).',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'Max results' } },
    required: [],
  },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(
      await MemoryGraphTools.get_surprising_connections({ workspace: ws, limit: args.limit })
    ),
};

export const getAnalysisReportTool: Tool = {
  name: 'get_analysis_report',
  description:
    'Get full markdown report with stats, communities, god nodes, and surprising connections.',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: () => JSON.stringify({ ok: false, error: 'Use executeAsync for this tool' }),
  executeAsync: async (args, ws) =>
    JSON.stringify(await MemoryGraphTools.get_analysis_report({ workspace: ws })),
};
