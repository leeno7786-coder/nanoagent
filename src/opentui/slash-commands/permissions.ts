import type { SlashCommandContext } from './types.js';
import { pushAssistant } from './utils.js';

export async function handlePermissionsCommand(args: string, ctx: SlashCommandContext): Promise<void> {
  const { agent } = ctx;
  const pm = agent.securityManager.permissionManager;
  const trimmedArgs = args ? args.trim() : '';

  if (!trimmedArgs) {
    const mode = pm.getMode();
    const rules = pm.getRules();
    const ruleEntries = Object.entries(rules);
    const rulesText =
      ruleEntries.length > 0
        ? ruleEntries.map(([t, l]) => `- \`${t}\`: ${l}`).join('\n')
        : 'None';

    pushAssistant(
      agent,
      `## Tool & Command Permissions\n\n` +
        `- **Current Global Mode**: \`${mode}\`\n` +
        `- **Category Defaults**:\n` +
        `  - Read tools (read_file, list_dir, grep_search, etc.): ALWAYS ALLOWED\n` +
        `  - Write tools (write_file, edit_file, etc.): ${
          mode === 'read_only'
            ? 'DENIED'
            : mode === 'allow_edits' || mode === 'always_allow'
              ? 'ALLOWED'
              : 'ASK'
        }\n` +
        `  - Commands (execute_command, run_tests, etc.): ${
          mode === 'read_only' ? 'DENIED' : mode === 'always_allow' ? 'ALLOWED' : 'ASK'
        }\n\n` +
        `### Custom Rules\n${rulesText}\n\n` +
        `### Commands\n` +
        `- Set Mode: \`/permissions read_only\` | \`/permissions ask\` | \`/permissions allow_edits\` | \`/permissions always_allow\`\n` +
        `- Set Rule: \`/permissions <allow|ask|deny> <tool_or_command>\` (e.g. \`/permissions allow execute_command\`)\n` +
        `- Reset Rules: \`/permissions reset\``,
      ctx.setMessages
    );
    return;
  }

  const parts = trimmedArgs.split(/\s+/);
  const sub = parts[0].toLowerCase();
  const target = parts.slice(1).join(' ').trim();

  if (sub === 'read_only' || sub === 'readonly') {
    pm.setMode('read_only');
    pushAssistant(
      agent,
      'Permission mode set to **read_only**. Write tools and command execution are now blocked.',
      ctx.setMessages
    );
  } else if (sub === 'ask') {
    if (target) {
      pm.setRule(target, 'ask');
      pushAssistant(agent, `Permission rule for \`${target}\` set to **ask**.`, ctx.setMessages);
    } else {
      pm.setMode('ask');
      pushAssistant(
        agent,
        'Permission mode set to **ask**. Write tools and commands will ask for confirmation.',
        ctx.setMessages
      );
    }
  } else if (sub === 'allow_edits' || sub === 'allowedits') {
    pm.setMode('allow_edits');
    pushAssistant(
      agent,
      'Permission mode set to **allow_edits**. Read and write tools are allowed; commands will ask for confirmation.',
      ctx.setMessages
    );
  } else if (sub === 'always_allow' || sub === 'alwaysallow') {
    pm.setMode('always_allow');
    pushAssistant(
      agent,
      'Permission mode set to **always_allow**. All read, write, and command operations are auto-allowed.',
      ctx.setMessages
    );
  } else if (sub === 'allow') {
    if (!target) {
      pushAssistant(agent, 'Usage: `/permissions allow <tool_or_command>`', ctx.setMessages);
    } else {
      pm.setRule(target, 'allow');
      pushAssistant(
        agent,
        `Permission rule for \`${target}\` set to **allow** (auto-approved).`,
        ctx.setMessages
      );
    }
  } else if (sub === 'deny') {
    if (!target) {
      pushAssistant(agent, 'Usage: `/permissions deny <tool_or_command>`', ctx.setMessages);
    } else {
      pm.setRule(target, 'deny');
      pushAssistant(
        agent,
        `Permission rule for \`${target}\` set to **deny** (blocked).`,
        ctx.setMessages
      );
    }
  } else if (sub === 'reset') {
    pm.setMode('ask');
    pm.clearRules();
    pushAssistant(
      agent,
      'Permission mode reset to **ask** and all custom rules cleared.',
      ctx.setMessages
    );
  } else {
    pushAssistant(
      agent,
      `Unknown permission mode/command: \`${sub}\`. Options: read_only, ask, allow_edits, always_allow, allow <target>, deny <target>, reset`,
      ctx.setMessages
    );
  }
}
