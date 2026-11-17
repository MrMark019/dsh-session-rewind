/**
 * Turn a snapshot comparison into a restore plan and apply it.
 *
 * The plan is expressed relative to the repository root and only ever names
 * paths git itself reported between the two snapshot trees, so nothing outside
 * the compared trees is touched. Restores go through `git checkout-index`, which
 * keeps binary content and file modes exact; removals delete only paths that did
 * not exist in the target snapshot.
 *
 * @module @mrmark019/dsh-session-rewind/rewind/restore
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { checkoutPaths, readTreeIntoIndex, refreshWorktreeStat } from './git.js'

/**
 * @typedef {{ restore: string[], remove: string[] }} RestorePlan
 */

/**
 * Reject a path that could escape the repository root.
 * @param {string} path - slash-separated path reported by git.
 * @returns {string} the same path when it is a plain relative path.
 */
export function assertSafePath(path) {
  if (typeof path !== 'string' || path === '') throw new Error('empty path in restore plan')
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`absolute path in restore plan: ${path}`)
  }
  if (/[\n\r]/.test(path)) throw new Error('path with a line break in restore plan')
  const segments = path.split('/')
  if (segments.some(segment => segment === '..' || segment === '.' || segment === '')) {
    throw new Error(`unsafe path in restore plan: ${path}`)
  }
  if (path === '.git' || path.startsWith('.git/')) throw new Error(`refusing to touch ${path}`)
  return path
}

/**
 * Split changed paths into paths to rewrite from the target snapshot and paths
 * to delete.
 * @param {readonly { status: string, path: string }[]} changes - `--name-status` records.
 * @param {number} maxFiles - inclusive cap on planned operations.
 * @returns {RestorePlan} the plan.
 * @throws when the plan exceeds `maxFiles` or names an unsafe path.
 */
export function planRestore(changes, maxFiles) {
  /** @type {RestorePlan} */
  const plan = { restore: [], remove: [] }
  for (const change of changes) {
    const path = assertSafePath(change.path)
    if (change.status === 'A') plan.remove.push(path)
    else plan.restore.push(path)
  }
  const total = plan.restore.length + plan.remove.length
  if (total > maxFiles) {
    const error = new Error(`restore plan covers ${total} paths, above the ${maxFiles} limit`)
    error.code = 'too-many-files'
    throw error
  }
  return plan
}

/**
 * Resolve a slash-separated path inside the repository root.
 * @param {string} root - repository top-level directory.
 * @param {string} path - safe relative path.
 * @returns {string} absolute path proven to stay inside `root`.
 */
function worktreePath(root, path) {
  const absolute = resolve(root, ...path.split('/'))
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error(`path escapes the repository root: ${path}`)
  }
  return absolute
}

/**
 * Apply a restore plan to the worktree.
 *
 * Restored content comes from `git checkout-index`, so binary bytes, symlinks,
 * and configured smudge filters behave exactly as in a normal checkout. The last
 * step re-records the stat data of paths whose content already matched the
 * staged blob: without it `git status` reports them as modified even though
 * `git diff` proves them equal. Staged content is never changed, because only
 * paths whose blob id already matches are refreshed.
 *
 * @param {object} input - restore facts.
 * @param {import('./git.js').GitRunner} input.git - command runner.
 * @param {import('./git.js').GitWorkspace} input.workspace - addressed repository.
 * @param {string} input.targetTree - snapshot tree the worktree should return to.
 * @param {RestorePlan} input.plan - paths to rewrite and delete.
 * @param {AbortSignal | undefined} input.signal - cancellation.
 * @returns {Promise<{ restored: string[], removed: string[], failed: { path: string, reason: string }[] }>} outcome.
 */
export async function applyRestore({ git, workspace, targetTree, plan, signal }) {
  const failed = []
  let restored = []
  if (plan.restore.length > 0) {
    const indexFile = join(workspace.scratch, `restore-${randomUUID()}.index`)
    try {
      await readTreeIntoIndex(git, workspace, targetTree, indexFile, signal)
      const outcome = await checkoutPaths(git, workspace, indexFile, plan.restore, signal)
      for (const failure of outcome.failed) failed.push(failure)
      const failedPaths = new Set(outcome.failed.map(failure => failure.path))
      restored = plan.restore.filter(path => !failedPaths.has(path))
    } finally {
      await rm(indexFile, { force: true }).catch(() => {})
    }
    await refreshWorktreeStat(git, workspace, restored, signal).catch(() => {})
  }
  const removed = []
  for (const path of plan.remove) {
    try {
      await rm(worktreePath(workspace.root, path), { force: true })
      removed.push(path)
    } catch (error) {
      failed.push({ path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { restored, removed, failed }
}