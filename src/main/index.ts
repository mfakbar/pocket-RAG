import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { runtimeConfig } from './config'
import { registerIpcHandlers } from './ipc/register-ipc-handlers'
import { DependencyInstaller } from './services/dependency-installer'
import { KnowledgeService } from './services/knowledge-service'
import { LocalRagService } from './services/local-rag-service'
import { OllamaService } from './services/ollama-service'
import { ResourceMonitorService } from './services/resource-monitor-service'
import { RuntimeOrchestrator } from './services/runtime-orchestrator'
import {
  stopKnowledgeFolderAccess,
  useKnowledgeFolderBookmark
} from './services/security-scoped-access'
import { readConfig } from './settings'
import { safeExternalUrl } from './lib/window-security'
import { installApplicationMenu } from './menu'

app.setName('RavnDock')

if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'PocketAI Dev'))
}

const backendSource = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'rag-backend')
    : path.join(app.getAppPath(), 'rag-backend')

const installer = new DependencyInstaller(
  () => app.getPath('userData'),
  runtimeConfig.ollamaDownloadUrl,
  runtimeConfig.uvDownloadUrl,
  runtimeConfig.uvDownloadSha256,
  backendSource
)
const ollama = new OllamaService(runtimeConfig.ollamaBaseUrl, () => installer.managedOllamaPath())
const queryRag = new LocalRagService(
  backendSource,
  () => path.join(app.getPath('userData'), 'rag-index'),
  runtimeConfig.ollamaBaseUrl,
  runtimeConfig.embeddingModel,
  runtimeConfig.rerankerModel,
  ollama
)
const ingestionRag = new LocalRagService(
  backendSource,
  () => path.join(app.getPath('userData'), 'rag-index'),
  runtimeConfig.ollamaBaseUrl,
  runtimeConfig.embeddingModel,
  runtimeConfig.rerankerModel,
  ollama
)
const runtime = new RuntimeOrchestrator(ollama, queryRag, installer, ingestionRag)
const knowledge = new KnowledgeService(ingestionRag)
const resources = new ResourceMonitorService(ollama)
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 940,
    minWidth: 900,
    minHeight: 720,
    title: 'RavnDock',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#00000000',
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    }
  })

  const openExternalUrl = (target: string): void => {
    const safeUrl = safeExternalUrl(target)
    if (safeUrl) void shell.openExternal(safeUrl).catch(() => undefined)
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternalUrl(url)
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  mainWindow.once('closed', () => {
    mainWindow = null
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
}

registerIpcHandlers(runtime, knowledge, queryRag, ingestionRag, ollama, resources, () =>
  path.join(app.getPath('userData'), 'rag-index')
)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    installApplicationMenu()
    const config = await readConfig()
    queryRag.setSearchModels(config.embeddingModel, config.rerankerModel)
    ingestionRag.setSearchModels(config.embeddingModel, config.rerankerModel)
    if (config.knowledgeFolderBookmark) {
      useKnowledgeFolderBookmark(config.knowledgeFolderBookmark)
    }
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopKnowledgeFolderAccess()
  queryRag.stop()
  ingestionRag.stop()
})
