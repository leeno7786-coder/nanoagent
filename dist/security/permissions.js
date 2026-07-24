/**
 * Permission levels system for tools and command execution.
 * Replaces pure block lists with granular permission categories and modes.
 */
const READ_TOOLS = new Set([
    'read_file',
    'batch_read_files',
    'list_dir',
    'grep_search',
    'find_files',
    'search_and_view',
    'map_project_tree',
    'stat_path',
    'git_status',
    'git_diff',
    'git_log',
    'git_show',
    'git_branch',
    'manage_todos',
    'explore_subagent',
    'read_resource',
    'list_permissions',
    'list_resources',
]);
const WRITE_TOOLS = new Set([
    'write_file',
    'edit_file',
    'edit_file_lines',
    'multi_replace_file_content',
    'replace_file_content',
    'create_new_skill',
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
]);
export class PermissionManager {
    mode = 'ask';
    rules = new Map();
    constructor(config) {
        if (config?.mode)
            this.mode = config.mode;
        if (config?.rules) {
            for (const [key, val] of Object.entries(config.rules)) {
                this.rules.set(key.toLowerCase(), val);
            }
        }
    }
    setMode(mode) {
        this.mode = mode;
    }
    getMode() {
        return this.mode;
    }
    setRule(target, level) {
        this.rules.set(target.toLowerCase(), level);
    }
    getRule(target) {
        return this.rules.get(target.toLowerCase());
    }
    removeRule(target) {
        return this.rules.delete(target.toLowerCase());
    }
    clearRules() {
        this.rules.clear();
    }
    getRules() {
        const res = {};
        for (const [k, v] of this.rules.entries()) {
            res[k] = v;
        }
        return res;
    }
    getCategory(toolName) {
        const name = toolName.toLowerCase();
        if (WRITE_TOOLS.has(name))
            return 'write';
        if (COMMAND_TOOLS.has(name))
            return 'command';
        return 'read';
    }
    checkPermission(toolName, args) {
        const category = this.getCategory(toolName);
        let commandStr;
        if (toolName === 'execute_command' && args?.command) {
            commandStr = String(args.command).trim();
        }
        else if (toolName === 'run_command' && args?.command) {
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
        let level = 'allow';
        if (category === 'read') {
            level = 'allow';
        }
        else if (category === 'write') {
            if (this.mode === 'read_only') {
                level = 'deny';
            }
            else if (this.mode === 'allow_edits' || this.mode === 'always_allow') {
                level = 'allow';
            }
            else {
                level = 'ask';
            }
        }
        else if (category === 'command') {
            if (this.mode === 'read_only') {
                level = 'deny';
            }
            else if (this.mode === 'always_allow') {
                level = 'allow';
            }
            else {
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
