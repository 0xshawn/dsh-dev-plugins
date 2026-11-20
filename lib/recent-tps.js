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
export const RECENT_TPS_MAX_SAMPLES = 512

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
  /** The open step's boundaries; null outside a step. */
  open: z.object({
    turn: z.number().int(),
    step: z.number().int(),
    firstTokenTime: z.number().nonnegative().nullable(),
  }).strict().nullable(),
  /** Fork-inherited prefix length; events below it belong to the parent. */
  skipBefore: z.number().int().nonnegative(),
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

/** Same `{ samples }` view object while the sample array is unchanged. */
const viewCache = new WeakMap()

/**
 * Client view of one folded state. Samples are re-clipped to the retention
 * window relative to the newest sample, so an idle Session never ships a stale
 * tail, and the object is reused so an internal-only state change does not
 * republish the wire value.
 * @param state - the folded state.
 * @returns the whole wire value.
 */
function viewOfState(state) {
  const samples = state.samples
  let view = viewCache.get(samples)
  if (view === undefined) {
    const newest = samples.length > 0 ? samples[samples.length - 1].completedTime : 0
    const cutoff = newest - RECENT_TPS_RETENTION_MS
    const kept = newest === 0 ? samples : samples.filter((sample) => sample.completedTime >= cutoff)
    view = { samples: kept }
    viewCache.set(samples, view)
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
  init: (_header, inheritedEventCount) => ({
    samples: [],
    open: null,
    skipBefore: Number.isFinite(inheritedEventCount) && inheritedEventCount > 0 ? inheritedEventCount : 0,
  }),
  apply: (state, event) => {
    // A fork inherits its parent's prefix; the reading describes this
    // Session's own steps, matching the statistics collector's attribution.
    if (typeof event.seq === 'number' && event.seq < state.skipBefore) return state
    switch (event.type) {
      case 'step/start':
        return {
          ...state,
          open: {
            turn: event.data.turn,
            step: event.data.step,
            firstTokenTime: null,
          },
        }
      case 'assistant/attempt': {
        const open = state.open
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
        if (open.firstTokenTime !== null) return state
        // A retried attempt records the earliest token; the assembled message
        // may belong to a later attempt and start much later.
        const first = firstTokenTime(event.data.stream)
        if (first === undefined) return state
        return { ...state, open: { ...open, firstTokenTime: first } }
      }
      case 'assistant/message': {
        const open = state.open
        const matches = open !== null && open.turn === event.data.turn && open.step === event.data.step
        const first = matches && open.firstTokenTime !== null
          ? open.firstTokenTime
          : firstTokenTime(event.data.stream)
        const outputTokens = usageOutputTokens(event.data.usage)
        const closed = open === null ? state : { ...state, open: null }
        if (first === undefined || outputTokens === null || event.time <= first) return closed
        const cutoff = event.time - RECENT_TPS_RETENTION_MS
        const samples = state.samples.filter((sample) => sample.completedTime >= cutoff)
        samples.push({ firstTokenTime: first, completedTime: event.time, outputTokens })
        if (samples.length > RECENT_TPS_MAX_SAMPLES) {
          samples.splice(0, samples.length - RECENT_TPS_MAX_SAMPLES)
        }
        return { ...closed, samples }
      }
      case 'step/end':
        return state.open === null ? state : { ...state, open: null }
      default:
        return state
    }
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
