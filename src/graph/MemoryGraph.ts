/**
 * Memory Graph System
 *
 * A knowledge graph that stores information about the codebase:
 * - Files, functions, classes, variables, types
 * - Dependencies and relationships between them
 * - Concepts and documentation
 *
 * Features:
 * - Build graph from source code
 * - Load/save existing graphs
 * - Query the graph for information
 * - Incremental updates
 */

import {
  GraphNode,
  GraphEdge,
  GraphQuery,
  GraphQueryResult,
  GraphBuildOptions,
  GraphCommunity,
  GodNode,
} from './types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { logError, logInfo, logWarn } from '../log.js';

const GRAPH_VERSION = '1.0.0';
const GRAPH_DIRECTORY = '.qwen-graph';
const GRAPH_FILE = 'memory-graph.json';
const HASH_FILE = 'graph-hash.json';

export class MemoryGraph {
  private nodes: Map<string, GraphNode>;
  private edges: Map<string, GraphEdge>;
  private indexes: {
    byType: Map<string, Set<string>>;
    byPath: Map<string, Set<string>>;
    byName: Map<string, Set<string>>;
    byLanguage: Map<string, Set<string>>;
  };
  private version: string;
  private lastUpdated: number;
  private workspace: string;
  private graphDir: string;
  private options: GraphBuildOptions;
  /** Per-file import map: fileId -> (localName -> module specifier + exported name). */
  private fileImports: Map<string, Map<string, { module: string; exported: string }>> = new Map();
  /** Call sites whose callee wasn't found in the same file (resolved post-build). */
  private pendingCalls: Array<{
    callerId: string;
    calledName: string;
    line: number;
    fileId: string;
  }> = [];

  constructor(workspace: string, options: GraphBuildOptions = {}) {
    this.workspace = workspace;
    this.graphDir = join(workspace, GRAPH_DIRECTORY);
    this.version = GRAPH_VERSION;
    this.lastUpdated = Date.now();
    this.options = {
      includeDependencies: true,
      includeCode: false,
      maxFileSize: 1024 * 1024, // 1MB
      excludedPaths: [
        'node_modules',
        'dist',
        'build',
        '.git',
        '.qwen-graph',
        '.next',
        '.turbo',
        '.cache',
        'coverage',
        '*.lock',
        '*.log',
      ],
      // NOTE: no default includedPaths — index the whole workspace (minus
      // excludedPaths) unless the caller explicitly scopes it. A default of
      // ['src','tests','lib'] silently skipped code in other directories.
      ...options,
    };

    this.nodes = new Map();
    this.edges = new Map();
    this.indexes = {
      byType: new Map(),
      byPath: new Map(),
      byName: new Map(),
      byLanguage: new Map(),
    };
  }

  /**
   * Check if a graph already exists for this workspace
   */
  static exists(workspace: string): boolean {
    const graphDir = join(workspace, GRAPH_DIRECTORY);
    const graphFile = join(graphDir, GRAPH_FILE);
    return existsSync(graphFile);
  }

  /**
   * Load an existing graph from disk
   */
  static async load(workspace: string): Promise<MemoryGraph | null> {
    const graphDir = join(workspace, GRAPH_DIRECTORY);
    const graphFile = join(graphDir, GRAPH_FILE);

    if (!existsSync(graphFile)) {
      return null;
    }

    try {
      const data = JSON.parse(readFileSync(graphFile, 'utf-8'));
      const graph = new MemoryGraph(workspace);

      // Load nodes
      for (const node of data.nodes || []) {
        graph.addNode(node);
      }

      // Load edges
      for (const edge of data.edges || []) {
        graph.addEdge(edge);
      }

      graph.version = data.version || GRAPH_VERSION;
      graph.lastUpdated = data.lastUpdated || Date.now();

      return graph;
    } catch (error) {
      logError('Error loading memory graph:', error);
      return null;
    }
  }

  /**
   * Create a new graph or load existing one
   */
  static async create(workspace: string, options: GraphBuildOptions = {}): Promise<MemoryGraph> {
    // Check if graph exists and is up to date
    const existingGraph = await MemoryGraph.load(workspace);
    if (existingGraph && (await existingGraph.isUpToDate())) {
      return existingGraph;
    }

    // Create new graph and build it so callers get a usable graph
    const graph = new MemoryGraph(workspace, options);
    await graph.build();
    return graph;
  }

  /**
   * Check if the graph is up to date with the source files
   */
  async isUpToDate(): Promise<boolean> {
    const hashFile = join(this.graphDir, HASH_FILE);

    if (!existsSync(hashFile)) {
      return false;
    }

    try {
      const savedHashes = JSON.parse(readFileSync(hashFile, 'utf-8'));
      const currentHashes = await this.computeFileHashes();

      const savedKeys = Object.keys(savedHashes);
      const currentKeys = Object.keys(currentHashes);

      // Different number of files means something was added or removed
      if (savedKeys.length !== currentKeys.length) {
        return false;
      }

      // Check if any tracked file has changed
      for (const [path, hash] of Object.entries(currentHashes)) {
        if (savedHashes[path] !== hash) {
          return false;
        }
      }

      // Check if any previously-tracked file was deleted
      for (const key of savedKeys) {
        if (!(key in currentHashes)) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Compute staleness fingerprints for all tracked files.
   * Uses mtime+size instead of content hashing — reading and MD5-hashing
   * every workspace file on every graph query was seconds of blocking I/O.
   */
  private async computeFileHashes(): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    const files = this.findFiles(this.workspace);

    for (const file of files) {
      try {
        const st = statSync(file);
        hashes[relative(this.workspace, file)] = `${st.mtimeMs}:${st.size}`;
      } catch {
        // Skip files that can't be stat'd
      }
    }

    return hashes;
  }

  /**
   * Find all files to index.
   * Uses OS-agnostic path comparison (normalizes backslashes to forward slashes).
   */
  private findFiles(directory: string): string[] {
    const files: string[] = [];

    try {
      for (const item of readdirSync(directory)) {
        const fullPath = join(directory, item);
        // Normalize to forward slashes for consistent matching on Windows and Unix
        const normPath = fullPath.replace(/\\/g, '/');

        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(fullPath);
        } catch {
          continue; // Skip unreadable entries
        }

        if (stat.isDirectory()) {
          // Skip excluded directories (match name exactly or as a path segment)
          if (
            this.options.excludedPaths?.some(
              (p) => item === p || normPath.includes(`/${p}/`) || normPath.endsWith(`/${p}`)
            )
          ) {
            continue;
          }

          if (!this.options.includedPaths) {
            // No include filter — recurse into everything not excluded
            files.push(...this.findFiles(fullPath));
          } else {
            // Only recurse if this directory is (or is under) an included path
            if (
              this.options.includedPaths.some(
                (p) => item === p || normPath.includes(`/${p}/`) || normPath.endsWith(`/${p}`)
              )
            ) {
              files.push(...this.findFiles(fullPath));
            }
          }
        } else if (stat.isFile()) {
          // Skip excluded files
          if (this.options.excludedPaths?.some((p) => item === p || item.endsWith(p))) {
            continue;
          }

          // Check file size
          if (stat.size <= (this.options.maxFileSize || Infinity)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Skip directories that can't be read
    }

    return files;
  }

  /**
   * Build the graph from source code
   */
  async build(): Promise<void> {
    logInfo('Building memory graph...');
    const startTime = Date.now();

    // Clear existing graph
    this.nodes.clear();
    this.edges.clear();
    this.indexes = {
      byType: new Map(),
      byPath: new Map(),
      byName: new Map(),
      byLanguage: new Map(),
    };

    // Find and process all files
    const files = this.findFiles(this.workspace);
    logInfo(`Found ${files.length} files to index`);

    for (const file of files) {
      try {
        await this.processFile(file);
      } catch (err: unknown) {
        logWarn(`Error processing file ${file}:`, (err as { message?: string }).message);
      }
    }

    // Resolve queued call sites against imported files (cross-file edges)
    this.linkCrossFileCalls();

    // Build indexes
    this.buildIndexes();

    // Save the graph
    await this.save();

    logInfo(`Memory graph built in ${Date.now() - startTime}ms`);
    logInfo(`Nodes: ${this.nodes.size}, Edges: ${this.edges.size}`);
  }

  /**
   * Process a single file and extract nodes/edges
   */
  private async processFile(filePath: string): Promise<void> {
    const relativePath = relative(this.workspace, filePath);
    const content = readFileSync(filePath, 'utf-8');
    const language = this.getLanguage(filePath);

    // Create file node
    const fileNode: GraphNode = {
      id: `file:${relativePath.replace(/\\/g, '/')}`,
      type: 'file',
      name: relativePath,
      path: relativePath,
      language,
      metadata: {
        size: statSync(filePath).size,
        mtime: statSync(filePath).mtimeMs,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.addNode(fileNode);

    // Extract nodes based on language
    switch (language) {
      case 'typescript':
      case 'javascript':
        this.processTypeScriptFile(filePath, content, fileNode);
        break;
      case 'json':
        this.processJsonFile(filePath, content, fileNode);
        break;
      case 'markdown':
        this.processMarkdownFile(filePath, content, fileNode);
        break;
      case 'yaml':
      case 'yml':
        this.processYamlFile(filePath, content, fileNode);
        break;
      default:
        // For other files, just create the file node
        break;
    }
  }

  /**
   * Get language from file extension
   */
  private getLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      json: 'json',
      md: 'markdown',
      yaml: 'yaml',
      yml: 'yaml',
      html: 'html',
      css: 'css',
      scss: 'scss',
      less: 'less',
      py: 'python',
      java: 'java',
      go: 'go',
      rs: 'rust',
      php: 'php',
      rb: 'ruby',
    };
    return languageMap[ext || ''] || 'unknown';
  }

  /**
   * Process TypeScript/JavaScript file using the native TS compiler AST parser
   */
  private processTypeScriptFile(filePath: string, content: string, fileNode: GraphNode): void {
    const isTSX = filePath.endsWith('.tsx');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      isTSX ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    for (const statement of sourceFile.statements) {
      this.processTSStatement(statement, fileNode, sourceFile);
    }
  }

  private processTSStatement(node: ts.Statement, fileNode: GraphNode, sf: ts.SourceFile): void {
    if (ts.isImportDeclaration(node)) {
      this.processTSImport(node, fileNode, sf);
    } else if (ts.isExportDeclaration(node)) {
      this.processTSExport(node, fileNode, sf);
    } else if (ts.isClassDeclaration(node) && node.name) {
      this.processTSClass(node, fileNode, sf);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      this.processTSFunction(node, fileNode, sf);
    } else if (ts.isVariableStatement(node)) {
      this.processTSVariables(node, fileNode, sf);
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      this.processTSType(node, fileNode, sf, 'interface');
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      this.processTSType(node, fileNode, sf, 'alias');
    } else if (ts.isEnumDeclaration(node) && node.name) {
      this.processTSEnum(node, fileNode, sf);
    } else if (ts.isModuleDeclaration(node) && node.name) {
      this.processTSModule(node, fileNode, sf);
    } else if (ts.isExportAssignment(node)) {
      this.processTSExportDefault(node, fileNode, sf);
    }
  }

  private tsLine(node: ts.Node, sf: ts.SourceFile): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  }

  private tsCode(node: ts.Node, sf: ts.SourceFile): string | undefined {
    return this.options.includeCode ? node.getText(sf) : undefined;
  }

  private processTSImport(
    node: ts.ImportDeclaration,
    fileNode: GraphNode,
    sf: ts.SourceFile
  ): void {
    const modulePath = (node.moduleSpecifier as ts.StringLiteral).text;
    const clause = node.importClause;
    if (!clause) return;

    // Record the import map for cross-file call resolution
    let importMap = this.fileImports.get(fileNode.id);
    if (!importMap) {
      importMap = new Map();
      this.fileImports.set(fileNode.id, importMap);
    }

    if (clause.name) {
      importMap.set(clause.name.text, { module: modulePath, exported: 'default' });
      this.addImportNode(clause.name.text, modulePath, fileNode, node, sf);
    }

    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const elem of clause.namedBindings.elements) {
          const exported = (elem.propertyName || elem.name).text;
          // elem.name is the LOCAL binding (handles `import { add as plus }`)
          importMap.set(elem.name.text, { module: modulePath, exported });
          this.addImportNode(exported, modulePath, fileNode, node, sf);
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        importMap.set(clause.namedBindings.name.text, { module: modulePath, exported: '*' });
        this.addImportNode(clause.namedBindings.name.text, modulePath, fileNode, node, sf);
      }
    }
  }

  private addImportNode(
    name: string,
    modulePath: string,
    fileNode: GraphNode,
    node: ts.Node,
    sf: ts.SourceFile
  ): void {
    const importNode: GraphNode = {
      id: `import:${fileNode.id}:${name}`,
      type: 'module',
      name,
      path: modulePath,
      line: this.tsLine(node, sf),
      language: fileNode.language,
      metadata: { importedFrom: modulePath, file: fileNode.id },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.addNode(importNode);
    this.addEdge({
      id: `edge:${fileNode.id}:${importNode.id}`,
      source: fileNode.id,
      target: importNode.id,
      type: 'imports',
      createdAt: Date.now(),
    });
  }

  private processTSExport(
    node: ts.ExportDeclaration,
    fileNode: GraphNode,
    sf: ts.SourceFile
  ): void {
    if (!node.moduleSpecifier || !node.exportClause) return;
    if (!ts.isNamedExports(node.exportClause)) return;

    const modulePath = (node.moduleSpecifier as ts.StringLiteral).text;
    for (const elem of node.exportClause.elements) {
      this.addImportNode(elem.name.text, modulePath, fileNode, node, sf);
    }
  }

  private processTSExportDefault(
    node: ts.ExportAssignment,
    fileNode: GraphNode,
    sf: ts.SourceFile
  ): void {
    const fn: GraphNode = {
      id: `function:${fileNode.id}:default`,
      type: 'function',
      name: 'default',
      path: fileNode.path,
      line: this.tsLine(node, sf),
      language: fileNode.language,
      code: this.tsCode(node, sf),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.addNode(fn);
    this.addEdge({
      id: `edge:${fileNode.id}:${fn.id}`,
      source: fileNode.id,
      target: fn.id,
      type: 'part_of',
      createdAt: Date.now(),
    });
  }

  private processTSClass(node: ts.ClassDeclaration, fileNode: GraphNode, sf: ts.SourceFile): void {
    const className = node.name!.text;
    const classNode: GraphNode = {
      id: `class:${fileNode.id}:${className}`,
      type: 'class',
      name: className,
      path: fileNode.path,
      line: this.tsLine(node, sf),
      language: fileNode.language,
      code: this.tsCode(node, sf),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.addNode(classNode);
    this.addEdge({
      id: `edge:${fileNode.id}:${classNode.id}`,
      source: fileNode.id,
      target: classNode.id,
      type: 'part_of',
      createdAt: Date.now(),
    });

    if (node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const t of clause.types) {
            const p = t.expression.getText(sf);
            this.addHeritageRef(`class:${fileNode.id}:${p}`, 'class', p, fileNode, node, sf);
            this.addEdge({
              id: `edge:${classNode.id}:extends:${p}`,
              source: classNode.id,
              target: `class:${fileNode.id}:${p}`,
              type: 'extends',
              createdAt: Date.now(),
            });
          }
        } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
          for (const t of clause.types) {
            const p = t.expression.getText(sf);
            this.addHeritageRef(`type:${fileNode.id}:${p}`, 'type', p, fileNode, node, sf);
            this.addEdge({
              id: `edge:${classNode.id}:implements:${p}`,
              source: classNode.id,
              target: `type:${fileNode.id}:${p}`,
              type: 'implements',
              createdAt: Date.now(),
            });
          }
        }
      }
    }

    if (node.members) {
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && m.name) {
          const mn = m.name.getText(sf);
          const fn: GraphNode = {
            id: `function:${classNode.id}:${mn}`,
            type: 'function',
            name: mn,
            path: fileNode.path,
            line: this.tsLine(m, sf),
            language: fileNode.language,
            code: this.tsCode(m, sf),
            metadata: { class: className },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.addNode(fn);
          this.addEdge({
            id: `edge:${classNode.id}:${fn.id}`,
            source: classNode.id,
            target: fn.id,
            type: 'part_of',
            createdAt: Date.now(),
          });
          this.extractCalls(m, fn, fileNode, sf);
        }

        if (ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
          const pn = m.name.text;
          const pv: GraphNode = {
            id: `variable:${classNode.id}:${pn}`,
            type: 'variable',
            name: pn,
            path: fileNode.path,
            line: this.tsLine(m, sf),
            language: fileNode.language,
            code: this.tsCode(m, sf),
            metadata: { class: className },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.addNode(pv);
          this.addEdge({
            id: `edge:${classNode.id}:${pv.id}`,
            source: classNode.id,
            target: pv.id,
            type: 'part_of',
            createdAt: Date.now(),
          });
        }
      }
    }
  }

  private addHeritageRef(
    id: string,
    type: GraphNode['type'],
    name: string,
    fileNode: GraphNode,
    node: ts.Node,
    sf: ts.SourceFile
  ): void {
    if (this.nodes.has(id)) return;
    this.addNode({
      id,
      type,
      name,
      path: fileNode.path,
      line: this.tsLine(node, sf),
      language: fileNode.language,
      metadata: { external: true },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.addEdge({
      id: `edge:${fileNode.id}:${id}`,
      source: fileNode.id,
      target: id,
      type: 'part_of',
      createdAt: Date.now(),
    });
  }

  private processTSFunction(
    node: ts.FunctionLikeDeclaration,
    fileNode: GraphNode,
    sf: ts.SourceFile
  ): void {
    const funcName = (node.name as ts.Identifier | undefined)?.text;
    if (!funcName) return;

    const fn: GraphNode = {
      id: `function:${fileNode.id}:${funcName}`,
      type: 'function',
      name: funcName,
      path: fileNode.path,
      line: this.tsLine(node, sf),
      language: fileNode.language,
      code: this.tsCode(node, sf),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.addNode(fn);
    this.addEdge({
      id: `edge:${fileNode.id}:${fn.id}`,
      source: fileNode.id,
      target: fn.id,
      type: 'part_of',
      createdAt: Date.now(),
    });
    this.extractCalls(node, fn, fileNode, sf);
  }

  private processTSVariables(
    node: ts.VariableStatement,
    fileNode: GraphNode,
    sf: ts.SourceFile
  ): void {
    for (const decl of node.declarationList.declarations) {
      if (!decl.name || !ts.isIdentifier(decl.name)) continue;

      const varName = decl.name.text;
      const isFunction =
        decl.initializer &&
        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
      const type: 'function' | 'variable' = isFunction ? 'function' : 'variable';
      const prefix = isFunction ? 'function' : 'variable';
      const line = this.tsLine(decl, sf);

      const n: GraphNode = {
        id: `${prefix}:${fileNode.id}:${varName}`,
        type,
        name: varName,
        path: fileNode.path,
        line,
        language: fileNode.language,
        code: this.tsCode(decl, sf),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.addNode(n);
      this.addEdge({
        id: `edge:${fileNode.id}:${n.id}`,
        source: fileNode.id,
        target: n.id,
        type: 'part_of',
        createdAt: Date.now(),
      });

      if (decl.initializer && ts.isFunctionLike(decl.initializer)) {
        this.extractCalls(decl.initializer as ts.FunctionLikeDeclaration, n, fileNode, sf);
      }
    }
  }

  private processTSType(
    node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
    fileNode: GraphNode,
    sf: ts.SourceFile,
    subType: 'interface' | 'alias'
  ): void {
    const typeName = node.name.text;
    const tn: GraphNode = {
      id: `type:${fileNode.id}:${typeName}`,
      type: 'type',
      name: typeName,
      path: fileNode.path,
      line: this.tsLine(node, sf),
      language: fileNode.language,
      code: this.tsCode(node, sf),
      metadata: { tsType: subType },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.addNode(tn);
    this.addEdge({
      id: `edge:${fileNode.id}:${tn.id}`,
      source: fileNode.id,
      target: tn.id,
      type: 'part_of',
      createdAt: Date.now(),
    });

    if (ts.isInterfaceDeclaration(node) && node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const t of clause.types) {
            const p = t.expression.getText(sf);
            this.addHeritageRef(`type:${fileNode.id}:${p}`, 'type', p, fileNode, node, sf);
            this.addEdge({
              id: `edge:${tn.id}:extends:${p}`,
              source: tn.id,
              target: `type:${fileNode.id}:${p}`,
              type: 'extends',
              createdAt: Date.now(),
            });
          }
        }
      }
    }
  }

  private processTSEnum(node: ts.EnumDeclaration, fileNode: GraphNode, sf: ts.SourceFile): void {
    const en: GraphNode = {
      id: `type:${fileNode.id}:${node.name.text}`,
      type: 'type',
      name: node.name.text,
      path: fileNode.path,
      line: this.tsLine(node, sf),
      language: fileNode.language,
      code: this.tsCode(node, sf),
      metadata: { tsType: 'enum' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.addNode(en);
    this.addEdge({
      id: `edge:${fileNode.id}:${en.id}`,
      source: fileNode.id,
      target: en.id,
      type: 'part_of',
      createdAt: Date.now(),
    });
  }

  private processTSModule(
    node: ts.ModuleDeclaration,
    fileNode: GraphNode,
    sf: ts.SourceFile
  ): void {
    const mn: GraphNode = {
      id: `concept:${fileNode.id}:${node.name.text}`,
      type: 'concept',
      name: node.name.text,
      path: fileNode.path,
      line: this.tsLine(node, sf),
      language: fileNode.language,
      code: this.tsCode(node, sf),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.addNode(mn);
    this.addEdge({
      id: `edge:${fileNode.id}:${mn.id}`,
      source: fileNode.id,
      target: mn.id,
      type: 'part_of',
      createdAt: Date.now(),
    });
  }

  private extractCalls(
    container: ts.Node,
    parentNode: GraphNode,
    fileNode: GraphNode,
    sf: ts.SourceFile
  ): void {
    ts.forEachChild(container, (child) => {
      if (ts.isCallExpression(child)) {
        const callee = child.expression;
        let calledName: string | undefined;

        if (ts.isIdentifier(callee)) {
          calledName = callee.text;
        } else if (ts.isPropertyAccessExpression(callee)) {
          calledName = callee.name.text;
        }

        if (calledName) {
          const targetId = `function:${fileNode.id}:${calledName}`;
          const altTargetId = `variable:${fileNode.id}:${calledName}`;
          const actualTarget = this.nodes.has(targetId)
            ? targetId
            : this.nodes.has(altTargetId)
              ? altTargetId
              : undefined;
          if (actualTarget) {
            this.addEdge({
              id: `edge:${parentNode.id}:calls:${calledName}`,
              source: parentNode.id,
              target: actualTarget,
              type: 'calls',
              metadata: { line: this.tsLine(child, sf) },
              createdAt: Date.now(),
            });
          } else {
            // Not a local symbol — queue for cross-file resolution after all
            // files have been processed
            this.pendingCalls.push({
              callerId: parentNode.id,
              calledName,
              line: this.tsLine(child, sf),
              fileId: fileNode.id,
            });
          }
        }
      }
      this.extractCalls(child, parentNode, fileNode, sf);
    });
  }

  /**
   * Resolve a relative module specifier to a file node id, trying common
   * extensions and index files.
   */
  private resolveModuleToFileId(modulePath: string, importerFileId: string): string | undefined {
    if (!modulePath.startsWith('.')) return undefined;
    const importerPath = importerFileId.slice('file:'.length);
    const importerDir = importerPath.includes('/')
      ? importerPath.slice(0, importerPath.lastIndexOf('/'))
      : '';
    const joined = `${importerDir}/${modulePath}`;
    // Normalize ./ and ../ segments
    const parts: string[] = [];
    for (const seg of joined.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    const base = parts.join('/');
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.jsx`,
    ];
    // ESM convention: `import './utils.js'` often refers to `utils.ts` on disk
    if (/\.[cm]?jsx?$/.test(base)) {
      const noExt = base.replace(/\.[cm]?jsx?$/, '');
      candidates.push(`${noExt}.ts`, `${noExt}.tsx`);
    }
    for (const cand of candidates) {
      const id = `file:${cand}`;
      if (this.nodes.has(id)) return id;
    }
    return undefined;
  }

  /**
   * Create `calls` edges for call sites whose callee lives in an imported file.
   */
  private linkCrossFileCalls(): void {
    for (const pc of this.pendingCalls) {
      const imports = this.fileImports.get(pc.fileId);
      if (!imports) continue;
      const imp = imports.get(pc.calledName);
      if (!imp) continue;
      const exported = imp.exported === '*' ? pc.calledName : imp.exported;
      const targetFileId = this.resolveModuleToFileId(imp.module, pc.fileId);
      if (!targetFileId) continue;
      const candidates = [
        `function:${targetFileId}:${exported}`,
        `variable:${targetFileId}:${exported}`,
        `class:${targetFileId}:${exported}`,
      ];
      const target = candidates.find((c) => this.nodes.has(c));
      if (target) {
        this.addEdge({
          id: `edge:${pc.callerId}:calls:${exported}@${targetFileId}`,
          source: pc.callerId,
          target,
          type: 'calls',
          metadata: { line: pc.line, crossFile: true },
          createdAt: Date.now(),
        });
      }
    }
    this.pendingCalls = [];
  }

  /**
   * Process JSON file
   */
  private processJsonFile(filePath: string, content: string, fileNode: GraphNode): void {
    try {
      const data = JSON.parse(content);

      if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) {
          const node: GraphNode = {
            id: `config:${fileNode.id}:${key}`,
            type: 'concept',
            name: key,
            description: typeof value === 'string' ? value : JSON.stringify(value),
            path: fileNode.path,
            metadata: {
              value: value,
              configType: typeof value,
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.addNode(node);

          this.addEdge({
            id: `edge:${fileNode.id}:${node.id}`,
            source: fileNode.id,
            target: node.id,
            type: 'part_of',
            createdAt: Date.now(),
          });
        }
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  /**
   * Process Markdown file
   */
  private processMarkdownFile(filePath: string, content: string, fileNode: GraphNode): void {
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Extract headers (concepts)
      const headerMatch = line.match(/^(#+)\s+(.+)/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        const title = headerMatch[2];

        const conceptNode: GraphNode = {
          id: `concept:${fileNode.id}:${title.replace(/\s+/g, '-').toLowerCase()}`,
          type: 'concept',
          name: title,
          description: `Header level ${level} in ${fileNode.name}`,
          path: fileNode.path,
          line: lineNum,
          metadata: {
            level,
            file: fileNode.id,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.addNode(conceptNode);

        this.addEdge({
          id: `edge:${fileNode.id}:${conceptNode.id}`,
          source: fileNode.id,
          target: conceptNode.id,
          type: 'part_of',
          createdAt: Date.now(),
        });
      }
    }
  }

  /**
   * Process YAML file
   */
  private processYamlFile(filePath: string, content: string, fileNode: GraphNode): void {
    // Simple YAML parsing - in production, use a proper YAML parser
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;

      if (line && !line.startsWith('#')) {
        const match = line.match(/^(\w+):\s*(.+)/);
        if (match) {
          const key = match[1];
          const value = match[2];

          const node: GraphNode = {
            id: `config:${fileNode.id}:${key}`,
            type: 'concept',
            name: key,
            description: value,
            path: fileNode.path,
            line: lineNum,
            metadata: {
              value,
              configType: 'yaml',
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.addNode(node);

          this.addEdge({
            id: `edge:${fileNode.id}:${node.id}`,
            source: fileNode.id,
            target: node.id,
            type: 'part_of',
            createdAt: Date.now(),
          });
        }
      }
    }
  }

  /**
   * Add a node to the graph
   */
  addNode(node: GraphNode): void {
    if (this.nodes.has(node.id)) {
      // Update existing node
      const existing = this.nodes.get(node.id)!;
      this.nodes.set(node.id, { ...existing, ...node, updatedAt: Date.now() });
    } else {
      // Add new node
      this.nodes.set(node.id, node);
    }
  }

  /**
   * Add an edge to the graph
   */
  addEdge(edge: GraphEdge): void {
    if (!edge.extraction) {
      edge.extraction = 'ast';
    }
    if (this.edges.has(edge.id)) {
      // Update existing edge
      const existing = this.edges.get(edge.id)!;
      this.edges.set(edge.id, { ...existing, ...edge, updatedAt: Date.now() });
    } else {
      // Add new edge
      this.edges.set(edge.id, edge);
    }
  }

  /**
   * Build indexes for faster querying
   */
  private buildIndexes(): void {
    this.indexes.byType.clear();
    this.indexes.byPath.clear();
    this.indexes.byName.clear();
    this.indexes.byLanguage.clear();

    for (const [id, node] of this.nodes) {
      // Index by type
      if (!this.indexes.byType.has(node.type)) {
        this.indexes.byType.set(node.type, new Set());
      }
      this.indexes.byType.get(node.type)!.add(id);

      // Index by path
      if (node.path) {
        if (!this.indexes.byPath.has(node.path)) {
          this.indexes.byPath.set(node.path, new Set());
        }
        this.indexes.byPath.get(node.path)!.add(id);
      }

      // Index by name
      if (!this.indexes.byName.has(node.name)) {
        this.indexes.byName.set(node.name, new Set());
      }
      this.indexes.byName.get(node.name)!.add(id);

      // Index by language
      if (node.language) {
        if (!this.indexes.byLanguage.has(node.language)) {
          this.indexes.byLanguage.set(node.language, new Set());
        }
        this.indexes.byLanguage.get(node.language)!.add(id);
      }
    }
  }

  /**
   * Save the graph to disk
   */
  async save(): Promise<void> {
    // Ensure directory exists
    if (!existsSync(this.graphDir)) {
      mkdirSync(this.graphDir, { recursive: true });
    }

    // Save graph data
    const graphData = {
      version: this.version,
      lastUpdated: this.lastUpdated,
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    };

    writeFileSync(join(this.graphDir, GRAPH_FILE), JSON.stringify(graphData, null, 2));

    // Save file hashes
    const hashes = await this.computeFileHashes();
    writeFileSync(join(this.graphDir, HASH_FILE), JSON.stringify(hashes, null, 2));

    logInfo(`Memory graph saved to ${this.graphDir}`);
  }

  /**
   * Query the graph
   */
  query(query: GraphQuery): GraphQueryResult {
    const startTime = Date.now();
    const result: GraphQueryResult = {
      nodes: [],
      edges: [],
      paths: [],
      stats: {
        nodeCount: this.nodes.size,
        edgeCount: this.edges.size,
        queryTime: 0,
      },
    };

    switch (query.type) {
      case 'node':
        result.nodes = this.queryNodes(query.query);
        break;
      case 'edge':
        result.edges = this.queryEdges(query.query);
        break;
      case 'path':
        result.paths = this.queryPaths(query.query);
        break;
      case 'pattern':
        result.nodes = typeof query.query === 'string' ? this.queryByPattern(query.query) : [];
        break;
      case 'semantic':
        result.nodes = this.querySemantic(query.query);
        break;
    }

    result.stats.queryTime = Date.now() - startTime;
    return result;
  }

  /**
   * Query nodes by criteria
   */
  private queryNodes(criteria: string | Record<string, unknown>): GraphNode[] {
    const results: GraphNode[] = [];
    let limit = 100;

    if (typeof criteria === 'string') {
      const node = this.nodes.get(criteria);
      if (node) results.push(node);
    } else if (typeof criteria === 'object') {
      limit = (criteria.limit as number) || 100;
      for (const [, node] of this.nodes) {
        let matches = true;

        for (const [key, value] of Object.entries(criteria)) {
          if (key === 'limit') continue;
          if (key === 'type' && node.type !== value) {
            matches = false;
            break;
          }
          if (key === 'name' && typeof value === 'string') {
            if (!node.name.toLowerCase().includes(value.toLowerCase())) {
              matches = false;
              break;
            }
          }
          if (key === 'path' && typeof value === 'string') {
            const nodePath = node.path || '';
            const normNodePath = nodePath.replace(/\\/g, '/');
            const normValue = value.replace(/\\/g, '/');
            if (!normNodePath.toLowerCase().includes(normValue.toLowerCase())) {
              matches = false;
              break;
            }
          }
          if (key === 'language' && node.language !== value) {
            matches = false;
            break;
          }
        }

        if (matches) {
          results.push(node);
        }
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Query edges by criteria
   */
  private queryEdges(criteria: string | Record<string, unknown>): GraphEdge[] {
    const results: GraphEdge[] = [];
    let limit = 100;

    if (typeof criteria === 'string') {
      const edge = this.edges.get(criteria);
      if (edge) results.push(edge);
    } else if (typeof criteria === 'object') {
      limit = (criteria.limit as number) || 100;
      for (const [, edge] of this.edges) {
        let matches = true;

        for (const [key, value] of Object.entries(criteria)) {
          if (key === 'type' && edge.type !== value) {
            matches = false;
            break;
          }
          if (key === 'source' && edge.source !== value) {
            matches = false;
            break;
          }
          if (key === 'target' && edge.target !== value) {
            matches = false;
            break;
          }
        }

        if (matches) {
          results.push(edge);
        }
      }
    }

    return results.slice(0, limit);
  }

  private queryPaths(criteria: string | Record<string, unknown>): string[][] {
    if (typeof criteria === 'object') {
      const from = criteria.from as string | undefined;
      const to = criteria.to as string | undefined;
      const maxDepth = (criteria.maxDepth as number) || 5;
      if (from && to) {
        return this.findPaths(from, to, maxDepth);
      }
    }
    return [];
  }

  /**
   * Find paths between two nodes using BFS
   */
  private findPaths(fromId: string, toId: string, maxDepth: number): string[][] {
    const paths: string[][] = [];
    const queue: { current: string; path: string[]; depth: number }[] = [
      { current: fromId, path: [fromId], depth: 0 },
    ];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const { current, path, depth } = queue.shift()!;

      if (depth > maxDepth) continue;
      if (visited.has(current)) continue;
      visited.add(current);

      if (current === toId) {
        paths.push(path);
        if (paths.length >= 10) break; // Limit results
        continue;
      }

      // Find all edges from this node
      for (const [, edge] of this.edges) {
        if (edge.source === current) {
          queue.push({
            current: edge.target,
            path: [...path, edge.target],
            depth: depth + 1,
          });
        }
      }
    }

    return paths;
  }

  /**
   * Query by pattern (simple text search)
   */
  private queryByPattern(pattern: string): GraphNode[] {
    const results: GraphNode[] = [];
    const regex = new RegExp(pattern, 'i');

    for (const [, node] of this.nodes) {
      if (
        regex.test(node.id) ||
        regex.test(node.name) ||
        (node.description && regex.test(node.description)) ||
        (node.code && regex.test(node.code))
      ) {
        results.push(node);
        if (results.length >= 50) break; // Limit results
      }
    }

    return results;
  }

  /**
   * Semantic query (more advanced)
   */
  private querySemantic(criteria: string | Record<string, unknown>): GraphNode[] {
    const results: GraphNode[] = [];

    if (typeof criteria === 'string') return results;
    const relatedTo = criteria.relatedTo as string | undefined;
    if (relatedTo) {
      const relatedNodes = new Set<string>();

      for (const [, edge] of this.edges) {
        if (edge.source === relatedTo) {
          relatedNodes.add(edge.target);
        }
        if (edge.target === relatedTo) {
          relatedNodes.add(edge.source);
        }
      }

      for (const id of relatedNodes) {
        const node = this.nodes.get(id);
        if (node) results.push(node);
      }
    }

    return results.slice(0, (criteria.limit as number) || 50);
  }

  /**
   * Get statistics about the graph
   */
  getStats(): {
    nodeCount: number;
    edgeCount: number;
    nodesByType: Record<string, number>;
    nodesByLanguage: Record<string, number>;
  } {
    const nodesByType: Record<string, number> = {};
    const nodesByLanguage: Record<string, number> = {};

    for (const node of this.nodes.values()) {
      nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
      if (node.language) {
        nodesByLanguage[node.language] = (nodesByLanguage[node.language] || 0) + 1;
      }
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      nodesByType,
      nodesByLanguage,
    };
  }

  /**
   * Clear the graph
   */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.indexes = {
      byType: new Map(),
      byPath: new Map(),
      byName: new Map(),
      byLanguage: new Map(),
    };
  }

  /**
   * Update an existing node
   */
  updateNode(id: string, updates: Partial<GraphNode>): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    this.nodes.set(id, { ...node, ...updates, updatedAt: Date.now() });
    this.buildIndexes();
    return true;
  }

  /**
   * Remove a node and its edges
   */
  removeNode(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Remove all edges connected to this node
    for (const [edgeId, edge] of this.edges) {
      if (edge.source === id || edge.target === id) {
        this.edges.delete(edgeId);
      }
    }

    this.nodes.delete(id);
    this.buildIndexes();
    return true;
  }

  /**
   * Export the graph as JSON
   */
  export(): { nodes: GraphNode[]; edges: GraphEdge[]; stats: Record<string, unknown> } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      stats: this.getStats(),
    };
  }

  /**
   * Import a graph from JSON
   */
  import(data: { nodes: GraphNode[]; edges: GraphEdge[] }): void {
    this.clear();

    for (const node of data.nodes) {
      this.addNode(node);
    }

    for (const edge of data.edges) {
      this.addEdge(edge);
    }

    this.buildIndexes();
  }

  /**
   * Build adjacency list from edges for community detection
   */
  private buildAdjacency(): Map<string, Map<string, number>> {
    const adj = new Map<string, Map<string, number>>();
    for (const [, edge] of this.edges) {
      if (!adj.has(edge.source)) adj.set(edge.source, new Map());
      if (!adj.has(edge.target)) adj.set(edge.target, new Map());
      adj.get(edge.source)!.set(edge.target, (adj.get(edge.source)!.get(edge.target) || 0) + 1);
      adj.get(edge.target)!.set(edge.source, (adj.get(edge.target)!.get(edge.source) || 0) + 1);
    }
    return adj;
  }

  /**
   * Detect communities using the Louvain method (modularity maximization).
   * Stores community id in each node's metadata.
   */
  detectCommunities(): { communities: Map<string, number>; modularity: number } {
    const adj = this.buildAdjacency();
    const nodeIds = Array.from(this.nodes.keys());
    const m = this.edges.size;
    const result = new Map<string, number>();

    if (nodeIds.length === 0 || m === 0) {
      for (const id of nodeIds) result.set(id, 0);
      return { communities: result, modularity: 0 };
    }

    // Initialize: each node in its own community
    const community = new Map<string, number>();
    nodeIds.forEach((id, i) => {
      community.set(id, i);
    });

    // Precompute degrees
    const degree = new Map<string, number>();
    for (const id of nodeIds) {
      degree.set(id, adj.get(id)?.size || 0);
    }

    // Sum of degrees per community
    const sumTot = new Map<number, number>();
    for (const id of nodeIds) {
      const c = community.get(id)!;
      sumTot.set(c, (sumTot.get(c) || 0) + degree.get(id)!);
    }

    let improved = true;
    let pass = 0;

    while (improved && pass < 20) {
      improved = false;
      pass++;

      for (const nodeId of nodeIds) {
        const nodeComm = community.get(nodeId)!;
        const k_i = degree.get(nodeId) || 0;
        if (k_i === 0) continue;

        const neighbors = adj.get(nodeId);
        if (!neighbors || neighbors.size === 0) continue;

        const commWeight = new Map<number, number>();
        for (const [neighbor, weight] of neighbors) {
          const nc = community.get(neighbor)!;
          commWeight.set(nc, (commWeight.get(nc) || 0) + weight);
        }

        const k_i_in_old = commWeight.get(nodeComm) || 0;
        const sumTot_old = sumTot.get(nodeComm) || 0;

        const gainRemove = -(k_i_in_old / m) + ((sumTot_old - k_i) * k_i) / (2 * m * m);

        let bestComm = nodeComm;
        let bestGain = 0;

        for (const [nc, k_i_in_new] of commWeight) {
          if (nc === nodeComm) continue;
          const sumTot_new = sumTot.get(nc) || 0;
          const gainAdd = k_i_in_new / m - (sumTot_new * k_i) / (2 * m * m);
          const totalGain = gainRemove + gainAdd;

          if (totalGain > bestGain) {
            bestGain = totalGain;
            bestComm = nc;
          }
        }

        if (bestComm !== nodeComm) {
          community.set(nodeId, bestComm);
          sumTot.set(nodeComm, (sumTot.get(nodeComm) || 0) - k_i);
          sumTot.set(bestComm, (sumTot.get(bestComm) || 0) + k_i);
          improved = true;
        }
      }
    }

    // Re-number communities sequentially
    const commMap = new Map<number, number>();
    let nextId = 0;
    const orderedComms: number[] = [];
    for (const [, c] of community) {
      if (!commMap.has(c)) {
        commMap.set(c, nextId++);
        orderedComms.push(c);
      }
    }

    for (const [id, c] of community) {
      const newId = commMap.get(c)!;
      result.set(id, newId);
      const node = this.nodes.get(id);
      if (node) {
        node.metadata = { ...node.metadata, community: newId };
      }
    }

    // Compute modularity
    let Q = 0;
    const m2 = 2 * m;
    for (const [, edge] of this.edges) {
      const ci = result.get(edge.source) ?? -1;
      const cj = result.get(edge.target) ?? -1;
      if (ci === cj && ci >= 0) {
        const ki = degree.get(edge.source) || 0;
        const kj = degree.get(edge.target) || 0;
        Q += 1 - (ki * kj) / m2;
      }
    }
    Q /= m2;

    return { communities: result, modularity: Q };
  }

  /**
   * Get communities with full metadata
   */
  getCommunities(): GraphCommunity[] {
    this.detectCommunities();

    const commNodes = new Map<number, string[]>();
    for (const [id, node] of this.nodes) {
      const c = node.metadata?.community as number | undefined;
      if (c !== undefined) {
        if (!commNodes.has(c)) commNodes.set(c, []);
        commNodes.get(c)!.push(id);
      }
    }

    const communities: GraphCommunity[] = [];
    for (const [commId, nodeIds] of commNodes) {
      const nodes = nodeIds.map((id) => this.nodes.get(id)!).filter(Boolean);
      let internalEdges = 0;
      let externalEdges = 0;
      for (const [, edge] of this.edges) {
        const sComm = this.nodes.get(edge.source)?.metadata?.community;
        const tComm = this.nodes.get(edge.target)?.metadata?.community;
        if (sComm === commId && tComm === commId) internalEdges++;
        else if (sComm === commId || tComm === commId) externalEdges++;
      }

      const community: GraphCommunity = {
        id: commId,
        size: nodeIds.length,
        nodes,
        internalEdges,
        externalEdges,
        density:
          nodeIds.length > 1 ? (2 * internalEdges) / (nodeIds.length * (nodeIds.length - 1)) : 0,
        topNodeIds: nodeIds.slice(0, 10),
        nodeIds,
      };
      communities.push(community);
    }

    communities.sort((a, b) => b.size - a.size);
    return communities;
  }

  /**
   * Get god nodes (most connected / highest degree)
   */
  getGodNodes(n: number = 10): GodNode[] {
    const degreeMap = new Map<string, { in: number; out: number; total: number }>();

    for (const [, edge] of this.edges) {
      if (!degreeMap.has(edge.source)) degreeMap.set(edge.source, { in: 0, out: 0, total: 0 });
      if (!degreeMap.has(edge.target)) degreeMap.set(edge.target, { in: 0, out: 0, total: 0 });
      degreeMap.get(edge.source)!.out++;
      degreeMap.get(edge.source)!.total++;
      degreeMap.get(edge.target)!.in++;
      degreeMap.get(edge.target)!.total++;
    }

    const godNodes: GodNode[] = [];
    for (const [id, deg] of degreeMap) {
      const node = this.nodes.get(id);
      if (node) {
        godNodes.push({ node, degree: deg.total, inDegree: deg.in, outDegree: deg.out });
      }
    }

    godNodes.sort((a, b) => b.degree - a.degree);
    return godNodes.slice(0, n);
  }

  /**
   * Get surprising connections: edges that connect different communities
   */
  getSurprisingConnections(
    limit: number = 20
  ): Array<{ edge: GraphEdge; sourceCommunity: number; targetCommunity: number }> {
    this.detectCommunities();
    const results: Array<{ edge: GraphEdge; sourceCommunity: number; targetCommunity: number }> =
      [];

    for (const [, edge] of this.edges) {
      const sNode = this.nodes.get(edge.source);
      const tNode = this.nodes.get(edge.target);
      if (!sNode || !tNode) continue;

      const sComm = sNode.metadata?.community as number | undefined;
      const tComm = tNode.metadata?.community as number | undefined;
      if (sComm !== undefined && tComm !== undefined && sComm !== tComm) {
        results.push({ edge, sourceCommunity: sComm, targetCommunity: tComm });
      }
    }

    // Sort by edge type interestingness
    results.sort((a, b) => {
      const rank: Record<string, number> = {
        calls: 5,
        imports: 4,
        extends: 3,
        implements: 2,
        part_of: 1,
        uses: 1,
      };
      return (rank[b.edge.type] || 0) - (rank[a.edge.type] || 0);
    });

    return results.slice(0, limit);
  }

  /**
   * Generate a full analysis report in markdown
   */
  generateAnalysisReport(): string {
    const stats = this.getStats();
    const communities = this.getCommunities();
    const godNodes = this.getGodNodes(15);
    const surprising = this.getSurprisingConnections(15);

    const lines: string[] = [];
    lines.push('# Memory Graph Analysis Report');
    lines.push('');
    lines.push('## Overview');
    lines.push('');
    lines.push(`- **Nodes**: ${stats.nodeCount}`);
    lines.push(`- **Edges**: ${stats.edgeCount}`);
    lines.push(`- **Communities**: ${communities.length}`);
    lines.push(
      `- **Graph Density**: ${stats.nodeCount > 1 ? (((2 * stats.edgeCount) / (stats.nodeCount * (stats.nodeCount - 1))) * 100).toFixed(2) : 0}%`
    );
    lines.push('');

    lines.push('## Nodes by Type');
    lines.push('');
    lines.push('| Type | Count |');
    lines.push('|------|-------|');
    for (const [type, count] of Object.entries(stats.nodesByType).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${type} | ${count} |`);
    }
    lines.push('');

    lines.push('## Nodes by Language');
    lines.push('');
    lines.push('| Language | Count |');
    lines.push('|----------|-------|');
    for (const [lang, count] of Object.entries(stats.nodesByLanguage).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${lang} | ${count} |`);
    }
    lines.push('');

    lines.push('## God Nodes (Highest Degree)');
    lines.push('');
    lines.push('| Rank | Node | Type | Degree | In | Out |');
    lines.push('|------|------|------|--------|----|-----|');
    godNodes.forEach((gn, i) => {
      lines.push(
        `| ${i + 1} | ${gn.node.name} | ${gn.node.type} | ${gn.degree} | ${gn.inDegree} | ${gn.outDegree} |`
      );
    });
    lines.push('');

    lines.push('## Communities');
    lines.push('');
    communities.forEach((comm, _i) => {
      lines.push(`### Community ${comm.id} (${comm.size} nodes)`);
      lines.push('');
      lines.push(`- **Size**: ${comm.size} nodes`);
      lines.push(`- **Internal Edges**: ${comm.internalEdges}`);
      lines.push(`- **External Edges**: ${comm.externalEdges}`);
      lines.push(`- **Density**: ${(comm.density * 100).toFixed(1)}%`);
      lines.push('');
      if (comm.topNodeIds.length > 0) {
        lines.push('Top nodes:');
        comm.topNodeIds.slice(0, 8).forEach((id) => {
          const node = this.nodes.get(id);
          if (node) {
            lines.push(`- \`${node.name}\` (${node.type})`);
          }
        });
        lines.push('');
      }
    });

    if (surprising.length > 0) {
      lines.push('## Surprising Connections (Cross-Community Edges)');
      lines.push('');
      lines.push('| Source | Target | Type | Communities |');
      lines.push('|--------|--------|------|-------------|');
      surprising.forEach((sc) => {
        const sName = this.nodes.get(sc.edge.source)?.name || sc.edge.source;
        const tName = this.nodes.get(sc.edge.target)?.name || sc.edge.target;
        lines.push(
          `| ${sName} | ${tName} | ${sc.edge.type} | ${sc.sourceCommunity} → ${sc.targetCommunity} |`
        );
      });
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Report generated at ${new Date().toISOString()}*`);

    return lines.join('\n');
  }
}
