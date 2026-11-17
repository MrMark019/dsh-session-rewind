/**
 * Per-session checkpoint bookkeeping and the private snapshot directories.
 *
 * Checkpoints live in memory for the life of the Host process and the git
 * objects that back them live in a per-session directory under the OS temporary
 * root. Directories are removed when the Session is disposed, when the plugin
 * unloads, and — for leftovers from an unclean exit — when the plugin starts.
 *
 * @module @mrmark019/dsh-session-rewind/rewind/store
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Accepted session-id spelling; the directory name is validated against this too. */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/**
 * One recorded turn.
 * @typedef {object} CheckpointEntry
 * @property {number} turn - turn number from `turn/start`.
 * @property {number} startSeq - seq of that turn's `turn/start` event.
 * @property {string | null} tree - snapshot tree id, or null when no snapshot could be taken.
 * @property {string} cwd - effective working directory at capture time.
 * @property {string | null} repoRoot - repository root the snapshot covers, or null.
 * @property {string | null} error - why the snapshot is unavailable, when it failed.
 */

/**
 * @typedef {object} SessionCheckpoints
 * @property {string} id - session id.
 * @property {string} dir - private directory holding this session's git objects.
 * @property {Map<number, CheckpointEntry>} entries - `turn/start` seq to recorded entry; the seq is unique even when a fork inherits turn numbers.
 * @property {Set<number>} open - turns that started and have not ended.
 * @property {Promise<unknown>} chain - serialized snapshot queue for this session.
 * @property {boolean} loaded - whether the persisted index has been read.
 */

/**
 * Reject a session id a directory name must not carry.
 * @param {string} id - session id.
 * @returns {string} the same id when it is safe.
 */
export function assertSessionId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('invalid session id')
  return id
}

/**
 * Checkpoint registry and the directories behind it.
 */
export class CheckpointStore {
  /**
   * @param {string} root - directory holding one private directory per session.
   */
  constructor(root) {
    /** @type {string} */
    this.root = root
    /** @type {Map<string, SessionCheckpoints>} */
    this.sessions = new Map()
  }

  /**
   * Directory name for one session, created on demand.
   * @param {string} id - session id.
   * @returns {Promise<string>} the private directory.
   */
  async dirFor(id) {
    assertSessionId(id)
    const dir = join(this.root, id)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * Read or create the in-memory record for one session.
   * @param {string} id - session id.
   * @returns {SessionCheckpoints} the session record.
   */
  session(id) {
    assertSessionId(id)
    let session = this.sessions.get(id)
    if (session === undefined) {
      session = {
        id,
        dir: join(this.root, id),
        entries: new Map(),
        open: new Set(),
        chain: Promise.resolve(),
        loaded: false,
      }
      this.sessions.set(id, session)
    }
    return session
  }

  /**
   * Write this session's checkpoint index beside its object store, so a Host
   * restart can still offer file rewind for turns whose objects survive.
   * @param {string} id - session id.
   * @returns {Promise<void>} resolves when the index is on disk.
   */
  async persist(id) {
    const session = this.sessions.get(id)
    if (session === undefined) return
    const file = join(session.dir, 'index.json')
    const payload = { version: 1, entries: [...session.entries.values()] }
    try {
      await mkdir(session.dir, { recursive: true })
      await writeFile(`${file}.tmp`, `${JSON.stringify(payload)}\n`)
      await rename(`${file}.tmp`, file)
    } catch {
      // The checkpoint still works for this process; only restart survival is lost.
    }
  }

  /**
   * Read the persisted index once per session.
   * @param {string} id - session id.
   * @returns {Promise<Map<number, CheckpointEntry>>} recorded entries.
   */
  async load(id) {
    const session = this.session(id)
    if (session.loaded) return session.entries
    session.loaded = true
    try {
      const parsed = JSON.parse(await readFile(join(session.dir, 'index.json'), 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return session.entries
      for (const entry of parsed.entries) {
        if (!Number.isSafeInteger(entry?.startSeq) || !Number.isSafeInteger(entry?.turn)) continue
        if (session.entries.has(entry.startSeq)) continue
        session.entries.set(entry.startSeq, {
          turn: entry.turn,
          startSeq: entry.startSeq,
          tree: typeof entry.tree === 'string' ? entry.tree : null,
          cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
          repoRoot: typeof entry.repoRoot === 'string' ? entry.repoRoot : null,
          error: typeof entry.error === 'string' ? entry.error : null,
        })
      }
    } catch {
      // No index for this session yet.
    }
    return session.entries
  }

  /**
   * Read the in-memory record without creating one.
   * @param {string} id - session id.
   * @returns {SessionCheckpoints | undefined} the record, when this process has one.
   */
  peek(id) {
    return this.sessions.get(id)
  }

  /**
   * Queue one operation behind this session's previous snapshot work.
   * @param {string} id - session id.
   * @param {() => Promise<void>} operation - work to run.
   * @returns {Promise<void>} resolves when the queued work settles.
   */
  enqueue(id, operation) {
    const session = this.session(id)
    const next = session.chain.then(operation, operation)
    // A failed snapshot must not poison the queue.
    session.chain = next.catch(() => {})
    return next
  }

  /**
   * Wait for every queued snapshot of one session.
   * @param {string} id - session id.
   * @returns {Promise<void>} resolves when the queue is empty.
   */
  async settled(id) {
    await this.sessions.get(id)?.chain.catch(() => {})
  }

  /**
   * Wait for every queued snapshot of every session.
   * @returns {Promise<void>} resolves when all queues are empty.
   */
  async settledAll() {
    await Promise.all([...this.sessions.values()].map(session => session.chain.catch(() => {})))
  }

  /**
   * Record one checkpoint entry.
   * @param {string} id - session id.
   * @param {CheckpointEntry} entry - recorded turn.
   * @returns {void}
   */
  record(id, entry) {
    this.session(id).entries.set(entry.startSeq, entry)
  }

  /**
   * Read one recorded turn by its `turn/start` seq.
   * @param {string} id - session id.
   * @param {number} startSeq - seq of the turn's `turn/start` event.
   * @returns {CheckpointEntry | undefined} the entry, when recorded.
   */
  get(id, startSeq) {
    return this.sessions.get(id)?.entries.get(startSeq)
  }

  /**
   * Every recorded turn of one session, in log order.
   * @param {string} id - session id.
   * @returns {CheckpointEntry[]} recorded entries.
   */
  list(id) {
    const session = this.sessions.get(id)
    if (session === undefined) return []
    return [...session.entries.values()].sort((left, right) => left.startSeq - right.startSeq)
  }

  /**
   * Mark one turn as running.
   * @param {string} id - session id.
   * @param {number} turn - turn number.
   * @returns {void}
   */
  openTurn(id, turn) {
    this.session(id).open.add(turn)
  }

  /**
   * Mark one turn as finished.
   * @param {string} id - session id.
   * @param {number} turn - turn number.
   * @returns {void}
   */
  closeTurn(id, turn) {
    this.sessions.get(id)?.open.delete(turn)
  }

  /**
   * Whether any turn of this session is still running.
   * @param {string} id - session id.
   * @returns {boolean} true while a turn is open.
   */
  hasOpenTurn(id) {
    return (this.sessions.get(id)?.open.size ?? 0) > 0
  }

  /**
   * Forget one session and remove its private snapshot directory.
   * @param {string} id - session id.
   * @returns {Promise<void>} resolves once the directory is gone.
   */
  async forget(id) {
    const session = this.sessions.get(id)
    this.sessions.delete(id)
    if (session === undefined) return
    await rm(session.dir, { recursive: true, force: true }).catch(() => {})
  }

  /**
   * Remove every private directory.
   * @returns {Promise<void>} resolves once they are gone.
   */
  async clear() {
    const ids = [...this.sessions.keys()]
    this.sessions.clear()
    await Promise.all(ids.map(id => rm(join(this.root, id), { recursive: true, force: true }).catch(() => {})))
  }

  /**
   * Remove leftover directories older than a cutoff, from earlier processes.
   * @param {number} maxAgeMs - age above which a directory is removed.
   * @returns {Promise<number>} number of removed directories.
   */
  async prune(maxAgeMs) {
    let names
    try {
      names = await readdir(this.root)
    } catch {
      return 0
    }
    const cutoff = Date.now() - maxAgeMs
    let removed = 0
    for (const name of names) {
      if (!ID_PATTERN.test(name) || this.sessions.has(name)) continue
      const dir = join(this.root, name)
      try {
        const info = await stat(dir)
        if (info.isDirectory() && info.mtimeMs < cutoff) {
          await rm(dir, { recursive: true, force: true })
          removed += 1
        }
      } catch {
        // A racing removal is not a failure.
      }
    }
    return removed
  }
}