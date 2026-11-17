/**
 * Browser-half smoke test: loads the real client module with a stub module
 * loader and a minimal React shim, applies it to a stub client context, and
 * renders the turn action for a boundary the server would report.
 *
 * It does not replace a real page, but it catches a broken factory, a wrong slot
 * name, a missing injected face, and a render that throws before the slot system
 * sees anything.
 *
 * Run with: node scripts/clienttest.mjs
 *
 * @module @mrmark019/dsh-session-rewind/scripts/clienttest
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/** Minimal React surface used by the module. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useRef: value => ({ current: value }),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useCallback: callback => callback,
}

/** Registrations captured from the stub slot service. */
const registrations = []
/** Slot owner keys the module asked to inject into. */
const injections = []
const notifications = []

const ctx = {
  effect(callback) { callback() },
  locale: {
    register: () => () => {},
    bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
  },
  slots: {
    inject(key, callback) {
      injections.push(key)
      callback()
    },
    register(definition, component) {
      registrations.push({ definition, component })
      return () => {}
    },
  },
  contextMenus: { notify: (text, success) => { notifications.push({ text, success }) } },
  get: name => (name === 'sessions'
    ? { fork: async () => 'session-child' }
    : name === 'uiWorkspace' ? { openSession: () => {} } : undefined),
}

/** Server answers the client asks for. */
const answers = {
  '/api/session.rewind/list': { ok: true, busy: false, turns: [{ turn: 1, startSeq: 5, hasTree: true }] },
  '/api/session.rewind': { ok: true, atSeq: 4, dryRun: true, restoreCount: 2, removeCount: 1 },
}
const calls = []

globalThis.fetch = async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  const payload = answers[url]
  return new Response(JSON.stringify(payload ?? { ok: false, code: 'failed' }), { status: payload ? 200 : 500 })
}

let loaded
globalThis.window = { __ModuleLoader__: { load: definition => { loaded = definition } } }

const here = dirname(fileURLToPath(import.meta.url))
const moduleUrl = pathToFileURL(join(here, '..', 'client.js')).href
check((await readFile(join(here, '..', 'client.js'), 'utf8')).includes("id: '@mrmark019/dsh-session-rewind'"), 'the bundle registers under its package name')

await import(moduleUrl)
check(loaded?.id === '@mrmark019/dsh-session-rewind', 'the module loader received the factory definition')

const plugin = loaded.factory(name => (name === 'react' ? React : undefined))
check(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), 'the plugin declares the services it needs')

plugin.apply(ctx)
check(injections.includes('conversation.chat.turnTail'), 'the action is injected into the turn tail')
check(injections.includes('shell.overlay'), 'the dialog is injected into the overlay')

const tail = registrations.find(entry => entry.definition.name === 'conversation.chat.turnTail')
const overlay = registrations.find(entry => entry.definition.name === 'shell.overlay')
check(tail?.definition.id === 'session-rewind', 'the turn tail entry uses its own id')
check(overlay?.definition.id === 'session-rewind.confirm', 'the dialog entry uses its own id')

const face = tail.definition.inject('session-test')
check(typeof face.open === 'function' && typeof face.controller.ensure === 'function', 'the injected face exposes the turn list and the dialog opener')
await face.controller.ensure()
check(calls.some(call => call.url === '/api/session.rewind/list' && call.body.sessionId === 'session-test'), 'the turn list is requested for the owning session')

const props = { seq: 20, t: key => key, useAccess: () => true, ...face }
const rendered = tail.component(props)
check(rendered !== null && rendered.type === 'div', 'a tail after a recorded boundary renders the action')
const early = tail.component({ ...props, seq: 3 })
check(early === null, 'a tail before the first boundary renders nothing')

rendered.children?.forEach?.((child) => {})
const button = rendered.children?.[0] ?? null
check(button !== null && button.type === 'button', 'the rendered node is a button')
check(button?.props?.['aria-label'] === 'action.label', 'the button carries its localized label')

face.open({ turn: 1, startSeq: 5, hasTree: true })
await new Promise(resolve => setTimeout(resolve, 0))
check(calls.some(call => call.url === '/api/session.rewind' && call.body.dryRun === true && call.body.startSeq === 5), 'opening the dialog requests a dry run for that boundary')

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}