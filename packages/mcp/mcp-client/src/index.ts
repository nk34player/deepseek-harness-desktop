/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'
import type { ConnectionHandle, ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export type { McpResult } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Valid `serverName`, kept below the public tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Live `serverName` reservations per app, keyed off `ctx.root` (multiple apps
 * in one process — tests — must not see each other's names). A duplicate
 * namespace is a configuration error surfaced at plugin load, never silent
 * shadowing.
 */
const activeServerNames = new WeakMap<Context, Set<string>>()

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process; empty uses the host cwd. */
  cwd: string
  /**
   * Spawn one child per live session, each rooted in that session's workspace
   * (its `header.cwd`), instead of one shared child on `cwd`. Each session's
   * child registers its tools scoped to that session's agent, so a file-indexer
   * like fff always searches the session it is used in and never leaks another
   * workspace's results. Use for servers that derive a search root from their
   * process cwd (e.g. a file indexer); avoid for long-lived GUI bridges, which
   * would run once per session.
   */
  useSessionWorkspace?: boolean
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

export const Config = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    useSessionWorkspace: z.boolean().default(false),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    failOnStartupError: z.boolean().default(false),
    reconnect: Reconnect,
  }),
]) as unknown as z<Config>

// ---- Plugin apply ----

/**
 * The workspace one session's `useSessionWorkspace` child roots in: the cwd of
 * a live non-subagent session, or undefined when the session carries none.
 * Subagent sessions inherit their parent's cwd, so giving each one its own
 * child would only duplicate a server already rooted there.
 * @param agent - the live agent/session to classify.
 */
function sessionWorkspace(agent: Agent): string | undefined {
  if (agent.session.header.origin === 'subagent') return undefined
  return agent.session.header.cwd
}

/**
 * Mount one supervised connection per live session for a `useSessionWorkspace`
 * stdio server, each rooted in that session's workspace and registering its
 * tools scoped to that session's agent. Sessions created later spawn their own
 * child; a disposed session tears its child down. Effect-scoped: disposal
 * detaches the listeners and disposes every live per-session connection.
 *
 * Activation does not await any one connection — children spawn and settle as
 * their sessions appear, so `failOnStartupError` has no single startup to gate.
 *
 * @param ctx - plugin context providing the `agents` service and global events.
 * @param agents - the live agent registry (per-session children are keyed by agent id).
 * @param config - the resolved stdio config carrying `useSessionWorkspace`.
 * @param reconnect - fully resolved reconnect policy.
 */
function mountPerSessionConnections(
  ctx: Context,
  agents: AgentRegistry,
  config: StdioConfig,
  reconnect: ResolvedReconnectPolicy,
): void {
  const connections = new Map<string, ConnectionHandle>()

  const spawn = (agent: Agent): void => {
    const cwd = sessionWorkspace(agent)
    if (cwd === undefined || connections.has(agent.id)) return
    connections.set(agent.id, startConnection(agent.ctx, { ...config, cwd }, reconnect))
  }
  const detach = (agent: Agent): void => {
    const handle = connections.get(agent.id)
    if (handle === undefined) return
    connections.delete(agent.id)
    void handle.dispose()
  }

  // Seed from already-live agents (an HMR reload of this plugin lands mid-session).
  for (const agent of agents.list()) spawn(agent)

  const offCreated = ctx.on('agent/created', ({ agent }) => spawn(agent), { global: true })
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => detach(agent), { global: true })

  ctx.effect(() => {
    return async () => {
      offCreated()
      offDisposed()
      await Promise.all([...connections.values()].map(handle => handle.dispose()))
      connections.clear()
    }
  }, 'mcp-client.per-session-connections')
}

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved transport and server namespace configuration.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // Reserve the namespace next: a duplicate `serverName` fails THIS instance
  // at load with an actionable error and leaves the earlier instance intact.
  ctx.effect(() => {
    let names = activeServerNames.get(ctx.root)
    if (!names) {
      names = new Set()
      activeServerNames.set(ctx.root, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    return () => void names.delete(config.serverName)
  }, 'mcp-client.serverName')

  // A session-workspace stdio server runs one child per session, each rooted in
  // that session's workspace; there is no single connection to gate activation.
  if (config.transport === 'stdio' && config.useSessionWorkspace === true) {
    const agents = ctx.get('agents')
    if (agents !== undefined) {
      mountPerSessionConnections(ctx, agents, config, reconnect)
      return
    }
    ctx.logger.warn(
      `mcp-client(${config.serverName}): useSessionWorkspace requires the agents service — falling back to the configured cwd`,
    )
  }

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  const connection = startConnection(ctx, config, reconnect)

  ctx.effect(() => {
    return () => connection.dispose()
  }, 'mcp-client.connection')

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor enters its reconnect loop.
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
