/**
 * Host half of the session-rewind plugin.
 *
 * Two jobs: record a workspace snapshot when a top-level turn starts, and serve
 * the two authenticated routes the browser half calls — the turn list that
 * decides where the rewind action may appear, and the rewind itself, which
 * restores files and reports the exact event seq to cut the conversation at.
 *
 * A snapshot completes before any tool of its turn can run, so the tree really
 * is the worktree as the turn found it. Snapshots write into a per-session
 * private object store; the repository's index, refs, and object store are never
 * written.
 *
 * The conversation half stays out of this file: the browser forks the session
 * through the shipped `ctx.sessions.fork`, exactly as the built-in branch action
 * does, using the `atSeq` this plugin returns.
 *
 * @module @mrmark019/dsh-session-rewind
 */

import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GitRunner,
  STDERR_TAIL_BYTES,
  TERMINATE_GRACE_MS,
  diffNameStatus,
  hasTree,
  locateWorkspace,
  snapshotTree,
} from './rewind/git.js'
import { applyRestore, planRestore } from './rewind/restore.js'
import { CheckpointStore, assertSessionId } from './rewind/store.js'

/** Loader entry label; keeps diagnostics readable. */
export const name = 'session-rewind'

/** Services this plugin needs; it stays inactive in profiles without them. */
export const inject = ['connection', 'sessions', 'sessionQuery', 'subprocess', 'workingDirectory']

/** Absolute registration path of the turn-list route on the authenticated `/api` channel. */
export const LIST_PATH = '/api/session.rewind/list'

/** Absolute registration path of the rewind route on the authenticated `/api` channel. */
export const REWIND_PATH = '/api/session.rewind'

/** Age above which a leftover private snapshot directory is removed at startup. */
const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Bound on the per-request warning list echoed to the browser. */
const MAX_WARNINGS = 20

/**
 * Normalize the row's configuration.
 * @param {unknown} config - raw loader row config.
 * @returns {{ restoreFiles: boolean, maxFiles: number, timeoutMs: number, maxScanEvents: number, outputMaxBytes: number }} resolved options.
 */
export function normalizeOptions(config) {
  const value = typeof config === 'object' && config !== null ? config : {}
  const integer = (candidate, fallback, minimum) => (
    Number.isSafeInteger(candidate) && candidate >= minimum ? candidate : fallback
  )
  return {
    restoreFiles: value.restoreFiles !== false,
    maxFiles: integer(value.maxFiles, 500, 1),
    timeoutMs: integer(value.timeoutMs, 30_000, 1_000),
    maxScanEvents: integer(value.maxScanEvents, 20_000, 100),
    outputMaxBytes: integer(value.outputMaxBytes, 8 * 1024 * 1024, 4 * 1024),
  }
}

/**
 * Human-readable reason for a thrown value.
 * @param {unknown} error - thrown value.
 * @returns {string} one line of text.
 */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * JSON response helper.
 * @param {number} status - HTTP status.
 * @param {unknown} body - serializable body.
 * @returns {Response} the response.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Read a JSON request body, tolerating an empty one.
 * @param {Request} request - incoming request.
 * @returns {Promise<Record<string, unknown>>} parsed body, or an empty object.
 */
async function readBody(request) {
  try {
    const parsed = await request.json()
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The working directory that decides which repository a turn snapshot covers.
 * @param {{ header?: { cwd?: unknown } }} session - live session.
 * @param {object} workingDirectory - `ctx.workingDirectory` face.
 * @returns {string | undefined} absolute directory, when the session has one.
 */
function effectiveCwd(session, workingDirectory) {
  try {
    const current = workingDirectory?.get?.(session)
    if (typeof current === 'string' && current !== '') return current
  } catch {
    // A session the service does not track falls back to its header.
  }
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Whether a session is a top-level conversation whose workspace should be recorded.
 * @param {{ header?: object }} session - live session.
 * @param {string | undefined} cwd - effective directory.
 * @returns {boolean} true for a recordable conversation.
 */
function recordable(session, cwd) {
  if (cwd === undefined) return false
  const header = session?.header
  if (header === undefined) return false
  if (header.origin === 'subagent') return false
  const depth = header.delegationDepth
  return !(typeof depth === 'number' && depth > 0)
}

/**
 * Wire the checkpoint recorder and both routes.
 * @param {object} ctx - Host context with connection, sessions, sessionQuery, subprocess, workingDirectory.
 * @param {unknown} config - raw row config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const options = normalizeOptions(config)
  /** Cancels every git command the plugin still owns. */
  const lifetime = new AbortController()
  /** Per-session checkpoints and their private object stores. */
  const store = new CheckpointStore(join(tmpdir(), 'dsh-session-rewind'))
  /** Session ids with a restore in flight. */
  const restores = new Set()
  /** Lazily scanned `turn/start` positions of sessions this process never saw from turn one. */
  const histories = new Map()

  ctx.effect(() => () => {
    // Snapshot directories are deliberately left for the startup prune: a Host
    // restart must still offer file rewind for turns it recorded earlier.
    lifetime.abort()
  }, 'session-rewind: git lifetime')
  void store.prune(PRUNE_MAX_AGE_MS).catch((error) => {
    ctx.logger?.warn?.(`session-rewind: stale snapshot cleanup failed: ${reasonOf(error)}`)
  })

  /**
   * Spawn one git child through the subprocess capability, with a timeout and a
   * scoped abort signal.
   * @param {string[]} argv - executable and arguments.
   * @param {object} spec - cwd, env, stdin, stdout cap, and cancellation.
   * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, truncated: boolean }>} settled facts.
   */
  const spawnGit = async (argv, spec) => {
    const controller = new AbortController()
    const forward = () => { controller.abort(spec.signal?.reason) }
    if (spec.signal?.aborted === true) forward()
    else spec.signal?.addEventListener('abort', forward, { once: true })
    const timer = setTimeout(() => { controller.abort(new Error(`git timed out after ${options.timeoutMs}ms`)) }, options.timeoutMs)
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: spec.cwd,
        stdio: {
          stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
          stdout: { maxBytes: spec.maxBytes },
          stderr: { maxBytes: STDERR_TAIL_BYTES },
        },
        graceMs: TERMINATE_GRACE_MS,
        signal: controller.signal,
        env: spec.env,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', forward)
    }
  }

  /** Resolved git runner, or null once the probe proves git unavailable. */
  let runnerPromise
  /**
   * Resolve git once per plugin activation.
   * @returns {Promise<GitRunner | null>} the runner, or null without git.
   */
  const gitRunner = () => {
    runnerPromise ??= (async () => {
      let executable
      try {
        executable = await ctx.subprocess.resolveExecutable('git', undefined, lifetime.signal)
      } catch {
        ctx.logger?.info?.('session-rewind: git is unavailable; only conversation rewind is offered')
        return null
      }
      if (typeof executable !== 'string' || executable === '') return null
      return new GitRunner(executable, spawnGit, { outputMaxBytes: options.outputMaxBytes })
    })()
    return runnerPromise
  }

  /**
   * Snapshot with one retry: a transient Windows sharing violation on the
   * object directory must not cost the turn its checkpoint.
   * @param {GitRunner} git - command runner.
   * @param {object} workspace - addressed repository.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @returns {Promise<string>} tree object id.
   */
  const captureTree = async (git, workspace, signal) => {
    try {
      return await snapshotTree(git, workspace, signal)
    } catch (error) {
      if (signal?.aborted === true) throw error
      await new Promise(resolve => setTimeout(resolve, 500))
      return snapshotTree(git, workspace, signal)
    }
  }

  /**
   * Seed a checkpoint entry and queue its snapshot.
   * @param {object} session - live session.
   * @param {number} turn - turn number from `turn/start`.
   * @param {number} startSeq - seq of that event.
   * @returns {void}
   */
  const beginTurn = (session, turn, startSeq) => {
    const id = String(session.id)
    store.openTurn(id, turn)
    const cwd = effectiveCwd(session, ctx.workingDirectory)
    if (!recordable(session, cwd)) return
    store.record(id, { turn, startSeq, tree: null, cwd, repoRoot: null, error: null })
    void store.enqueue(id, async () => {
      const entry = store.get(id, startSeq)
      if (entry === undefined) return
      /**
       * Record one snapshot outcome and make it survive a Host restart.
       * @param {object} patch - entry fields to replace.
       * @returns {void}
       */
      const commit = (patch) => {
        store.record(id, { ...entry, ...patch })
        void store.persist(id)
      }
      let directory
      try {
        const git = await gitRunner()
        if (git === null) {
          commit({ error: 'git-unavailable' })
          return
        }
        directory = await store.dirFor(id)
        const workspace = await locateWorkspace(git, cwd, directory, lifetime.signal)
        if (workspace === null) {
          commit({ error: 'not-a-repository' })
          return
        }
        const tree = await captureTree(git, workspace, lifetime.signal)
        commit({ tree, repoRoot: workspace.root, error: null })
      } catch (error) {
        const message = reasonOf(error)
        ctx.logger?.warn?.(`session-rewind: snapshot for turn ${turn} failed: ${message}`)
        commit({ error: message })
        // A failure the dialog can quote, kept beside the (empty) object store.
        if (directory !== undefined) {
          void appendFile(
            join(directory, 'snapshot-error.log'),
            `${new Date().toISOString()} turn ${turn}: ${message}\n`,
          ).catch(() => {})
        }
      }
    })
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') {
      beginTurn(session, event.data.turn, event.seq)
      return
    }
    if (event?.type === 'turn/end') store.closeTurn(String(session.id), event.data.turn)
  })

  ctx.on('session/disposed', (session) => {
    const id = String(session.id)
    histories.delete(id)
    void store.forget(id)
  })

  // No tool may mutate the worktree before its turn's baseline exists.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session
    if (session !== undefined) await store.settled(String(session.id))
    return next()
  })

  /**
   * `turn/start` positions of a session this process did not observe from turn one.
   * @param {string} id - session id.
   * @returns {Promise<{ turn: number, startSeq: number }[] | null>} positions, or null when the log is too large or unreadable.
   */
  const historyFor = async (id) => {
    if (histories.has(id)) return histories.get(id)
    let scanned = null
    try {
      const snapshot = await ctx.sessionQuery.readSession(id)
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      if (events.length <= options.maxScanEvents) {
        scanned = []
        for (const event of events) {
          if (event?.type !== 'turn/start') continue
          const turn = event.data?.turn
          const seq = event.seq
          if (Number.isSafeInteger(turn) && Number.isSafeInteger(seq)) scanned.push({ turn, startSeq: seq })
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`session-rewind: log scan for ${id} failed: ${reasonOf(error)}`)
    }
    histories.set(id, scanned)
    return scanned
  }

  /**
   * Every rewindable turn of one session, in log order.
   * @param {string} id - session id.
   * @returns {Promise<{ turn: number, startSeq: number, hasTree: boolean }[]>} rewindable turns.
   */
  const turnsOf = async (id) => {
    await store.load(id)
    const merged = new Map()
    for (const entry of (await historyFor(id)) ?? []) merged.set(entry.startSeq, { ...entry, hasTree: false, error: null })
    for (const entry of store.list(id)) {
      merged.set(entry.startSeq, {
        turn: entry.turn,
        startSeq: entry.startSeq,
        hasTree: entry.tree !== null,
        error: entry.error ?? null,
      })
    }
    return [...merged.values()]
      .filter(entry => entry.startSeq >= 1)
      .sort((left, right) => left.startSeq - right.startSeq)
  }

  /**
   * The recorded or historical boundary at one `turn/start` seq.
   * @param {string} id - session id.
   * @param {number} startSeq - seq to resolve.
   * @returns {Promise<{ turn: number, startSeq: number, tree: string | null, cwd?: string, repoRoot?: string | null } | undefined>} the entry.
   */
  const entryAt = async (id, startSeq) => {
    await store.load(id)
    const recorded = store.get(id, startSeq)
    if (recorded !== undefined) return recorded
    const known = await historyFor(id)
    const found = known?.find(entry => entry.startSeq === startSeq)
    return found === undefined ? undefined : { turn: found.turn, startSeq, tree: null }
  }

  /**
   * `POST /api/session.rewind/list` — where the rewind action may appear.
   * @param {Request} request - incoming request.
   * @returns {Promise<Response>} turn list.
   */
  const handleList = async (request) => {
    const body = await readBody(request)
    let id
    try {
      id = assertSessionId(typeof body.sessionId === 'string' ? body.sessionId.trim() : '')
    } catch {
      return jsonResponse(400, { ok: false, code: 'bad-request' })
    }
    try {
      const turns = await turnsOf(id)
      return jsonResponse(200, { ok: true, turns, busy: store.hasOpenTurn(id) })
    } catch (error) {
      ctx.logger?.warn?.(`session-rewind: list failed for ${id}: ${reasonOf(error)}`)
      return jsonResponse(500, { ok: false, code: 'list-failed' })
    }
  }

  /**
   * `POST /api/session.rewind` — preview or perform one rewind.
   * @param {Request} request - incoming request.
   * @returns {Promise<Response>} restore outcome or a failure code.
   */
  const handleRewind = async (request) => {
    const body = await readBody(request)
    let id
    try {
      id = assertSessionId(typeof body.sessionId === 'string' ? body.sessionId.trim() : '')
    } catch {
      return jsonResponse(400, { ok: false, code: 'bad-request' })
    }
    const startSeq = body.startSeq
    if (!Number.isSafeInteger(startSeq) || startSeq < 1) return jsonResponse(400, { ok: false, code: 'bad-request' })
    const dryRun = body.dryRun === true
    const restoreFiles = body.restoreFiles === true && options.restoreFiles
    const signal = AbortSignal.any([request.signal, lifetime.signal])
    const entry = await entryAt(id, startSeq)
    if (entry === undefined) return jsonResponse(404, { ok: false, code: 'no-checkpoint' })
    if (store.hasOpenTurn(id)) return jsonResponse(409, { ok: false, code: 'session-busy' })
    const atSeq = startSeq - 1
    if (!restoreFiles) {
      return jsonResponse(200, {
        ok: true, atSeq, dryRun, restoreCount: 0, removeCount: 0, restored: 0, removed: 0, warnings: [],
      })
    }
    if (restores.has(id)) return jsonResponse(409, { ok: false, code: 'restore-busy' })
    restores.add(id)
    try {
      const git = await gitRunner()
      if (git === null) return jsonResponse(409, { ok: false, code: 'no-git' })
      if (entry.tree === null || typeof entry.tree !== 'string') return jsonResponse(409, { ok: false, code: 'no-snapshot' })
      if (typeof entry.cwd !== 'string') return jsonResponse(409, { ok: false, code: 'no-snapshot' })
      const directory = await store.dirFor(id)
      const workspace = await locateWorkspace(git, entry.cwd, directory, signal)
      if (workspace === null) return jsonResponse(409, { ok: false, code: 'no-repository' })
      if (typeof entry.repoRoot === 'string' && entry.repoRoot !== workspace.root) {
        return jsonResponse(409, { ok: false, code: 'worktree-changed' })
      }
      if (!(await hasTree(git, workspace, entry.tree, signal))) {
        return jsonResponse(409, { ok: false, code: 'no-snapshot' })
      }
      const currentTree = await snapshotTree(git, workspace, signal)
      const changes = await diffNameStatus(git, workspace, entry.tree, currentTree, signal)
      let plan
      try {
        plan = planRestore(changes, options.maxFiles)
      } catch (error) {
        if (error?.code === 'too-many-files') return jsonResponse(409, { ok: false, code: 'too-many-files' })
        throw error
      }
      if (dryRun) {
        return jsonResponse(200, {
          ok: true, atSeq, dryRun: true,
          restoreCount: plan.restore.length, removeCount: plan.remove.length,
        })
      }
      const outcome = await applyRestore({ git, workspace, targetTree: entry.tree, plan, signal })
      ctx.logger?.info?.(
        `session-rewind: restored ${outcome.restored.length} and removed ${outcome.removed.length} paths for ${id}`,
      )
      return jsonResponse(200, {
        ok: true, atSeq, dryRun: false,
        restoreCount: plan.restore.length, removeCount: plan.remove.length,
        restored: outcome.restored.length, removed: outcome.removed.length,
        warnings: outcome.failed.slice(0, MAX_WARNINGS).map(failure => `${failure.path}: ${failure.reason}`),
      })
    } catch (error) {
      ctx.logger?.warn?.(`session-rewind: restore failed for ${id}: ${reasonOf(error)}`)
      return jsonResponse(500, { ok: false, code: 'restore-failed' })
    } finally {
      restores.delete(id)
    }
  }

  const channel = ctx.connection?.fetch
  if (typeof channel?.register !== 'function') {
    ctx.logger?.warn?.('session-rewind: no connection fetch channel; the routes stay unregistered')
    return
  }
  ctx.effect(() => {
    const disposeList = channel.register({ path: LIST_PATH, methods: ['POST'], requestBody: 'buffered', fetch: handleList })
    const disposeRewind = channel.register({ path: REWIND_PATH, methods: ['POST'], requestBody: 'buffered', fetch: handleRewind })
    return async () => {
      await disposeList()
      await disposeRewind()
    }
  }, 'session-rewind: authenticated routes')
}