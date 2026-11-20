/**
 * Host half of the recent-output-speed reading: one `devPluginsRecentTps`
 * session projection that keeps a bounded list of settled decode samples
 * (first token, message, provider output tokens).
 *
 * The Web client cannot rebuild this from its paged Chat window: durable
 * replay keeps assembled messages there, and their `timing.firstTokenTime` is
 * null once the step's chunk events leave the loaded event window. Folding the
 * compact stream on the Host keeps the first-token moment for every settled
 * step, so the client can clip the trailing five minutes exactly.
 *
 * @module dsh-dev-plugins/recent-tps
 */
import { z } from 'zod'

/** Projection key shared by the Host unit and the browser bundle. */
export const RECENT_TPS_PROJECTION_KEY = 'devPluginsRecentTps'
/** Samples kept in the fold; a little longer than the client's five-minute window. */
export const RECENT_TPS_RETENTION_MS = 6 * 60 * 1000
/** Hard cap so a burst of very short steps cannot grow the persisted state. */
export const RECENT_TPS_MAX_SAMPLES = 1024

const sampleSchema = z.object({
  /** First non-empty token delta, epoch ms. */
  firstTokenTime: z.number().nonnegative(),
  /** Assembled `assistant/message` time, epoch ms. */
  completedTime: z.number().nonnegative(),
  /** Provider-reported output tokens for the step. */
  outputTokens: z.number().nonnegative(),
})

/** Fold state persisted with the Session projection checkpoint. */
const stateSchema = z.object({
  samples: z.array(sampleSchema),
}).strict()

/** Wire payload the browser folds into the trailing window. */
export const recentTpsViewSchema = z.object({
  samples: z.array(sampleSchema),
}).strict()

/**
 * Whether one compact stream chunk is a token delta; mirrors the Host LLM
 * package's predicate without importing it into this bundle.
 * @param chunk - one stream chunk.
 * @returns true for non-empty text, reasoning, or tool-call deltas.
 */
export function isTokenDeltaChunk(chunk) {
  switch (chunk?.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text !== ''
    case 'tool-call-delta':
      return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') || chunk.name !== undefined
    default:
      return false
  }
}

/**
 * Reconstructed time of the first qualifying member of one packed delta run.
 * @param run - `text-chunks` or `tool-call-chunks` record.
 * @returns epoch ms, or undefined when no member carries a token.
 */
function runFirstTokenTime(run) {
  if (typeof run?.time0 !== 'number') return undefined
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
  const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
  if (!Array.isArray(fragments)) return undefined
  let time = run.time0
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) time += run.dt?.[index - 1] ?? 0
    if (fragments[index] !== '') return time
  }
  return undefined
}

/**
 * First token time of one compact assistant stream.
 * @param stream - records from an `assistant/message` (or attempt) event.
 * @returns epoch ms, or undefined when the stream carries no token.
 */
export function firstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record?.type === 'chunk') {
      if (typeof record.time === 'number' && isTokenDeltaChunk(record.chunk)) return record.time
      continue
    }
    const time = runFirstTokenTime(record)
    if (time !== undefined) return time
  }
  return undefined
}

/**
 * Provider-reported completion tokens, guarded the way the stock projection
 * guards its usage field.
 * @param usage - one `assistant/message` usage record.
 * @returns the output-token count, or null when unreported or invalid.
 */
export function usageOutputTokens(usage) {
  if (typeof usage !== 'object' || usage === null) return null
  const value = usage.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Same `{ samples }` reference while the sample array is unchanged. */
const viewCache = new WeakMap()

/**
 * Client view of one folded state; reuse the object so an internal-only state
 * change does not republish the wire value.
 * @param state - the folded state.
 * @returns the whole wire value.
 */
function viewOfState(state) {
  let view = viewCache.get(state.samples)
  if (view === undefined) {
    view = { samples: state.samples }
    viewCache.set(state.samples, view)
  }
  return view
}

/**
 * The `devPluginsRecentTps` projection unit. Only settled assistant messages
 * with a recorded first token and provider usage enter the sample list; the
 * list is pruned against the event clock so replay never keeps stale steps.
 */
export const recentTpsProjection = {
  key: RECENT_TPS_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => ({ samples: [] }),
  apply: (state, event) => {
    if (event.type !== 'assistant/message') return state
    const first = firstTokenTime(event.data.stream)
    const outputTokens = usageOutputTokens(event.data.usage)
    if (first === undefined || outputTokens === null || event.time <= first) return state
    const cutoff = event.time - RECENT_TPS_RETENTION_MS
    const samples = state.samples.filter((sample) => sample.completedTime >= cutoff)
    samples.push({ firstTokenTime: first, completedTime: event.time, outputTokens })
    if (samples.length > RECENT_TPS_MAX_SAMPLES) {
      samples.splice(0, samples.length - RECENT_TPS_MAX_SAMPLES)
    }
    return { samples }
  },
  wire: {
    viewSchema: recentTpsViewSchema,
    view: viewOfState,
    summary: false,
  },
}

/**
 * Register the projection once the Session projection registry resolves. The
 * unit stays registered for the plugin's lifetime; the browser-side switch
 * only controls whether the reading renders.
 * @param ctx - Host Cordis context.
 * @returns true when the registry already resolved and registration started.
 */
export function installRecentTpsProjection(ctx) {
  if (typeof ctx?.inject !== 'function') return false
  let installed = false
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    installed = true
    Promise.resolve(projectionCtx.sessionProjections.register(recentTpsProjection)).catch((error) => {
      ctx.logger?.warn?.('dsh-dev-plugins: recent-TPS projection registration failed:', error)
    })
  })
  return installed
}
