import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, nativeTheme, net, protocol, session, shell } from 'electron';
import { ASSET_SCHEME } from '@shared/ipc';
import { PALETTES, resolveTheme } from '@shared/theme';
import { DockedPanel, trackerScriptPath } from './dockedPanel';
import { EmbeddedApp } from './embeddedApp';
import { registerIpc } from './ipc';
import type { ProjectStore } from './projectStore';
import { ProjectManager } from './projects';
import { SettingsStore } from './settingsStore';

protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

app.setName('CreateCraft');
// Data stays where it has always been (%APPDATA%\creative-studio) despite the rename.
// CS_USER_DATA_DIR gives automated smoke tests an isolated profile; never set in normal use.
app.setPath('userData', process.env.CS_USER_DATA_DIR ? path.resolve(process.env.CS_USER_DATA_DIR) : path.join(app.getPath('appData'), 'creative-studio'));

// One instance per profile: two processes seeding/writing the same project would race.
if (!app.requestSingleInstanceLock()) app.exit(0);

const appIcon = () => path.join(app.getAppPath(), 'resources', 'icon.ico');
let mainWindow: BrowserWindow | null = null;
const panelClosedListeners: Array<() => void> = [];
const embedded = new EmbeddedApp(() => mainWindow, trackerScriptPath(app.getAppPath()), () => { /* app window closed */ });
const panel = new DockedPanel({
  preload: path.join(__dirname, '../preload/index.js'),
  icon: appIcon,
  trackerScript: trackerScriptPath(app.getAppPath()),
  backgroundColor: PALETTES.artcraft.surface,
  load: async (win) => {
    win.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (devUrl) await win.loadURL(`${devUrl}#panel`);
    else await win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'panel' });
  },
  onClosed: () => { for (const cb of panelClosedListeners) cb(); },
});
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
const settings = new SettingsStore(app.getPath('userData'));
const projects = new ProjectManager(
  path.join(app.getPath('userData'), 'projects'),
  path.join(app.getAppPath(), 'fixtures', 'sample-project'),
  path.join(app.getPath('userData'), 'projects.json'),
  (dir) => shell.trashItem(dir),
);
const project = (): Promise<ProjectStore> => projects.current();

const devUrl = process.env.ELECTRON_RENDERER_URL;
const isAppUrl = (url: string) =>
  devUrl ? url.startsWith(devUrl) : url.startsWith(pathToFileURL(path.join(__dirname, '../renderer/')).href);

async function createWindow() {
  const appearance = await settings.load();
  nativeTheme.themeSource = appearance.mode === 'system' ? 'system' : appearance.mode === 'light' ? 'light' : 'dark';
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'CreateCraft',
    icon: appIcon(),
    backgroundColor: PALETTES[resolveTheme(appearance, nativeTheme.shouldUseDarkColors)].bg,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; panel.close(); embedded.release(false); });
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen'] as const) {
    mainWindow.on(ev as 'move', () => embedded.apply());
  }

  // App-only navigation; external links go to the default browser after scheme check.
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  app.setAppUserModelId('ClaudeCraft.CreateCraft');
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  // studio-asset://asset/<assetId>[?p=<projectKey>] → read-only file inside that project's root.
  protocol.handle(ASSET_SCHEME, async (req) => {
    try {
      const url = new URL(req.url);
      const assetId = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (url.host !== 'asset' || !/^[\w-]{1,128}$/.test(assetId)) return new Response('Bad request', { status: 400 });
      const key = url.searchParams.get('p');
      const store = key ? await projects.storeFor(key) : await project();
      const file = await store.resolveAssetPath(assetId);
      // The renderer decodes sound for waveforms with fetch(), which needs a CORS header (the
      // scheme only serves this app's own library files, read-only).
      const res = await net.fetch(pathToFileURL(file).href, { headers: req.headers.get('range') ? { range: req.headers.get('range')! } : undefined });
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpc({
    window: () => mainWindow,
    isTrustedSender: (e) => !!e.senderFrame && isAppUrl(e.senderFrame.url),
    settings,
    onAppearanceChanged: (s) => { nativeTheme.themeSource = s.mode === 'system' ? 'system' : s.mode === 'light' ? 'light' : 'dark'; },
    project,
    projects,
    secretsDir: path.join(app.getPath('userData'), 'secrets'),
    panel: {
      open: (pid) => panel.open(pid),
      close: () => panel.close(),
      get isOpen() { return panel.isOpen; },
      onClosed: (cb) => { panelClosedListeners.push(cb); },
    },
    embedded,
  });

  await createWindow();
  embedded.prewarm();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
