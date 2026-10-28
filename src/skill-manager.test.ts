/**
 * SkillManager message-split behavior: active skill prompts must never live
 * inside system-base (the cached prompt prefix), and the session tool set can
 * only grow — a mid-session tools[] change re-prefills the whole history.
 */
import { describe, it, expect } from 'bun:test';
import { SkillManager } from './skill-manager.js';
import { loadSkills } from './skills.js';
import type { Message, Skill } from './types.js';

function makeMessages(prompt: string): Message[] {
  return [
    { id: 'system-base', role: 'system', content: prompt, timestamp: Date.now() },
    {
      id: 'system-todos',
      role: 'system',
      content: 'Current todo list: (empty)',
      timestamp: Date.now(),
    },
  ];
}

const skill: Skill = {
  name: 'unit-test-skill',
  description: 'test',
  prompt: 'UNIQUE-SKILL-PROMPT',
  tools: [],
  enabled: false,
} as Skill;

describe('SkillManager message split', () => {
  it('writes active skill prompts to system-skills, never system-base', () => {
    const mgr = new SkillManager();
    const messages = makeMessages('BASE-PROMPT-TEXT');

    expect(mgr.load(skill, messages, false)).toBe(true);

    const base = messages.find((m) => m.id === 'system-base')!;
    expect(base.content).toBe('BASE-PROMPT-TEXT');
    const skillMsg = messages.find((m) => m.id === 'system-skills');
    expect(skillMsg).toBeDefined();
    expect(skillMsg!.content).toContain('UNIQUE-SKILL-PROMPT');
    expect(skillMsg!.content).toContain('## Active skill: unit-test-skill');
  });

  it('clears the skill message content on unload instead of deleting it', () => {
    const mgr = new SkillManager();
    const messages = makeMessages('BASE-PROMPT-TEXT');
    mgr.load(skill, messages, false);

    expect(mgr.unload('unit-test-skill', messages, false)).toBe(true);
    expect(messages.find((m) => m.id === 'system-skills')!.content).toBe('');
    expect(messages.find((m) => m.id === 'system-base')!.content).toBe('BASE-PROMPT-TEXT');
  });

  it('strips legacy in-place skill sections from system-base', () => {
    const mgr = new SkillManager();
    // Real layout: skill sections are always appended at the very end of
    // system-base (sync appends last, after Runtime / Sub-agents / MCP lines).
    const messages = makeMessages(
      'BASE-PROMPT-TEXT\n\n## Harness state\nrest\n\n## Active skill: old\nOLD-MARKER'
    );

    mgr.syncSkillMessages(messages, false);

    const base = messages.find((m) => m.id === 'system-base')!;
    expect(base.content).not.toContain('OLD-MARKER');
    expect(base.content).toContain('## Harness state');
  });

  it('keeps the session tool set grow-only across unload', () => {
    const mgr = new SkillManager();
    const messages = makeMessages('BASE');

    expect(mgr.toolSkillNames().has('unit-test-skill')).toBe(false);
    mgr.load(skill, messages, false);
    expect(mgr.toolSkillNames().has('unit-test-skill')).toBe(true);

    // Unloading deactivates the prompt but must NOT change the tools array
    // mid-session — shrinking it would re-prefill the whole cached prefix.
    mgr.unload('unit-test-skill', messages, false);
    expect(mgr.activeNames()).not.toContain('unit-test-skill');
    expect(mgr.toolSkillNames().has('unit-test-skill')).toBe(true);
  });

  it('seeding marks both active skills and the session tool set', () => {
    const mgr = new SkillManager();
    mgr.seed('unit-test-skill', skill);
    expect(mgr.activeNames()).toContain('unit-test-skill');
    expect(mgr.toolSkillNames().has('unit-test-skill')).toBe(true);
  });

  it('adopts a restored session prefix section back into the seeded home', () => {
    // --resume replaces agent.messages with the persisted history while the
    // manager starts fresh — the old in-prefix sections must be re-homed, not
    // stripped, so the resumed prompt keeps them byte-identical.
    const bundled = [...loadSkills().entries()].find(([, s]) => s.source === 'skilli.md');
    expect(bundled).toBeDefined();
    const [name, bundledSkill] = bundled!;
    const renderedPrompt = (bundledSkill.prompt || '').replace(/\bbash\b/g, 'execute_command');

    const mgr = new SkillManager();
    const messages = [
      {
        id: 'system-base',
        role: 'system' as const,
        content: `BASE\n\n## Active skill: ${name}\n${renderedPrompt}`,
        timestamp: Date.now(),
      },
      { id: 'system-todos', role: 'system' as const, content: 't', timestamp: Date.now() },
      { id: 'system-skills', role: 'system' as const, content: '', timestamp: Date.now() },
    ];

    mgr.syncSkillMessages(messages, false);

    expect(mgr.activeNames()).toContain(name);
    const base = messages.find((m) => m.id === 'system-base')!;
    expect(base.content).toContain(`## Active skill: ${name}`);
    // Steady state: a second sync produces byte-identical content (no write,
    // no prefix rewrite → cache keeps hitting).
    const afterFirst = base.content;
    mgr.syncSkillMessages(messages, false);
    expect(base.content).toBe(afterFirst);
  });

  it('adopts a restored session tail skill back into the mid-session home', () => {
    const bundled = [...loadSkills().entries()].find(([, s]) => s.source === 'skilli.md');
    expect(bundled).toBeDefined();
    const [name] = bundled!;

    const mgr = new SkillManager();
    const messages = [
      { id: 'system-base', role: 'system' as const, content: 'BASE', timestamp: Date.now() },
      { id: 'system-todos', role: 'system' as const, content: 't', timestamp: Date.now() },
      {
        id: 'system-skills',
        role: 'system' as const,
        content: `## Active skill: ${name}\nrestored prompt body`,
        timestamp: Date.now(),
      },
    ];

    mgr.syncSkillMessages(messages, false);

    expect(mgr.activeNames()).toContain(name);
    expect(mgr.toolSkillNames().has(name)).toBe(true);
    const tail = messages.find((m) => m.id === 'system-skills')!;
    expect(tail.content).toContain(`## Active skill: ${name}`);
    // Prefix untouched — adoption must not rewrite the leading prompt.
    expect(messages.find((m) => m.id === 'system-base')!.content).toBe('BASE');
  });
});
