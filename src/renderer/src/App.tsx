import { useCallback, useEffect, useState } from 'react'

import Preview from './Preview'
import type { CheckResult, DoctorReport, FixOutcome } from '../../shared/doctor'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

const STATUS_LABEL: Record<CheckResult['status'], string> = {
  ok: 'Ready',
  warn: 'Check',
  fail: 'Blocked',
  checking: 'Checking',
  pending: 'Pending'
}

function Check({ check, onFixed }: { check: CheckResult; onFixed: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [outcome, setOutcome] = useState<FixOutcome | null>(null)
  const [progress, setProgress] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [restartIn, setRestartIn] = useState<number | null>(null)

  // Elapsed time, because "Running…" on its own cannot distinguish work in
  // progress from something that has quietly stopped answering.
  useEffect(() => {
    if (!fixing) return
    const started = Date.now()
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [fixing])

  useEffect(
    () =>
      window.pitwall.doctor.onFixProgress((p) => {
        if (p.id === check.fixId) setProgress(p.text)
      }),
    [check.fixId]
  )

  // An interactive step is finished by the user in a window of its own, so keep
  // re-probing until the machine agrees it is done. Stops as soon as the check
  // it belongs to goes green.
  useEffect(() => {
    if (!outcome?.pending || check.status === 'ok') return
    const timer = window.setInterval(onFixed, 5000)
    return () => window.clearInterval(timer)
  }, [outcome?.pending, check.status, onFixed])

  const openDocs = (): void => {
    if (check.docsUrl) void window.pitwall.openExternal(check.docsUrl)
  }

  const copy = async (): Promise<void> => {
    if (!check.command) return
    await navigator.clipboard.writeText(check.command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  // A fix that needs a restart restarts the machine, rather than leaving a
  // button for someone to find. The countdown exists so it is never a surprise
  // and can be stopped — there may be unsaved work in another window.
  useEffect(() => {
    if (!outcome?.needsRestart || !outcome.ok) return
    setRestartIn(20)
  }, [outcome?.needsRestart, outcome?.ok])

  useEffect(() => {
    if (restartIn === null) return
    if (restartIn <= 0) {
      void window.pitwall.doctor.fix('restart-windows')
      return
    }
    const timer = window.setTimeout(() => setRestartIn((n) => (n === null ? null : n - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [restartIn])

  const restart = async (): Promise<void> => {
    setRestartIn(null)
    const result = await window.pitwall.doctor.fix('restart-windows')
    // On success the machine is going down and there is nothing to report.
    if (!result.ok) setOutcome(result)
  }

  const runFix = async (): Promise<void> => {
    setFixing(true)
    setOutcome(null)
    setProgress('')
    try {
      if (!check.fixId) return
      const result = await window.pitwall.doctor.fix(check.fixId)
      setOutcome(result)
      // Re-probe on success: what the machine looks like afterwards is the only
      // trustworthy signal, and an elevated command cannot report its own output.
      if (result.ok) onFixed()
      // A pending launch is not done; the effect above keeps watching.
      if (result.pending) setFixing(false)
    } finally {
      setFixing(false)
    }
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
              <div className="cmd">
                <code>{check.command}</code>
                {check.canFix && (
                  <button type="button" className="btn btn--tiny btn--primary" onClick={() => void runFix()} disabled={fixing}>
                    {fixing ? `Running… ${formatElapsed(elapsed)}` : 'Run this'}
                  </button>
                )}
                <button type="button" className="btn btn--tiny" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
            {check.canFix && !outcome && (
              <p className="check__aside">
                {check.fixElevated
                  ? 'Windows will ask for permission, then a console window opens showing progress. It closes when the command finishes.'
                  : 'A console window opens showing progress. It closes when the command finishes.'}
              </p>
            )}
            {fixing && check.fixWhileRunning && (
              <p className="check__aside">{check.fixWhileRunning}</p>
            )}
            {fixing && progress && (
              <pre className="fixlog">{progress.split('\n').slice(-6).join('\n')}</pre>
            )}
            {outcome && !outcome.needsRestart && (
              <p className={outcome.ok ? 'check__aside check__aside--ok' : 'check__aside check__aside--bad'}>
                {outcome.ok ? (outcome.afterward ?? 'Done.') : outcome.error}
              </p>
            )}
            {outcome?.needsRestart && (
              <div className="restart">
                <p>
                  {outcome.afterward}
                  <br />
                  {restartIn === null
                    ? 'This check stays blocked until Windows restarts — that is expected, not a failure.'
                    : restartIn > 0
                      ? `Restarting in ${restartIn} second${restartIn === 1 ? '' : 's'}. Save anything open in other windows.`
                      : 'Restarting now.'}
                </p>
                <div className="restart__actions">
                  {restartIn !== null && restartIn > 0 && (
                    <button type="button" className="btn btn--tiny" onClick={() => setRestartIn(null)}>
                      Not now
                    </button>
                  )}
                  {/* Never disabled by an unrelated fix still marked running.
                      A restart button that cannot be clicked because something
                      else got stuck is the worst possible time to be stuck. */}
                  <button type="button" className="btn btn--tiny btn--primary" onClick={() => void restart()}>
                    Restart now
                  </button>
                </div>
              </div>
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
                <Check key={check.id} check={check} onFixed={() => void probe()} />
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

      {ready && <Preview />}

      {report && !ready && (
        <p className="hint">
          {blocked > 0
            ? 'Work through the blocked items above, then check again.'
            : 'Everything essential is present. The warnings above are worth resolving but will not stop a run.'}
        </p>
      )}
    </main>
  )
}
