import { useCallback, useEffect, useState } from 'react'

import GitHub from './GitHub'
import Tickets from './Tickets'
import type { CheckResult, DoctorReport } from '../../shared/doctor'
import type { Repo } from '../../shared/github'

const STATUS_LABEL: Record<CheckResult['status'], string> = {
  ok: 'Ready',
  warn: 'Check',
  fail: 'Blocked',
  checking: 'Checking',
  pending: 'Pending'
}

function Check({ check }: { check: CheckResult }): JSX.Element {
  const [copied, setCopied] = useState(false)

  const openDocs = (): void => {
    if (check.docsUrl) void window.pitwall.openExternal(check.docsUrl)
  }

  const copy = async (): Promise<void> => {
    if (!check.command) return
    await navigator.clipboard.writeText(check.command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <li className={`check check--${check.status}`}>
      <span className="check__status">{STATUS_LABEL[check.status]}</span>
      <div className="check__body">
        <p className="check__label">{check.label}</p>
        <p className="check__detail">{check.detail}</p>
        {check.remediation && (
          <div className="check__fix">
            <p>
              {check.remediation}
              {check.docsUrl && (
                <button className="linklike" type="button" onClick={openDocs}>
                  Open instructions
                </button>
              )}
            </p>
            {check.command && (
              <>
                {check.shell && <p className="check__shell">{check.shell}</p>}
                <div className="cmd">
                  <code>{check.command}</code>
                  <button type="button" className="btn btn--tiny" onClick={() => void copy()}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

export default function App(): JSX.Element {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [running, setRunning] = useState(true)
  const [showChecks, setShowChecks] = useState(false)
  const [repo, setRepo] = useState<Repo | null>(null)

  const probe = useCallback(async () => {
    setRunning(true)
    try {
      const next = await window.pitwall.doctor.run()
      setReport(next)
      // A passing environment is not what anyone opened the app to read. Once it
      // passes, collapse it to one line and give the space to the work.
      setShowChecks(!next.ready)
    } finally {
      setRunning(false)
    }
  }, [])

  useEffect(() => {
    void probe()
  }, [probe])

  const ready = report?.ready ?? false
  const blocked = report?.checks.filter((c) => c.status === 'fail').length ?? 0

  return (
    <main className={ready ? 'shell shell--working' : 'shell'}>
      {ready ? (
        <header className="statusline">
          <span className="statusline__dot" aria-hidden="true" />
          <span className="statusline__text">
            Environment ready · {report?.targetDistro} · probed in {report?.elapsedMs} ms
          </span>
          <button type="button" className="linklike" onClick={() => setShowChecks((v) => !v)}>
            {showChecks ? 'Hide checks' : 'Show checks'}
          </button>
          <button type="button" className="linklike" onClick={() => void probe()} disabled={running}>
            Re-check
          </button>
        </header>
      ) : (
        <header className="masthead">
          <p className="eyebrow">Pitwall · first run</p>
          <h1>Checking this machine</h1>
          <p className="deck">
            Pitwall keeps every ticket in its own worktree and its own pair of containers, all inside WSL2. These
            are the things that have to be true before a repo can be connected.
          </p>
        </header>
      )}

      {(showChecks || !report) && (
        <section className="panel" aria-busy={running}>
          {report ? (
            <ul className="checks">
              {report.checks.map((check) => (
                <Check key={check.id} check={check} />
              ))}
            </ul>
          ) : (
            <p className="probing">Probing…</p>
          )}

          {!ready && (
            <footer className="panel__foot">
              <span className="meta">
                {report
                  ? `${report.targetDistro ? `Target: ${report.targetDistro}` : 'No usable distribution'} · probed in ${report.elapsedMs} ms`
                  : 'Running checks'}
              </span>
              <div className="actions">
                <button type="button" className="btn" onClick={() => void probe()} disabled={running}>
                  {running ? 'Checking…' : 'Check again'}
                </button>
              </div>
            </footer>
          )}
        </section>
      )}

      {ready && (
        <>
          <GitHub picked={repo} onPick={setRepo} />
          {repo && <Tickets repo={repo} />}
        </>
      )}

      {report && !ready && (
        <p className="hint">
          {blocked > 0
            ? 'Run the commands above, then check again.'
            : 'Everything essential is present. The warnings above are worth resolving but will not stop a run.'}
        </p>
      )}
    </main>
  )
}
