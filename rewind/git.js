/**
 * Git plumbing for workspace snapshots and restores.
 *
 * Every command runs through an injected `spawn(argv, options)` so the Host can
 * use the `subprocess` capability while the selftest uses `node:child_process`.
 * Snapshot objects land in a per-session private object store; the repository's
 * object store is attached read-only as an alternate, so `add`/`write-tree`
 * never write into the user's repository, index, or refs.
 *
 * @module @mrmark019/dsh-session-rewind/rewind/git
 */

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Milliseconds a git child gets to exit after termination starts. */
export const TERMINATE_GRACE_MS = 2_000

/** Retained stderr tail for diagnostics. */
export const STDERR_TAIL_BYTES = 16 * 1024

/** The environment every git command runs under, merged before caller overrides. */
const BASE_ENV = Object.freeze({
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
})

/**
 * One settled git command.
 * @typedef {{ exitCode: number | null, stdout: string, stderr: string, truncated: boolean }} GitRunResult
 */

/**
 * Thrown for a failed git command; carries git's stderr for the report.
 */
export class GitError extends Error {
  /**
   * @param {string} what - command description.
   * @param {string} stderr - git's stderr tail.
   */
  constructor(what, stderr) {
    super(`${what} failed: ${stderr.trim()}`)
    this.name = 'GitError'
  }
}

/**
 * Reject a failed command with its stderr.
 * @param {GitRunResult} result - settled command facts.
 * @param {string} what - command description for the error message.
 * @returns {GitRunResult} the same result when it exited zero.
 */
export function ok(result, what) {
  if (result.exitCode !== 0) throw new GitError(what, result.stderr)
  return result
}

/**
 * Run `git <args>` through the injected spawn function.
 */
export class GitRunner {
  /**
   * @param {string} executable - resolved git executable.
   * @param {(argv: string[], options: object) => Promise<GitRunResult>} spawn - spawn adapter.
   * @param {{ outputMaxBytes: number }} limits - stdout cap defaults.
   */
  constructor(executable, spawn, limits) {
    this.executable = executable
    this.spawn = spawn
    this.limits = limits
  }

  /**
   * Run one git command to completion.
   * @param {readonly string[]} args - git arguments; never shell-interpreted.
   * @param {{ cwd: string, env?: Record<string, string>, stdin?: string, maxBytes?: number, signal?: AbortSignal }} options - run facts.
   * @returns {Promise<GitRunResult>} exit facts and collected output.
   */
  async exec(args, options) {
    const env = { ...BASE_ENV, ...options.env }
    return this.spawn([this.executable, ...args], {
      cwd: options.cwd,
      env,
      stdin: options.stdin,
      maxBytes: options.maxBytes ?? this.limits.outputMaxBytes,
      signal: options.signal,
    })
  }
}

/**
 * @typedef {object} GitWorkspace
 * @property {string} root - repository top-level directory; every diff path is relative to it.
 * @property {string} gitDir - absolute git directory holding the repository index.
 * @property {string} scratch - private directory holding the snapshot object store and scratch indexes.
 * @property {Record<string, string>} env - routes object writes to the private store, reads through the repository's store.
 * @property {readonly string[]} excludes - work-tree pathspecs a snapshot must skip.
 */

/**
 * Resolve a path to its canonical spelling, falling back to the given path.
 * @param {string} path - path to canonicalize.
 * @returns {Promise<string>} canonical path.
 */
async function canonical(path) {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Whether `inner` lies strictly inside `outer`.
 * @param {string} outer - container path.
 * @param {string} inner - candidate path.
 * @returns {boolean} true when inner is under outer.
 */
export function isStrictlyInside(outer, inner) {
  const rel = relative(outer, inner)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return false
  // Two paths on different Windows drives have no common ancestor, and
  // `relative` answers with the absolute target; that is not "inside".
  return !isAbsolute(rel)
}

/**
 * Locate the repository enclosing a working directory and prepare its private
 * snapshot directory. Returns null when the directory is outside any repository;
 * other git failures throw.
 * @param {GitRunner} git - command runner.
 * @param {string} cwd - absolute working directory.
 * @param {string} scratch - private directory for this session's objects and indexes.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<GitWorkspace | null>} the repository, or null outside one.
 */
export async function locateWorkspace(git, cwd, scratch, signal) {
  const found = await git.exec(
    ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'],
    { cwd, signal },
  )
  if (found.exitCode === 128 && /not a git repository/i.test(found.stderr)) return null
  const lines = ok(found, 'git rev-parse').stdout.split('\n').map(line => resolve(cwd, line))
  const [root, gitDir, repositoryObjects] = lines
  if (typeof root !== 'string' || typeof gitDir !== 'string' || typeof repositoryObjects !== 'string') {
    throw new Error('git rev-parse returned an unexpected shape')
  }
  const directory = await canonical(scratch)
  const objects = join(directory, 'objects')
  await mkdir(objects, { recursive: true })
  const canonicalRoot = await canonical(root)
  const excludes = isStrictlyInside(canonicalRoot, directory) ? [relative(canonicalRoot, directory).split(sep).join('/')] : []
  return {
    root: canonicalRoot,
    gitDir: await canonical(gitDir),
    scratch: directory,
    env: { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects },
    excludes,
  }
}

/**
 * Write the complete work tree — tracked, modified, and untracked but not
 * ignored — into a tree object through a private index seeded from the
 * repository's index.
 * @param {GitRunner} git - command runner.
 * @param {GitWorkspace} workspace - addressed repository.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<string>} tree object id.
 */
export async function snapshotTree(git, workspace, signal) {
  // A flat index file rather than a created directory: fewer filesystem steps
  // between the turn boundary and the first git command.
  const index = join(workspace.scratch, `snapshot-${randomUUID()}.index`)
  try {
    // A missing or momentarily locked repository index is not fatal: an empty
    // start index only costs a full re-hash of the worktree.
    await copyFile(join(workspace.gitDir, 'index'), index).catch(() => {})
    const env = { ...workspace.env, GIT_INDEX_FILE: index }
    const pathspec = workspace.excludes.length === 0
      ? []
      : ['--', '.', ...workspace.excludes.map(path => `:(exclude)${path}`)]
    // `--ignore-errors` skips unreadable files and reports them through exit code 1.
    const added = await git.exec(['add', '--all', '--ignore-errors', ...pathspec], {
      cwd: workspace.root, env, signal,
    })
    if (added.exitCode !== 1) ok(added, `git add in ${workspace.root}`)
    return ok(await git.exec(['write-tree'], { cwd: workspace.root, env, signal }), 'git write-tree').stdout.trim()
  } finally {
    await rm(index, { force: true }).catch(() => {})
    await rm(`${index}.lock`, { force: true }).catch(() => {})
  }
}

/**
 * Whether the private object store still holds a tree object.
 * @param {GitRunner} git - command runner.
 * @param {GitWorkspace} workspace - addressed repository.
 * @param {string} tree - tree id.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<boolean>} true when the object is readable.
 */
export async function hasTree(git, workspace, tree, signal) {
  const result = await git.exec(['cat-file', '-e', `${tree}^{tree}`], { cwd: workspace.root, env: workspace.env, signal })
  return result.exitCode === 0
}

/**
 * One `--name-status` record between two snapshot trees.
 * @typedef {{ status: 'A' | 'M' | 'D' | 'T' | 'R' | 'C' | string, path: string }} TreeChange
 */

/**
 * Compare two snapshot trees and report each changed path.
 * @param {GitRunner} git - command runner.
 * @param {GitWorkspace} workspace - addressed repository.
 * @param {string} target - tree the worktree should return to.
 * @param {string} current - tree describing the worktree now.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<TreeChange[]>} changed paths relative to the repository root.
 */
export async function diffNameStatus(git, workspace, target, current, signal) {
  if (target === current) return []
  const result = ok(await git.exec(['diff-tree', '-r', '-z', '--name-status', target, current], {
    cwd: workspace.root, env: workspace.env, signal,
  }), 'git diff-tree')
  if (result.truncated) throw new Error('git diff-tree output exceeded the configured cap')
  const parts = result.stdout.split('\0')
  const changes = []
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index]
    const path = parts[index + 1]
    if (typeof status !== 'string' || status === '' || typeof path !== 'string' || path === '') continue
    changes.push({ status: status[0], path })
  }
  return changes
}

/**
 * Load one snapshot tree into a private index file.
 * @param {GitRunner} git - command runner.
 * @param {GitWorkspace} workspace - addressed repository.
 * @param {string} tree - tree id to load.
 * @param {string} indexFile - private index path.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<void>} resolves when the index holds the tree.
 */
export async function readTreeIntoIndex(git, workspace, tree, indexFile, signal) {
  ok(await git.exec(['read-tree', tree], {
    cwd: workspace.root, env: { ...workspace.env, GIT_INDEX_FILE: indexFile }, signal,
  }), 'git read-tree')
}

/**
 * Write the named paths from a private index into the worktree.
 * Binary-safe and mode-preserving: content comes straight from the object store
 * through git's own checkout, never through a text decode.
 * @param {GitRunner} git - command runner.
 * @param {import('./git.js').GitWorkspace} workspace - addressed repository.
 * @param {string} indexFile - private index holding the target tree.
 * @param {readonly string[]} paths - slash-separated paths relative to the repository root.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<{ failed: { path: string, reason: string }[] }>} per-path failures.
 */
export async function checkoutPaths(git, workspace, indexFile, paths, signal) {
  if (paths.length === 0) return { failed: [] }
  const env = { ...workspace.env, GIT_INDEX_FILE: indexFile }
  // NUL-terminated with no trailing newline: a newline would be read as an extra path.
  const stdin = paths.map(path => `${path}\0`).join('')
  const all = await git.exec(['checkout-index', '-f', '-z', '--stdin'], {
    cwd: workspace.root, env, stdin, signal,
  })
  if (all.exitCode === 0) return { failed: [] }
  // Retry one path at a time so a locked file does not block the rest.
  const failed = []
  for (const path of paths) {
    const one = await git.exec(['checkout-index', '-f', '-z', '--stdin'], {
      cwd: workspace.root, env, stdin: `${path}\0`, signal,
    })
    if (one.exitCode !== 0) failed.push({ path, reason: one.stderr.trim().slice(0, 300) || 'checkout failed' })
  }
  return { failed }
}

/**
 * Object ids the repository index already records for the given paths.
 * @param {GitRunner} git - command runner.
 * @param {GitWorkspace} workspace - addressed repository.
 * @param {readonly string[]} paths - path names.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<Map<string, string>>} path to blob id, unmerged entries omitted.
 */
export async function indexEntries(git, workspace, paths, signal) {
  if (paths.length === 0) return new Map()
  const result = ok(await git.exec(['ls-files', '-s', '-z', '--', ...paths], {
    cwd: workspace.root, env: { ...workspace.env, GIT_LITERAL_PATHSPECS: '1' }, signal,
  }), 'git ls-files')
  const entries = new Map()
  for (const record of result.stdout.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const fields = record.slice(0, tab).split(' ')
    if (fields.length < 3 || fields[2] !== '0') continue
    entries.set(record.slice(tab + 1), fields[1])
  }
  return entries
}

/**
 * Blob ids the worktree would produce for the given paths, through the same
 * clean filters `git add` applies.
 * @param {GitRunner} git - command runner.
 * @param {GitWorkspace} workspace - addressed repository.
 * @param {readonly string[]} paths - path names.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<string[]>} blob ids in input order.
 */
export async function hashObjects(git, workspace, paths, signal) {
  if (paths.length === 0) return []
  const result = ok(await git.exec(['hash-object', '--stdin-paths'], {
    cwd: workspace.root, env: workspace.env, stdin: paths.map(path => `${path}\n`).join(''), signal,
  }), 'git hash-object')
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * Record the current worktree stat data for already-tracked paths.
 * `git add` re-hashes through the clean filters, so an unchanged blob leaves the
 * staged content identical while the index stat cache becomes accurate again.
 * Without this, `git status` reports restored files as modified even though
 * `git diff` proves their content matches.
 * @param {GitRunner} git - command runner.
 * @param {GitWorkspace} workspace - addressed repository.
 * @param {readonly string[]} paths - path names.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<number>} number of paths whose stat data was refreshed.
 */
export async function refreshWorktreeStat(git, workspace, paths, signal) {
  const tracked = await indexEntries(git, workspace, paths, signal)
  const candidates = paths.filter(path => tracked.has(path))
  if (candidates.length === 0) return 0
  const hashes = await hashObjects(git, workspace, candidates, signal)
  if (hashes.length !== candidates.length) return 0
  // Only paths whose restored content already equals the staged blob are
  // refreshed; anything else would silently restage the user's work.
  const unchanged = candidates.filter((path, index) => hashes[index] === tracked.get(path))
  if (unchanged.length === 0) return 0
  await git.exec(['add', '--', ...unchanged], {
    cwd: workspace.root, env: { ...workspace.env, GIT_LITERAL_PATHSPECS: '1' }, signal,
  })
  return unchanged.length
}