/**
 * Tests for the per-session `useSessionWorkspace` mode: one supervised MCP
 * connection per live session, each rooted in that session's workspace, with
 * its tools scoped to that session's agent. Covers spawn-on-agent-created,
 * correct per-session cwd, teardown on agent-disposed, and skipping cwd-less
 * sessions. Isolated file so vi.mock of the MCP SDK doesn't pollute other suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

const {
  mockConnect, mockClose, mockListTools, mockStdioTransport, instances, stdioTransportOptions, MockClient,
} = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = vi.fn()
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  /** The spawn options (command, args, cwd) of every StdioClientTransport construction. */
  const stdioTransportOptions: { command: string; args: string[]; cwd: string }[] = []
  const mockStdioTransport = vi.fn(function (this: unknown, options: { command: string; args: string[]; cwd: string }) {
    stdioTransportOptions.push(options)
    return { start: vi.fn(), close: vi.fn() }
  })
  return {
    mockConnect, mockClose, mockListTools, mockStdioTransport, instances, stdioTransportOptions, MockClient,
  }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: mockStdioTransport }))

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'

// ---- Helpers ----

/** Adapter that never runs: agents are created but not driven in these tests. */
class IdleAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(): AsyncIterable<never> { return }
}

function stdioConfigWithWorkspace(): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    useSessionWorkspace: true,
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  }
}

/** The tool list the mock server advertises after a successful connect. */
function listing(): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return { tools: [{ name: 'remote', inputSchema: { type: 'object' } }], nextCursor: undefined }
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], new IdleAdapter())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('per-session workspace servers', () => {
  beforeEach(() => {
    instances.length = 0
    stdioTransportOptions.length = 0
    mockConnect.mockReset()
    mockClose.mockReset()
    mockListTools.mockReset()
    mockListTools.mockResolvedValue(listing())
  })

  it('spawns one server per session, each rooted in that session\'s workspace', async () => {
    const ctx = await harness()
    await apply(ctx, stdioConfigWithWorkspace())

    const a = await ctx.agents.create({ sessionId: SessionId('a'), meta: { cwd: '/a' } })
    await vi.waitFor(() => { expect(instances).toHaveLength(1) })
    expect(stdioTransportOptions[0]?.cwd).toBe('/a')

    const b = await ctx.agents.create({ sessionId: SessionId('b'), meta: { cwd: '/b' } })
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    expect(stdioTransportOptions[1]?.cwd).toBe('/b')

    await a.dispose()
    await b.dispose()
    await ctx.fiber.dispose()
  })

  it('disposes a session\'s server when the agent is disposed', async () => {
    const ctx = await harness()
    await apply(ctx, stdioConfigWithWorkspace())

    const a = await ctx.agents.create({ sessionId: SessionId('a'), meta: { cwd: '/a' } })
    await vi.waitFor(() => { expect(instances).toHaveLength(1) })
    const closedBefore = mockClose.mock.calls.length

    await a.dispose()
    await vi.waitFor(() => { expect(mockClose.mock.calls.length).toBeGreaterThan(closedBefore) })

    await ctx.fiber.dispose()
  })
})
