import { describe, it, expect, beforeEach } from 'bun:test';
import { PermissionManager } from './permissions';

describe('PermissionManager', () => {
  let pm: PermissionManager;

  beforeEach(() => {
    pm = new PermissionManager();
  });

  it('should default to "ask" mode', () => {
    expect(pm.getMode()).toBe('ask');
  });

  it('should allow read tools by default in ask mode', () => {
    const readTools = ['read_file', 'batch_read_files', 'list_dir', 'grep_search', 'find_files'];
    for (const tool of readTools) {
      const res = pm.checkPermission(tool);
      expect(res.category).toBe('read');
      expect(res.level).toBe('allow');
      expect(res.allowed).toBe(true);
      expect(res.requiresConfirmation).toBe(false);
    }
  });

  it('should require confirmation (ask) for write tools and commands by default', () => {
    const writeRes = pm.checkPermission('write_file');
    expect(writeRes.category).toBe('write');
    expect(writeRes.level).toBe('ask');
    expect(writeRes.requiresConfirmation).toBe(true);

    const cmdRes = pm.checkPermission('execute_command', { command: 'bun test' });
    expect(cmdRes.category).toBe('command');
    expect(cmdRes.level).toBe('ask');
    expect(cmdRes.requiresConfirmation).toBe(true);
  });

  it('should enforce "read_only" mode policies', () => {
    pm.setMode('read_only');

    expect(pm.checkPermission('read_file').level).toBe('allow');
    expect(pm.checkPermission('write_file').level).toBe('deny');
    expect(pm.checkPermission('execute_command', { command: 'ls' }).level).toBe('deny');
  });

  it('should enforce "allow_edits" mode policies', () => {
    pm.setMode('allow_edits');

    expect(pm.checkPermission('read_file').level).toBe('allow');
    expect(pm.checkPermission('write_file').level).toBe('allow');
    expect(pm.checkPermission('edit_file').level).toBe('allow');
    expect(pm.checkPermission('execute_command', { command: 'npm test' }).level).toBe('ask');
  });

  it('should enforce "always_allow" mode policies', () => {
    pm.setMode('always_allow');

    expect(pm.checkPermission('read_file').level).toBe('allow');
    expect(pm.checkPermission('write_file').level).toBe('allow');
    expect(pm.checkPermission('execute_command', { command: 'rm -rf ./temp' }).level).toBe('allow');
  });

  it('should respect custom tool and command rules', () => {
    pm.setRule('execute_command', 'allow');
    pm.setRule('write_file', 'deny');
    pm.setRule('bun test', 'allow');

    expect(pm.checkPermission('execute_command', { command: 'dir' }).level).toBe('allow');
    expect(pm.checkPermission('write_file').level).toBe('deny');
    expect(pm.checkPermission('execute_command', { command: 'bun test' }).level).toBe('allow');

    expect(pm.getRules()).toEqual({
      execute_command: 'allow',
      write_file: 'deny',
      'bun test': 'allow',
    });
  });

  it('should allow clearing and removing custom rules', () => {
    pm.setRule('write_file', 'allow');
    expect(pm.getRule('write_file')).toBe('allow');

    pm.removeRule('write_file');
    expect(pm.getRule('write_file')).toBeUndefined();

    pm.setRule('execute_command', 'allow');
    pm.clearRules();
    expect(Object.keys(pm.getRules()).length).toBe(0);
  });
});
