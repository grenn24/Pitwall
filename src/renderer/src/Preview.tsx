import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { PreviewStatus } from '../../shared/preview'
import type { Ticket } from '../../shared/ticket'

/**
 * The running app for one ticket.
 *
 * Lives inside the ticket rather than beside it. A preview is of a branch, and
 * the branch belongs to a ticket — a separate panel with its own repository and
 * ticket fields meant two worktrees for one piece of work and no way to tell
 * which one you were looking at.
 */

const PHASE_TEXT: Record<PreviewStatus['phase'], string> = {
  idle: 'Idle',
  'writing-compose': 'Reading the project…',
  'starting-database': 'Starting the database…',
  'building-app': 'Building the app image…',
  'waiting-for-app': 'Waiting for the app to answer…',
  ready: 'Ready',
  failed: 'Not available'
}

export default function Preview({ ticket }: { ticket: Ticket }): JSX.Element {
  const [status, setStatus] = useState<PreviewStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const slot = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      window.pitwall.preview.onPhase((payload) => {
        if (payload.id === ticket.id) setStatus(payload.status)
      }),
    [ticket.id]
  )

  useEffect(() => {
    void window.pitwall.preview.status(ticket.id).then(setStatus)
  }, [ticket.id])

  const ready = status?.phase === 'ready' && status.env

  /**
   * The preview is a native view over the window, not a DOM node, so its bounds
   * are pushed to main whenever the layout moves. Layout effect rather than
   * effect: reading the rect after paint shows it in last frame's position.
   */
  useLayoutEffect(() => {
    if (!ready || !slot.current) return

    const push = (): void => {
      const r = slot.current?.getBoundingClientRect()
      if (r) void window.pitwall.preview.attach(ticket.id, { x: r.x, y: r.y, width: r.width, height: r.height })
    }

    push()
    const observer = new ResizeObserver(push)
    observer.observe(slot.current)
    window.addEventListener('scroll', push, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', push, true)
    }
  }, [ready, ticket.id])

  const start = useCallback(async () => {
    setBusy(true)
    setStatus({ phase: 'writing-compose', env: null })
    try {
      setStatus(await window.pitwall.preview.start(ticket.id))
    } finally {
      setBusy(false)
    }
  }, [ticket.id])

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      await window.pitwall.preview.stop(ticket.id)
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }, [ticket.id])

  return (
    <div className="preview">
      <div className="preview__bar">
        {ready && status.env ? (
          <>
            <span className="preview__url">{status.env.url}</span>
            <span className="preview__meta">up in {((status.elapsedMs ?? 0) / 1000).toFixed(1)}s</span>
            <button type="button" className="btn btn--tiny" onClick={() => void window.pitwall.preview.reload()}>
              Reload
            </button>
            <button type="button" className="btn btn--tiny" onClick={() => void stop()} disabled={busy}>
              Stop preview
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--tiny" onClick={() => void start()} disabled={busy}>
            {busy ? (status ? PHASE_TEXT[status.phase] : 'Starting…') : 'Start preview'}
          </button>
        )}
      </div>

      {status?.phase === 'failed' && (
        <div className="preview__unavailable">
          {/* Not every project has an app to preview. A desktop app, a library
              or a CLI never will, and the reviewer judges those on tests
              alone. Saying so is different from reporting a failure. */}
          <p>{status.error}</p>
        </div>
      )}

      {(ready || (busy && status?.phase !== 'failed')) && <div className="stage" ref={slot} />}
    </div>
  )
}
