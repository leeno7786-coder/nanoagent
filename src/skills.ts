import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, basename, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import type { Skill, SkillCommand } from './types.js';

const SKILL_DIRS = [
  join(process.cwd(), 'skills'),
  join(homedir(), '.qwen-agent-tui', 'skills'),
  join(homedir(), '.agents', 'skills'),
  join(homedir(), '.claude', 'skills'),
];

const TEMPLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
  'templates'
);

const SKILL_CONFIG_FILE = join(homedir(), '.qwen-agent-tui', 'skill-config.json');

// Resolved relative to this compiled module. Under a normal install the bin is
// dist/main.js and this file compiles to dist/skills.js, so the package root
// (containing /skills) is one level up from dist.
const BUILTIN_SKILL_DIR = (() => {
  const fromBin = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidate = join(fromBin, 'skills');
  if (existsSync(candidate)) return candidate;
  // Running from source tree where compiled output lives elsewhere.
  return join(process.cwd(), 'skills');
})();

function ensureSkillDirs(): void {
  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* dir may already exist */
      }
    }
  }
}

// P1: Validate skill sourcePath against allowed paths
export function isSkillPathAllowed(sourcePath: string, allowedPaths?: string[]): boolean {
  if (!allowedPaths || allowedPaths.length === 0) {
    // No restrictions configured, allow by default
    return true;
  }

  for (const allowedPath of allowedPaths) {
    try {
      // Normalize paths for comparison
      const normalizedSource = sourcePath.replace(/\\/g, '/');
      const normalizedAllowed = allowedPath.replace(/\\/g, '/');

      // Check if sourcePath starts with allowedPath
      if (
        normalizedSource.startsWith(normalizedAllowed + '/') ||
        normalizedSource === normalizedAllowed
      ) {
        return true;
      }
    } catch {
      // If comparison fails, continue to next allowed path
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

  // Normalize line endings (handle both CRLF and LF)
  const normalizedText = text.replace(/\r\n/g, '\n');

  // Match YAML frontmatter between --- delimiters
  const match = normalizedText.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return result;

  const yaml = match[1];
  const lines = yaml.split('\n');

  let currentKey: string | null = null;
  let isBlockValue = false;
  let blockValue: string[] = [];

  for (const raw of lines) {
    const line = raw;

    // Handle block scalar indicator (|)
    if (isBlockValue && currentKey) {
      if (line.startsWith('  ') || line.startsWith('- ') || line.trim() === '') {
        blockValue.push(line);
        continue;
      } else {
        // End of block value
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
      // Parse inline array: triggers: ["a", "b"]
      if (value.startsWith('[')) {
        try {
          result.triggers = JSON.parse(value.replace(/'/g, '"'));
        } catch {
          /* not valid JSON, skip inline parse */
        }
      } else if (value === '') {
        // Triggers as block list: triggers:\n  - item
        currentKey = 'triggers';
        isBlockValue = true;
        blockValue = [];
        continue;
      }
    }
  }

  // Handle trailing block value
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
  // Extract WHEN: sections from description
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
      // Parse SKILL.md with YAML frontmatter
      const content = readFileSync(filePath, 'utf-8');
      const frontmatter = parseYamlFrontmatter(content);
      if (!frontmatter.name) return null;

      // Extract prompt body (everything after frontmatter) - handle both CRLF and LF
      const normalizedContent = content.replace(/\r\n/g, '\n');
      const prompt = normalizedContent.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();

      // Extract triggers from frontmatter or description
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
      // Legacy JSON skill support
      const skill: Skill = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (!skill.name) {
        skill.name = basename(filePath, '.json');
      }
      skill.source = 'json';
      skill.sourcePath = filePath;
      if (skill.enabled === undefined) skill.enabled = true;

      // Extract triggers from tags or longDescription
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

  // Scan for SKILL.md files (in subdirectories)
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

    // Also scan for direct .json files (legacy support)
    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = join(dir, entry.name);
        const ext = extname(entry.name).toLowerCase();
        if (ext !== '.json') continue;
        // Skip if a corresponding SKILL.md subdirectory exists (SKILL.md takes priority)
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

export function loadSkills(): Map<string, Skill> {
  ensureSkillDirs();

  const userPrefs = loadSkillConfig();
  const map = new Map<string, Skill>();

  // Built-ins first so local/user skills can override
  // Use process.cwd() + "skills" as the primary skills directory
  const projectSkillsDir = join(process.cwd(), 'skills');
  let allDirs = [projectSkillsDir, ...SKILL_DIRS];

  // Fallback: If project skills directory doesn't exist, use BUILTIN_SKILL_DIR
  if (!existsSync(projectSkillsDir)) {
    allDirs = [BUILTIN_SKILL_DIR, ...SKILL_DIRS];
  }

  for (const dir of allDirs) {
    if (!existsSync(dir)) continue;
    const dirSkills = scanDirForSkills(dir);
    for (const [name, skill] of dirSkills) {
      // Apply user preference from config
      if (userPrefs[name] !== undefined) {
        skill.enabled = userPrefs[name];
      }
      map.set(name, skill);
    }
  }

  return map;
}

export function matchSkillTriggers(text: string, skills: Map<string, Skill>): Skill[] {
  const lower = text.toLowerCase();
  const matched: Skill[] = [];
  const seen = new Set<string>();

  for (const [name, skill] of skills) {
    if (seen.has(name)) continue;
    if (skill.enabled) continue; // Don't auto-load already-enabled skills

    // Check triggers
    if (skill.triggers?.length) {
      for (const trigger of skill.triggers) {
        if (lower.includes(trigger.toLowerCase())) {
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

export function getSkillCommands(skills: Map<string, Skill>): SkillCommand[] {
  const commands: SkillCommand[] = [];

  for (const [name, skill] of skills) {
    if (!skill.enabled) continue;
    const commandName = skill.command || `skill:${name}`;
    const shortDesc = skill.description || '';
    const displayDesc = shortDesc.length > 80 ? shortDesc.slice(0, 77) + '...' : shortDesc;

    commands.push({
      name: `/${commandName}`,
      description: displayDesc,
      fullDescription: skill.longDescription || skill.description || '',
      skillName: name,
    });
  }

  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands;
}

export function getSkill(name: string): Skill | undefined {
  const skills = loadSkills();
  return skills.get(name) || skills.get(name.replace(/^skill:/, ''));
}

export function saveSkill(skill: Skill): string {
  ensureSkillDirs();
  const filename = `${skill.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
  const path = join(SKILL_DIRS[0], filename);

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
  return path;
}

export function deleteSkill(name: string): boolean {
  const skills = loadSkills();
  const skill = skills.get(name) || skills.get(name.replace(/^skill:/, ''));
  if (!skill) return false;

  for (const dir of [BUILTIN_SKILL_DIR, ...SKILL_DIRS]) {
    if (!existsSync(dir)) continue;
    if (skill.sourcePath) {
      try {
        const normSrc = skill.sourcePath.replace(/\\/g, '/');
        const normDir = dir.replace(/\\/g, '/');
        if (!normSrc.startsWith(normDir)) continue;
        rmSync(skill.sourcePath, { force: true });
        return true;
      } catch {
        /* skill not deletable */
      }
    }
    const filename = `${skill.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    const path = join(dir, filename);
    try {
      rmSync(path, { force: true });
      return true;
    } catch {
      /* skill dir not writable */
    }
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

  return true;
}

export function getSkillNames(): string[] {
  const skills = loadSkills();
  return Array.from(skills.keys());
}

function loadSkillConfig(): Record<string, boolean> {
  if (!existsSync(SKILL_CONFIG_FILE)) return {};
  try {
    const content = readFileSync(SKILL_CONFIG_FILE, 'utf-8');
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
    writeFileSync(SKILL_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    /* config file not writable */
  }
}

export function getSkillConfig(): Record<string, boolean> {
  return loadSkillConfig();
}
