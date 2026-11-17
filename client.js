/**
 * Browser half of the session-rewind plugin.
 *
 * One compact action above a completed turn's icon row, one confirmation dialog,
 * and the two calls the Host owns: preview/perform the file restore, then fork
 * the conversation before the turn through the shipped `ctx.sessions.fork` and
 * open the new session.
 *
 * Colors come only from the host's own aliases; the button inherits `currentColor`
 * so it follows the action row's chrome in both themes.
 */

window.__ModuleLoader__.load({
  id: '@mrmark019/dsh-session-rewind',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-rewind'
    const LIST_URL = '/api/session.rewind/list'
    const REWIND_URL = '/api/session.rewind'

    const zh = {
      'action.label': '撤回本轮',
      'action.hint': '把对话切到本轮之前，并可还原工作区文件',
      'dialog.title': '撤回到本轮之前？',
      'dialog.body': '会从本轮之前新建一个会话分支并打开它。本轮提问和它的回答、以及之后的所有轮次都不会进入新会话；原会话完整保留在侧边栏。',
      'dialog.restore': '同时还原工作区文件（Git 快照）',
      'dialog.restoreHint': '本轮的改动会被覆盖，本轮新增的文件会被删除，本轮删除的文件会被找回。被忽略的未跟踪文件不受影响。',
      'dialog.onlyChat': '本轮没有可用快照，本次只撤回对话，工作区文件保持现状。',
      'dialog.unavailable.git': '当前工作区不是 Git 仓库，只能撤回对话。',
      'dialog.unavailable.noGit': '这台机器上没有可用的 Git，只能撤回对话。',
      'dialog.unavailable.noSnapshot': '本轮没有可用快照，只能撤回对话。',
      'dialog.unavailable.worktree': '工作区换过仓库根目录，无法还原文件，只能撤回对话。',
      'dialog.previewLoading': '正在对比快照…',
      'dialog.preview': '将还原 {restore} 个文件，删除 {remove} 个本轮新增的文件。',
      'dialog.previewEmpty': '工作区与快照一致，没有文件需要还原。',
      'dialog.previewFailed': '无法预览文件差异；仍可尝试还原，或取消勾选只撤回对话。',
      'dialog.snapshotError': '快照失败原因：{reason}',
      'dialog.cancel': '取消',
      'dialog.confirm': '撤回',
      'dialog.busy': '正在撤回…',
      'toast.restored': '已撤回：新会话已打开，还原 {restore} 个文件、删除 {remove} 个',
      'toast.chatOnly': '已撤回：新会话已打开（未改动文件）',
      'toast.warnings': '{count} 个文件未能处理：{warning}',
      'toast.restoredButForkFailed': '文件已还原，但新会话创建失败。原会话保持不变。',
      'error.no-checkpoint': '这一轮没有可撤回的记录，请刷新页面后重试。',
      'error.no-git': '没有可用的 Git，无法还原文件。',
      'error.no-repository': '当前工作区不是 Git 仓库，无法还原文件。',
      'error.no-snapshot': '这一轮没有可用快照，无法还原文件。',
      'error.worktree-changed': '工作区换过仓库根目录，已停止还原。',
      'error.session-busy': '会话仍在运行，请等它停下来再撤回。',
      'error.restore-busy': '另一个还原正在进行，请稍后重试。',
      'error.too-many-files': '需要处理的文件太多，已停止还原。',
      'error.restore-failed': '还原文件失败，未创建新会话。',
      'error.fork-failed': '创建新会话失败，原会话保持不变。',
      'error.failed': '撤回失败，请稍后重试。',
    }
    const en = {
      'action.label': 'Rewind this turn',
      'action.hint': 'Cut the conversation before this turn and optionally restore workspace files',
      'dialog.title': 'Rewind to before this turn?',
      'dialog.body': 'A new session branch is created from before this turn and opened. This turn\u2019s prompt and answer, and every later turn, stay out of it; the original session is kept in the sidebar.',
      'dialog.restore': 'Also restore workspace files (git snapshot)',
      'dialog.restoreHint': 'Changes made by this turn are overwritten, files it added are deleted, and files it deleted come back. Ignored untracked files are untouched.',
      'dialog.onlyChat': 'No snapshot is available for this turn, so only the conversation is rewound and workspace files stay as they are.',
      'dialog.unavailable.git': 'This workspace is not a git repository, so only the conversation can be rewound.',
      'dialog.unavailable.noGit': 'Git is not available on this machine, so only the conversation can be rewound.',
      'dialog.unavailable.noSnapshot': 'No snapshot is available for this turn, so only the conversation can be rewound.',
      'dialog.unavailable.worktree': 'The workspace changed its repository root, so files cannot be restored; only the conversation can be rewound.',
      'dialog.previewLoading': 'Comparing the snapshot\u2026',
      'dialog.preview': '{restore} files will be restored and {remove} files this turn added will be deleted.',
      'dialog.previewEmpty': 'The workspace already matches the snapshot; no files need restoring.',
      'dialog.previewFailed': 'The file comparison could not be shown. You can still try the restore, or clear the checkbox to rewind the conversation only.',
      'dialog.snapshotError': 'Snapshot failed: {reason}',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Rewind',
      'dialog.busy': 'Rewinding\u2026',
      'toast.restored': 'Rewound: the new session is open, {restore} files restored and {remove} removed',
      'toast.chatOnly': 'Rewound: the new session is open (files untouched)',
      'toast.warnings': '{count} files could not be handled: {warning}',
      'toast.restoredButForkFailed': 'Files were restored, but the new session could not be created. The original session is unchanged.',
      'error.no-checkpoint': 'There is no rewind record for this turn. Reload the page and try again.',
      'error.no-git': 'Git is not available, so files cannot be restored.',
      'error.no-repository': 'This workspace is not a git repository, so files cannot be restored.',
      'error.no-snapshot': 'No snapshot is available for this turn, so files cannot be restored.',
      'error.worktree-changed': 'The workspace changed its repository root, so the restore stopped.',
      'error.session-busy': 'This conversation is still working. Wait until it stops, then rewind.',
      'error.restore-busy': 'Another restore is running. Try again in a moment.',
      'error.too-many-files': 'Too many files would be touched, so the restore stopped.',
      'error.restore-failed': 'Restoring files failed, and no new session was created.',
      'error.fork-failed': 'The new session could not be created. The original session is unchanged.',
      'error.failed': 'Rewind failed. Please try again.',
    }

    /** Result codes with their own copy; anything else falls back to `error.failed`. */
    const KNOWN_CODES = new Set(Object.keys(zh).filter(key => key.startsWith('error.')).map(key => key.slice(6)))

    /** Codes that mean the snapshot itself cannot be used, so the checkbox turns off. */
    const UNUSABLE_CODES = new Set(['no-git', 'no-repository', 'no-snapshot', 'worktree-changed'])

    /**
     * POST one JSON body and normalize the result.
     * @param {string} url - route path.
     * @param {object} body - request body.
     * @returns {Promise<{ ok: boolean, payload: object }>} normalized outcome.
     */
    async function post(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      return { ok: response.ok === true && payload?.ok === true, payload: payload ?? {} }
    }

    /**
     * The turn boundary a tail seq belongs to: the latest `turn/start` before it.
     * @param {{ startSeq: number, turn: number, hasTree: boolean }[]} turns - server list, ascending.
     * @param {number} tailSeq - the tail node's seq.
     * @returns {{ startSeq: number, turn: number, hasTree: boolean } | undefined} the boundary.
     */
    function boundaryFor(turns, tailSeq) {
      if (!Array.isArray(turns) || !Number.isFinite(tailSeq)) return undefined
      let found
      for (const entry of turns) {
        if (!entry || !Number.isFinite(entry.startSeq)) continue
        if (entry.startSeq >= tailSeq) break
        found = entry
      }
      return found
    }

    /**
     * Create the shared per-session turn list.
     * @param {string} sessionId - owning session.
     * @returns {{ subscribe: Function, getSnapshot: Function, ensure: Function }} a tiny external store.
     */
    function createTurnList(sessionId) {
      const listeners = new Set()
      let state = { status: 'idle', turns: [], busy: false }
      let pending
      const publish = (next) => {
        state = next
        for (const listener of Array.from(listeners)) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot: () => state,
        ensure() {
          if (pending !== undefined) return pending
          pending = post(LIST_URL, { sessionId })
            .then(({ ok, payload }) => {
              publish(ok
                ? { status: 'ready', turns: Array.isArray(payload.turns) ? payload.turns : [], busy: payload.busy === true }
                : { status: 'error', turns: [], busy: false })
            })
            .catch(() => { publish({ status: 'error', turns: [], busy: false }) })
            .finally(() => { pending = undefined })
          return pending
        },
      }
    }

    /** Per-session turn lists, created on first use and dropped when the plugin unloads. */
    const turnLists = new Map()

    /** Closed dialog state, also the reset applied at every activation. */
    const CLOSED = Object.freeze({
      open: false, busy: false, code: null, sessionId: null, startSeq: null,
      hasTree: false, restoreFiles: false, unavailable: null, previewing: false,
      preview: null, previewFailed: false, warnings: [], snapshotError: null,
    })

    const dialogListeners = new Set()
    let dialogState = CLOSED
    const dialogStore = {
      getSnapshot: () => dialogState,
      subscribe(listener) {
        dialogListeners.add(listener)
        return () => { dialogListeners.delete(listener) }
      },
    }
    const publishDialog = (next) => {
      dialogState = next
      for (const listener of Array.from(dialogListeners)) listener()
    }

    /**
     * Undo glyph: an arrow hooking back to the left over the work it undoes.
     * Deliberately not a closed circle — a circular arrow reads as retry or
     * refresh in a chat action row, which is the opposite of rewinding.
     */
    function RewindIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, focusable: false,
        style: {
          display: 'block', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        },
      },
        h('path', { d: 'M6 2.7 3 5.7l3 3' }),
        h('path', { d: 'M3 5.7h6.7a3.7 3.7 0 0 1 0 7.4H7.3' }))
    }

    /**
     * Build the confirmation dialog bound to one plugin activation.
     * @param {object} ctx - browser context carrying fetch, sessions, and workspace navigation.
     * @param {Function} t - localized translator for this plugin's namespace.
     * @returns {Function} the overlay component.
     */
    function createDialog(ctx, t) {
      const ghostButton = {
        minWidth: '72px', padding: '6px 14px', fontSize: '14px', lineHeight: '1.4',
        borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
      }
      const primaryButton = {
        ...ghostButton,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-3)',
        fontWeight: '600',
      }

      /**
       * Open the dialog for one boundary and start its preview.
       *
       * The preview is requested even when the turn list reported no snapshot:
       * the list may have been read before that turn's snapshot finished, and
       * only the Host can say whether a usable tree exists.
       * @param {string} sessionId - owning session.
       * @param {{ startSeq: number, hasTree: boolean, error?: string | null }} boundary - resolved boundary.
       * @returns {void}
       */
      function open(sessionId, boundary) {
        const listed = boundary.hasTree === true
        publishDialog({
          ...CLOSED, open: true, sessionId, startSeq: boundary.startSeq,
          hasTree: listed, restoreFiles: listed, unavailable: listed ? null : 'noSnapshot',
          snapshotError: typeof boundary.error === 'string' ? boundary.error : null,
          previewing: true,
        })
        void post(REWIND_URL, { sessionId, startSeq: boundary.startSeq, restoreFiles: true, dryRun: true })
          .then(({ ok, payload }) => {
            if (!dialogState.open || dialogState.startSeq !== boundary.startSeq) return
            if (ok) {
              publishDialog({
                ...dialogState, previewing: false, hasTree: true, restoreFiles: true,
                unavailable: null, snapshotError: null,
                preview: { restore: Number(payload.restoreCount) || 0, remove: Number(payload.removeCount) || 0 },
              })
              return
            }
            const code = typeof payload.code === 'string' ? payload.code : 'failed'
            if (UNUSABLE_CODES.has(code)) {
              const key = code === 'no-repository' ? 'git' : code === 'no-git' ? 'noGit' : code === 'worktree-changed' ? 'worktree' : 'noSnapshot'
              publishDialog({ ...dialogState, previewing: false, hasTree: false, restoreFiles: false, unavailable: key })
              return
            }
            publishDialog({ ...dialogState, previewing: false, previewFailed: true })
          })
          .catch(() => {
            if (dialogState.open && dialogState.startSeq === boundary.startSeq) {
              publishDialog({ ...dialogState, previewing: false, previewFailed: true })
            }
          })
      }

      /**
       * Restore files when asked, then fork the conversation and open the child.
       * @param {object} current - dialog state at confirm time.
       * @returns {Promise<void>} resolves when the attempt settles.
       */
      async function confirm(current) {
        publishDialog({ ...current, busy: true, code: null })
        let atSeq = current.startSeq - 1
        let outcome = { restore: 0, remove: 0, warnings: [] }
        if (current.restoreFiles) {
          let result
          try {
            result = await post(REWIND_URL, {
              sessionId: current.sessionId, startSeq: current.startSeq, restoreFiles: true, dryRun: false,
            })
          } catch {
            result = { ok: false, payload: { code: 'failed' } }
          }
          if (!result.ok) {
            const code = typeof result.payload.code === 'string' && KNOWN_CODES.has(result.payload.code)
              ? result.payload.code
              : 'failed'
            publishDialog({ ...dialogState, busy: false, code })
            return
          }
          atSeq = Number.isSafeInteger(result.payload.atSeq) ? result.payload.atSeq : atSeq
          outcome = {
            restore: Number(result.payload.restored) || 0,
            remove: Number(result.payload.removed) || 0,
            warnings: Array.isArray(result.payload.warnings) ? result.payload.warnings : [],
          }
        }
        if (!Number.isSafeInteger(atSeq) || atSeq < 0) {
          publishDialog({ ...dialogState, busy: false, code: 'no-checkpoint' })
          return
        }
        const sessions = ctx.get('sessions')
        if (sessions === undefined || typeof sessions.fork !== 'function') {
          publishDialog({ ...dialogState, busy: false, code: 'fork-failed' })
          return
        }
        let childId
        try {
          childId = await sessions.fork({
            sessionId: current.sessionId, atSeq, increaseTitle: true,
          })
        } catch {
          ctx.contextMenus.notify(t('toast.restoredButForkFailed'), false)
          publishDialog({ ...dialogState, busy: false, code: 'fork-failed' })
          return
        }
        const workspace = ctx.get('uiWorkspace')
        if (typeof workspace?.openSession === 'function') workspace.openSession(childId)
        const parts = [
          current.restoreFiles
            ? t('toast.restored', { restore: outcome.restore, remove: outcome.remove })
            : t('toast.chatOnly'),
        ]
        if (outcome.warnings.length > 0) {
          parts.push(t('toast.warnings', { count: outcome.warnings.length, warning: outcome.warnings.join('; ') }))
        }
        ctx.contextMenus.notify(parts.join(' · '), true)
        publishDialog(CLOSED)
      }

      function SessionRewindDialog() {
        const current = React.useSyncExternalStore(dialogStore.subscribe, dialogStore.getSnapshot, dialogStore.getSnapshot)
        const cardRef = React.useRef(null)
        const cancelRef = React.useRef(null)

        React.useEffect(() => {
          if (!current.open) return undefined
          const returned = document.activeElement
          cancelRef.current?.focus()
          return () => { if (returned instanceof HTMLElement) returned.focus() }
        }, [current.open])

        if (!current.open) return null

        const dismiss = () => { if (!current.busy) publishDialog(CLOSED) }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); dismiss(); return }
          if (event.key !== 'Tab') return
          const focusable = cardRef.current?.querySelectorAll('button:not([disabled])')
          if (!(focusable instanceof NodeList) || focusable.length === 0) return
          const items = Array.from(focusable)
          const at = items.indexOf(document.activeElement)
          event.preventDefault()
          const next = event.shiftKey
            ? items[(at - 1 + items.length) % items.length]
            : items[(at + 1) % items.length]
          next?.focus()
        }

        let previewText = null
        if (current.previewing) previewText = t('dialog.previewLoading')
        else if (current.previewFailed) previewText = t('dialog.previewFailed')
        else if (current.preview !== null) {
          previewText = current.preview.restore === 0 && current.preview.remove === 0
            ? t('dialog.previewEmpty')
            : t('dialog.preview', { restore: current.preview.restore, remove: current.preview.remove })
        } else if (current.hasTree === false && current.unavailable === null) previewText = t('dialog.onlyChat')
        const unavailableText = current.unavailable === null ? null : t(`dialog.unavailable.${current.unavailable}`)
        const checkboxDisabled = current.hasTree !== true || current.busy

        return h('div', {
          role: 'presentation',
          onMouseDown: (event) => { if (event.target === event.currentTarget) dismiss() },
          style: {
            position: 'fixed', inset: 0, zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px', boxSizing: 'border-box',
            background: 'var(--dsw-alias-bg-mask-1)',
          },
        }, h('div', {
          ref: cardRef,
          role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'session-rewind-title',
          tabIndex: -1, onKeyDown,
          style: {
            width: 'min(460px, calc(100vw - 32px))',
            display: 'flex', flexDirection: 'column', gap: '10px',
            padding: '18px 18px 14px', boxSizing: 'border-box', borderRadius: '12px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '0 16px 40px rgba(0, 0, 0, 0.35)',
            fontSize: '14px', lineHeight: '1.55',
          },
        },
        h('div', {
          id: 'session-rewind-title', style: { fontSize: '15px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' },
        }, t('dialog.title')),
        h('div', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('dialog.body')),
        h('label', {
          style: {
            display: 'flex', alignItems: 'flex-start', gap: '8px',
            padding: '8px 10px', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-mask-2)', cursor: checkboxDisabled ? 'default' : 'pointer',
            opacity: checkboxDisabled ? 0.72 : 1,
          },
        },
        h('input', {
          type: 'checkbox',
          checked: current.restoreFiles,
          disabled: checkboxDisabled,
          style: { marginTop: '3px' },
          onChange: (event) => { publishDialog({ ...dialogState, restoreFiles: event.target.checked }) },
        }),
        h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('dialog.restore')),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' } }, t('dialog.restoreHint')))),
        unavailableText === null ? null : h('div', {
          style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' }, role: 'note',
        }, unavailableText),
        current.snapshotError === null ? null : h('div', {
          style: {
            color: 'var(--dsw-alias-label-secondary)', fontSize: '11px',
            wordBreak: 'break-word', opacity: 0.85,
          }, role: 'note',
        }, t('dialog.snapshotError', { reason: current.snapshotError })),
        previewText === null ? null : h('div', {
          style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' }, role: 'note',
        }, previewText),
        current.code === null ? null : h('div', {
          role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' },
        }, t(`error.${current.code}`)),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '2px' } },
          h('button', {
            ref: cancelRef, type: 'button', style: ghostButton, disabled: current.busy, onClick: dismiss,
          }, t('dialog.cancel')),
          h('button', {
            type: 'button', style: primaryButton, disabled: current.busy,
            onClick: () => { void confirm(current) },
          }, current.busy ? t('dialog.busy') : t('dialog.confirm')))))
      }

      return { Dialog: SessionRewindDialog, open }
    }

    /**
     * One turn's rewind control, seated above the turn's icon row.
     * @param {object} props - owner turn facts plus the injected face.
     * @returns {object | null} the element, or null when this turn has no boundary.
     */
    function RewindAction(props) {
      const { seq, controller } = props
      const t = typeof props.t === 'function' ? props.t : key => key
      const allowed = typeof props.useAccess === 'function' ? props.useAccess('session/fork') : true
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
      // A Turn that ended after the list was read has no entry yet: refetch once
      // per tail seq so its action appears without reopening the session.
      const asked = React.useRef(null)
      React.useEffect(() => { controller.ensure() }, [controller])
      React.useEffect(() => {
        if (state.status !== 'ready' || asked.current === seq) return
        asked.current = seq
        if (boundaryFor(state.turns, seq) === undefined) controller.ensure()
      }, [state, seq, controller])
      if (allowed !== true) return null
      const boundary = boundaryFor(state.turns, seq)
      if (boundary === undefined) return null
      return h('div', {
        style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center' },
      }, h('button', {
        type: 'button',
        'aria-label': t('action.label'),
        title: t('action.hint'),
        onClick: () => { props.open(boundary) },
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '22px', height: '22px', padding: 0,
          border: 'none', borderRadius: '6px', background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
          opacity: 0.55, transition: 'opacity 120ms ease, background-color 120ms ease',
        },
        onMouseEnter: (event) => {
          event.currentTarget.style.opacity = '1'
          event.currentTarget.style.background = 'var(--dsw-alias-bg-mask-2)'
        },
        onMouseLeave: (event) => {
          event.currentTarget.style.opacity = '0.55'
          event.currentTarget.style.background = 'transparent'
        },
        onFocus: (event) => { event.currentTarget.style.opacity = '1' },
        onBlur: (event) => { event.currentTarget.style.opacity = '0.55' },
      }, h(RewindIcon)))
    }

    return {
      inject: ['slots', 'locale', 'contextMenus'],
      apply(ctx) {
        turnLists.clear()
        publishDialog(CLOSED)
        ctx.effect(() => () => { turnLists.clear() }, 'session-rewind: turn lists')
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-rewind: dictionaries')
        const t = ctx.locale.bind(NS)
        // One dialog instance owns the preview and the fork, so a turn's button
        // and the overlay never disagree about the boundary being rewound.
        const dialog = createDialog(ctx, t)

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'session-rewind',
          order: 10,
          locale: NS,
          inject: (sessionId) => {
            let controller = turnLists.get(sessionId)
            if (controller === undefined) {
              controller = createTurnList(sessionId)
              turnLists.set(sessionId, controller)
            }
            return {
              controller,
              open: (boundary) => { dialog.open(sessionId, boundary) },
            }
          },
        }, RewindAction))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-rewind.confirm',
          locale: NS,
          order: 900,
        }, dialog.Dialog))
      },
    }
  },
})