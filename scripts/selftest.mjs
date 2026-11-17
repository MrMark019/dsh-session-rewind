/**
 * Self-test for the snapshot and restore core, without Cordis.
 *
 * Builds a throwaway git repository under the OS temporary directory, snapshots
 * it, changes it the way a turn would, restores the snapshot, and proves the
 * worktree returns to the recorded state — while the repository's own index and
 * object store stay untouched.
 *
 * Run with: node scripts/selftest.mjs
 *
 * @module @mrmark019/dsh-session-rewind/scripts/selftest
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GitRunner, diffNameStatus, hasTree, isStrictlyInside, locateWorkspace, snapshotTree,
} from '../rewind/git.js'
import { applyRestore, planRestore } from '../rewind/restore.js'

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
 * Hash one file's bytes.
 * @param {string} path - file to hash.
 * @returns {Promise<string>} hex digest, or 'missing'.
 */
async function fileHash(path) {
  try {
    return createHash('sha1').update(await readFile(path)).digest('hex')
  } catch {
    return 'missing'
  }
}

/**
 * Count files under a directory.
 * @param {string} path - directory.
 * @returns {Promise<number>} file count.
 */
async function countFiles(path) {
  let total = 0
  let names
  try {
    names = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of names) {
    if (entry.isDirectory()) total += await countFiles(join(path, entry.name))
    else total += 1
  }
  return total
}

/**
 * Spawn git synchronously for the test adapter.
 * @param {string[]} argv - executable and arguments.
 * @param {{ cwd: string, env: Record<string, string>, stdin?: string, maxBytes: number }} options - run facts.
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, truncated: boolean }>} settled facts.
 */
async function spawn(argv, options) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    input: options.stdin,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: Math.max(options.maxBytes, 4 * 1024 * 1024),
  })
  const stdout = result.stdout ?? ''
  return {
    exitCode: result.status,
    stdout,
    stderr: result.stderr ?? '',
    truncated: stdout.length >= options.maxBytes,
  }
}

/**
 * Run git and return trimmed stdout, for assertions only.
 * @param {string} cwd - repository directory.
 * @param {string[]} args - git arguments.
 * @returns {string} trimmed output.
 */
function gitText(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return (result.stdout ?? '').trimEnd()
}

/**
 * Throwaway repository with the files the cases need.
 * @param {string} root - scratch parent.
 * @returns {Promise<{ repo: string, objectsBefore: number, staged: string }>} fixture facts.
 */
async function createFixture(root) {
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  const run = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  run(['init', '-q'])
  await writeFile(join(repo, 'keep.txt'), 'keep\n')
  await writeFile(join(repo, 'modify.txt'), 'before\n')
  await writeFile(join(repo, 'remove.txt'), 'here before\n')
  await writeFile(join(repo, 'blob \u6570\u636e.bin'), Buffer.from([0, 1, 2, 3, 254, 255, 128, 10, 13, 0]))
  await writeFile(join(repo, '.gitignore'), 'ignored/\n*.log\n')
  run(['add', '-A'])
  run(['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '-q', '-m', 'baseline'])
  return {
    repo,
    objectsBefore: await countFiles(join(repo, '.git', 'objects')),
    staged: gitText(repo, ['ls-files', '-s']),
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-selftest-'))
const scratch = join(root, 'scratch')
await mkdir(scratch, { recursive: true })
try {
  console.log('fixture')
  const fixture = await createFixture(root)
  const { repo } = fixture
  const git = new GitRunner('git', spawn, { outputMaxBytes: 8 * 1024 * 1024 })

  const workspace = await locateWorkspace(git, repo, scratch, undefined)
  check(workspace !== null, 'locateWorkspace finds the repository')
  if (workspace === null) throw new Error('no workspace')

  console.log('path containment')
  // Regression: the snapshot exclude list must stay empty when the private store
  // lives outside the repository. A Windows drive mismatch broke this and made
  // every snapshot fail with "is outside repository".
  if (process.platform === 'win32') {
    check(isStrictlyInside('D:\\repo', 'D:\\repo\\sub'), 'a nested directory counts as inside')
    check(!isStrictlyInside('D:\\repo', 'D:\\repo2'), 'a sibling directory does not')
    check(!isStrictlyInside('D:\\repo', 'C:\\Users\\x\\Temp'), 'a directory on another drive does not')
  } else {
    check(isStrictlyInside('/repo', '/repo/sub'), 'a nested directory counts as inside')
    check(!isStrictlyInside('/repo', '/repo2'), 'a sibling directory does not')
    check(!isStrictlyInside('/repo', '/tmp/x'), 'an unrelated directory does not')
  }

  console.log('snapshot')
  const target = await snapshotTree(git, workspace, undefined)
  check(/^[0-9a-f]{40,64}$/.test(target), `snapshotTree returns a tree id (${target})`)
  check(await hasTree(git, workspace, target, undefined), 'the private store still holds the tree')

  // A turn: edit, delete, add, and touch an ignored file.
  await writeFile(join(repo, 'modify.txt'), 'after\n')
  await writeFile(join(repo, 'added.txt'), 'added by the turn\n')
  await rm(join(repo, 'remove.txt'))
  await writeFile(join(repo, 'blob \u6570\u636e.bin'), Buffer.from([9, 9, 9]))
  await mkdir(join(repo, 'ignored'), { recursive: true })
  await writeFile(join(repo, 'ignored', 'build.log'), 'ignored output\n')

  const current = await snapshotTree(git, workspace, undefined)
  const changes = await diffNameStatus(git, workspace, target, current, undefined)
  check(changes.length === 4, `diffNameStatus reports every changed path (${changes.length})`)
  check(changes.some(change => change.path === 'added.txt' && change.status === 'A'), 'added.txt is reported as A')
  check(changes.some(change => change.path === 'remove.txt' && change.status === 'D'), 'remove.txt is reported as D')
  check(changes.some(change => change.path === 'modify.txt' && change.status === 'M'), 'modify.txt is reported as M')
  check(!changes.some(change => change.path.startsWith('ignored/')), 'ignored paths stay out of the comparison')

  console.log('plan')
  const plan = planRestore(changes, 500)
  check(plan.restore.length === 3 && plan.remove.length === 1, 'plan splits rewrites and removals')
  let tooMany = null
  try {
    planRestore(changes, 2)
  } catch (error) {
    tooMany = error
  }
  check(tooMany?.code === 'too-many-files', 'planRestore enforces maxFiles')
  let unsafe = null
  try {
    planRestore([{ status: 'M', path: '../escape.txt' }], 100)
  } catch {
    unsafe = true
  }
  check(unsafe === true, 'planRestore rejects a path that escapes the repository')

  console.log('restore')
  const outcome = await applyRestore({ git, workspace, targetTree: target, plan, signal: undefined })
  check(outcome.failed.length === 0, `applyRestore reports no failures (${JSON.stringify(outcome.failed)})`)
  check(outcome.restored.length === 3, 'three paths were rewritten')
  check(outcome.removed.length === 1, 'one added path was removed')

  const status = gitText(repo, ['status', '--porcelain'])
  check(status === '', `git status is clean after the restore (${JSON.stringify(status)})`)
  const marker = await mkdtemp(join(root, 'verify-'))
  const verifyIndex = join(marker, 'index')
  await writeFile(verifyIndex, await readFile(join(repo, '.git', 'index')))
  const verifyEnv = { ...workspace.env, GIT_INDEX_FILE: verifyIndex }
  await spawn(['git', 'add', '--all', '--ignore-errors'], { cwd: repo, env: verifyEnv, maxBytes: 8 * 1024 * 1024 })
  const after = (await git.exec(['write-tree'], { cwd: repo, env: verifyEnv, signal: undefined })).stdout.trim()
  check(after === target, `the worktree returns to the recorded tree (${after} === ${target})`)

  check(await fileHash(join(repo, 'modify.txt')) !== 'missing', 'modify.txt exists again')
  check(
    gitText(repo, ['hash-object', '--', 'modify.txt']) === gitText(repo, ['rev-parse', `${target}:modify.txt`]),
    'modify.txt has its recorded content',
  )
  check(
    gitText(repo, ['hash-object', '--', 'remove.txt']) === gitText(repo, ['rev-parse', `${target}:remove.txt`]),
    'remove.txt came back with its recorded content',
  )
  check(await fileHash(join(repo, 'added.txt')) === 'missing', 'added.txt was deleted')
  const blob = await readFile(join(repo, 'blob \u6570\u636e.bin'))
  check(blob.equals(Buffer.from([0, 1, 2, 3, 254, 255, 128, 10, 13, 0])), 'the binary file is byte-exact')
  check((await readFile(join(repo, 'ignored', 'build.log'), 'utf8')) === 'ignored output\n', 'the ignored file was untouched')

  console.log('repository safety')
  check(
    gitText(repo, ['ls-files', '-s']) === fixture.staged,
    'the staged content is identical to before the turn',
  )
  check(await countFiles(join(repo, '.git', 'objects')) === fixture.objectsBefore, 'the repository object store gained nothing')
  for (const leftover of [marker]) await rm(leftover, { recursive: true, force: true })
} finally {
  await rm(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}