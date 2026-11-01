/**
 * Noise filtering for the memory-graph file walk.
 *
 * Two sources, applied in this order (later rules win, git semantics):
 * 1. A built-in default list — dependency/build/cache directories that are
 *    never project source (node_modules, venv, __pycache__, target, …).
 *    Names are chosen to have near-zero collision with real source dirs and
 *    are matched at any depth, because build output appears at any depth
 *    (multi-module Maven/Rust projects).
 * 2. The project's own `.gitignore` files (root and nested) — the project
 *    already declares what is not source. Ignoring that declaration is what
 *    let a Python venv's site-packages flood the graph with thousands of
 *    third-party nodes and made it unusable.
 *
 * This is a pragmatic subset of gitignore semantics: comments, blanks,
 * negation (`!`), dir-only (`/`-suffixed) patterns, root-anchored patterns,
 * `*`, `?` and `**` globs, last-match-wins. It does not handle CRLF quirks
 * beyond trimming or git's "directory can't be re-included" edge cases.
 */

export interface IgnoreRule {
  /** Regex matched against the workspace-relative POSIX path. */
  regex: RegExp;
  /** `!pattern` — re-includes a previously ignored path. */
  negate: boolean;
  /** `pattern/` — matches directories only. */
  dirOnly: boolean;
}

/**
 * Never-source directories/files, matched at any depth. Deliberately excludes
 * ambiguous names like `env`, `out` or `build`-adjacent words that could be
 * real source directories — the project's .gitignore covers those cases.
 */
export const DEFAULT_GRAPH_EXCLUDES: string[] = [
  // Harness / VCS state
  '.git',
  '.nanoagent',
  '.qwen-graph', // legacy graph dir (pre-2.7.26)
  // JS build output & tool caches
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.eslintcache',
  // Rust / Java / Go build output & vendored deps
  'target',
  'vendor',
  '.gradle',
  '.m2',
  // Python environments & caches
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.eggs',
  'site-packages',
  // IDE metadata
  '.idea',
  '.vscode',
  '.vs',
  // Generated/binary artifacts by name
  '*.lock',
  '*.log',
  '*.pyc',
  '*.pyo',
  '*.pyd',
  '*.map',
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.tsbuildinfo',
  '*.egg-info',
  'package-lock.json',
  'pnpm-lock.yaml',
  'bun.lockb',
];

/**
 * Extensionless files that ARE project structure and deserve a node even
 * though they have no parseable source extension.
 */
export const SPECIAL_FILE_NAMES = new Set([
  'makefile',
  'dockerfile',
  'cmakelists.txt',
  'gemfile',
  'rakefile',
  'procfile',
  'justfile',
  'go.mod',
]);

/** Escape a literal path segment for embedding in a regex. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one glob body (negation/`/`-suffix already stripped) to a regex
 * source. `base` anchors the pattern under a nested .gitignore's directory.
 */
function globBodyToRegexSource(body: string, anchored: boolean, base: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '*') {
      if (body[i + 1] === '*') {
        // `**/` → any number of leading segments; bare `**` → anything
        if (body[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(ch!);
    }
  }
  const prefix = base ? `${escapeRegex(base)}/` : '';
  // Anchored (leading `/` or an interior `/`): match from the base dir.
  // Otherwise match at any depth below the base dir.
  return anchored ? `^${prefix}${out}$` : `^${prefix}(?:.*/)?${out}$`;
}

/**
 * Compile a single glob (gitignore syntax) into a rule relative to `base`.
 * Returns null for lines that carry no pattern (blank/comment).
 */
export function compileIgnoreGlob(glob: string, base = ''): IgnoreRule | null {
  let pattern = glob;
  // Git ignores trailing spaces unless escaped; strip for robustness.
  pattern = pattern.replace(/(?<!\\)\s+$/, '');
  if (!pattern || pattern.startsWith('#')) return null;

  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }

  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }

  let anchored = false;
  if (pattern.startsWith('/')) {
    anchored = true;
    pattern = pattern.slice(1);
  } else if (pattern.includes('/')) {
    // An interior slash anchors the pattern to the .gitignore's directory.
    anchored = true;
  }
  if (!pattern) return null;

  return {
    regex: new RegExp(globBodyToRegexSource(pattern, anchored, base)),
    negate,
    dirOnly,
  };
}

/** Parse .gitignore content into rules. `base` is the workspace-relative dir
 *  the file lives in (nested .gitignore patterns apply under it). */
export function parseIgnoreFile(content: string, base = ''): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of content.split(/\r?\n/)) {
    const rule = compileIgnoreGlob(line, base);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Evaluate rules against a workspace-relative POSIX path.
 * Last matching rule wins (git semantics); `dirOnly` rules skip files.
 */
export function isIgnored(rules: readonly IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.regex.test(relPath)) ignored = !rule.negate;
  }
  return ignored;
}
