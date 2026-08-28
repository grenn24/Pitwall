import { useCallback, useEffect, useState } from 'react'

import type { Repo } from '../../shared/github'
import type { Ticket, TicketState } from '../../shared/ticket'

/**
 * Tickets, and what the engine is doing with them.
 *
 * Ordered by state rather than by date, per §9: whatever wants a human comes
 * first. With one ticket at a time that ordering barely shows, but the list is
 * the thing v1 scales and this is the shape it scales in.
 */

/** How much a state deserves your attention. Lower sorts first. */
const URGENCY: Record<TicketState, number> = {
  failed: 0,
  changes_requested: 1,
  review_passed: 2,
  planning: 3,
  writing_tests: 3,
  writing_code: 3,
  reviewing: 3,
  draft: 4,
  spec_ready: 4,
  tests_written: 4,
  code_complete: 4,
  done: 5
}

const LABEL: Record<TicketState, string> = {
  draft: 'Not started',
  planning: 'Designing',
  spec_ready: 'Spec ready',
  writing_tests: 'Writing tests',
  tests_written: 'Tests written',
  writing_code: 'Writing code',
  code_complete: 'Code complete',
  reviewing: 'Reviewing',
  review_passed: 'Ready for you',
  changes_requested: 'Sent back',
  done: 'Done',
  failed: 'Failed'
}

export default function Tickets({ repo }: { repo: Repo }): JSX.Element {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setTickets(await window.pitwall.engine.list())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Checkpoints arrive while the run is still going, so the list follows along
  // rather than jumping from "started" to "finished".
  useEffect(
    () =>
      window.pitwall.engine.onCheckpoint((ticket) => {
        setTickets((current) => {
          const rest = current.filter((t) => t.id !== ticket.id)
          return [ticket, ...rest]
        })
      }),
    []
  )

  const create = async (): Promise<void> => {
    if (!title.trim()) return
    setBusy(true)
    try {
      const ticket = await window.pitwall.engine.open({
        title: title.trim(),
        body: body.trim(),
        cloneUrl: repo.cloneUrl,
        repoFullName: repo.fullName
      })
      setTitle('')
      setBody('')
      setOpenId(ticket.id)
      await refresh()
      await window.pitwall.engine.run(ticket.id)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const runAgain = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await window.pitwall.engine.run(id)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const sorted = [...tickets].sort(
    (a, b) => URGENCY[a.state] - URGENCY[b.state] || b.updatedAt.localeCompare(a.updatedAt)
  )

  return (
    <section className="tickets">
      <div className="ticketform">
        <input
          className="ticketform__title"
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
        <textarea
          className="ticketform__body"
          placeholder="Anything the agents need to know. Everything not written here is out of scope."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          disabled={busy}
        />
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={() => void create()} disabled={busy || !title.trim()}>
            {busy ? 'Running…' : 'Create and run'}
          </button>
          {busy && (
            <button type="button" className="btn" onClick={() => void window.pitwall.engine.stop()}>
              Stop
            </button>
          )}
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="tickets__empty">No tickets yet. Write one above and the agents will pick it up.</p>
      ) : (
        <ul className="ticketlist">
          {sorted.map((ticket) => (
            <li key={ticket.id} className={`tkt tkt--${ticket.state}`}>
              <button type="button" className="tkt__head" onClick={() => setOpenId(openId === ticket.id ? null : ticket.id)}>
                <span className="tkt__state">{LABEL[ticket.state]}</span>
                <span className="tkt__title">{ticket.title}</span>
                <span className="tkt__meta">
                  {ticket.branch ?? '—'} · {ticket.checkpoints.length} steps
                </span>
              </button>

              {openId === ticket.id && (
                <div className="tkt__body">
                  {ticket.error && <p className="tkt__error">{ticket.error}</p>}
                  <ol className="trail">
                    {ticket.checkpoints.map((c, i) => (
                      <li key={`${c.at}-${i}`}>
                        <span className="trail__to">{LABEL[c.to]}</span>
                        <span className="trail__note">{c.note}</span>
                        <span className="trail__who">{c.role ?? 'engine'}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="actions">
                    <button type="button" className="btn btn--tiny" onClick={() => void runAgain(ticket.id)} disabled={busy}>
                      Run
                    </button>
                    <button
                      type="button"
                      className="btn btn--tiny"
                      onClick={() => void window.pitwall.engine.discard(ticket.id).then(refresh)}
                      disabled={busy}
                    >
                      Discard workspace
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
