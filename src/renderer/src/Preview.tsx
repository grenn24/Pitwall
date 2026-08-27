import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { PreviewStatus } from '../../shared/preview'

const PHASE_TEXT: Record<PreviewStatus['phase'], string> = {
  idle: 'Idle',
  'writing-compose': 'Reading the project…',
  'starting-database': 'Starting the database…',
  'building-app': 'Building the app image…',
  'waiting-for-app': 'Waiting for the app to answer…',
  ready: 'Ready',
  failed: 'Failed'
}

export default function Preview(): JSX.Element {
  const [remote, setRemote] = useState('https://github.com/docker/welcome-to-docker.git')
  const [ticketId, setTicketId] = useState('ticket-1')
  const [status, setStatus] = useState<PreviewStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const slot = useRef<HTMLDivElement>(null)

  // Phase updates arrive on their own channel while ticket.open is still
  // pending, so the user sees the build progressing rather than a frozen button.
  useEffect(() => window.pitwall.ticket.onPhase(setStatus), [])

  const ready = status?.phase === 'ready' && status.env

  /**
   * The preview is a native view sitting on top of the window, not a DOM node,
   * so its bounds have to be pushed to the main process whenever the layout
   * moves. Layout effect rather than effect: reading the rect after paint would
   * show the view in last frame's position for a frame.
   */
  useLayoutEffect(() => {
    if (!ready || !slot.current) return

    const push = (): void => {
      const r = slot.current?.getBoundingClientRect()
      if (r) void window.pitwall.preview.attach({ x: r.x, y: r.y, width: r.width, height: r.height })
    }

    push()
    const observer = new ResizeObserver(push)
    observer.observe(slot.current)
    window.addEventListener('scroll', push, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', push, true)
    }
  }, [ready])

  const open = useCallback(async () => {
    setBusy(true)
    setStatus({ phase: 'writing-compose', env: null })
    try {
      setStatus(await window.pitwall.ticket.open(remote.trim(), ticketId.trim() || 'ticket-1'))
    } finally {
      setBusy(false)
    }
  }, [remote, ticketId])

  const close = useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.pitwall.ticket.close()
      setStatus(null)
      if (result && result.containersLeft.length > 0) {
        console.warn('Containers survived teardown:', result.containersLeft)
      }
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <section className="preview">
      <div className="bar">
        <label className="field">
          <span>Repository</span>
          <input value={remote} onChange={(e) => setRemote(e.target.value)} disabled={busy || !!ready} spellCheck={false} />
        </label>
        <label className="field field--narrow">
          <span>Ticket</span>
          <input value={ticketId} onChange={(e) => setTicketId(e.target.value)} disabled={busy || !!ready} spellCheck={false} />
        </label>
        {ready ? (
          <div className="actions">
            <button type="button" className="btn" onClick={() => void window.pitwall.preview.reload()}>
              Reload
            </button>
            <button type="button" className="btn" onClick={() => void close()} disabled={busy}>
              Tear down
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn--primary" onClick={() => void open()} disabled={busy || !remote.trim()}>
            {busy ? 'Working…' : 'Create preview'}
          </button>
        )}
      </div>

      {ready && status.env && (
        <div className="urlbar">
          <span className="urlbar__url">{status.env.url}</span>
          <span className="urlbar__meta">
            {status.env.databaseUrl} · up in {((status.elapsedMs ?? 0) / 1000).toFixed(1)}s
          </span>
        </div>
      )}

      <div className="stage" ref={slot}>
        {!status && <p className="stage__idle">No preview running. Create one to see the app.</p>}
        {status && !ready && status.phase !== 'failed' && (
          <p className="stage__idle">
            {PHASE_TEXT[status.phase]}
            <span className="stage__hint">First run pulls and builds images. Later runs are much faster.</span>
          </p>
        )}
        {status?.phase === 'failed' && (
          <div className="stage__error">
            <p className="stage__errorTitle">Preview did not start</p>
            <pre>{status.error}</pre>
            <button type="button" className="btn" onClick={() => setStatus(null)}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
