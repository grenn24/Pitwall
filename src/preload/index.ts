import { contextBridge, ipcRenderer } from 'electron'

import type { DoctorReport } from '../shared/doctor'

/**
 * The only surface the renderer gets. Context isolation is on and node
 * integration is off, so everything the UI can do is listed here — which is the
 * point: the list is short enough to audit.
 */
const api = {
  doctor: {
    run: (): Promise<DoctorReport> => ipcRenderer.invoke('doctor:run')
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
