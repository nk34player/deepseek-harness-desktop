/**
 * Desktop-only update & version row for General settings. Talks to the
 * Electron shell's `window.dshDesktop.updates` surface; hidden when that
 * bridge is absent. Self-refreshes from the shell's status events, so the
 * row tracks checking / available / downloading / downloaded / failed
 * without polling.
 */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import clsx from 'clsx'
import css from './UpdateRow.module.css'
import type { UpdateStatus, UpdatesBridge } from './dsh-desktop-bridge.ts'

/** Update-row methods required after the preload probe succeeds. */
type DesktopUpdatesBridge = Pick<UpdatesBridge, 'getStatus' | 'getVersion' | 'onStatus' | 'check' | 'install'>

/** Full component props: runtime share + locale seat. */
export type UpdateRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'>

/**
 * Whether the Electron preload bridge exposes the auto-update surface.
 * @returns the bridge, or `undefined` outside the desktop shell.
 */
export function readDesktopUpdatesBridge(): DesktopUpdatesBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = window.dshDesktop
  if (bridge === undefined) return undefined
  const updates = bridge.updates
  if (updates === undefined) return undefined
  if (typeof updates.getStatus !== 'function' || typeof updates.getVersion !== 'function'
    || typeof updates.onStatus !== 'function' || typeof updates.check !== 'function'
    || typeof updates.install !== 'function') {
    return undefined
  }
  return updates as DesktopUpdatesBridge
}

/** The phase's active action, or `undefined` when the row is passive. */
type RowAction = 'check' | 'download' | 'install'

function actionFor(status: UpdateStatus): RowAction | undefined {
  switch (status.phase) {
    case 'idle':
    case 'up-to-date':
      return 'check'
    case 'available':
      return 'download'
    case 'downloaded':
      return 'install'
    case 'error':
      return 'check'
    default:
      return undefined
  }
}

/** Whether the phase is mid-flight and offers no user action. */
function busy(status: UpdateStatus): boolean {
  return status.phase === 'checking' || status.phase === 'downloading'
}

/**
 * Render the update & version row: current version, update availability, and
 * one-click check / download / restart-and-update. Defaults to idle until the
 * shell reports a status.
 * @param props - composed slot props.
 * @returns the row element tree, or `null` when not running under desktop.
 */
export function UpdateRow({ t }: UpdateRowComponentProps) {
  const bridge = readDesktopUpdatesBridge()
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle' })

  useEffect(() => {
    if (bridge === undefined) return
    let cancelled = false
    void bridge.getVersion().then((value) => {
      if (!cancelled) setVersion(value)
    })
    void bridge.getStatus().then((value) => {
      if (!cancelled) setStatus(value)
    })
    const unsubscribe = bridge.onStatus((value) => {
      if (!cancelled) setStatus(value)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge])

  if (bridge === undefined) return null

  const action = actionFor(status)
  const isBusy = busy(status)
  const unsupported = status.phase === 'unsupported'

  let statusText = t('update.idle')
  if (unsupported) statusText = t('update.unsupported')
  else if (status.phase === 'checking') statusText = t('update.checking')
  else if (status.phase === 'up-to-date') statusText = t('update.upToDate')
  else if (status.phase === 'available') statusText = `${t('update.available')} v${status.version}`
  else if (status.phase === 'downloading') {
    statusText = `${t('update.downloading')} ${status.percent}%`
  } else if (status.phase === 'downloaded') statusText = `${t('update.ready')} v${status.version}`
  else if (status.phase === 'error') statusText = `${t('update.failed')} ${status.message}`

  const buttonLabel = unsupported || action === undefined
    ? t('update.noop')
    : action === 'install' ? t('update.install')
      : action === 'download' ? t('update.download')
        : t('update.check')

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('update.title')}</div>
        <div className={css.description}>
          {version === '' ? t('update.reading') : version}
        </div>
        <div className={clsx(css.status, status.phase === 'error' && css.statusError)}>
          {statusText}
        </div>
      </div>
      <div className={css.actions}>
        <button
          type="button"
          className={clsx(css.action, action === 'install' && css.primary)}
          disabled={isBusy || unsupported || action === undefined}
          onClick={() => {
            if (action === 'install') void bridge.install()
            else if (action === 'download') void bridge.check()
            else if (action === 'check') void bridge.check()
          }}
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  )
}
