import { loadSkills, matchSkillTriggers, getSkill } from './skills.js';
import type { Message, Skill } from './types.js';

export class SkillManager {
  activeSkills: Map<string, Skill> = new Map();
  private _autoLoadedSkills: Set<string> = new Set();

  /**
   * Load a skill. Returns true if newly loaded, false if already active.
   */
  load(skill: Skill, messages: Message[], smallModel: boolean, onUpdate?: () => void): boolean {
    if (this.activeSkills.has(skill.name)) return false;
    this.activeSkills.set(skill.name, skill);
    this._autoLoadedSkills.add(skill.name);
    this.syncSkillMessages(messages, smallModel);
    onUpdate?.();
    return true;
  }

  /**
   * Unload a skill by name. Returns true if removed, false if not found.
   */
  unload(name: string, messages: Message[], smallModel: boolean, onUpdate?: () => void): boolean {
    if (!this.activeSkills.has(name)) return false;
    this.activeSkills.delete(name);
    this._autoLoadedSkills.delete(name);
    this.syncSkillMessages(messages, smallModel);
    onUpdate?.();
    return true;
  }

  /** Get names of all active skills. */
  activeNames(): string[] {
    return Array.from(this.activeSkills.keys());
  }

  /**
   * Rebuild the system-base message to include active skill prompts.
   */
  syncSkillMessages(messages: Message[], smallModel: boolean): void {
    const base = messages.find((m) => m.id === 'system-base');
    if (!base) return;

    const cleanBase = base.content
      .replace(/\n\n## Active skill[\s\S]*?(?=\n\n##|$)/g, '')
      .trimEnd();
    const skillCharCap = smallModel ? 3500 : 6000;
    let skillSection = '';

    for (const [name, skill] of this.activeSkills) {
      let prompt = (skill.prompt || '').replace(/\bbash\b/g, 'execute_command');
      if (prompt.length > skillCharCap) {
        prompt =
          prompt.slice(0, skillCharCap) +
          `\n\n[Skill truncated to ${skillCharCap} chars for context efficiency.]`;
      }
      skillSection += `\n\n## Active skill: ${name}\n${prompt}`;
    }

    base.content = cleanBase + skillSection;
  }

  /**
   * Load skills whose triggers match user text. Returns newly loaded skills.
   */
  autoLoad(
    userText: string,
    messages: Message[],
    smallModel: boolean,
    onUpdate?: () => void
  ): Skill[] {
    const allSkills = loadSkills();
    const matched = matchSkillTriggers(userText, allSkills);
    const newlyLoaded: Skill[] = [];

    for (const skill of matched) {
      if (this._autoLoadedSkills.has(skill.name)) continue;
      if (this.activeSkills.has(skill.name)) continue;
      this.load(skill, messages, smallModel, onUpdate);
      newlyLoaded.push(skill);
    }

    return newlyLoaded;
  }

  /**
   * Get all available skills (loaded + unloaded) with their status.
   */
  getAllWithStatus(): { name: string; description: string; active: boolean }[] {
    const all = loadSkills();
    const active = this.activeNames();
    const result: { name: string; description: string; active: boolean }[] = [];
    for (const [name, s] of all) {
      result.push({ name, description: s.description || '', active: active.includes(name) });
    }
    return result;
  }

  /**
   * Get skill by name (from all available skills).
   */
  static getByName(name: string): Skill | undefined {
    return getSkill(name);
  }
}
