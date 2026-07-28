import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SkillConfig } from '../types.js';
import { logError, logWarn } from '../log.js';

function ensureSkillConfigDir(): string {
  const skillConfigDir = join(homedir(), '.qwen-agent-tui', 'skill-config');
  if (!existsSync(skillConfigDir)) {
    try {
      mkdirSync(skillConfigDir, { recursive: true });
    } catch (err) {
      logWarn('Warning: failed to create skill config directory:', err);
    }
  }
  return skillConfigDir;
}

export function loadSkillConfig(): SkillConfig {
  const skillConfigDir = ensureSkillConfigDir();
  const configPath = join(skillConfigDir, 'skill-config.json');
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    logWarn(
      `Warning: failed to parse skill config ${configPath}:`,
      err instanceof Error ? err.message : String(err)
    );
    return {};
  }
}

export function saveSkillConfig(config: SkillConfig): boolean {
  try {
    const skillConfigDir = ensureSkillConfigDir();
    if (!existsSync(skillConfigDir)) {
      mkdirSync(skillConfigDir, { recursive: true });
    }
    const configPath = join(skillConfigDir, 'skill-config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (error) {
    logError('Error saving skill configuration:', error);
    return false;
  }
}

export function toggleSkillInConfig(name: string): boolean {
  try {
    const config = loadSkillConfig();
    if (!config.skills) {
      config.skills = {};
    }
    if (config.skills[name] === undefined) {
      if (config.enabled === undefined) {
        config.enabled = true;
      }
      config.skills[name] = !config.enabled;
    } else {
      config.skills[name] = !config.skills[name];
    }
    saveSkillConfig(config);
    return true;
  } catch (error) {
    logError('Error toggling skill in config:', error);
    return false;
  }
}

export function getSkillEnabledFromConfig(name: string): boolean | undefined {
  const config = loadSkillConfig();
  if (config.skills && config.skills[name] !== undefined) {
    return config.skills[name];
  }
  return config.enabled;
}

export function getAllConfiguredSkills(): Map<string, boolean> {
  const config = loadSkillConfig();
  const map = new Map<string, boolean>();
  if (config.enabled !== undefined) {
    map.set('*', config.enabled);
  }
  if (config.skills && typeof config.skills === 'object') {
    for (const [name, enabled] of Object.entries(config.skills)) {
      map.set(name, enabled);
    }
  }
  return map;
}
