import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type {
  McpServerConfig,
  McpServerState,
  McpLocalServerConfig,
  McpRemoteServerConfig,
} from '../types.js';
import type { Tool } from '../tools/index.js';
import { readFileSync } from 'fs';
import { resolve, normalize } from 'path';

/**
 * Interpolates {env:VAR} and {file:path} placeholders in a string value.
 * {file:path} is restricted to files within the workspace for security.
 */
function interpolateEnv(value: string, workspace?: string): string {
  return value
    .replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] ?? '';
    })
    .replace(/\{file:([^}]+)\}/g, (_, filePath) => {
      if (!workspace) return '';
      try {
        const resolved = resolve(workspace, normalize(filePath));
        const normResolved = resolved.replace(/\\/g, '/');
        const normWorkspace = workspace.replace(/\\/g, '/');
        if (!normResolved.startsWith(normWorkspace + '/') && normResolved !== normWorkspace) {
          return '';
        }
        return readFileSync(resolved, 'utf-8').trim();
      } catch {
        return '';
      }
    });
}

/**
 * A connected MCP server with its client and discovered tools.
 */
interface McpServerConnection {
  name: string;
  client: Client;
  config: McpServerConfig;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: object;
  }>;
  state: McpServerState;
}

/**
 * Manages connections to MCP servers and exposes their tools
 * in the agent's Tool format.
 */
export class McpManager {
  private connections: Map<string, McpServerConnection> = new Map();
  private configs: Record<string, McpServerConfig>;
  private workspace: string;

  constructor(configs?: Record<string, McpServerConfig>, workspace?: string) {
    this.configs = configs ?? {};
    this.workspace = workspace || process.cwd();
  }

  /**
   * Connect to all configured MCP servers.
   * Returns a summary of connection results.
   */
  async connectAll(): Promise<McpServerState[]> {
    const states: McpServerState[] = [];
    const entries = Object.entries(this.configs);

    if (entries.length === 0) return states;

    // Connect to servers in parallel (up to 5 concurrent)
    const batchSize = 5;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(([name, config]) => this.connectServer(name, config))
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          states.push(result.value);
        } else {
          states.push({
            name: 'unknown',
            status: 'error',
            toolCount: 0,
            error: result.reason?.message ?? String(result.reason),
          });
        }
      }
    }

    return states;
  }

  /**
   * Connect to a single MCP server.
   */
  private async connectServer(name: string, config: McpServerConfig): Promise<McpServerState> {
    // Check if explicitly disabled
    if (config.enabled === false) {
      const state: McpServerState = { name, status: 'disabled', toolCount: 0 };
      return state;
    }

    const client = new Client({ name: 'qwen-agent-tui', version: '1.1.0' });

    try {
      if (config.type === 'local') {
        await this.connectLocal(client, name, config);
      } else {
        await this.connectRemote(client, name, config);
      }

      // Discover tools
      const { tools: mcpTools } = await client.listTools();
      const tools = mcpTools.map((t) => ({
        name: t.name,
        description: t.description ?? `MCP tool: ${t.name}`,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }));

      const serverInfo = client.getServerVersion() ?? undefined;
      const state: McpServerState = {
        name,
        status: 'connected',
        toolCount: tools.length,
        serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
      };

      this.connections.set(name, { name, client, config, tools, state });
      return state;
    } catch (err: unknown) {
      const e = err as { message?: string };
      const state: McpServerState = {
        name,
        status: 'error',
        toolCount: 0,
        error: e.message ?? String(err),
      };
      // Try to close client on error
      try {
        await client.close();
      } catch {
        /* cleanup best-effort */
      }
      return state;
    }
  }

  /**
   * Build a sanitized base environment for spawned MCP servers.
   * API keys/secrets are stripped — servers only receive secrets that are
   * explicitly declared in their config `env` block.
   */
  private sanitizedBaseEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE)/i.test(k)) continue;
      out[k] = v;
    }
    return out;
  }

  /**
   * Connect to a local MCP server via stdio transport.
   */
  private async connectLocal(
    client: Client,
    name: string,
    config: McpLocalServerConfig
  ): Promise<void> {
    const [command, ...args] = config.command;
    const env: Record<string, string> = this.sanitizedBaseEnv();
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        env[k] = interpolateEnv(v, this.workspace);
      }
    }

    const transport = new StdioClientTransport({
      command,
      args,
      env,
      cwd: config.cwd,
    });

    await client.connect(transport);
  }

  /**
   * Connect to a remote MCP server via HTTP (Streamable HTTP or SSE).
   */
  private async connectRemote(
    client: Client,
    name: string,
    config: McpRemoteServerConfig
  ): Promise<void> {
    const url = new URL(config.url);
    const headers: Record<string, string> = {};
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) {
        headers[k] = interpolateEnv(v, this.workspace);
      }
    }

    // Try Streamable HTTP first, fall back to SSE
    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
      await client.connect(transport);
    } catch {
      // Fallback to SSE transport for older servers
      const sseTransport = new SSEClientTransport(url, {
        requestInit: { headers },
      });
      await client.connect(sseTransport);
    }
  }

  /**
   * Convert all discovered MCP tools into the agent's Tool format.
   * Each tool is prefixed with "mcp_<server>_" to avoid name collisions.
   */
  getTools(): Tool[] {
    const result: Tool[] = [];

    for (const [serverName, conn] of this.connections) {
      if (conn.state.status !== 'connected') continue;

      for (const mcpTool of conn.tools) {
        const toolName = `mcp_${serverName}_${mcpTool.name}`;
        result.push({
          name: toolName,
          description: `[MCP: ${serverName}] ${mcpTool.description}`,
          parameters: mcpTool.inputSchema,
          execute: (_args: unknown, _workspace: string) => {
            return JSON.stringify({ ok: false, error: 'MCP tools require async execution' });
          },
          executeAsync: async (
            args: unknown,
            _workspace: string,
            _cfg?: unknown,
            signal?: AbortSignal
          ) => {
            return this.callTool(serverName, mcpTool.name, args as Record<string, unknown>, signal);
          },
        });
      }
    }

    return result;
  }

  /**
   * Call an MCP tool on a connected server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      return JSON.stringify({ ok: false, error: `MCP server "${serverName}" not connected` });
    }
    if (conn.state.status !== 'connected') {
      return JSON.stringify({
        ok: false,
        error: `MCP server "${serverName}" status: ${conn.state.status}`,
      });
    }

    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args });

      // MCP protocol: a tool-level failure is reported via isError, NOT thrown
      const isError = (result as { isError?: boolean }).isError === true;

      // Extract text content from the result
      const content = result.content;
      if (Array.isArray(content)) {
        const texts = content as Array<{ type?: string; text?: string }>;
        const filtered = texts.filter((c) => c.type === 'text').map((c) => c.text);
        if (filtered.length === 1) {
          return isError
            ? JSON.stringify({ ok: false, error: filtered[0]! })
            : JSON.stringify({ ok: true, output: filtered[0]! });
        }
        if (filtered.length > 1) {
          return JSON.stringify(
            isError ? { ok: false, error: filtered.join('\n') } : { ok: true, output: filtered.join('\n') }
          );
        }
        // Non-text content (images, etc.)
        return JSON.stringify(isError ? { ok: false, error: 'MCP tool error', content } : { ok: true, content });
      }

      return JSON.stringify(isError ? { ok: false, error: 'MCP tool error', result: content } : { ok: true, result: content });
    } catch (err: unknown) {
      return JSON.stringify({
        ok: false,
        error: `MCP tool "${toolName}" on "${serverName}" failed: ${(err as { message?: string }).message ?? String(err)}`,
      });
    }
  }

  /**
   * Get the connection status of all configured servers.
   */
  getStates(): McpServerState[] {
    return Array.from(this.connections.values()).map((c) => c.state);
  }

  /**
   * Get the number of connected servers.
   */
  get connectedCount(): number {
    return Array.from(this.connections.values()).filter((c) => c.state.status === 'connected')
      .length;
  }

  /**
   * Get the total number of MCP tools available.
   */
  get totalTools(): number {
    return Array.from(this.connections.values()).reduce(
      (sum, c) => sum + (c.state.status === 'connected' ? c.state.toolCount : 0),
      0
    );
  }

  /**
   * Disconnect from all MCP servers and clean up resources.
   */
  async disconnectAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const conn of this.connections.values()) {
      closePromises.push(conn.client.close().catch(() => {}));
    }
    await Promise.allSettled(closePromises);
    this.connections.clear();
  }

  /**
   * Disconnect from a specific server.
   */
  async disconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (conn) {
      try {
        await conn.client.close();
      } catch {
        /* cleanup best-effort */
      }
      this.connections.delete(name);
    }
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  isMcpTool(toolName: string): boolean {
    return toolName.startsWith('mcp_');
  }

  /**
   * Parse an MCP tool name back to server and tool names.
   */
  parseMcpToolName(prefixedName: string): { server: string; tool: string } | null {
    if (!prefixedName.startsWith('mcp_')) return null;
    const rest = prefixedName.slice(4); // remove "mcp_"
    const underscoreIdx = rest.indexOf('_');
    if (underscoreIdx === -1) return null;
    return {
      server: rest.slice(0, underscoreIdx),
      tool: rest.slice(underscoreIdx + 1),
    };
  }
}

/**
 * Create an McpManager from config.
 */
export function createMcpManager(mcpConfigs?: Record<string, McpServerConfig>, workspace?: string): McpManager {
  return new McpManager(mcpConfigs, workspace);
}
