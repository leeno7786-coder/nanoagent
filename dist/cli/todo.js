import { printRootHelp } from './help.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const STORAGE_FILE_PATH = fileURLToPath(new URL('.todos.json', import.meta.url));
function loadTodos() {
    try {
        if (!existsSync(STORAGE_FILE_PATH))
            return [];
        const content = readFileSync(STORAGE_FILE_PATH, 'utf-8');
        if (!content.trim())
            return [];
        return JSON.parse(content);
    }
    catch {
        return [];
    }
}
function saveTodos(todos) {
    try {
        writeFileSync(STORAGE_FILE_PATH, JSON.stringify(todos, null, 2), 'utf-8');
    }
    catch {
        /* ignore */
    }
}
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export async function cmdTodo(argv) {
    const [subcommand, ...args] = argv;
    const todos = loadTodos();
    switch (subcommand) {
        case 'add': {
            const text = args.join(' ').trim();
            if (!text) {
                console.error('Error: todo text is required. Usage: todo add <text>');
                return 1;
            }
            const newTodo = {
                id: generateId(),
                text,
                done: false,
                createdAt: Date.now(),
            };
            todos.unshift(newTodo);
            saveTodos(todos);
            console.log(`Added: ${newTodo.id.slice(0, 8)} ${text}`);
            return 0;
        }
        case 'done': {
            const id = args[0];
            if (!id) {
                console.error('Error: todo id is required. Usage: todo done <id>');
                return 1;
            }
            const todo = todos.find((t) => t.id.startsWith(id));
            if (!todo) {
                console.error(`Error: todo "${id}" not found.`);
                return 1;
            }
            todo.done = true;
            saveTodos(todos);
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
            const filtered = todos.filter((t) => !t.id.startsWith(id));
            if (filtered.length === before) {
                console.error(`Error: todo "${id}" not found.`);
                return 1;
            }
            saveTodos(filtered);
            console.log(`Deleted todo "${id}".`);
            return 0;
        }
        case 'clear': {
            const cleared = todos.filter((t) => t.done);
            const remaining = todos.filter((t) => !t.done);
            saveTodos(remaining);
            console.log(`Cleared ${cleared.length} completed todo(s).`);
            return 0;
        }
        case 'clear-all': {
            saveTodos([]);
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
