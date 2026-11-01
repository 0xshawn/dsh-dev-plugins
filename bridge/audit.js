/**
 * Append-only JSONL audit trail for browser-control tool calls.
 *
 * Every tool call writes one line to `$DSH_BROWSER_BRIDGE_HOME/audit.jsonl`.
 * Secrets never reach this module: handlers summarize typed text as
 * `{ length }` and cookie values are dropped before the call. Write failures
 * are reported on stderr and never fail the tool call that produced them.
 */
import { appendFile, chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Directory mode for the audit home, matching the token directory. */
const DIR_MODE = 0o700
/** File mode for the audit log. */
const FILE_MODE = 0o600

/**
 * Build one audit record. Pure so tests can assert the line shape.
 * @param entry - tool, paramsSummary, optional tabId/url/paths, ok, ms, error.
 * @param now - clock used for `ts`.
 * @returns the JSON-serializable record.
 */
export function buildAuditLine(entry, now = Date.now()) {
  const record = {
    ts: new Date(now).toISOString(),
    tool: entry.tool,
    paramsSummary: entry.paramsSummary ?? {},
  }
  if (entry.tabId !== undefined && entry.tabId !== null) record.tabId = entry.tabId
  if (typeof entry.url === 'string' && entry.url !== '') record.url = entry.url
  if (Array.isArray(entry.paths)) record.paths = entry.paths
  record.ok = entry.ok === true
  record.ms = Number.isFinite(entry.ms) ? entry.ms : 0
  if (entry.ok !== true && typeof entry.error === 'string') record.error = entry.error
  return record
}

/**
 * Append one audit record.
 * @param home - bridge home directory (created 0700 on first write).
 * @param entry - see {@link buildAuditLine}.
 */
export async function auditToolCall(home, entry) {
  try {
    await mkdir(home, { recursive: true, mode: DIR_MODE })
    await chmod(home, DIR_MODE).catch(() => {})
    const line = `${JSON.stringify(buildAuditLine(entry))}\n`
    await appendFile(join(home, 'audit.jsonl'), line, { mode: FILE_MODE })
  } catch (error) {
    console.error('browser-bridge: failed to write audit log:', error instanceof Error ? error.message : error)
  }
}
