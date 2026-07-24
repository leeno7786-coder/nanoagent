export const NANOAGENT_BANNER = `
  _  _                 _                    _   
 | \\| |__ _ _ _  ___  /_\\  __ _ ___ _ _ | |_ 
 | .\` / _\` | ' \\/ _ \\/ _ \\/ _\` / -_) ' \\|  _|
 |_|\\_\\__,_|_||_\\___/_/ \\_\\__, \\___|_||_\\__|
                          |___/              
      ⚡ NanoAgent — Tiny Models, Scalable Intelligence ⚡
`;

export function printRootHelp(): void {
  console.log(`${NANOAGENT_BANNER}
Usage:
  nanogent <command> [options]

Commands:
  run       Run one task headlessly (for scripts and agents)
  models    List models from a local runtime (LM Studio)
  doctor    Check config and runtime connectivity
  todo      Manage your todo list
  tui       Interactive terminal UI (default)

Options:
  -h, --help    Show help

Examples:
  nanogent tui
  nanogent run --prompt "summarize package.json"
  echo "list src files" | nanogent run --stdin --workspace .
  nanogent models --base-url http://127.0.0.1:1234/v1
  nanogent doctor --json
  nanogent todo add "Buy milk"
  nanogent todo list
`);
}

export function printRunHelp(): void {
  console.log(`Usage:
  nanogent run [options]

Options:
  -p, --prompt <text>       Task prompt (required unless --stdin)
      --stdin                 Read prompt from stdin
  -w, --workspace <path>    Working directory (default: cwd)
  -m, --model <id>          Model id
      --base-url <url>        API base URL (default: from config)
      --max-rounds <n>        Max agent rounds per invocation (default: 30)
      --max-iterations <n>    Max tool loops per round (default: from config)
      --json                  JSON output on stdout
      --quiet                 Only print the final assistant message
      --verbose               Log tool calls to stderr
  -h, --help                  Show help

Examples:
  nanogent run --prompt "run tests and fix failures" --workspace .
  nanogent run -p "what does agent.ts do?" -w ./src --quiet
  cat task.txt | nanogent run --stdin --workspace /repo
  nanogent run --prompt "status" --json --model qwen3-8b
`);
}

export function printModelsHelp(): void {
  console.log(`Usage:
  nanogent models [options]

Options:
      --base-url <url>    Runtime URL (default: from config)
      --json              JSON array on stdout
  -h, --help              Show help

Examples:
  nanogent models
  nanogent models --base-url http://127.0.0.1:1234/v1 --json
`);
}

export function printDoctorHelp(): void {
  console.log(`Usage:
  nanogent doctor [options]

Options:
      --json              JSON report on stdout
  -h, --help              Show help

Examples:
  nanogent doctor
  nanogent doctor --json
`);
}

export function printTuiHelp(): void {
  console.log(`Usage:
  nanogent tui

Launches the full-screen OpenTUI interface.

Examples:
  nanogent
  nanogent tui
`);
}

export function cliError(message: string, hint?: string): never {
  console.error(`Error: ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}
