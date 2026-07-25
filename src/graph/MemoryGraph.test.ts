/**
 * Behavioral tests for MemoryGraph and the graph tool wrappers.
 * Uses real temp workspaces with small TS/JS fixtures (offline, deterministic).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryGraph } from './MemoryGraph.js';
import {
  build_memory_graph,
  query_memory_graph,
  get_graph_stats,
  search_nodes_by_type,
  search_nodes_by_name,
  search_nodes_by_path,
  find_dependencies,
  find_path,
  pattern_search,
  get_file_info,
  get_function_info,
  get_class_info,
  list_files,
  list_functions,
  list_classes,
  get_communities,
  get_god_nodes,
  get_surprising_connections,
  get_analysis_report,
  clear_graph_cache,
} from './tools.js';

const UTILS_TS = `export function add(a: number, b: number): number {
  return a + b;
}

export const VERSION = '1.0.0';

export interface Shape {
  area(): number;
}

export type ID = string | number;

export enum Color {
  Red,
  Green,
}

export class Greeter {
  name = 'world';

  greet(): number {
    return add(1, 2);
  }
}
`;

const MAIN_TS = `import { add } from './utils.js';

export function main(): number {
  return add(2, 3);
}
`;

const HELPER_JS = `function shout(msg) {
  return msg.toUpperCase();
}

module.exports = { shout };
`;

const PKG_JSON = `{ "name": "fixture-pkg", "version": "0.0.1" }`;

function seedWorkspace(ws: string): void {
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'utils.ts'), UTILS_TS);
  writeFileSync(join(ws, 'src', 'main.ts'), MAIN_TS);
  writeFileSync(join(ws, 'src', 'helper.js'), HELPER_JS);
  writeFileSync(join(ws, 'src', 'package.json'), PKG_JSON);
}

describe('MemoryGraph', () => {
  let ws: string;

  beforeEach(() => {
    // Unique workspace per test: isolates the .qwen-graph dir and the tools.ts graphCache
    ws = mkdtempSync(join(tmpdir(), 'memory-graph-test-'));
    seedWorkspace(ws);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clear_graph_cache();
    rmSync(ws, { recursive: true, force: true });
  });

  describe('build()', () => {
    it('creates file nodes for all seeded files', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();

      const stats = graph.getStats();
      expect(stats.nodeCount).toBeGreaterThan(0);
      expect(stats.edgeCount).toBeGreaterThan(0);
      expect(stats.nodesByType.file).toBe(4);
      expect(stats.nodesByLanguage.typescript).toBeGreaterThan(0);
      expect(stats.nodesByLanguage.javascript).toBeGreaterThan(0);
    });

    it('extracts functions, classes, variables, types and enums from TS files', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();

      const stats = graph.getStats();
      expect(stats.nodesByType.function).toBeGreaterThan(0);
      expect(stats.nodesByType.class).toBeGreaterThan(0);
      expect(stats.nodesByType.variable).toBeGreaterThan(0);
      expect(stats.nodesByType.type).toBeGreaterThan(0);

      // Specific symbols are findable by exact node id
      expect(
        graph.query({ type: 'node', query: 'function:file:src/utils.ts:add' }).nodes
      ).toHaveLength(1);
      expect(
        graph.query({ type: 'node', query: 'class:file:src/utils.ts:Greeter' }).nodes
      ).toHaveLength(1);
      expect(
        graph.query({ type: 'node', query: 'variable:file:src/utils.ts:VERSION' }).nodes
      ).toHaveLength(1);
      expect(
        graph.query({ type: 'node', query: 'type:file:src/utils.ts:Shape' }).nodes
      ).toHaveLength(1);
      expect(
        graph.query({ type: 'node', query: 'type:file:src/utils.ts:Color' }).nodes
      ).toHaveLength(1);
      expect(
        graph.query({ type: 'node', query: 'function:file:src/helper.js:shout' }).nodes
      ).toHaveLength(1);
    });

    it('creates class member nodes (methods and properties)', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();

      const method = graph.query({
        type: 'node',
        query: 'function:class:file:src/utils.ts:Greeter:greet',
      });
      expect(method.nodes).toHaveLength(1);
      expect(method.nodes[0].metadata?.class).toBe('Greeter');

      const prop = graph.query({
        type: 'node',
        query: 'variable:class:file:src/utils.ts:Greeter:name',
      });
      expect(prop.nodes).toHaveLength(1);
    });

    it('creates part_of edges from files to their symbols', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();

      const edges = graph.query({
        type: 'edge',
        query: { type: 'part_of', source: 'file:src/utils.ts' },
      }).edges;
      const targets = edges.map((e) => e.target);
      expect(targets).toContain('function:file:src/utils.ts:add');
      expect(targets).toContain('class:file:src/utils.ts:Greeter');
    });

    it('creates imports edges for import declarations', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();

      const edges = graph.query({
        type: 'edge',
        query: { type: 'imports', source: 'file:src/main.ts' },
      }).edges;
      expect(edges).toHaveLength(1);
      expect(edges[0].target).toBe('import:file:src/main.ts:add');

      const importNode = graph.query({ type: 'node', query: 'import:file:src/main.ts:add' })
        .nodes[0];
      expect(importNode.type).toBe('module');
      expect(importNode.metadata?.importedFrom).toBe('./utils.js');
    });

    it('creates calls edges for intra-file function calls', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();

      // Greeter.greet() calls add() in the same file
      const calls = graph.query({
        type: 'edge',
        query: { type: 'calls', target: 'function:file:src/utils.ts:add' },
      }).edges;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0].source).toBe('function:class:file:src/utils.ts:Greeter:greet');
    });

    it('creates calls edges for cross-file calls via imports (ESM .js -> .ts)', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();

      // main.ts imports { add } from './utils.js' (utils.ts on disk) and calls it
      const calls = graph.query({
        type: 'edge',
        query: { type: 'calls', target: 'function:file:src/utils.ts:add' },
      }).edges;
      const crossFile = calls.find((e) => e.source === 'function:file:src/main.ts:main');
      expect(crossFile).toBeDefined();
      expect(crossFile!.metadata?.crossFile).toBe(true);
    });

    it('extracts config concept nodes from JSON files', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();

      const node = graph.query({
        type: 'node',
        query: 'config:file:src/package.json:name',
      }).nodes[0];
      expect(node).toBeDefined();
      expect(node.type).toBe('concept');
      expect(node.description).toBe('fixture-pkg');
    });
  });

  describe('save/load', () => {
    it('reports exists() only after a build has saved the graph', async () => {
      expect(MemoryGraph.exists(ws)).toBe(false);

      const graph = new MemoryGraph(ws);
      await graph.build();

      expect(MemoryGraph.exists(ws)).toBe(true);
    });

    it('round-trips nodes and edges through disk', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();
      const before = graph.getStats();

      const loaded = await MemoryGraph.load(ws);
      expect(loaded).not.toBeNull();
      const after = loaded!.getStats();

      expect(after.nodeCount).toBe(before.nodeCount);
      expect(after.edgeCount).toBe(before.edgeCount);
      expect(
        loaded!.query({ type: 'node', query: 'class:file:src/utils.ts:Greeter' }).nodes
      ).toHaveLength(1);
    });

    it('load() returns null when no graph exists', async () => {
      const loaded = await MemoryGraph.load(ws);
      expect(loaded).toBeNull();
    });
  });

  describe('isUpToDate()', () => {
    it('is false before any build and true right after', async () => {
      const graph = new MemoryGraph(ws);
      expect(await graph.isUpToDate()).toBe(false);

      await graph.build();
      expect(await graph.isUpToDate()).toBe(true);
    });

    it('is false after a tracked file is modified', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();
      expect(await graph.isUpToDate()).toBe(true);

      appendFileSync(join(ws, 'src', 'utils.ts'), '\nexport const EXTRA = 42;\n');
      expect(await graph.isUpToDate()).toBe(false);
    });

    it('is false after a file is added or removed', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();

      writeFileSync(join(ws, 'src', 'added.ts'), 'export const x = 1;\n');
      expect(await graph.isUpToDate()).toBe(false);

      rmSync(join(ws, 'src', 'added.ts'));
      expect(await graph.isUpToDate()).toBe(true);

      rmSync(join(ws, 'src', 'helper.js'));
      expect(await graph.isUpToDate()).toBe(false);
    });
  });

  describe('query/search APIs', () => {
    let graph: MemoryGraph;

    beforeEach(async () => {
      graph = new MemoryGraph(ws);
      await graph.build();
    });

    it('finds nodes by name (case-insensitive substring)', () => {
      const result = graph.query({ type: 'node', query: { name: 'greeter' } });
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.some((n) => n.name === 'Greeter')).toBe(true);
    });

    it('finds nodes by type', () => {
      const result = graph.query({ type: 'node', query: { type: 'class' } });
      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].name).toBe('Greeter');
    });

    it('finds nodes by path substring', () => {
      const result = graph.query({ type: 'node', query: { path: 'utils.ts' } });
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.every((n) => (n.path || '').includes('utils.ts'))).toBe(true);
    });

    it('combines criteria (type + name) and respects limit', () => {
      const result = graph.query({ type: 'node', query: { type: 'function', name: 'add' } });
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.every((n) => n.type === 'function')).toBe(true);

      const limited = graph.query({ type: 'node', query: { type: 'function', limit: 1 } });
      expect(limited.nodes).toHaveLength(1);
    });

    it('pattern query matches name/id with regex', () => {
      const result = graph.query({ type: 'pattern', query: '^greet' });
      expect(result.nodes.some((n) => n.name === 'greet')).toBe(true);

      const none = graph.query({ type: 'pattern', query: 'no-such-symbol-zzz' });
      expect(none.nodes).toHaveLength(0);
    });

    it('semantic query returns nodes related to a given node id', () => {
      const result = graph.query({
        type: 'semantic',
        query: { relatedTo: 'file:src/main.ts' },
      });
      const ids = result.nodes.map((n) => n.id);
      expect(ids).toContain('import:file:src/main.ts:add');
      expect(ids).toContain('function:file:src/main.ts:main');
    });

    it('path query finds a path between connected nodes (file -> import)', () => {
      const result = graph.query({
        type: 'path',
        query: { from: 'file:src/main.ts', to: 'import:file:src/main.ts:add' },
      });
      expect(result.paths.length).toBeGreaterThan(0);
      expect(result.paths[0][0]).toBe('file:src/main.ts');
      expect(result.paths[0][result.paths[0].length - 1]).toBe('import:file:src/main.ts:add');
    });

    it('path query returns empty for unreachable nodes', () => {
      const result = graph.query({
        type: 'path',
        query: { from: 'class:file:src/utils.ts:Greeter', to: 'file:src/main.ts' },
      });
      // Edges are directed file -> symbol, so symbol -> file is unreachable
      expect(result.paths).toHaveLength(0);
    });

    it('query result stats reflect the whole graph', () => {
      const stats = graph.getStats();
      const result = graph.query({ type: 'node', query: { name: 'add' } });
      expect(result.stats.nodeCount).toBe(stats.nodeCount);
      expect(result.stats.edgeCount).toBe(stats.edgeCount);
      expect(result.stats.queryTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('analysis APIs', () => {
    let graph: MemoryGraph;

    beforeEach(async () => {
      graph = new MemoryGraph(ws);
      await graph.build();
    });

    it('getStats returns counts grouped by type and language', () => {
      const stats = graph.getStats();
      expect(stats.nodeCount).toBeGreaterThan(0);
      expect(stats.edgeCount).toBeGreaterThan(0);
      const typeSum = Object.values(stats.nodesByType).reduce((a, b) => a + b, 0);
      expect(typeSum).toBe(stats.nodeCount);
    });

    it('getCommunities covers all nodes with sequential ids', () => {
      const communities = graph.getCommunities();
      expect(communities.length).toBeGreaterThan(0);
      const total = communities.reduce((a, c) => a + c.size, 0);
      expect(total).toBe(graph.getStats().nodeCount);
      // Sorted by size descending
      for (let i = 1; i < communities.length; i++) {
        expect(communities[i - 1].size).toBeGreaterThanOrEqual(communities[i].size);
      }
    });

    it('getGodNodes ranks file nodes highest (they own all symbols)', () => {
      const godNodes = graph.getGodNodes(5);
      expect(godNodes.length).toBeGreaterThan(0);
      expect(godNodes[0].node.type).toBe('file');
      for (let i = 1; i < godNodes.length; i++) {
        expect(godNodes[i - 1].degree).toBeGreaterThanOrEqual(godNodes[i].degree);
      }
      expect(godNodes[0].degree).toBe(godNodes[0].inDegree + godNodes[0].outDegree);
    });

    it('getSurprisingConnections returns cross-community edges', () => {
      const surprising = graph.getSurprisingConnections(20);
      for (const sc of surprising) {
        expect(sc.sourceCommunity).not.toBe(sc.targetCommunity);
        expect(sc.edge).toBeDefined();
      }
    });

    it('generateAnalysisReport produces a markdown report with sane values', () => {
      const report = graph.generateAnalysisReport();
      expect(report).toContain('# Memory Graph Analysis Report');
      expect(report).toContain('## Nodes by Type');
      expect(report).toContain('## God Nodes');
      expect(report).toContain('Greeter');
      const stats = graph.getStats();
      expect(report).toContain(`- **Nodes**: ${stats.nodeCount}`);
      expect(report).toContain(`- **Edges**: ${stats.edgeCount}`);
    });
  });

  describe('node/edge mutation helpers', () => {
    it('updateNode, removeNode, export and import behave consistently', async () => {
      const graph = new MemoryGraph(ws);
      await graph.build();
      const stats = graph.getStats();

      expect(graph.updateNode('file:src/utils.ts', { description: 'updated' })).toBe(true);
      expect(graph.updateNode('no-such-id', {})).toBe(false);
      expect(graph.query({ type: 'node', query: 'file:src/utils.ts' }).nodes[0].description).toBe(
        'updated'
      );

      const before = graph.getStats().nodeCount;
      expect(graph.removeNode('variable:file:src/utils.ts:VERSION')).toBe(true);
      expect(graph.removeNode('variable:file:src/utils.ts:VERSION')).toBe(false);
      expect(graph.getStats().nodeCount).toBe(before - 1);
      // Edges touching the removed node are gone
      expect(
        graph.query({ type: 'edge', query: { target: 'variable:file:src/utils.ts:VERSION' } }).edges
      ).toHaveLength(0);

      const exported = graph.export();
      expect(exported.nodes).toHaveLength(graph.getStats().nodeCount);
      expect(exported.edges).toHaveLength(graph.getStats().edgeCount);

      const clone = new MemoryGraph(ws);
      clone.import({ nodes: exported.nodes, edges: exported.edges });
      expect(clone.getStats().nodeCount).toBe(stats.nodeCount - 1);
    });
  });
});

describe('graph tools (tools.ts wrappers)', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'memory-graph-tools-test-'));
    seedWorkspace(ws);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clear_graph_cache();
    rmSync(ws, { recursive: true, force: true });
  });

  it('build_memory_graph returns ok with node/edge counts', async () => {
    const result = await build_memory_graph({ workspace: ws });
    expect(result.ok).toBe(true);
    expect(result.nodes).toBeGreaterThan(0);
    expect(result.edges).toBeGreaterThan(0);
    expect(result.time).toBeGreaterThanOrEqual(0);
    expect(MemoryGraph.exists(ws)).toBe(true);
  });

  it('query wrappers return seeded symbols from the built graph', async () => {
    await build_memory_graph({ workspace: ws });

    const byName = await search_nodes_by_name({ workspace: ws, name: 'Greeter' });
    expect(byName.some((n) => n.type === 'class' && n.name === 'Greeter')).toBe(true);

    const byType = await search_nodes_by_type({ workspace: ws, type: 'function' });
    expect(byType.length).toBeGreaterThan(0);
    expect(byType.every((n) => n.type === 'function')).toBe(true);

    const byPath = await search_nodes_by_path({ workspace: ws, path: 'main.ts' });
    expect(byPath.length).toBeGreaterThan(0);

    const fn = await get_function_info({ workspace: ws, name: 'add' });
    expect(fn.some((n) => n.name === 'add')).toBe(true);

    const cls = await get_class_info({ workspace: ws, name: 'Greeter' });
    expect(cls).toHaveLength(1);

    const file = await get_file_info({ workspace: ws, path: 'utils.ts' });
    expect(file).not.toBeNull();
    expect(file!.type).toBe('file');
  });

  it('list wrappers enumerate files, functions and classes', async () => {
    await build_memory_graph({ workspace: ws });

    const files = await list_files({ workspace: ws });
    expect(files).toHaveLength(4);
    expect(files.every((n) => n.type === 'file')).toBe(true);

    const fns = await list_functions({ workspace: ws });
    expect(fns.length).toBeGreaterThan(0);

    const classes = await list_classes({ workspace: ws });
    expect(classes.map((c) => c.name)).toContain('Greeter');
  });

  it('dependency and path queries traverse import edges', async () => {
    await build_memory_graph({ workspace: ws });

    const deps = await find_dependencies({ workspace: ws, nodeId: 'file:src/main.ts' });
    const depIds = deps.map((n) => n.id);
    expect(depIds).toContain('import:file:src/main.ts:add');

    const paths = await find_path({
      workspace: ws,
      from: 'file:src/main.ts',
      to: 'import:file:src/main.ts:add',
    });
    expect(paths.length).toBeGreaterThan(0);

    const matches = await pattern_search({ workspace: ws, pattern: 'Greeter' });
    expect(matches.some((n) => n.name === 'Greeter')).toBe(true);
  });

  it('stats and analysis wrappers report sane values', async () => {
    await build_memory_graph({ workspace: ws });

    const stats = await get_graph_stats({ workspace: ws });
    expect(stats.nodeCount).toBeGreaterThan(0);
    expect(stats.nodesByType.file).toBe(4);

    const communities = await get_communities({ workspace: ws });
    expect(communities.ok).toBe(true);
    expect(communities.communities.length).toBeGreaterThan(0);

    const godNodes = await get_god_nodes({ workspace: ws, limit: 3 });
    expect(godNodes.ok).toBe(true);
    expect(godNodes.godNodes.length).toBeGreaterThan(0);
    expect(godNodes.godNodes.length).toBeLessThanOrEqual(3);

    const surprising = await get_surprising_connections({ workspace: ws });
    expect(surprising.ok).toBe(true);

    const report = await get_analysis_report({ workspace: ws });
    expect(report.ok).toBe(true);
    expect(report.report).toContain('# Memory Graph Analysis Report');
  });

  it('query_memory_graph returns a full GraphQueryResult', async () => {
    await build_memory_graph({ workspace: ws });

    const result = await query_memory_graph({
      workspace: ws,
      query: { type: 'node', query: { name: 'add' } },
    });
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.stats.nodeCount).toBeGreaterThan(0);
  });

  it('reuses the cached graph instance without rebuilding on repeated queries', async () => {
    const buildSpy = vi.spyOn(MemoryGraph.prototype, 'build');

    await build_memory_graph({ workspace: ws });
    expect(buildSpy.mock.calls.length).toBe(1);

    await query_memory_graph({ workspace: ws, query: { type: 'node', query: { type: 'file' } } });
    await query_memory_graph({ workspace: ws, query: { type: 'node', query: { name: 'add' } } });
    await get_graph_stats({ workspace: ws });

    // Graph is cached and up to date — no rebuilds triggered by queries
    expect(buildSpy.mock.calls.length).toBe(1);
  });

  it('auto-rebuilds via getMemoryGraph when a file changes after build', async () => {
    const buildSpy = vi.spyOn(MemoryGraph.prototype, 'build');

    await build_memory_graph({ workspace: ws });
    expect(buildSpy.mock.calls.length).toBe(1);

    appendFileSync(join(ws, 'src', 'main.ts'), '\nexport const CHANGED = true;\n');

    const stats = await get_graph_stats({ workspace: ws });
    // Stale graph detected -> rebuilt automatically, new symbol indexed
    expect(buildSpy.mock.calls.length).toBe(2);
    const found = await search_nodes_by_name({ workspace: ws, name: 'CHANGED' });
    expect(found.length).toBe(1);
    expect(stats.nodeCount).toBeGreaterThan(0);
  });

  it('wrappers degrade gracefully for a workspace that cannot be built', async () => {
    // A file (not a directory) as workspace: readdir fails, graph stays empty but nothing throws
    const fileWs = join(ws, 'not-a-dir.ts');
    writeFileSync(fileWs, 'export const x = 1;\n');

    const stats = await get_graph_stats({ workspace: fileWs });
    expect(stats.nodeCount).toBe(0);

    const nodes = await search_nodes_by_name({ workspace: fileWs, name: 'x' });
    expect(nodes).toEqual([]);
  });
});
