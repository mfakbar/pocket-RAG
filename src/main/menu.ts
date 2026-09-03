import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppCommand } from '../shared/contracts'

function sendCommand(command: AppCommand): void {
  const window = BrowserWindow.getFocusedWindow()
  if (window && !window.isDestroyed()) window.webContents.send('app:command', command)
}

export function installApplicationMenu(): void {
  const toggleSidebarAccelerator =
    process.platform === 'darwin' ? 'Command+Control+S' : 'Ctrl+Shift+S'
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'RavnDock',
      submenu: [
        { label: 'About RavnDock', click: () => sendCommand('about') },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendCommand('settings')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendCommand('new-chat')
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+1', click: () => sendCommand('home') },
        { label: 'Chat', accelerator: 'CmdOrCtrl+2', click: () => sendCommand('chat') },
        { label: 'Monitor', accelerator: 'CmdOrCtrl+3', click: () => sendCommand('monitor') },
        { type: 'separator' },
        {
          label: 'Toggle Chat Sidebar',
          accelerator: toggleSidebarAccelerator,
          click: () => sendCommand('toggle-sidebar')
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
