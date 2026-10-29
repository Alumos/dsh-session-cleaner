/**
 * dsh-session-cleaner — the client half.
 *
 * Two registrations, one flow:
 *   sidebar.workspaces.session.menu.item  →「删除会话」in the Session context menu
 *   shell.overlay                         → the confirmation dialog
 *
 * The dialog posts to the Host half through the same-origin route it registers
 * (`config.basePath`, default `/dsh-session-cleaner`), because a hand-written
 * bundle has no generated typert remote namespace. The row itself is removed by
 * the Host's `api-session/removed` event, so this half never touches the list.
 *
 * The menu entry and the dialog are hand-written copies of the primitives, not
 * imports: a plugin may not depend on `@deepseek-ai/dsh-client-ui-*` packages.
 * The geometry, tokens and icon paths below are taken from the primitives CSS
 * and `IconTrashOutlineRegular` / `IconCloseOutlineRegular` so a plugin item is
 * indistinguishable from a first-party one.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-cleaner',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BASE_PATH = '/dsh-session-cleaner'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const DIALOG_ID = 'dsh-session-cleaner-dialog'

    const zh =
      typeof document !== 'undefined' &&
      ((document.documentElement && document.documentElement.lang) || '').toLowerCase().startsWith('zh')
    const COPY = zh
      ? {
          menu: '删除会话',
          title: '删除会话',
          description: '这个会话的记录和它在磁盘上的目录都会被删除，侧栏里的这一行随即消失。',
          permanent: '永久删除（不放进回收站）',
          permanentHint: '默认会移进 ~/.dsh/session-trash/，可以手动恢复。',
          close: '关闭',
          cancel: '取消',
          confirm: '删除',
          deleting: '删除中…',
          failed: '删除失败',
          liveTitle: '这个会话仍在本进程里打开着',
          liveBody: '它的日志还在被写入。继续会先关闭这个会话 —— 正在跑的回合会被中止，未完成的工作会丢失 —— 然后删除它。',
          confirmClose: '关闭并删除',
        }
      : {
          menu: 'Delete session',
          title: 'Delete session',
          description: 'The session record and its directory on disk are removed, and this row leaves the sidebar.',
          permanent: 'Delete permanently (skip the trash)',
          permanentHint: 'By default the directory moves to ~/.dsh/session-trash/ and can be restored by hand.',
          close: 'Close',
          cancel: 'Cancel',
          confirm: 'Delete',
          deleting: 'Deleting…',
          failed: 'Delete failed',
          liveTitle: 'This session is still open in this Harness',
          liveBody: 'Its log is still being written. Continuing closes this session first — the running turn is cancelled and unfinished work is lost — and then deletes it.',
          confirmClose: 'Close and delete',
        }

    /** Five paths of the primitives `IconTrashOutlineRegular` (16px grid, stroke width 1). */
    const TRASH_PATHS = [
      'M1.28149 3.88831H14.7187',
      'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
      'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
      'M6.44946 6.98926V11.1238',
      'M9.55054 6.98926V11.1238',
    ]

    /** The primitives outline X used by Modal's close button. */
    const CLOSE_PATHS = ['M2.5 2.5L13.5 13.5', 'M13.5 2.5L2.5 13.5']

    function outlineIcon(paths, size) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          strokeWidth: 1,
        },
        paths.map((d, index) => h('path', { key: index, d, stroke: 'currentColor' })),
      )
    }

    /**
     * Mirrors the primitives stylesheet: menu item geometry and tokens (`4ub78`),
     * modal layout (`o6lrb`), buttons (`1rv3m`) and the checkbox (`1wz3s`).
     */
    const styles = `
.dsc-item-wrap { position: relative; }
.dsc-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dsc-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.dsc-item:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); outline: none; }
.dsc-item:disabled { opacity: 0.4; cursor: not-allowed; }
.dsc-item[data-danger="true"],
.dsc-item[data-danger="true"] .dsc-item-icon { color: var(--dsw-alias-state-error-primary, #d92d20); }
.dsc-item[data-danger="true"]:hover:not(:disabled),
.dsc-item[data-danger="true"]:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(217, 45, 32, 0.08)); }
.dsc-item-icon {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-menu-icon, currentColor);
}
.dsc-item-icon svg { width: 14px; height: 14px; }
.dsc-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dsc-root {
  pointer-events: auto;
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
}
.dsc-mask {
  position: absolute;
  inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.32));
  backdrop-filter: var(--dsw-mask-blur, blur(2px));
}
.dsc-dialog {
  box-sizing: border-box;
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: min(380px, 100%);
  padding: 0 0 24px;
  overflow: hidden;
  border: 0;
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.24));
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dsc-dialog:focus { outline: none; }
.dsc-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 12px 24px; }
.dsc-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2328); }
.dsc-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary, #57606a);
}
.dsc-close:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.dsc-close:disabled { opacity: 0.4; cursor: not-allowed; }
.dsc-description {
  margin: 0;
  padding: 0 24px;
  font-size: 14px;
  line-height: 22px;
  font-weight: 400;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dsc-body { display: flex; flex-direction: column; min-width: 0; gap: 12px; margin-top: 20px; padding: 0 24px; }
.dsc-subject {
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.08));
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 14px;
  line-height: 22px;
  overflow-wrap: anywhere;
}
.dsc-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1f2328);
  cursor: pointer;
}
.dsc-checkbox input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary, #4f46e5);
  cursor: inherit;
}
.dsc-checkbox input:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4f46e5));
  outline-offset: 2px;
}
.dsc-checkbox:has(input:disabled) { cursor: default; opacity: 0.5; }
.dsc-hint { margin: 0; color: var(--dsw-alias-label-secondary, #57606a); font-size: 12px; line-height: 18px; }
.dsc-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-bg-error-subtle, rgba(217, 45, 32, 0.1));
  color: var(--dsw-alias-state-error-primary, #d92d20);
  font-size: 13px;
  line-height: 20px;
}
.dsc-warning {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-state-warn-tertiary, rgba(255, 193, 7, 0.12));
  color: var(--dsw-alias-state-warn-label, #8a5a00);
  font-size: 13px;
  line-height: 20px;
}
.dsc-warning strong { font-weight: 500; }
.dsc-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.dsc-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.dsc-button:disabled { cursor: not-allowed; opacity: 0.4; }
.dsc-button[data-variant="outline"] { border: 0.5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.32)); background: transparent; }
.dsc-button[data-variant="outline"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.dsc-button[data-variant="primary"] {
  background: var(--dsw-alias-button-primary-fill, #1f2328);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
}
.dsc-button[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #33383f); }
`

    /** Where a pending deletion lives: set from the menu, read by the overlay. */
    let pending = null
    const listeners = new Set()

    function setPending(next) {
      pending = next
      for (const listener of listeners) listener(next)
    }

    function subscribePending(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    /**
     * `useSyncExternalStore` is available on the React the client provides, but
     * its absence would only mean the overlay stays closed, so guard for it.
     */
    function usePendingStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribePending, () => pending, () => pending)
      }
      const [value, setValue] = React.useState(pending)
      React.useEffect(() => subscribePending(setValue), [])
      return value
    }

    function postDelete(sessionId, permanent, force) {
      return fetch(`${BASE_PATH}/delete`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, permanent, force }),
      })
        .then(async (response) => {
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (!response.ok || payload === null || payload.ok !== true) {
            const message = payload && payload.error && payload.error.message
            const code = payload && payload.error && payload.error.code
            const failure = new Error(message || `${response.status} ${response.statusText}`)
            failure.code = code || 'INTERNAL'
            throw failure
          }
          return payload
        })
    }

    /**
     * One entry of the session context menu. Reproduces the primitives
     * `MenuItemButton` markup (item wrap + button + icon + label) so the menu's
     * own list styles and keyboard handling treat it like a first-party item.
     */
    function DeleteMenuItem(props) {
      const sessionId = props && props.sessionId
      const displayTitle = props && props.displayTitle
      const useMenuOpenState = props && props.useMenuOpenState
      const setMenuOpen = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : null
      const onClick = () => {
        if (typeof setMenuOpen === 'function') setMenuOpen(false)
        if (typeof sessionId !== 'string' || sessionId === '') return
        setPending({ sessionId, title: typeof displayTitle === 'string' ? displayTitle : '' })
      }
      return h(
        'div',
        { className: 'dsc-item-wrap' },
        h(
          'button',
          { type: 'button', role: 'menuitem', className: 'dsc-item', 'data-danger': 'true', onClick },
          h('span', { className: 'dsc-item-icon' }, outlineIcon(TRASH_PATHS, 14)),
          h('span', { className: 'dsc-item-label' }, COPY.menu),
        ),
      )
    }

    function Dialog() {
      const request = usePendingStore()
      const open = request !== null
      const [permanent, setPermanent] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [liveMode, setLiveMode] = React.useState(false)
      const dialogRef = React.useRef(null)

      React.useEffect(() => {
        if (open) {
          setPermanent(false)
          setBusy(false)
          setError(null)
          setLiveMode(false)
        }
      }, [open, request && request.sessionId])

      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) setPending(null)
        }
        document.addEventListener('keydown', onKeyDown)
        const focusable = dialogRef.current
        if (focusable !== null && typeof focusable.focus === 'function') focusable.focus()
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open, busy])

      if (!open) return null

      const sessionId = request.sessionId
      const label = request.title || sessionId
      const close = () => {
        if (!busy) setPending(null)
      }

      const confirm = () => {
        if (busy) return
        setBusy(true)
        setError(null)
        postDelete(sessionId, permanent, liveMode)
          .then(() => setPending(null))
          .catch((failure) => {
            // Still open in this Harness: do not fail, ask. The retry closes it
            // first (busy turn cancelled) and then deletes, so the second press
            // is the user's explicit consent to drop that work.
            if (failure && failure.code === 'SESSION_LIVE') {
              setLiveMode(true)
              setError(null)
            } else {
              setError(failure instanceof Error ? failure.message : String(failure))
            }
            setBusy(false)
          })
      }

      return h(
        'div',
        { className: 'dsc-root', role: 'presentation' },
        h('div', { className: 'dsc-mask', 'aria-hidden': 'true', onMouseDown: close }),
        h(
          'div',
          {
            className: 'dsc-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': `${DIALOG_ID}-title`,
            'aria-describedby': `${DIALOG_ID}-desc`,
            tabIndex: -1,
            ref: dialogRef,
          },
          h(
            'div',
            { className: 'dsc-header' },
            h('h2', { className: 'dsc-title', id: `${DIALOG_ID}-title` }, COPY.title),
            h(
              'button',
              { type: 'button', className: 'dsc-close', 'aria-label': COPY.close, disabled: busy, onClick: close },
              outlineIcon(CLOSE_PATHS, 16),
            ),
          ),
          h('p', { className: 'dsc-description', id: `${DIALOG_ID}-desc` }, COPY.description),
          h(
            'div',
            { className: 'dsc-body' },
            h('p', { className: 'dsc-subject' }, label),
            liveMode
              ? h(
                  'div',
                  { className: 'dsc-warning', role: 'alert' },
                  h('strong', null, COPY.liveTitle),
                  h('span', null, COPY.liveBody),
                )
              : null,
            h(
              'label',
              { className: 'dsc-checkbox' },
              h('input', {
                type: 'checkbox',
                checked: permanent,
                disabled: busy,
                onChange: (event) => setPermanent(event.target.checked === true),
              }),
              h('span', null, COPY.permanent),
            ),
            h('p', { className: 'dsc-hint' }, COPY.permanentHint),
            error === null ? null : h('p', { className: 'dsc-error', role: 'alert' }, `${COPY.failed}：${error}`),
          ),
          h(
            'div',
            { className: 'dsc-footer' },
            h(
              'button',
              { type: 'button', className: 'dsc-button', 'data-variant': 'outline', disabled: busy, onClick: close },
              COPY.cancel,
            ),
            h(
              'button',
              { type: 'button', className: 'dsc-button', 'data-variant': 'primary', disabled: busy, onClick: confirm },
              busy ? COPY.deleting : liveMode ? COPY.confirmClose : COPY.confirm,
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const styleElement = document.createElement('style')
        styleElement.setAttribute('data-dsh-session-cleaner', '')
        styleElement.textContent = styles
        document.head.appendChild(styleElement)
        ctx.effect(() => () => styleElement.remove())

        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register(
            {
              name: MENU_SLOT,
              id: 'dsh-session-cleaner-delete',
              order: 350,
              label: () => COPY.menu,
            },
            DeleteMenuItem,
          ),
        )

        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register({ name: OVERLAY_SLOT, id: DIALOG_ID }, Dialog),
        )
      },
    }
  },
})
