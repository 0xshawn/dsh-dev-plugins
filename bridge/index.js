#!/usr/bin/env node
/**
 * Browser-control bridge entry point.
 *
 * Runs one process with two halves: a WebSocket relay the Chrome extension
 * connects to (loopback only) and a stdio MCP server that dsh spawns. stdout
 * carries MCP protocol frames only; all logging goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

import { ChromeSession } from './chrome.js'
import { loadConfig } from './config.js'
import { createRelay } from './relay.js'
import { registerTools } from './tools.js'

/** Version reported to the extension in `welcome`; keep in sync with package.json. */
const BRIDGE_VERSION = '0.8.0'

let shuttingDown = false

async function shutdown(runtime) {
  if (shuttingDown) return
  shuttingDown = true
  runtime.session?.close()
  await runtime.server?.close().catch(() => {})
  await runtime.relay?.close().catch(() => {})
}

async function main() {
  const config = await loadConfig(process.env)
  if (!config.enabled) {
    // DSH_BROWSER_BRIDGE=0: exit before touching the network or MCP.
    process.exit(0)
  }

  const relay = createRelay(config, { bridgeVersion: BRIDGE_VERSION })
  try {
    await relay.listen()
  } catch (error) {
    console.error('browser-bridge: could not start the WebSocket relay:', error instanceof Error ? error.message : error)
    process.exit(1)
  }

  const session = new ChromeSession(relay, config)
  const server = new McpServer({ name: 'browser', version: BRIDGE_VERSION }, { capabilities: { tools: {} } })
  registerTools(server, session, config)

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const runtime = { relay, session, server }
  const stop = () => {
    void shutdown(runtime).then(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.stdin.on('end', stop)
  process.stdin.on('close', stop)
  process.stdin.on('error', (error) => {
    console.error('browser-bridge: stdin error:', error instanceof Error ? error.message : error)
    stop()
  })

  console.error(`browser-bridge: listening on ws://127.0.0.1:${relay.port}/extension (MCP on stdio)`)
}

main().catch((error) => {
  console.error('browser-bridge: fatal:', error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
})
