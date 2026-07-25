import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';

import type { Tool } from './shared.js';
import {
  MAX_SEARCH_RESULTS,
  SKIP_DIRS,
  checkSmallModel,
  isAccessBlocked,
  rel,
  safe,
  walk,
} from './shared.js';

export const mapProjectTreeTool: Tool = {
  name: 'map_project_tree',
  description: 'Map project structure as a tree',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', default: '.' },
      max_depth: { type: 'number', default: 5 },
      include_hidden: { type: 'boolean', default: false },
    },
  },
  execute: (args, ws, cfg) => {
    try {
      const root = safe(args.path || '.', ws, cfg);
      const isSmall = checkSmallModel(cfg);
      // Reduce max depth for small models to prevent overwhelming them
      const defaultMaxDepth = isSmall ? 2 : 4;
      const maxDepth = Math.min(8, Math.max(1, Number(args.max_depth || defaultMaxDepth)));
      const includeHidden = Boolean(args.include_hidden);

      // Helper function to build a markdown tree representation
      function buildMarkdownTree(currentPath: string, currentDepth: number, prefix = ''): string {
        if (currentDepth > maxDepth) return '';

        try {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          let result = '';

          // Sort entries: directories first, then files
          entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

          // Limit entries for small models
          const maxEntries = isSmall ? 20 : 50;
          const limitedEntries = entries.slice(0, maxEntries);

          for (let i = 0; i < limitedEntries.length; i++) {
            const entry = limitedEntries[i];
            const isLast = i === limitedEntries.length - 1;

            // Skip hidden files unless explicitly requested
            if (!includeHidden && entry.name.startsWith('.')) continue;
            // Skip common build/cache directories
            if (SKIP_DIRS.has(entry.name)) continue;

            const fullPath = resolve(currentPath, entry.name);

            if (entry.isDirectory()) {
              // Add directory entry
              const displayPrefix = prefix + (isLast ? '└── ' : '├── ');
              result += `${displayPrefix}${entry.name}/\n`;

              // Recursively add subdirectories
              const subTree = buildMarkdownTree(
                fullPath,
                currentDepth + 1,
                prefix + (isLast ? '    ' : '│   ')
              );
              if (subTree) {
                result += subTree;
              }
            }
            // For small models, we skip files entirely to reduce token usage
            // For larger models, we can include file information
            if (!isSmall && entry.isFile()) {
              // Skip very large files for large models too
              const st = statSync(fullPath);
              if (st.size > 1000000) continue;

              // Focus on source code files
              const ext = entry.name.split('.').pop()?.toLowerCase() || '';
              const sourceExtensions = new Set([
                'ts',
                'tsx',
                'js',
                'jsx',
                'py',
                'json',
                'md',
                'txt',
                'html',
                'css',
                'yaml',
                'yml',
              ]);
              if (!sourceExtensions.has(ext)) continue;

              const fileDisplayPrefix = prefix + (isLast ? '└── ' : '├── ');
              result += `${fileDisplayPrefix}${entry.name} (${Math.round(st.size / 1024)}KB)\n`;
            }
          }

          return result;
        } catch {
          // If we can't read a directory, just return empty result
          return '';
        }
      }

      // Generate the markdown tree
      const treeContent = buildMarkdownTree(root, 0);

      // For small models, we also provide the directory structure in JSON for parsing
      if (isSmall) {
        return JSON.stringify({
          ok: true,
          tree: treeContent,
          small_model_optimized: true,
          note: 'Small model mode: Tree structure shown in markdown format for efficiency. Only directories included.',
        });
      }

      // For larger models, still provide the markdown tree but with more details
      return JSON.stringify({
        ok: true,
        tree: treeContent,
        small_model_optimized: false,
        note: 'Large model mode: Tree structure shown in markdown format with directory and file information.',
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};

// Search and Analysis Tools
export const searchAndViewTool: Tool = {
  name: 'search_and_view',
  description:
    'Search for a pattern and show matching lines with surrounding context. Use this to find where code is defined or used, then edit with edit_file_lines',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      path: {
        type: 'string',
        description: 'File or directory to search in (default: workspace root)',
      },
      file_pattern: { type: 'string', description: "Optional file filter (e.g. '*.ts', '*.py')" },
      context_lines: {
        type: 'number',
        description: 'Lines of context before and after each match (default: 3)',
      },
      regex: { type: 'boolean', description: 'Treat pattern as regex (default: false)' },
    },
    required: ['pattern'],
  },
  execute: (args, ws, cfg) => {
    try {
      const root = safe(args.path || '.', ws, cfg);
      const q = String(args.pattern || '');
      if (!q) return JSON.stringify({ ok: false, error: 'pattern cannot be empty' });
      const re = args.regex ? new RegExp(q, 'i') : null;
      const fileFilter = String(args.file_pattern || '').toLowerCase();
      const ctxLines = Math.max(0, Math.min(20, Number(args.context_lines ?? 3)));
      const isSmall = checkSmallModel(cfg);
      const maxResults = isSmall ? 8 : 40;
      const results: Array<{ path: string; line: number; context: string[] }> = [];

      // If the user passed a file, search that file only (common small-model mistake).
      const rootStat = statSync(root);
      const searchFile = (file: string) => {
        if (isAccessBlocked(file, cfg)) return;
        if (fileFilter && !file.toLowerCase().includes(fileFilter)) return;
        const st = statSync(file);
        const maxSize = isSmall ? 500_000 : 2_000_000;
        if (st.size > maxSize) return;
        let text = '';
        try {
          text = readFileSync(file, 'utf-8');
        } catch {
          return;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = re ? re.test(line) : line.toLowerCase().includes(q.toLowerCase());
          if (hit) {
            const start = Math.max(0, i - ctxLines);
            const end = Math.min(lines.length, i + ctxLines + 1);
            const snippet = lines.slice(start, end);
            const annotated = snippet.map((l, idx) => {
              const lineNum = start + idx + 1;
              const marker = start + idx === i ? '>' : ' ';
              return `${marker} ${String(lineNum).padStart(4, ' ')}│ ${l}`;
            });
            results.push({ path: rel(file, ws), line: i + 1, context: annotated });
          }
          if (results.length >= maxResults) return false;
        }
      };

      if (rootStat.isFile()) {
        searchFile(root);
      } else {
        walk(root, ws, cfg, (file) => {
          searchFile(file);
          return results.length < maxResults;
        });
      }
      return JSON.stringify({
        ok: true,
        results,
        context_lines: ctxLines,
        truncated: results.length >= maxResults,
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};

export const findFilesTool: Tool = {
  name: 'find_files',
  description: 'Find files by name or regex',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', default: '.' },
      query: { type: 'string' },
      regex: { type: 'boolean', default: false },
      max_depth: { type: 'number', default: 10 },
    },
    required: ['query'],
  },
  execute: (args, ws, cfg) => {
    try {
      const root = safe(args.path || '.', ws, cfg);
      const q = String(args.query || '');
      const re = args.regex ? new RegExp(q, 'i') : null;
      const isSmall = checkSmallModel(cfg);
      // Reduce max results for small models
      const maxResults = isSmall ? 20 : MAX_SEARCH_RESULTS;
      const results: string[] = [];
      walk(
        root,
        ws,
        cfg,
        (file) => {
          const name = file.replace(/\\/g, '/');
          const hit = re ? re.test(name) : name.toLowerCase().includes(q.toLowerCase());
          if (hit) {
            if (isSmall) {
              // For small models, focus on source files only
              const ext = name.split('.').pop()?.toLowerCase() || '';
              const sourceExtensions = new Set([
                'ts',
                'tsx',
                'js',
                'jsx',
                'py',
                'json',
                'md',
                'txt',
                'html',
                'css',
                'yaml',
                'yml',
              ]);
              if (!sourceExtensions.has(ext)) return true; // continue walking
            }
            results.push(rel(file, ws));
          }
          return results.length < maxResults;
        },
        0,
        Number(args.max_depth || (isSmall ? 5 : 10))
      );
      return JSON.stringify({
        ok: true,
        results,
        truncated: results.length >= maxResults,
        small_model_optimized: isSmall,
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};

export const grepSearchTool: Tool = {
  name: 'grep_search',
  description: 'Search text patterns in files',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text or regex pattern to search for' },
      path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
      file_glob: { type: 'string', description: "File pattern filter (e.g., '*.ts', 'src/**')" },
      regex: { type: 'boolean', description: 'Treat query as regex (default: false)' },
    },
    required: ['query'],
  },
  execute: (args, ws, cfg) => {
    try {
      const root = safe(args.path || '.', ws, cfg);
      // If root is a file, search it directly instead of recursing into it
      let rootStat: ReturnType<typeof statSync>;
      try {
        rootStat = statSync(root);
      } catch {
        return JSON.stringify({ ok: false, error: `Directory not found: ${rel(root, ws)}` });
      }
      if (rootStat.isFile()) {
        const q = String(args.query || '');
        if (!q) return JSON.stringify({ ok: false, error: 'query is required for grep_search' });
        if (isAccessBlocked(root, cfg)) {
          return JSON.stringify({ ok: false, error: 'Access denied (blocked path)' });
        }
        const re = args.regex ? new RegExp(q, 'i') : null;
        const results: Array<{ path: string; line: number; text: string }> = [];
        let text = '';
        try {
          text = readFileSync(root, 'utf-8');
        } catch {
          return JSON.stringify({ ok: false, error: `Cannot read file: ${rel(root, ws)}` });
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = re ? re.test(line) : line.toLowerCase().includes(q.toLowerCase());
          if (hit) {
            results.push({ path: rel(root, ws), line: i + 1, text: line.trim().slice(0, 240) });
          }
        }
        return JSON.stringify({
          ok: true,
          results,
          truncated: false,
          single_file: true,
          small_model_optimized: checkSmallModel(cfg),
        });
      }
      const q = String(args.query || '');
      const re = args.regex ? new RegExp(q, 'i') : null;
      const fileFilter = String(args.file_glob || '').toLowerCase();
      const isSmall = checkSmallModel(cfg);
      // Reduce max results for small models
      const maxResults = isSmall ? 10 : MAX_SEARCH_RESULTS;
      const results: Array<{ path: string; line: number; text: string }> = [];
      walk(root, ws, cfg, (file) => {
        if (fileFilter && !file.toLowerCase().includes(fileFilter)) return;

        // For small models, focus on source files only
        if (isSmall) {
          const name = file.replace(/\\/g, '/');
          const ext = name.split('.').pop()?.toLowerCase() || '';
          const sourceExtensions = new Set([
            'ts',
            'tsx',
            'js',
            'jsx',
            'py',
            'json',
            'md',
            'txt',
            'html',
            'css',
            'yaml',
            'yml',
          ]);
          if (!sourceExtensions.has(ext)) return;
        }

        const st = statSync(file);
        // Reduce file size limit for small models
        const maxSize = isSmall ? 500_000 : 2_000_000;
        if (st.size > maxSize) return;
        let text = '';
        try {
          text = readFileSync(file, 'utf-8');
        } catch {
          return;
        }
        const lines = text.split(/\r?\n/);
        // For small models, limit lines processed per file
        const maxLines = isSmall ? 100 : lines.length;
        for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
          const line = lines[i];
          const hit = re ? re.test(line) : line.toLowerCase().includes(q.toLowerCase());
          if (hit) {
            // Reduce context for small models
            const contextLength = isSmall ? 120 : 240;
            results.push({
              path: rel(file, ws),
              line: i + 1,
              text: line.trim().slice(0, contextLength),
            });
          }
          if (results.length >= maxResults) return false;
        }
      });
      return JSON.stringify({
        ok: true,
        results,
        truncated: results.length >= maxResults,
        small_model_optimized: isSmall,
      });
    } catch (e: unknown) {
      return JSON.stringify({ ok: false, error: (e as { message?: string }).message });
    }
  },
};
