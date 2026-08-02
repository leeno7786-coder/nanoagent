import { existsSync, readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

export interface RepoContext {
  isGit: boolean;
  branch?: string;
  files: string[];
  readme?: string;
  projectType: string;
  primaryLanguage: string;
}

function walkTopFiles(dir: string, maxFiles: number): string[] {
  const result: string[] = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (result.length >= maxFiles) break;
      if (SKIP.has(e.name)) continue;
      // Never list dotfiles (.env, .npmrc, ...) — they may name secrets and
      // must not appear in prompts.
      if (e.name.startsWith('.')) continue;
      if (e.isFile()) {
        result.push(e.name);
      } else if (e.isDirectory()) {
        result.push(e.name + '/');
        try {
          const sub = readdirSync(resolve(dir, e.name), { withFileTypes: true });
          for (const se of sub) {
            if (result.length >= maxFiles) break;
            if (se.name.startsWith('.')) continue;
            if (se.isFile() && !SKIP.has(se.name)) {
              result.push(e.name + '/' + se.name);
            }
          }
        } catch {
          /* skip unreadable subdirs */
        }
      }
    }
  } catch {
    /* workspace may not be readable */
  }
  return result;
}

export function detectContext(workspace: string): RepoContext {
  const ctx: RepoContext = {
    isGit: false,
    files: [],
    projectType: 'unknown',
    primaryLanguage: 'unknown',
  };
  try {
    execSync('git rev-parse --git-dir', { cwd: workspace, stdio: 'ignore', timeout: 5000 });
    ctx.isGit = true;
    ctx.branch = execSync('git branch --show-current', {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();
  } catch {
    /* not git */
  }

  ctx.files = walkTopFiles(workspace, 50);

  // Detect project type and primary language — prioritize manifest files over extensions
  const hasPackageJson = ctx.files.some((f) => f === 'package.json' || f.endsWith('/package.json'));
  const hasTsConfig = ctx.files.some((f) => f === 'tsconfig.json' || f.endsWith('/tsconfig.json'));
  const hasCargoToml = ctx.files.some((f) => f === 'Cargo.toml' || f.endsWith('/Cargo.toml'));
  const hasGoMod = ctx.files.some((f) => f === 'go.mod' || f.endsWith('/go.mod'));
  const hasBuildGradle = ctx.files.some((f) => f.includes('build.gradle') || f.includes('pom.xml'));
  const hasRequirementsTxt = ctx.files.some(
    (f) => f === 'requirements.txt' || f.endsWith('/requirements.txt')
  );
  const hasPyProject = ctx.files.some(
    (f) => f === 'pyproject.toml' || f === 'setup.py' || f.endsWith('/pyproject.toml')
  );

  const tsCount = ctx.files.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')).length;
  const jsCount = ctx.files.filter((f) => f.endsWith('.js') || f.endsWith('.jsx')).length;
  const pyCount = ctx.files.filter((f) => f.endsWith('.py')).length;
  const rsCount = ctx.files.filter((f) => f.endsWith('.rs')).length;
  const goCount = ctx.files.filter((f) => f.endsWith('.go')).length;
  const javaCount = ctx.files.filter((f) => f.endsWith('.java')).length;

  if (hasPackageJson) {
    ctx.projectType = 'nodejs';
    if (hasTsConfig && tsCount > jsCount) {
      ctx.primaryLanguage = 'typescript';
    } else if (jsCount > 0) {
      ctx.primaryLanguage = 'javascript';
    }
  } else if (hasCargoToml || rsCount > 2) {
    ctx.projectType = 'rust';
    ctx.primaryLanguage = 'rust';
  } else if (hasGoMod || goCount > 2) {
    ctx.projectType = 'golang';
    ctx.primaryLanguage = 'go';
  } else if (hasBuildGradle || javaCount > 2) {
    ctx.projectType = 'java';
    ctx.primaryLanguage = 'java';
  } else if (hasPyProject || hasRequirementsTxt || pyCount > 2) {
    ctx.projectType = 'python';
    ctx.primaryLanguage = 'python';
  }

  const readmePath = resolve(workspace, 'README.md');
  if (existsSync(readmePath)) {
    try {
      ctx.readme = readFileSync(readmePath, 'utf-8').slice(0, 2000);
    } catch {
      /* README not readable */
    }
  }

  return ctx;
}
