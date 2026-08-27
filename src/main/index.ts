import { join } from 'node:path'

import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import { runDoctor } from './doctor/index'
import { runFix } from './doctor/fixes'
import { attachPreview, closeTicket, currentStatus, openTicket } from './session'
import type { CheckId } from '../shared/doctor'
import { hidePreview, reloadPreview, setPreviewBounds, type PaneBounds } from './preview/pane'

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0c1114',
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Show only once painted, so startup never flashes an empty white frame.
  window.on('ready-to-show', () => window.show())

  // Anything targeting a new window is a real link. Send it to the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('sh.pitwall.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // The probe lives in main because it has to answer whether WSL exists at all,
  // which is a question only the Windows side can ask.
  ipcMain.handle('doctor:run', () => runDoctor())
  // Takes a check id, never a command. The command table lives in main so the
  // renderer cannot ask for anything that is not on it.
  ipcMain.handle('doctor:fix', (_event, id: CheckId) => runFix(id))
  ipcMain.handle('shell:openExternal', (_event, url: string) => shell.openExternal(url))

  // Preview progress is streamed rather than awaited: bringing an environment up
  // takes tens of seconds, and a UI that shows nothing until it finishes is
  // indistinguishable from one that has hung.
  ipcMain.handle('ticket:open', async (event, input: { remoteUrl: string; ticketId: string }) => {
    return openTicket(input, (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('ticket:phase', status)
    })
  })
  ipcMain.handle('ticket:close', () => closeTicket())
  ipcMain.handle('ticket:status', () => currentStatus())

  ipcMain.handle('preview:attach', (event, bounds: PaneBounds) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) attachPreview(window, bounds)
  })
  ipcMain.handle('preview:bounds', (_event, bounds: PaneBounds) => setPreviewBounds(bounds))
  ipcMain.handle('preview:reload', () => reloadPreview())
  ipcMain.handle('preview:hide', () => hidePreview())

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
