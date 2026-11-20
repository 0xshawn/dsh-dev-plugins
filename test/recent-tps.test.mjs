import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RECENT_TPS_MAX_SAMPLES,
  RECENT_TPS_PROJECTION_KEY,
  RECENT_TPS_RETENTION_MS,
  firstTokenTime,
  installRecentTpsProjection,
  isTokenDeltaChunk,
  recentTpsProjection,
  usageOutputTokens,
} from '../lib/recent-tps.js'

/** One assistant message event carrying a compact stream. */
function message(time, stream, outputTokens) {
  return {
    type: 'assistant/message',
    time,
    data: { turn: 1, step: 1, stream, ...(outputTokens === undefined ? {} : { usage: { outputTokens } }) },
  }
}

/** A chunk record. */
function chunk(time, value) {
  return { type: 'chunk', time, chunk: value }
}

/** Fold a list of events through the projection. */
function fold(events, state = recentTpsProjection.init({}, 0)) {
  return events.reduce((current, event) => recentTpsProjection.apply(current, event), state)
}

test('token-delta chunks cover text, reasoning, and tool calls', () => {
  assert.equal(isTokenDeltaChunk({ type: 'text-delta', text: 'x' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'text-delta', text: '' }), false)
  assert.equal(isTokenDeltaChunk({ type: 'reasoning-delta', text: 'x' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'tool-call-delta', argumentsDelta: '{}' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'tool-call-delta', name: 'read' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'tool-call-delta', argumentsDelta: '' }), false)
  assert.equal(isTokenDeltaChunk({ type: 'finish' }), false)
  assert.equal(isTokenDeltaChunk(undefined), false)
})

test('the first token time reads chunks and packed delta runs', () => {
  assert.equal(firstTokenTime([chunk(1_000, { type: 'finish' }), chunk(1_100, { type: 'text-delta', text: 'hi' })]), 1_100)
  // A packed run carries the first member's offset in dt.
  assert.equal(firstTokenTime([{ type: 'text-chunks', time0: 2_000, dt: [10, 20], texts: ['', 'a', 'b'] }]), 2_010)
  // A name-bearing tool-call run starts at its first member.
  assert.equal(firstTokenTime([{ type: 'tool-call-chunks', name: 'read', time0: 3_000, dt: [], args: [] }]), 3_000)
  assert.equal(firstTokenTime([{ type: 'text-chunks', time0: 4_000, dt: [], texts: [] }]), undefined)
  assert.equal(firstTokenTime([]), undefined)
  assert.equal(firstTokenTime(undefined), undefined)
})

test('usage output tokens are guarded', () => {
  assert.equal(usageOutputTokens({ outputTokens: 12 }), 12)
  assert.equal(usageOutputTokens({ outputTokens: 0 }), 0)
  assert.equal(usageOutputTokens({ outputTokens: -1 }), null)
  assert.equal(usageOutputTokens({ outputTokens: '12' }), null)
  assert.equal(usageOutputTokens(undefined), null)
})

test('the projection keeps one sample per settled step with token usage', () => {
  const state = fold([
    { type: 'step/start', time: 1_000, data: { turn: 1, step: 1 } },
    message(5_000, [chunk(2_000, { type: 'text-delta', text: 'a' })], 100),
    // No provider usage: no sample.
    message(6_000, [chunk(5_500, { type: 'text-delta', text: 'b' })]),
    // No recorded first token: no sample.
    message(7_000, [chunk(6_900, { type: 'finish' })], 50),
    // Completed at the first token: no decode span.
    message(8_000, [chunk(8_000, { type: 'text-delta', text: 'c' })], 10),
  ])
  assert.deepEqual(state.samples, [{ firstTokenTime: 2_000, completedTime: 5_000, outputTokens: 100 }])
  assert.equal(recentTpsProjection.apply(state, { type: 'tool/call', time: 9_000, data: { callId: 'c' } }), state)
})

test('the projection prunes the retention window and caps the sample list', () => {
  const base = 10 * RECENT_TPS_RETENTION_MS
  const events = [
    message(base, [chunk(base - 1_000, { type: 'text-delta', text: 'old' })], 1),
    message(base + RECENT_TPS_RETENTION_MS + 1, [chunk(base, { type: 'text-delta', text: 'new' })], 2),
  ]
  const state = fold(events)
  assert.equal(state.samples.length, 1)
  assert.equal(state.samples[0].outputTokens, 2)

  // One more settled step than the cap, all inside the retention window.
  const start = 1_000_000
  const burst = []
  for (let index = 0; index <= RECENT_TPS_MAX_SAMPLES; index += 1) {
    const time = start + index * 2
    burst.push(message(time, [chunk(time - 1, { type: 'text-delta', text: 'x' })], 1))
  }
  assert.equal(fold(burst).samples.length, RECENT_TPS_MAX_SAMPLES)
})

test('the wire view reuses its reference while the samples are unchanged', () => {
  const samples = [{ firstTokenTime: 1, completedTime: 2, outputTokens: 3 }]
  assert.equal(recentTpsProjection.wire.view({ samples }), recentTpsProjection.wire.view({ samples }))
  const empty = []
  assert.equal(recentTpsProjection.wire.view({ samples: empty }), recentTpsProjection.wire.view({ samples: empty }))
  assert.notEqual(recentTpsProjection.wire.view({ samples: empty }), recentTpsProjection.wire.view({ samples }))
  assert.equal(recentTpsProjection.wire.summary, false)
  assert.equal(recentTpsProjection.key, RECENT_TPS_PROJECTION_KEY)
  assert.equal(recentTpsProjection.wire.viewSchema.safeParse({ samples }).success, true)
  assert.equal(recentTpsProjection.wire.viewSchema.safeParse({ samples: [{ firstTokenTime: -1 }] }).success, false)
  assert.equal(recentTpsProjection.stateSchema.safeParse({ samples, extra: true }).success, false)
})

test('installRecentTpsProjection registers on the resolved registry', async () => {
  const registrations = []
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['sessionProjections'])
      callback({ sessionProjections: { register: (definition) => {
        registrations.push(definition)
        return Promise.resolve(() => {})
      } } })
    },
  }
  assert.equal(installRecentTpsProjection(ctx), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(registrations.map((definition) => definition.key), [RECENT_TPS_PROJECTION_KEY])
  assert.equal(installRecentTpsProjection({}), false)
})
