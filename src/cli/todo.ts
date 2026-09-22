import { printRootHelp } from './help.js';

/**
 * CLI command: todo
 * Manage your todo list from the command line.
 *
 * Usage:
 *   nanogent todo                    — list all todos
 *   nanogent todo add "Buy milk"     — add a todo
 *   nanogent todo done <id>          — mark a todo as done
 *   nanogent todo delete <id>        — delete a todo
 *   nanogent todo clear              — clear all completed todos
 *   nanogent todo clear-all          — clear all todos
 */

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TODO_FILE, nanoagentPaths } from '../config/paths.js';

/** Lazy accessor: resolves against the current NANOAGENT_ROOT at call time. */
export function TODO_STORAGE_PATH(): string {
  return TODO_FILE();
}

function storagePath(): string {
  return TODO_STORAGE_PATH();
}

function loadTodos(): TodoItem[] {
  try {
    const path = storagePath();
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf-8');
    if (!content.trim()) return [];
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (todo): todo is TodoItem =>
        !!todo &&
        typeof todo === 'object' &&
        typeof (todo as TodoItem).id === 'string' &&
        typeof (todo as TodoItem).text === 'string' &&
        typeof (todo as TodoItem).done === 'boolean' &&
        typeof (todo as TodoItem).createdAt === 'number'
    );
  } catch {
    return [];
  }
}

function saveTodos(todos: TodoItem[]): boolean {
  try {
    const path = storagePath();
    const dir = nanoagentPaths().configDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(todos, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function findTodoByPrefix(
  todos: TodoItem[],
  id: string
): { todo: TodoItem } | { error: string } | undefined {
  const matches = todos.filter((todo) => todo.id.startsWith(id));
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    return { error: `todo prefix "${id}" is ambiguous; use more characters` };
  }
  return { todo: matches[0]! };
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function cmdTodo(argv: string[]): Promise<number> {
  const [subcommand, ...args] = argv;
  const todos = loadTodos();

  switch (subcommand) {
    case 'add': {
      const text = args.join(' ').trim();
      if (!text) {
        console.error('Error: todo text is required. Usage: todo add <text>');
        return 1;
      }
      const newTodo: TodoItem = {
        id: generateId(),
        text,
        done: false,
        createdAt: Date.now(),
      };
      todos.unshift(newTodo);
      if (!saveTodos(todos)) {
        console.error(
          'Error: could not persist todos. Check the NanoAgent config directory permissions.'
        );
        return 1;
      }
      console.log(`Added: ${newTodo.id.slice(0, 8)} ${text}`);
      return 0;
    }

    case 'done': {
      const id = args[0];
      if (!id) {
        console.error('Error: todo id is required. Usage: todo done <id>');
        return 1;
      }
      const match = findTodoByPrefix(todos, id);
      if (!match) {
        console.error(`Error: todo "${id}" not found.`);
        return 1;
      }
      if ('error' in match) {
        console.error(`Error: ${match.error}`);
        return 1;
      }
      const todo = match.todo;
      todo.done = true;
      if (!saveTodos(todos)) {
        console.error(
          'Error: could not persist todos. Check the NanoAgent config directory permissions.'
        );
        return 1;
      }
      console.log(`Done: ${todo.text}`);
      return 0;
    }

    case 'delete': {
      const id = args[0];
      if (!id) {
        console.error('Error: todo id is required. Usage: todo delete <id>');
        return 1;
      }
      const before = todos.length;
      const match = findTodoByPrefix(todos, id);
      if (!match) {
        console.error(`Error: todo "${id}" not found.`);
        return 1;
      }
      if ('error' in match) {
        console.error(`Error: ${match.error}`);
        return 1;
      }
      const filtered = todos.filter((t) => t.id !== match.todo.id);
      if (filtered.length === before) return 1;
      if (!saveTodos(filtered)) {
        console.error(
          'Error: could not persist todos. Check the NanoAgent config directory permissions.'
        );
        return 1;
      }
      console.log(`Deleted todo "${id}".`);
      return 0;
    }

    case 'clear': {
      const cleared = todos.filter((t) => t.done);
      const remaining = todos.filter((t) => !t.done);
      if (!saveTodos(remaining)) {
        console.error(
          'Error: could not persist todos. Check the NanoAgent config directory permissions.'
        );
        return 1;
      }
      console.log(`Cleared ${cleared.length} completed todo(s).`);
      return 0;
    }

    case 'clear-all': {
      if (!saveTodos([])) {
        console.error(
          'Error: could not persist todos. Check the NanoAgent config directory permissions.'
        );
        return 1;
      }
      console.log('Cleared all todos.');
      return 0;
    }

    case 'list':
    case undefined: {
      if (todos.length === 0) {
        console.log('No todos. Use `todo add <text>` to add one.');
        return 0;
      }
      const active = todos.filter((t) => !t.done);
      const done = todos.filter((t) => t.done);
      console.log(`\nTodos (${active.length} active, ${done.length} done):\n`);
      for (const t of todos) {
        const mark = t.done ? '✓' : ' ';
        console.log(`  [${mark}] ${t.id.slice(0, 8)} ${t.text}`);
      }
      console.log();
      return 0;
    }

    default:
      console.error(`Error: unknown todo subcommand "${subcommand}"`);
      printRootHelp();
      return 1;
  }
}
