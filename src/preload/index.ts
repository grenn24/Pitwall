import { contextBridge, ipcRenderer } from 'electron'

import type { DoctorReport } from '../shared/doctor'
import type { AuthState, BranchStatus, Repo } from '../shared/github'
import type { Refusal, Ticket } from '../shared/ticket'
import type { PreviewStatus } from '../shared/preview'

export interface PaneBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The only surface the renderer gets. Context isolation is on and node
 * integration is off, so everything the UI can do is listed here — which is the
 * point: the list is short enough to audit.
 */
const api = {
  doctor: {
    run: (): Promise<DoctorReport> => ipcRenderer.invoke('doctor:run')
  },
  github: {
    /** Restore a stored sign-in on launch. */
    restore: (): Promise<AuthState> => ipcRenderer.invoke('github:restore'),
    state: (): Promise<AuthState> => ipcRenderer.invoke('github:state'),
    /** Resolves when the user has finished on GitHub, or explains why not. */
    signIn: (): Promise<AuthState> => ipcRenderer.invoke('github:signIn'),
    cancelSignIn: (): Promise<void> => ipcRenderer.invoke('github:cancelSignIn'),
    signOut: (): Promise<AuthState> => ipcRenderer.invoke('github:signOut'),
    repositories: (): Promise<Repo[]> => ipcRenderer.invoke('github:repositories'),
    hasNoInstallations: (): Promise<boolean> => ipcRenderer.invoke('github:hasNoInstallations'),
    branchStatus: (fullName: string, ref: string): Promise<BranchStatus> =>
      ipcRenderer.invoke('github:branchStatus', { fullName, ref }),
    /** The device code arrives here while signIn is still pending. */
    onState: (handler: (state: AuthState) => void): (() => void) => {
      const listener = (_e: unknown, state: AuthState): void => handler(state)
      ipcRenderer.on('github:state', listener)
      return () => ipcRenderer.removeListener('github:state', listener)
    }
  },
  engine: {
    open: (input: { title: string; body: string; cloneUrl: string; repoFullName: string }): Promise<Ticket> =>
      ipcRenderer.invoke('engine:open', input),
    run: (id: string): Promise<Ticket> => ipcRenderer.invoke('engine:run', id),
    stop: (): Promise<void> => ipcRenderer.invoke('engine:stop'),
    list: (): Promise<Ticket[]> => ipcRenderer.invoke('engine:list'),
    get: (id: string): Promise<Ticket | null> => ipcRenderer.invoke('engine:get', id),
    discard: (id: string): Promise<void> => ipcRenderer.invoke('engine:discard', id),
    refusals: (): Promise<Refusal[]> => ipcRenderer.invoke('engine:refusals'),
    /** Every transition, while the run is still going. */
    onCheckpoint: (handler: (ticket: Ticket) => void): (() => void) => {
      const listener = (_e: unknown, ticket: Ticket): void => handler(ticket)
      ipcRenderer.on('engine:checkpoint', listener)
      return () => ipcRenderer.removeListener('engine:checkpoint', listener)
    }
  },
  ticket: {
    open: (remoteUrl: string, ticketId: string): Promise<PreviewStatus> =>
      ipcRenderer.invoke('ticket:open', { remoteUrl, ticketId }),
    close: (): Promise<{ containersLeft: string[] } | null> => ipcRenderer.invoke('ticket:close'),
    status: (): Promise<PreviewStatus | null> => ipcRenderer.invoke('ticket:status'),
    /** Returns an unsubscribe function, so a re-render cannot stack listeners. */
    onPhase: (handler: (status: PreviewStatus) => void): (() => void) => {
      const listener = (_e: unknown, status: PreviewStatus): void => handler(status)
      ipcRenderer.on('ticket:phase', listener)
      return () => ipcRenderer.removeListener('ticket:phase', listener)
    }
  },
  preview: {
    attach: (bounds: PaneBounds): Promise<void> => ipcRenderer.invoke('preview:attach', bounds),
    setBounds: (bounds: PaneBounds): Promise<void> => ipcRenderer.invoke('preview:bounds', bounds),
    reload: (): Promise<void> => ipcRenderer.invoke('preview:reload'),
    hide: (): Promise<void> => ipcRenderer.invoke('preview:hide')
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
}

export type PitwallApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('pitwall', api)
} else {
  // Only reachable if context isolation is ever turned off, which it should not
  // be. Cast rather than relying on the renderer's global augmentation, which is
  // not part of this compilation unit.
  ;(window as unknown as Record<string, unknown>).pitwall = api
}
