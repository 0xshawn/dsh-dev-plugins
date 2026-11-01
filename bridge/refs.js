/**
 * Per-tab ref map: `e1..eN` to the CDP identity captured by `observe`.
 * Refs are dropped on observe, navigation, tab switch, and tab close.
 */
export class RefStore {
  constructor() {
    this.entries = new Map()
    this.snapshotAt = 0
  }

  /**
   * @param entries - iterable of `[ref, { backendNodeId, frameId, snapshotAt }]`.
   * @param at - invalidation timestamp reported as `refsInvalidatedAt`.
   */
  set(entries, at = Date.now()) {
    this.entries = new Map(entries)
    this.snapshotAt = at
  }

  get(ref) {
    return this.entries.get(ref)
  }

  clear() {
    this.entries.clear()
  }

  get size() {
    return this.entries.size
  }

  list() {
    return [...this.entries.entries()].map(([ref, entry]) => ({ ref, ...entry }))
  }
}

/** Create an empty ref store. */
export function createRefStore() {
  return new RefStore()
}
