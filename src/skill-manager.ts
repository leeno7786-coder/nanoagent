import { loadSkills, matchSkillTriggers, getSkill } from './skills.js';
import type { Message, Skill } from './types.js';

/**
 * Optional sink for keeping ContextManager accounting in step with skill
 * message updates. Structurally matches ContextManager — without it, message
 * content still updates in place (both arrays share the message objects) and
 * token accounting catches up at the next full resync (rebuild / compaction).
 */
export interface SkillMessageSink {
  updateMessage(message: Message): void;
  insertMessage(index: number, message: Message): void;
}

/** `## Active skill: <name>` section headers inside a prompt/message. */
function skillNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/## Active skill: ([^\n]+)/g)) {
    names.push(m[1].trim());
  }
  return names;
}

export class SkillManager {
  activeSkills: Map<string, Skill> = new Map();
  /**
   * Skills whose prompts live INSIDE system-base — the cached prefix.
   *
   * These are active from boot (enabled in config, pinned in systemPrompt) or
   * were active when a session was restored. Their sections are session-static:
   * re-syncing produces byte-identical output, so the prefix cache / llama.cpp
   * KV reuse keeps hitting. Content here is only ever rewritten by an explicit
   * unload or a system-prompt rebuild (both sanctioned prefix rewrites).
   */
  private _seededSkills: Map<string, Skill> = new Map();
  /**
   * Skills activated MID-SESSION (triggers, /skill:name). Their prompts live
   * in the trailing `system-skills` message, emitted as a `[skill-context]`
   * user turn — appending there never touches the prefix, so an auto-load
   * costs zero re-prefills instead of busting the whole cached history.
   * The trade is deliberate: tail content is re-prefilled every request, so
   * only rarely-changing boot skills stay in the prefix.
   */
  private _midSkills: Map<string, Skill> = new Map();
  private _autoLoadedSkills: Set<string> = new Set();
  /**
   * Skills whose tool sets were activated this session — append-only.
   *
   * The tools array is part of the cached prompt prefix, so a mid-session
   * change re-prefills the whole conversation. `memory-graph` re-enables 14
   * graph tools for small models when it activates; a grow-only set caps that
   * at one bust per session and removes the second bust when the skill is
   * unloaded. The set resets with the manager (new session / boot).
   */
  private _toolSkills = new Set<string>();
  /** Called when system-base content is rewritten by a sync. */
  onPromptSync?: (content: string) => void;

  /**
   * Load a skill. Returns true if newly loaded, false if already active.
   * Newly loaded = mid-session activation → trailing turn, prefix untouched.
   */
  load(
    skill: Skill,
    messages: Message[],
    smallModel: boolean,
    onUpdate?: () => void,
    sink?: SkillMessageSink
  ): boolean {
    if (this.activeSkills.has(skill.name)) return false;
    this.activeSkills.set(skill.name, skill);
    this._midSkills.set(skill.name, skill);
    this._autoLoadedSkills.add(skill.name);
    this._toolSkills.add(skill.name);
    this.syncSkillMessages(messages, smallModel, sink);
    onUpdate?.();
    return true;
  }

  /**
   * Unload a skill by name. Returns true if removed, false if not found.
   * Its tool set stays enabled (see `_toolSkills`).
   */
  unload(
    name: string,
    messages: Message[],
    smallModel: boolean,
    onUpdate?: () => void,
    sink?: SkillMessageSink
  ): boolean {
    if (!this.activeSkills.has(name)) return false;
    this.activeSkills.delete(name);
    this._seededSkills.delete(name);
    this._midSkills.delete(name);
    this._autoLoadedSkills.delete(name);
    this.syncSkillMessages(messages, smallModel, sink);
    onUpdate?.();
    return true;
  }

  /**
   * Register a skill as prefix-resident: active from boot (enabled in config
   * or pinned via systemPrompt) or adopted from a restored session's prompt.
   */
  seed(name: string, skill: Skill): void {
    this.activeSkills.set(name, skill);
    this._seededSkills.set(name, skill);
    this._toolSkills.add(name);
  }

  /** Get names of all active skills. */
  activeNames(): string[] {
    return Array.from(this.activeSkills.keys());
  }

  /**
   * Skills that have had their tools enabled this session (active + previously
   * active). This — NOT `activeNames()` — is what decides the tools array, so
   * the schema can only grow mid-session.
   */
  toolSkillNames(): Set<string> {
    return new Set(this._toolSkills);
  }

  /**
   * Re-derive both skill homes from the active maps and keep the persisted
   * messages in step.
   *
   * - system-base gets the SEEDED (prefix-resident) sections back. Sections
   *   are always at the very end of system-base, so strip-then-append is a
   *   pure rebuild: unchanged membership produces byte-identical content and
   *   no write happens.
   * - `system-skills` (trailing `[skill-context]` turn) mirrors the
   *   mid-session skills only.
   *
   * A resumed session has no manager state but its persisted messages still
   * carry the old sections — on first sync those names are adopted back
   * (prefix sections → seeded, tail message → mid) so an un-/unload-able set
   * survives `--resume` byte-for-byte. Names no longer on disk are dropped.
   */
  syncSkillMessages(messages: Message[], smallModel: boolean, sink?: SkillMessageSink): void {
    const skillCharCap = smallModel ? 3500 : 6000;
    const blocksOf = (map: Map<string, Skill>): string => {
      const blocks: string[] = [];
      for (const [name, skill] of map) {
        let prompt = (skill.prompt || '').replace(/\bbash\b/g, 'execute_command');
        if (prompt.length > skillCharCap) {
          prompt =
            prompt.slice(0, skillCharCap) +
            `\n\n[Skill truncated to ${skillCharCap} chars for context efficiency.]`;
        }
        blocks.push(`## Active skill: ${name}\n${prompt}`);
      }
      return blocks.join('\n\n');
    };

    // --- Adopt persisted skill homes (restored sessions only) --------------
    const base = messages.find((m) => m.id === 'system-base');
    if (base) {
      const markerIdx = base.content.indexOf('\n\n## Active skill');
      if (markerIdx >= 0) {
        // fs access only for names the manager does not already know — i.e.
        // once per resumed session, never on the steady-state request path.
        for (const name of skillNamesIn(base.content.slice(markerIdx))) {
          if (this.activeSkills.has(name)) continue;
          const skill = getSkill(name);
          if (skill) this.seed(name, skill);
        }
      }
    }
    const skillMsgIdx = messages.findIndex((m) => m.id === 'system-skills');
    if (skillMsgIdx >= 0) {
      const persisted = messages[skillMsgIdx]!.content;
      if (persisted.trim()) {
        for (const name of skillNamesIn(persisted)) {
          if (this.activeSkills.has(name)) continue;
          const skill = getSkill(name);
          if (skill) {
            this.activeSkills.set(name, skill);
            this._midSkills.set(name, skill);
            this._toolSkills.add(name);
          }
        }
      }
    }

    // --- Rebuild the prefix-resident sections in system-base ---------------
    if (base) {
      const markerIdx = base.content.indexOf('\n\n## Active skill');
      // Sections are always the tail of system-base (sync appends them last),
      // so cutting at the marker and re-appending is a pure rebuild.
      const head = markerIdx >= 0 ? base.content.slice(0, markerIdx).trimEnd() : base.content;
      const section = blocksOf(this._seededSkills);
      const next = section ? `${head}\n\n${section}` : head;
      if (next !== base.content) {
        base.content = next;
        this.onPromptSync?.(next);
        sink?.updateMessage(base);
      }
    }

    // --- Mirror mid-session skills into the trailing message ---------------
    const content = blocksOf(this._midSkills);
    const idx = messages.findIndex((m) => m.id === 'system-skills');
    if (idx >= 0) {
      const msg = messages[idx]!;
      if (msg.content !== content) {
        msg.content = content;
        sink?.updateMessage(msg);
      }
      return;
    }

    // Mirrors syncTodoMessage: created once, kept even while empty, parked in
    // the leading system block so compaction treats it as a kept system id.
    const skillMsg: Message = {
      id: 'system-skills',
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    const todosIdx = messages.findIndex((m) => m.id === 'system-todos');
    const baseIdx = messages.findIndex((m) => m.id === 'system-base');
    const insertAt = todosIdx >= 0 ? todosIdx + 1 : baseIdx >= 0 ? baseIdx + 1 : 0;
    messages.splice(insertAt, 0, skillMsg);
    sink?.insertMessage(insertAt, skillMsg);
  }

  /**
   * Load skills whose triggers match user text. Returns newly loaded skills.
   */
  autoLoad(
    userText: string,
    messages: Message[],
    smallModel: boolean,
    onUpdate?: () => void,
    sink?: SkillMessageSink
  ): Skill[] {
    const allSkills = loadSkills();
    const matched = matchSkillTriggers(userText, allSkills);
    const newlyLoaded: Skill[] = [];

    // Cap at 2 skills per turn — flooding the context with 5 skill prompts
    // dilutes all of them (especially for small models)
    for (const skill of matched.slice(0, 2)) {
      if (this._autoLoadedSkills.has(skill.name)) continue;
      if (this.activeSkills.has(skill.name)) continue;
      this.load(skill, messages, smallModel, onUpdate, sink);
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
