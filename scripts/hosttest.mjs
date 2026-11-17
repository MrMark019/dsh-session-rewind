/**
 * Host-half wiring test: loads the real plugin entry with a stub Cordis context
 * and drives it the way the runtime does.
 *
 * It proves what the module tests cannot: the `session/event` listener records a
 * checkpoint before the turn's tools mutate anything, the routes registered on
 * the authenticated channel answer, the busy guard fires while a turn is open,
 * and a rewind returns the seq to cut the conversation at.
 *
 * Run with: node scripts/hosttest.mjs
 *
 * @module @mrmark019/dsh-session-rewind/scripts/hosttest
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, LIST_PATH, REWIND_PATH } from '../index.js'

let failures = 0

/**
 * Record one assertion.
 * @param {boolean} condition - assertion outcome.
 * @param {string} label - human-readable expectation.
 * @returns {void}
 */
function check(condition, label) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}`)
}

/**
 * Spawn adapter over `spawnSync`, shaped like the subprocess capability.
 * @param {string[]} argv - executable and arguments.
 * @param {{ cwd: string, env: Record<string, string>, stdin?: string, maxBytes: number }} spec - run facts.
 * @returns {object} a handle with `done` and `collected`.
 */
function fakeSpawn(argv, spec) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    input: spec.stdin,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: Math.max(spec.maxBytes, 4 * 1024 * 1024),
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return {
    done: Promise.resolve({ exitCode: result.status }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
    },
  }
}

/**
 * Minimal Cordis context with only the members this plugin touches.
 * @param {{ cwd: string, history: object[] }} facts - session directory and pre-install events.
 * @returns {object} the stub host.
 */
function createHost(facts) {
  const listeners = new Map()
  const routes = new Map()
  const disposers = []
  const ctx = {
    logger: { info: () => {}, warn: message => console.log(`  warn ${message}`) },
    effect(callback) { disposers.push(callback()) },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
    },
    workingDirectory: { get: () => facts.cwd },
    sessions: { get: () => undefined },
    sessionQuery: { readSession: async () => ({ session: {}, inheritedEventCount: 0, events: facts.history }) },
    subprocess: {
      resolveExecutable: async () => 'git',
      spawn: spec => fakeSpawn(spec.argv, {
        cwd: spec.cwd,
        env: spec.env,
        stdin: spec.stdio.stdin?.data,
        maxBytes: spec.stdio.stdout.maxBytes,
      }),
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        },
      },
    },
  }
  return {
    ctx,
    routes,
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) void listener(...args)
    },
    async emitAsync(name, ...args) {
      for (const listener of listeners.get(name) ?? []) await listener(...args)
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose?.()
    },
  }
}

/**
 * POST one route the way the browser half does.
 * @param {object} route - registered route.
 * @param {object} body - JSON body.
 * @returns {Promise<{ status: number, payload: object }>} normalized answer.
 */
async function call(route, body) {
  const request = new Request(`http://dsh.invalid${route.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await route.fetch(request)
  return { status: response.status, payload: await response.json() }
}

/**
 * One git assertion helper.
 * @param {string} cwd - repository directory.
 * @param {string[]} args - git arguments.
 * @returns {string} trimmed stdout.
 */
function gitText(cwd, args) {
  return (spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout ?? '').trimEnd()
}

const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-hosttest-'))
const repo = join(root, 'repo')
const sessionId = 'session-rewind-hosttest'
try {
  await mkdir(repo, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: repo })
  await writeFile(join(repo, 'current.txt'), 'turn-one value\n')
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'], { cwd: repo })

  // What the log holds before this process started: turn 1 closed at seq 14 and
  // turn 2 opening at seq 15 (the same turn the recorder is about to observe).
  const history = [
    { type: 'turn/start', seq: 11, data: { turn: 1 } },
    { type: 'turn/end', seq: 14, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 15, data: { turn: 2 } },
  ]
  const host = createHost({ cwd: repo, history })
  apply(host.ctx, { restoreFiles: true })

  console.log('routes')
  check(host.routes.has(LIST_PATH), `${LIST_PATH} is registered`)
  check(host.routes.has(REWIND_PATH), `${REWIND_PATH} is registered`)

  console.log('recorder')
  const session = { id: sessionId, header: { cwd: repo, isSeeded: false } }
  host.emit('session/event', session, { type: 'turn/start', seq: 15, data: { turn: 2 } })
  // `tools/pre-execute` is the runtime's barrier: no tool runs before its turn's
  // snapshot settles.
  await host.emitAsync('tools/pre-execute', { agent: { session } }, () => Promise.resolve())

  const busy = await call(host.routes.get(REWIND_PATH), { sessionId, startSeq: 15, restoreFiles: true, dryRun: true })
  check(busy.status === 409 && busy.payload.code === 'session-busy', 'an open turn refuses a rewind')

  // The turn now mutates the workspace the way tools would.
  await writeFile(join(repo, 'current.txt'), 'turn-two value\n')
  await writeFile(join(repo, 'added.txt'), 'added by turn two\n')
  host.emit('session/event', session, { type: 'turn/end', seq: 18, data: { turn: 2, reason: { kind: 'completed' } } })

  const listed = await call(host.routes.get(LIST_PATH), { sessionId })
  check(listed.status === 200, 'the list route answers')
  const turns = listed.payload.turns ?? []
  check(turns.some(entry => entry.startSeq === 15 && entry.turn === 2 && entry.hasTree === true), 'the recorded turn is listed with its snapshot')
  check(turns.some(entry => entry.startSeq === 11 && entry.hasTree === false), 'a pre-install turn is listed without a snapshot')

  console.log('rewind')
  const preview = await call(host.routes.get(REWIND_PATH), { sessionId, startSeq: 15, restoreFiles: true, dryRun: true })
  check(preview.status === 200 && preview.payload.dryRun === true, 'the dry run answers')
  check(preview.payload.atSeq === 14, `the cut lands before the turn (${preview.payload.atSeq})`)
  check(preview.payload.restoreCount === 1 && preview.payload.removeCount === 1, 'the preview counts one rewrite and one removal')
  check((await readFile(join(repo, 'current.txt'), 'utf8')) === 'turn-two value\n', 'the dry run changed nothing')

  const applied = await call(host.routes.get(REWIND_PATH), { sessionId, startSeq: 15, restoreFiles: true, dryRun: false })
  check(applied.status === 200 && applied.payload.ok === true, 'the restore succeeds')
  check(applied.payload.atSeq === 14, 'the restore reports the same cut seq')
  check(applied.payload.restored === 1 && applied.payload.removed === 1, 'the restore reports one path each way')

  console.log('history-only')
  const onlyChat = await call(host.routes.get(REWIND_PATH), { sessionId, startSeq: 11, restoreFiles: false, dryRun: false })
  check(onlyChat.status === 200 && onlyChat.payload.restored === 0, 'a turn without a snapshot rewinds the conversation only')
  check(onlyChat.payload.atSeq === 10, 'its cut seq is the one before the turn')
  const noSnapshot = await call(host.routes.get(REWIND_PATH), { sessionId, startSeq: 11, restoreFiles: true, dryRun: true })
  check(noSnapshot.status === 409 && noSnapshot.payload.code === 'no-snapshot', 'asking for files there reports no-snapshot')

  const bad = await call(host.routes.get(REWIND_PATH), { sessionId, startSeq: 999, dryRun: true })
  check(bad.status === 404 && bad.payload.code === 'no-checkpoint', 'an unknown boundary is rejected')

  console.log('files')
  const restoredText = (await readFile(join(repo, 'current.txt'), 'utf8')).replaceAll('\r\n', '\n')
  check(restoredText === 'turn-one value\n', 'the workspace is back to the recorded content')
  check(gitText(repo, ['status', '--porcelain']) === '', 'git status is clean afterwards')
  check(!(await readFile(join(repo, 'added.txt'), 'utf8').then(() => true, () => false)), 'the file the turn added is gone')

  console.log('restart')
  // The index write is fire-and-forget in the plugin; give it a tick.
  await new Promise(resolve => setTimeout(resolve, 300))
  await host.dispose()
  const storeDir = join(tmpdir(), 'dsh-session-rewind', sessionId)
  check(
    await readFile(join(storeDir, 'index.json'), 'utf8').then(() => true, () => false),
    'the checkpoint index is on disk',
  )
  await writeFile(join(repo, 'current.txt'), 'after restart\n')
  const restarted = createHost({ cwd: repo, history })
  apply(restarted.ctx, {})
  const listedAgain = await call(restarted.routes.get(LIST_PATH), { sessionId })
  check(
    (listedAgain.payload.turns ?? []).some(entry => entry.startSeq === 15 && entry.hasTree === true),
    'a restarted Host still lists the snapshot',
  )
  const replay = await call(restarted.routes.get(REWIND_PATH), { sessionId, startSeq: 15, restoreFiles: true, dryRun: false })
  check(replay.status === 200 && replay.payload.restored === 1, 'a restarted Host can still restore it')
  const replayedText = (await readFile(join(repo, 'current.txt'), 'utf8')).replaceAll('\r\n', '\n')
  check(replayedText === 'turn-one value\n', 'the file is restored after the restart')
  await restarted.dispose()
  await rm(storeDir, { recursive: true, force: true })
} finally {
  await rm(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}