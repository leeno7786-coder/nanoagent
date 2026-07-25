/**
 * Permission levels system for tools and command execution.
 * Replaces pure block lists with granular permission categories and modes.
 */

export type PermissionMode = 'read_only' | 'ask' | 'allow_edits' | 'always_allow';

export type PermissionLevel = 'allow' | 'ask' | 'deny';

export type ToolCategory = 'read' | 'write' | 'command';

export interface PermissionCheckResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  level: PermissionLevel;
  category: ToolCategory;
  tool: string;
  command?: string;
  reason?: string;
}

export interface PermissionRequest {
  id: string;
  tool: string;
  category: ToolCategory;
  command?: string;
  args?: Record<string, unknown>;
}

export interface PermissionConfig {
  mode: PermissionMode;
  rules: Record<string, PermissionLevel>;
}

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'edit_file_lines',
  'multi_replace_file_content',
  'replace_file_content',
  'create_new_skill',
  'manage_todos',
  'build_memory_graph',
]);

const COMMAND_TOOLS = new Set([
  'execute_command',
  'run_tests',
  'install_dependencies',
  'run_command',
  'typecheck',
  'git_commit',
  'git_push',
  'git_pull',
  'git_add',
  'git_reset',
  'git_checkout',
  'change_workspace',
]);

export class PermissionManager {
  private mode: PermissionMode = 'ask';
  private rules: Map<string, PermissionLevel> = new Map();

  constructor(config?: Partial<PermissionConfig>) {
    if (config?.mode) this.mode = config.mode;
    if (config?.rules) {
      for (const [key, val] of Object.entries(config.rules)) {
        this.rules.set(key.toLowerCase(), val);
      }
    }
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setRule(target: string, level: PermissionLevel): void {
    this.rules.set(target.toLowerCase(), level);
  }

  getRule(target: string): PermissionLevel | undefined {
    return this.rules.get(target.toLowerCase());
  }

  removeRule(target: string): boolean {
    return this.rules.delete(target.toLowerCase());
  }

  clearRules(): void {
    this.rules.clear();
  }

  getRules(): Record<string, PermissionLevel> {
    const res: Record<string, PermissionLevel> = {};
    for (const [k, v] of this.rules.entries()) {
      res[k] = v;
    }
    return res;
  }

  getCategory(toolName: string): ToolCategory {
    const name = toolName.toLowerCase();
    // MCP tools are provided by external servers and can do anything —
    // never auto-allow them; route through the command (confirmation) path.
    if (name.startsWith('mcp_')) return 'command';
    if (WRITE_TOOLS.has(name)) return 'write';
    if (COMMAND_TOOLS.has(name)) return 'command';
    return 'read';
  }

  checkPermission(toolName: string, args?: Record<string, unknown>): PermissionCheckResult {
    const category = this.getCategory(toolName);
    let commandStr: string | undefined;

    if (toolName === 'execute_command' && args?.command) {
      commandStr = String(args.command).trim();
    } else if (toolName === 'run_command' && args?.command) {
      commandStr = String(args.command).trim();
    }

    // 1. Check explicit rule for exact command string
    if (commandStr) {
      const cmdRule = this.rules.get(commandStr.toLowerCase());
      if (cmdRule) {
        return {
          allowed: cmdRule === 'allow',
          requiresConfirmation: cmdRule === 'ask',
          level: cmdRule,
          category,
          tool: toolName,
          command: commandStr,
          reason: `Explicit rule for command "${commandStr}"`,
        };
      }
    }

    // 2. Check explicit rule for tool name
    const toolRule = this.rules.get(toolName.toLowerCase());
    if (toolRule) {
      return {
        allowed: toolRule === 'allow',
        requiresConfirmation: toolRule === 'ask',
        level: toolRule,
        category,
        tool: toolName,
        command: commandStr,
        reason: `Explicit rule for tool "${toolName}"`,
      };
    }

    // 3. Fallback to mode policies
    let level: PermissionLevel = 'allow';

    if (category === 'read') {
      level = 'allow';
    } else if (category === 'write') {
      if (this.mode === 'read_only') {
        level = 'deny';
      } else if (this.mode === 'allow_edits' || this.mode === 'always_allow') {
        level = 'allow';
      } else {
        level = 'ask';
      }
    } else if (category === 'command') {
      if (this.mode === 'read_only') {
        level = 'deny';
      } else if (this.mode === 'always_allow') {
        level = 'allow';
      } else {
        level = 'ask';
      }
    }

    return {
      allowed: level === 'allow',
      requiresConfirmation: level === 'ask',
      level,
      category,
      tool: toolName,
      command: commandStr,
      reason: `Default mode (${this.mode}) for category (${category})`,
    };
  }
}
