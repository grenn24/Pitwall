import { BrowserWindow, WebContentsView } from 'electron'

/**
 * The embedded browser that shows a running preview.
 *
 * The build plan says BrowserView; that API is deprecated as of Electron 30 and
 * WebContentsView replaces it with the same capability and a saner lifecycle.
 * Same idea, current API.
 *
 * The preview renders a container built from the user's repository, so it is
 * treated as untrusted: its own process, no node integration, no access to our
 * preload, and any window it tries to open is refused rather than handed to the
 * OS browser.
 */

export interface PaneBounds {
  x: number
  y: number
  width: number
  height: number
}

let view: WebContentsView | null = null
let attachedTo: BrowserWindow | null = null

export function showPreview(window: BrowserWindow, url: string, bounds: PaneBounds): void {
  if (!view) {
    view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // No preload. The preview must never reach window.pitwall.
        webSecurity: true
      }
    })

    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  if (attachedTo !== window) {
    window.contentView.addChildView(view)
    attachedTo = window
  }

  view.setBounds(roundBounds(bounds))
  if (view.webContents.getURL() !== url) void view.webContents.loadURL(url)
}

export function setPreviewBounds(bounds: PaneBounds): void {
  view?.setBounds(roundBounds(bounds))
}

export function reloadPreview(): void {
  view?.webContents.reload()
}

/**
 * Remove the pane and destroy its process.
 *
 * Called on teardown as well as on hide: leaving a view pointed at a port whose
 * container has just been removed produces a connection-refused page that looks
 * like our failure rather than an expected end of life.
 */
export function hidePreview(): void {
  if (!view) return
  if (attachedTo && !attachedTo.isDestroyed()) attachedTo.contentView.removeChildView(view)
  view.webContents.close()
  view = null
  attachedTo = null
}

/** Bounds must be integers; fractional values from a DOM rect throw. */
function roundBounds(b: PaneBounds): PaneBounds {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height))
  }
}
