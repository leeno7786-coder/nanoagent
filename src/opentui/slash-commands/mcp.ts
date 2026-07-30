import type { SlashCommandContext } from './types.js';
import { pushAssistant } from './utils.js';

export async function handleMcpCommand(args: string, ctx: SlashCommandContext): Promise<void> {
  const { agent } = ctx;
  const states = agent.mcpStates;
  const mgr = agent.mcpManager;
  if (!states || states.length === 0) {
    pushAssistant(
      agent,
      'No MCP servers configured. Add `mcp` to ~/.qwen-agent.json.\n\nExample:\n```json\n"mcp": {\n  "filesystem": {\n    "type": "local",\n    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]\n  },\n  "remote": {\n    "type": "remote",\n    "url": "https://mcp.example.com/sse"\n  }\n}\n```\n\nYou can also ask me to add an MCP server — just describe what you need and I\'ll use manage_mcp to configure it.',
      ctx.setMessages
    );
  } else {
    const connected = mgr?.connectedCount ?? 0;
    const totalTools = mgr?.totalTools ?? 0;
    const lines = [
      `## MCP Servers (${connected} connected, ${totalTools} tools)`,
      '',
      ...states.map((s) => {
        const icon = s.status === 'connected' ? '+' : s.status === 'error' ? '!' : '-';
        const info = s.serverInfo
          ? ` (${s.serverInfo.name}${s.serverInfo.version ? ` v${s.serverInfo.version}` : ''})`
          : '';
        const err = s.error ? ` - ${s.error}` : '';
        return `- [${icon}] ${s.name}${info}: ${s.status}, ${s.toolCount} tools${err}`;
      }),
      '',
      'Commands: `/mcp-add`, `/mcp-remove`, or ask me to manage MCP servers.',
    ];
    pushAssistant(agent, lines.join('\n'), ctx.setMessages);
  }
}

export async function handleMcpAddCommand(args: string, ctx: SlashCommandContext): Promise<void> {
  const { agent } = ctx;
  if (!args) {
    pushAssistant(
      agent,
      'Usage: `/mcp-add <name> <type> <connection>`\n\nExamples:\n- `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /home/user/docs`\n- `/mcp-add github remote https://mcp.github.com/sse`\n\nOr just ask me in natural language: "Add an MCP server for reading files in /tmp"',
      ctx.setMessages
    );
    return;
  }
  const parts = args.split(/\s+/);
  const name = parts[0];
  const type = parts[1];
  if (type === 'local') {
    const cmdParts = parts.slice(2);
    if (cmdParts.length === 0) {
      pushAssistant(
        agent,
        'Local servers need a command. Example: `/mcp-add filesystem local npx -y @modelcontextprotocol/server-filesystem /path`',
        ctx.setMessages
      );
      return;
    }
    const result = await agent.executeToolDirect('manage_mcp', {
      action: 'add',
      name,
      type: 'local',
      command: cmdParts,
    });
    pushAssistant(agent, result ?? 'Added. Restart to connect.', ctx.setMessages);
  } else if (type === 'remote') {
    const url = parts[2];
    if (!url) {
      pushAssistant(
        agent,
        'Remote servers need a URL. Example: `/mcp-add api remote https://mcp.example.com/sse`',
        ctx.setMessages
      );
      return;
    }
    const result = await agent.executeToolDirect('manage_mcp', {
      action: 'add',
      name,
      type: 'remote',
      url,
    });
    pushAssistant(agent, result ?? 'Added. Restart to connect.', ctx.setMessages);
  } else {
    pushAssistant(
      agent,
      "Type must be 'local' or 'remote'. Example: `/mcp-add filesystem local npx -y ...`",
      ctx.setMessages
    );
  }
}

export async function handleMcpRemoveCommand(
  args: string,
  ctx: SlashCommandContext
): Promise<void> {
  const { agent } = ctx;
  if (!args) {
    pushAssistant(
      agent,
      'Usage: `/mcp-remove <server-name>` — e.g. `/mcp-remove filesystem`',
      ctx.setMessages
    );
    return;
  }
  const result = await agent.executeToolDirect('manage_mcp', {
    action: 'remove',
    name: args.trim(),
  });
  pushAssistant(agent, result ?? 'Removed. Restart to apply.', ctx.setMessages);
}
