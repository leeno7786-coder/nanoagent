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
import { createSecurityManager } from '../security/index.js';
import { readFileSync, realpathSync } from 'fs';
import { resolve, normalize } from 'path';

/**
 * Interpolates {env:VAR} and {file:path} placeholders in a string value.
 * {file:path} is restricted to files within the workspace for security, and
 * the read goes through the standard blocked-path guard (.env, keys, ...).
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
        // Resolve symlinks before the boundary check — a workspace symlink
        // pointing at ~/.ssh/id_rsa must not pass as an in-workspace path.
        const real = realpathSync(resolved);
        const normReal = real.replace(/\\/g, '/');
        const normWorkspace = realpathSync(workspace).replace(/\\/g, '/');
        if (!normReal.startsWith(normWorkspace + '/') && normReal !== normWorkspace) {
          return '';
        }
        // Refuse to interpolate blocked files (workspace .env, private keys,
        // etc.) into MCP server env/headers — that would exfiltrate secrets.
        // Validate the REAL path so symlink targets hit the blocked patterns.
        const access = createSecurityManager({}, workspace).validateFileAccess(real, 'read');
        if (!access.ok) {
          throw new Error(
            `MCP config {file:${filePath}} refused: ${access.error ?? 'blocked path'}`
          );
        }
        return readFileSync(real, 'utf-8').trim();
      } catch (e: unknown) {
        if (e instanceof Error && e.message.startsWith('MCP config {file:')) throw e;
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
      // Default to agent workspace so project-aware servers (e.g. Serena
      // --project-from-cwd) activate the correct root.
      cwd: config.cwd ?? this.workspace,
      // Never inherit stderr into the TUI — MCP servers (Serena especially)
      // emit INFO logs that corrupt the OpenTUI screen.
      stderr: 'pipe',
    });

    // Drain stderr so a noisy server cannot block on a full pipe buffer.
    // Keep a small ring for connection-error diagnostics; only echo when debugging.
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    const MAX_STDERR_CAPTURE = 32 * 1024;
    const debugMcp = Boolean(process.env.QWEN_DEBUG_MCP);
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (stderrBytes < MAX_STDERR_CAPTURE) {
        stderrChunks.push(buf);
        stderrBytes += buf.length;
      }
      if (debugMcp) {
        process.stderr.write(`[mcp:${name}] ${buf.toString('utf8')}`);
      }
    });

    try {
      await client.connect(transport);
    } catch (err: unknown) {
      const captured = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (captured) {
        const base = err instanceof Error ? err.message : String(err);
        throw new Error(`${base}\n--- mcp:${name} stderr ---\n${captured.slice(-4000)}`);
      }
      throw err;
    }
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

    // Try Streamable HTTP first, fall back to SSE for older servers
    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
      await client.connect(transport);
    } catch (httpErr: unknown) {
      try {
        const sseTransport = new SSEClientTransport(url, {
          requestInit: { headers },
        });
        await client.connect(sseTransport);
        if (process.env.QWEN_DEBUG_MCP) {
          const msg = httpErr instanceof Error ? httpErr.message : String(httpErr);
          process.stderr.write(
            `[mcp:${name}] Streamable HTTP failed (${msg}); connected via SSE fallback\n`
          );
        }
      } catch (sseErr: unknown) {
        const httpMsg = httpErr instanceof Error ? httpErr.message : String(httpErr);
        const sseMsg = sseErr instanceof Error ? sseErr.message : String(sseErr);
        throw new Error(
          `Remote MCP "${name}" failed over Streamable HTTP (${httpMsg}) and SSE (${sseMsg})`
        );
      }
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
    signal?: AbortSignal
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
      if (signal?.aborted) {
        return JSON.stringify({ ok: false, error: 'Aborted' });
      }

      // SDK signature: callTool(params, resultSchema?, options?) — pass signal via options.
      const result = await conn.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        signal ? { signal } : undefined
      );

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
            isError
              ? { ok: false, error: filtered.join('\n') }
              : { ok: true, output: filtered.join('\n') }
          );
        }
        // Non-text content (images, etc.)
        return JSON.stringify(
          isError ? { ok: false, error: 'MCP tool error', content } : { ok: true, content }
        );
      }

      return JSON.stringify(
        isError
          ? { ok: false, error: 'MCP tool error', result: content }
          : { ok: true, result: content }
      );
    } catch (err: unknown) {
      const aborted =
        signal?.aborted ||
        (err instanceof Error &&
          (err.name === 'AbortError' || err.message.toLowerCase().includes('abort')));
      if (aborted) {
        return JSON.stringify({ ok: false, error: 'Aborted' });
      }
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
   * Matches against connected server names (longest first) so servers whose
   * names contain '_' parse correctly; falls back to splitting at the first
   * '_' when no connected server matches.
   */
  parseMcpToolName(prefixedName: string): { server: string; tool: string } | null {
    if (!prefixedName.startsWith('mcp_')) return null;
    const rest = prefixedName.slice(4); // remove "mcp_"
    const names = [...this.connections.keys()].sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (rest.startsWith(name + '_')) {
        return { server: name, tool: rest.slice(name.length + 1) };
      }
    }
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
export function createMcpManager(
  mcpConfigs?: Record<string, McpServerConfig>,
  workspace?: string
): McpManager {
  return new McpManager(mcpConfigs, workspace);
}
