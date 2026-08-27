import { contextBridge, ipcRenderer } from 'electron'

import type { CheckId, DoctorReport, FixOutcome } from '../shared/doctor'
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
    run: (): Promise<DoctorReport> => ipcRenderer.invoke('doctor:run'),
    fix: (id: CheckId): Promise<FixOutcome> => ipcRenderer.invoke('doctor:fix', id)
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
