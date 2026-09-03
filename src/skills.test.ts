/**
 * Unit tests for skills.ts - Skill management
 * Covers: skill loading, matching, triggering
 */

import { describe, it, expect } from 'bun:test';
import {
  loadSkills,
  matchSkillTriggers,
  loadTemplates,
  getSkillCommands,
  getSkillNames,
} from './skills.js';

describe('skills.ts - Skill Management', () => {
  describe('loadSkills', () => {
    it('should return a Map', () => {
      const skills = loadSkills();
      expect(skills instanceof Map).toBe(true);
    });

    it('should load built-in skills', () => {
      const skills = loadSkills();
      expect(skills.size).toBeGreaterThan(0);
    });

    it('should have skill names', () => {
      const names = getSkillNames();
      expect(names.length).toBeGreaterThan(0);
    });
  });

  describe('matchSkillTriggers', () => {
    it('should match exact triggers', () => {
      const skills = new Map([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['test-skill', { name: 'test-skill', triggers: ['test-trigger'], content: 'test' } as any],
      ]);
      const matched = matchSkillTriggers('test-trigger', skills);
      expect(matched.length).toBe(1);
      expect(matched[0].name).toBe('test-skill');
    });

    it('should return empty array for no matches', () => {
      const skills = new Map();
      const matched = matchSkillTriggers('nonexistent', skills);
      expect(matched).toEqual([]);
    });

    it('should match partial triggers', () => {
      const skills = new Map([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['test-skill', { name: 'test-skill', triggers: ['prefix-test'], content: 'test' } as any],
      ]);
      const matched = matchSkillTriggers('prefix-test', skills);
      expect(matched.length).toBe(1);
    });

    it('matches multi-word triggers order-independently (all words present)', () => {
      const skills = new Map([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['fd', { name: 'fd', triggers: ['frontend design'] } as any],
      ]);
      expect(matchSkillTriggers('design a frontend for my app', skills).length).toBe(1);
      expect(matchSkillTriggers('I need a frontend design', skills).length).toBe(1);
      // missing one of the words -> no match
      expect(matchSkillTriggers('design a poster', skills).length).toBe(0);
    });

    it('single-word triggers require a word boundary (no substring false positives)', () => {
      const skills = new Map([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['api', { name: 'api', triggers: ['api'] } as any],
      ]);
      expect(matchSkillTriggers('build an api endpoint', skills).length).toBe(1);
      // 'capitalize' contains 'api' but not as a word
      expect(matchSkillTriggers('capitalize the first letter', skills).length).toBe(0);
    });

    it('ignores words of 2 chars or less inside trigger phrases', () => {
      const skills = new Map([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['ui', { name: 'ui', triggers: ['ui design'] } as any],
      ]);
      // 'ui' is dropped (too short); 'design' must match as a word
      expect(matchSkillTriggers('design a poster', skills).length).toBe(1);
      expect(matchSkillTriggers('redesign', skills).length).toBe(0);
    });

    it('skips already-enabled skills', () => {
      const skills = new Map([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['on', { name: 'on', triggers: ['deploy'], enabled: true } as any],
      ]);
      expect(matchSkillTriggers('deploy the app', skills).length).toBe(0);
    });
  });

  describe('loadTemplates', () => {
    it('should return a Map', () => {
      const templates = loadTemplates();
      expect(templates instanceof Map).toBe(true);
    });
  });

  describe('getSkillCommands', () => {
    it('should return array of commands', () => {
      const skills = new Map([
        [
          'test-skill',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { name: 'test-skill', triggers: ['trigger1'], content: 'test', enabled: true } as any,
        ],
      ]);
      const commands = getSkillCommands(skills);
      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBeGreaterThan(0);
    });

    it('should return empty array for empty skills', () => {
      const commands = getSkillCommands(new Map());
      expect(commands).toEqual([]);
    });

    it('should exclude disabled skills', () => {
      const skills = new Map([
        [
          'test-skill',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { name: 'test-skill', triggers: ['trigger1'], content: 'test', enabled: false } as any,
        ],
      ]);
      const commands = getSkillCommands(skills);
      expect(commands).toEqual([]);
    });

    it('should include disabled skills when includeDisabled is true', () => {
      const skills = new Map([
        [
          'a-disabled',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { name: 'a-disabled', triggers: [], content: 'x', enabled: false } as any,
        ],
        [
          'b-enabled',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { name: 'b-enabled', triggers: [], content: 'y', enabled: true } as any,
        ],
      ]);
      const commands = getSkillCommands(skills, { includeDisabled: true });
      expect(commands).toHaveLength(2);
      const names = commands.map((c) => c.name).sort();
      expect(names).toEqual(['/skill:a-disabled', '/skill:b-enabled']);
      // Enabled entries surface before disabled ones.
      expect(commands[0].name).toBe('/skill:b-enabled');
      expect(commands[0].enabled).toBe(true);
      expect(commands[1].enabled).toBe(false);
    });
  });

  describe('getSkillNames', () => {
    it('should return array of skill names', () => {
      const names = getSkillNames();
      expect(Array.isArray(names)).toBe(true);
      expect(names.length).toBeGreaterThan(0);
    });
  });
});
