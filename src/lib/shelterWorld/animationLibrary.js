/**
 * Cached fetcher for kimodo motion JSON + a user-extensible tag registry.
 *
 * Motions are content-addressed by id (e.g. `342711ffd11f` for the
 * built-in idle). Once fetched, the parsed JSON is held in memory for
 * the lifetime of the page — motions are small and we want zero
 * latency when spawning new avatars that share a clip.
 *
 * Tags ('idle', 'walk', 'cast', plus any user-defined tag) let the
 * rest of the app ask for "the current walk motion" without knowing
 * which animation id is currently assigned. Tag list and assignments
 * persist in localStorage; the Animations tab is the authoring UI.
 *
 * `BUILTIN_TAGS` are seeded into a fresh registry but can be removed.
 * `BUILTIN_DEFAULTS` provides a fallback animation id for selected
 * built-ins (only `idle` ships with one) so the app has a sane
 * starting state before any user assignment.
 */

export const BUILTIN_TAGS = ['idle', 'walk', 'cast', 'wave']
export const BUILTIN_DEFAULTS = {
  idle: '342711ffd11f',
  cast: '4290481a993e',
  // walk has no built-in default — falls back to idle until assigned
}
const STORAGE_KEY = 'woid.animationTags'
const LEGACY_STORAGE_KEY = 'woid.animationRoles' // pre-tag-registry shape: { idle: id, walk: id, … }

const cache = new Map()    // id → motion JSON
const inflight = new Map() // id → Promise<motion>

function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const tags = Array.isArray(parsed?.tags) ? parsed.tags.filter(isValidTag) : []
      const assignments = (parsed?.assignments && typeof parsed.assignments === 'object')
        ? parsed.assignments : {}
      return {
        tags: tags.length ? tags : [...BUILTIN_TAGS],
        assignments,
      }
    }
    // No new-shape data — try migrating from the legacy key (flat tag→id map).
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (legacy) {
      const flat = JSON.parse(legacy)
      if (flat && typeof flat === 'object') {
        const assignments = {}
        for (const [k, v] of Object.entries(flat)) {
          if (isValidTag(k) && typeof v === 'string') assignments[k] = v
        }
        const tags = [...new Set([...BUILTIN_TAGS, ...Object.keys(assignments)])]
          .filter(isValidTag)
        const migrated = { tags, assignments }
        writeState(migrated)
        try { localStorage.removeItem(LEGACY_STORAGE_KEY) } catch {}
        return migrated
      }
    }
    return seedState()
  } catch {
    return seedState()
  }
}

function seedState() {
  return { tags: [...BUILTIN_TAGS], assignments: {} }
}

function writeState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* quota */ }
}

function isValidTag(t) {
  return typeof t === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(t)
}

export function normalizeTag(input) {
  const slug = String(input ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return isValidTag(slug) ? slug : null
}

function fetchMotion(id) {
  if (!id) return Promise.resolve(null)
  if (cache.has(id)) return Promise.resolve(cache.get(id))
  const existing = inflight.get(id)
  if (existing) return existing
  const p = fetch(`/api/kimodo/animations/${id}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (m) cache.set(id, m)
      inflight.delete(id)
      return m
    })
    .catch(() => {
      inflight.delete(id)
      return null
    })
  inflight.set(id, p)
  return p
}

const subscribers = new Set()
function notify(kind, detail) {
  for (const fn of subscribers) {
    try { fn(kind, detail) } catch (e) { console.warn('[animationLibrary]', e) }
  }
}

/** Resolve a tag to its current animation id (assignment → built-in default → idle fallback). */
function getRoleId(tag) {
  const { assignments } = readState()
  return assignments[tag] ?? BUILTIN_DEFAULTS[tag] ?? BUILTIN_DEFAULTS.idle ?? null
}

export const animationLibrary = {
  BUILTIN_TAGS,
  BUILTIN_DEFAULTS,

  /** Resolves to motion JSON, or null on failure. Idempotent. */
  get: fetchMotion,
  /** Synchronously returns a previously-fetched motion, or null. */
  peek(id) { return cache.get(id) ?? null },

  /** All tags in display order. */
  getTags() { return readState().tags },
  /** animId currently assigned to `tag`, or null if unset. */
  getAssignment(tag) { return readState().assignments[tag] ?? null },
  /** Resolved id (assignment | builtin default | idle fallback). */
  getRoleId,
  /** Resolves to the motion JSON for `tag`. */
  getRole(tag) { return fetchMotion(getRoleId(tag)) },

  /** Persist a new id for a tag and notify subscribers. Pass null/undefined to clear. */
  setRoleId(tag, animId) {
    if (!isValidTag(tag)) return
    const state = readState()
    if (!state.tags.includes(tag)) state.tags.push(tag)
    if (animId) state.assignments[tag] = animId
    else delete state.assignments[tag]
    writeState(state)
    if (animId) fetchMotion(animId)
    notify('assignment', { tag, animId: animId ?? null })
  },

  /** Define a new tag. Returns the canonical (slugified) name on success, null on invalid input. */
  addTag(input) {
    const tag = normalizeTag(input)
    if (!tag) return null
    const state = readState()
    if (!state.tags.includes(tag)) {
      state.tags.push(tag)
      writeState(state)
      notify('tags', { tags: state.tags })
    }
    return tag
  },

  /** Remove a tag and its assignment. */
  removeTag(tag) {
    const state = readState()
    const i = state.tags.indexOf(tag)
    if (i < 0) return
    state.tags.splice(i, 1)
    delete state.assignments[tag]
    writeState(state)
    notify('tags', { tags: state.tags })
  },

  /** Subscribe to tag/assignment changes. Returns an unsubscribe fn. */
  subscribe(fn) {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  },

  /** Pre-warm the cache with every assigned clip. Returns a Promise. */
  bootstrap() {
    const tags = readState().tags
    return Promise.all(tags.map((t) => fetchMotion(getRoleId(t))))
  },
}
