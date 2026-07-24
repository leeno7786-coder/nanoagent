import { printRootHelp } from './help.js';
import { cmdRun } from './run.js';
import { cmdModels } from './models.js';
import { cmdDoctor } from './doctor.js';
import { cmdTodo } from './todo.js';
export async function runCli(argv) {
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
        printRootHelp();
        return 0;
    }
    switch (cmd) {
        case 'run':
            return cmdRun(rest);
        case 'models':
            return cmdModels(rest);
        case 'doctor':
            return cmdDoctor(rest);
        case 'todo':
            return cmdTodo(rest);
        case 'tui':
            return 0; // handled by main before dispatch
        default:
            console.error(`Error: unknown command "${cmd}"\n`);
            printRootHelp();
            return 1;
    }
}
