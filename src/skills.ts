import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, basename, dirname, extname } from 'path';
import type { Skill, SkillCommand } from './types.js';
import { SKILLS_DIR, SKILL_CONFIG_FILE } from './config/paths.js';

const TEMPLATE_DIR = join(dirname(import.meta.url.replace('file:///', '')), '..', 'skills', 'templates');

function ensureSkillDir(): void {
  const dir = SKILLS_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// P1: Validate skill sourcePath against allowed paths
export function isSkillPathAllowed(sourcePath: string, allowedPaths?: string[]): boolean {
  if (!allowedPaths || allowedPaths.length === 0) return true;

  for (const allowedPath of allowedPaths) {
    try {
      const normalizedSource = sourcePath.replace(/\\/g, '/');
      const normalizedAllowed = allowedPath.replace(/\\/g, '/');

      if (
        normalizedSource.startsWith(normalizedAllowed + '/') ||
        normalizedSource === normalizedAllowed
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

function parseYamlFrontmatter(text: string): {
  name?: string;
  description?: string;
  triggers?: string[];
  [key: string]: unknown;
} {
  const result: {
    name?: string;
    description?: string;
    triggers?: string[];
    [key: string]: unknown;
  } = {};

  const normalizedText = text.replace(/\r\n/g, '\n');
  const match = normalizedText.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return result;

  const yaml = match[1];
  const lines = yaml.split('\n');

  let currentKey: string | null = null;
  let isBlockValue = false;
  let blockValue: string[] = [];

  for (const raw of lines) {
    const line = raw;

    if (isBlockValue && currentKey) {
      if (line.startsWith('  ') || line.startsWith('- ') || line.trim() === '') {
        blockValue.push(line);
        continue;
      } else {
        if (currentKey === 'description') {
          result.description = blockValue
            .map((l) => l.replace(/^ {2}/, ''))
            .join('\n')
            .trim();
        } else if (currentKey === 'triggers') {
          result.triggers = blockValue
            .filter((l) => l.trim().startsWith('- '))
            .map((l) => l.trim().slice(2).trim().replace(/^"|"$/g, ''));
        }
        currentKey = null;
        isBlockValue = false;
        blockValue = [];
      }
    }

    const keyMatch = line.match(/^(\w[\w_-]*?):\s*(.*)$/);
    if (!keyMatch) continue;

    const key = keyMatch[1];
    const value = keyMatch[2].trim();

    if (value === '|') {
      currentKey = key;
      isBlockValue = true;
      blockValue = [];
      continue;
    }

    if (key === 'name') {
      result.name = value;
    } else if (key === 'description') {
      result.description = value;
    } else if (key === 'triggers') {
      if (value.startsWith('[')) {
        try {
          result.triggers = JSON.parse(value.replace(/'/g, '"'));
        } catch {
          /* not valid JSON, skip inline parse */
        }
      } else if (value === '') {
        currentKey = 'triggers';
        isBlockValue = true;
        blockValue = [];
        continue;
      }
    }
  }

  if (isBlockValue && currentKey) {
    if (currentKey === 'description') {
      result.description = blockValue
        .map((l) => l.replace(/^ {2}/, ''))
        .join('\n')
        .trim();
    } else if (currentKey === 'triggers') {
      result.triggers = blockValue
        .filter((l) => l.trim().startsWith('- '))
        .map((l) => l.trim().slice(2).trim().replace(/^"|"$/g, ''));
    }
  }

  return result;
}

function extractTriggersFromDescription(description: string): string[] {
  const whenMatch = description.match(/(?:WHEN|when|Use when):\s*(.*?)(?:\.\s|$)/);
  if (!whenMatch) return [];

  return whenMatch[1]
    .split(/[,;]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function loadSkillFile(filePath: string): Skill | null {
  try {
    const ext = extname(filePath).toLowerCase();

    if (ext === '.md') {
      const content = readFileSync(filePath, 'utf-8');
      const frontmatter = parseYamlFrontmatter(content);
      if (!frontmatter.name) return null;

      const normalizedContent = content.replace(/\r\n/g, '\n');
      const prompt = normalizedContent.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();

      const triggers = frontmatter.triggers?.length
        ? frontmatter.triggers
        : extractTriggersFromDescription(frontmatter.description || '');

      return {
        name: frontmatter.name,
        description: frontmatter.description || '',
        prompt,
        tools: [],
        triggers,
        enabled: false,
        source: 'skilli.md',
        sourcePath: filePath,
        command: `skill:${frontmatter.name}`,
      };
    }

    if (ext === '.json') {
      const skill: Skill = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (!skill.name) {
        skill.name = basename(filePath, '.json');
      }
      skill.source = 'json';
      skill.sourcePath = filePath;
      if (skill.enabled === undefined) skill.enabled = true;

      if (!skill.triggers) {
        skill.triggers = skill.tags?.length
          ? skill.tags
          : extractTriggersFromDescription(skill.longDescription || skill.description || '');
      }

      if (!skill.command) {
        skill.command = `skill:${skill.name}`;
      }

      return skill;
    }

    return null;
  } catch {
    return null;
  }
}

function scanDirForSkills(dir: string): Map<string, Skill> {
  const map = new Map<string, Skill>();

  if (!existsSync(dir)) return map;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = join(dir, entry.name, 'SKILL.md');
        if (existsSync(skillMdPath)) {
          const skill = loadSkillFile(skillMdPath);
          if (skill) map.set(skill.name, skill);
        }
      }
    }

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = join(dir, entry.name);
        const ext = extname(entry.name).toLowerCase();
        if (ext !== '.json') continue;
        const jsonName = basename(entry.name, '.json');
        if (existsSync(join(dir, jsonName, 'SKILL.md'))) continue;
        const skill = loadSkillFile(filePath);
        if (skill) map.set(skill.name, skill);
      }
    }
  } catch {
    /* skill dir not readable */
  }

  return map;
}

// --- Skills cache -------------------------------------------------------
let skillsCache: { key: string; map: Map<string, Skill> } | null = null;

/** Force the next loadSkills() to rescan (called after skill mutations). */
export function invalidateSkillsCache(): void {
  skillsCache = null;
}

function fingerprintSkillsInputs(dir: string): string {
  const parts: string[] = [];
  try {
    if (!existsSync(dir)) {
      parts.push(`${dir}:missing`);
    } else {
      const entries = readdirSync(dir).sort();
      const sigs = entries.map((name) => {
        try {
          const st = statSync(join(dir, name));
          let sig = `${name}:${st.mtimeMs}`;
          if (st.isDirectory()) {
            const skillMd = join(dir, name, 'SKILL.md');
            if (existsSync(skillMd)) sig += `:${statSync(skillMd).mtimeMs}`;
          }
          return sig;
        } catch {
          return `${name}:?`;
        }
      });
      parts.push(`${dir}[${sigs.join(',')}]`);
    }
  } catch {
    parts.push(`${dir}:err`);
  }
  try {
    parts.push(
      `cfg:${existsSync(SKILL_CONFIG_FILE()) ? statSync(SKILL_CONFIG_FILE()).mtimeMs : 'none'}`
    );
  } catch {
    parts.push('cfg:?');
  }
  return parts.join('|');
}

// statSync is required by fingerprintSkillsInputs; pulling it in here keeps
// the module's fs imports minimal.
import { statSync } from 'fs';

/**
 * Load every skill the agent owns.
 *
 * There is exactly one source of truth: `<NANOAGENT_ROOT>/skills/`. Bundled
 * skills ship inside the package and are installed to that directory by the
 * launcher on first run. User skills drop into the same directory. There is
 * no <cwd>/skills, no ~/.nanoagent/skills, no ~/.qwen-agent-tui/skills, no
 * ~/.agents/skills, no ~/.claude/skills — those were the source of the
 * "skills disappear depending on cwd" bug.
 */
export function loadSkills(): Map<string, Skill> {
  ensureSkillDir();
  const dir = SKILLS_DIR();

  const cacheKey = fingerprintSkillsInputs(dir);
  if (skillsCache && skillsCache.key === cacheKey) {
    return new Map(skillsCache.map);
  }

  const userPrefs = loadSkillConfig();
  const map = new Map<string, Skill>();
  const dirSkills = scanDirForSkills(dir);
  for (const [name, skill] of dirSkills) {
    if (userPrefs[name] !== undefined) {
      skill.enabled = userPrefs[name];
    }
    map.set(name, skill);
  }

  skillsCache = { key: cacheKey, map };
  return new Map(map);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function triggerMatches(trigger: string, lowerText: string): boolean {
  const words = trigger
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return false;
  if (words.length === 1) {
    return new RegExp(`\\b${escapeRegExp(words[0])}\\b`, 'i').test(lowerText);
  }
  return words.every((w) => lowerText.includes(w));
}

export function matchSkillTriggers(text: string, skills: Map<string, Skill>): Skill[] {
  const lower = text.toLowerCase();
  const matched: Skill[] = [];
  const seen = new Set<string>();

  for (const [name, skill] of skills) {
    if (seen.has(name)) continue;
    if (skill.enabled) continue;

    if (skill.triggers?.length) {
      for (const trigger of skill.triggers) {
        if (triggerMatches(trigger, lower)) {
          matched.push(skill);
          seen.add(name);
          break;
        }
      }
    }
  }

  return matched;
}

export function loadTemplates(): Map<string, Skill> {
  const map = new Map<string, Skill>();
  if (!existsSync(TEMPLATE_DIR)) return map;

  for (const file of readdirSync(TEMPLATE_DIR)) {
    const filePath = join(TEMPLATE_DIR, file);
    const skill = loadSkillFile(filePath);
    if (skill) {
      skill.enabled = false;
      map.set(skill.name, skill);
    }
  }

  return map;
}

export function getSkillCommands(
  skills: Map<string, Skill>,
  opts: { includeDisabled?: boolean } = {}
): SkillCommand[] {
  const commands: SkillCommand[] = [];

  for (const [name, skill] of skills) {
    if (!skill.enabled && !opts.includeDisabled) continue;
    const commandName = skill.command || `skill:${name}`;
    const shortDesc = skill.description || '';
    const displayDesc = shortDesc.length > 80 ? shortDesc.slice(0, 77) + '...' : shortDesc;

    commands.push({
      name: `/${commandName}`,
      description: displayDesc,
      fullDescription: skill.longDescription || skill.description || '',
      skillName: name,
      enabled: !!skill.enabled,
    });
  }

  commands.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return commands;
}

export function getSkill(name: string): Skill | undefined {
  const skills = loadSkills();
  return skills.get(name) || skills.get(name.replace(/^skill:/, ''));
}

export function saveSkill(skill: Skill): string {
  ensureSkillDir();
  const filename = `${skill.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
  const path = join(SKILLS_DIR(), filename);

  const fullSkill: Skill = {
    name: skill.name,
    description: skill.description || '',
    prompt: skill.prompt || '',
    tools: skill.tools || [],
    triggers: skill.triggers || [],
    enabled: skill.enabled !== false,
    command: skill.command,
    longDescription: skill.longDescription,
    version: skill.version || '1.0.0',
    author: skill.author || 'user',
    tags: skill.tags || [],
    source: 'json',
  };

  writeFileSync(path, JSON.stringify(fullSkill, null, 2), 'utf-8');
  invalidateSkillsCache();
  return path;
}

export function deleteSkill(name: string): boolean {
  const skills = loadSkills();
  const skill = skills.get(name) || skills.get(name.replace(/^skill:/, ''));
  if (!skill) return false;

  const dir = SKILLS_DIR();
  if (!existsSync(dir)) return false;
  if (skill.sourcePath) {
    try {
        const normSrc = skill.sourcePath.replace(/\\/g, '/');
        const normDir = dir.replace(/\\/g, '/').replace(/\/?$/, '/');
        if (!normSrc.startsWith(normDir)) return false;
        rmSync(skill.sourcePath, { force: true });
        invalidateSkillsCache();
        return true;
    } catch {
      /* skill not deletable */
    }
  }
  const filename = `${skill.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
  const path = join(dir, filename);
  try {
    rmSync(path, { force: true });
    invalidateSkillsCache();
    return true;
  } catch {
    /* skill dir not writable */
  }
  return false;
}

export function toggleSkill(name: string): boolean {
  const skills = loadSkills();
  const skill = skills.get(name) || skills.get(name.replace(/^skill:/, ''));
  if (!skill) return false;

  skill.enabled = !skill.enabled;
  const config = loadSkillConfig();
  config[name] = skill.enabled;
  saveSkillConfig(config);
  invalidateSkillsCache();

  return true;
}

export function getSkillNames(): string[] {
  const skills = loadSkills();
  return Array.from(skills.keys());
}

function loadSkillConfig(): Record<string, boolean> {
  const path = SKILL_CONFIG_FILE();
  if (!existsSync(path)) return {};
  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.reduce((acc, skill) => ({ ...acc, [skill]: true }), {});
    }
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function saveSkillConfig(config: Record<string, boolean>): void {
  try {
    writeFileSync(SKILL_CONFIG_FILE(), JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    /* config file not writable */
  }
}

export function getSkillConfig(): Record<string, boolean> {
  return loadSkillConfig();
}