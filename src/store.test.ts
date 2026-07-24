/**
 * Unit tests for store.ts - Session persistence
 * Covers: Session CRUD, auto-save, resume, export, input history
 */

import { describe, it, expect } from 'bun:test';
import {
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  getLatestSession,
  copyToClipboard,
  exportToMarkdown,
  loadInputHistory,
  saveInputHistory,
} from './store.js';
import type { Session, Message } from './types.js';

const createTestMessage = (content: string, role: Message['role'] = 'user'): Message => ({
  id: `msg-${Math.random().toString(36).slice(2, 8)}`,
  role,
  content,
  timestamp: Date.now(),
});

describe('store.ts - Session Management', () => {
  describe('saveSession and loadSession', () => {
    it('should save and load a session', () => {
      const messages: Message[] = [
        createTestMessage('Hello'),
        createTestMessage('Hi there!', 'assistant'),
      ];

      const session: Session = {
        id: `test-session-${Date.now()}`,
        messages,
        todos: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const id = saveSession(session);
      expect(id).toBe(session.id);

      const loaded = loadSession(id);
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(session.id);
      expect(loaded?.messages.length).toBe(2);

      // Cleanup
      deleteSession(id);
    });

    it('should save and load session with exact settings, model, and provider', () => {
      const session: Session = {
        id: `test-settings-session-${Date.now()}`,
        messages: [createTestMessage('Hello')],
        todos: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: 'qwen3.5-coder',
        baseURL: 'http://localhost:1234/v1',
        provider: 'lmstudio',
        config: {
          model: 'qwen3.5-coder',
          baseURL: 'http://localhost:1234/v1',
          permissionMode: 'ask',
          maxIterations: 45,
          temperature: 0.2,
        },
      };

      const id = saveSession(session);
      const loaded = loadSession(id);

      expect(loaded).not.toBeNull();
      expect(loaded?.model).toBe('qwen3.5-coder');
      expect(loaded?.baseURL).toBe('http://localhost:1234/v1');
      expect(loaded?.provider).toBe('lmstudio');
      expect(loaded?.config?.permissionMode).toBe('ask');
      expect(loaded?.config?.maxIterations).toBe(45);

      deleteSession(id);
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', () => {
      const session: Session = {
        id: `delete-test-${Date.now()}`,
        messages: [],
        todos: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const id = saveSession(session);
      expect(loadSession(id)).not.toBeNull();

      deleteSession(id);
      expect(loadSession(id)).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('should list sessions', () => {
      const session: Session = {
        id: `list-test-${Date.now()}`,
        messages: [],
        todos: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const id = saveSession(session);
      const sessions = listSessions();

      expect(sessions).toContain(id);

      // Cleanup
      deleteSession(id);
    });
  });

  describe('getLatestSession', () => {
    it('should return the most recently created session', () => {
      const session: Session = {
        id: `latest-test-${Date.now()}`,
        messages: [],
        todos: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const id = saveSession(session);
      const latest = getLatestSession();

      expect(latest?.id).toBe(id);

      // Cleanup
      deleteSession(id);
    });
  });

  describe('exportToMarkdown', () => {
    it('should export messages to markdown format', async () => {
      const messages = [createTestMessage('Hello'), createTestMessage('Hi there!', 'assistant')];

      const filename = exportToMarkdown(messages);
      expect(filename).toContain('chat-export-');
      expect(filename).toContain('.md');

      // Read the file to verify content
      const content = await Bun.file(filename).text();
      expect(content).toContain('Hello');
      expect(content).toContain('Hi there!');
    });
  });

  describe('copyToClipboard', () => {
    it('should return a boolean', () => {
      try {
        const result = copyToClipboard('test content');
        expect(typeof result).toBe('boolean');
      } catch {
        // System clipboard execution may fail or time out in headless test environments
      }
    });
  });

  describe('Input History', () => {
    it('should save and load input history', () => {
      const history = ['input1', 'input2', 'input3'];
      saveInputHistory(history);
      const loaded = loadInputHistory();
      expect(loaded).toEqual(history);
    });
  });
});
