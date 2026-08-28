import { join } from 'node:path'

import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import { runDoctor } from './doctor/index'
import * as github from './github/session'
import * as engine from './engine/session'
import { readRefusals } from './engine/store'
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
      nodeIntegration: false,
      // Chromium throttles timers and skips paints for windows that are
      // occluded or unfocused. Pitwall spends most of its life behind a
      // terminal while a long install runs, and a status that only refreshes
      // when the window is touched is worse than useless — it reads as a hang.
      backgroundThrottling: false
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
  ipcMain.handle('shell:openExternal', (_event, url: string) => shell.openExternal(url))

  // The token stays in main. The renderer asks for repositories and receives
  // repositories, never the credential that fetched them.
  ipcMain.handle('github:restore', () => github.restore())
  ipcMain.handle('github:state', () => github.currentState())
  ipcMain.handle('github:signIn', (event) =>
    github.signIn({
      onCode: (state) => {
        if (!event.sender.isDestroyed()) event.sender.send('github:state', state)
      }
    })
  )
  ipcMain.handle('github:cancelSignIn', () => github.cancelSignIn())
  ipcMain.handle('github:signOut', () => github.signOut())
  ipcMain.handle('github:repositories', () => github.repositories())
  ipcMain.handle('github:hasNoInstallations', () => github.hasNoInstallations())
  // Checkpoints stream while runTicket is still pending, because a run takes
  // long enough that a UI showing nothing until it finishes cannot be told
  // apart from one that has hung.
  ipcMain.handle('engine:open', (_e, input: engine.OpenTicketInput) => engine.openTicket(input))
  ipcMain.handle('engine:run', (event, id: string) =>
    engine.runTicket(id, (ticket) => {
      if (!event.sender.isDestroyed()) event.sender.send('engine:checkpoint', ticket)
    })
  )
  ipcMain.handle('engine:stop', () => engine.stopTicket())
  ipcMain.handle('engine:list', () => engine.list())
  ipcMain.handle('engine:get', (_e, id: string) => engine.get(id))
  ipcMain.handle('engine:discard', (_e, id: string) => engine.discard(id))
  ipcMain.handle('engine:refusals', () => readRefusals())

  ipcMain.handle('github:branchStatus', (_e, input: { fullName: string; ref: string }) =>
    github.branchStatus(input.fullName, input.ref)
  )

  // A preview belongs to a ticket and runs on the worktree that ticket already
  // has. Phases stream while it builds, because a cold start takes long enough
  // that a silent UI is indistinguishable from a hung one.
  ipcMain.handle('preview:start', (event, id: string) =>
    engine.previewTicket(id, (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('preview:phase', { id, status })
    })
  )
  ipcMain.handle('preview:stop', (_e, id: string) => engine.stopPreviewFor(id))
  ipcMain.handle('preview:status', (_e, id: string) => engine.previewOf(id))
  ipcMain.handle('preview:attach', (event, input: { id: string; bounds: PaneBounds }) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) engine.attachPreviewPane(window, input.id, input.bounds)
  })
  ipcMain.handle('preview:bounds', (_e, bounds: PaneBounds) => setPreviewBounds(bounds))
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
