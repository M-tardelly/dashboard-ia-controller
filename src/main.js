'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, safeStorage, shell, Notification, dialog } = require('electron');
const transfer = require('./core/transfer');
const { Updater } = require('./updater');
const { Manager, PROVIDERS } = require('./core/manager');

// modo de teste usa uma pasta de dados própria (não conflita com o app aberto)
if (process.env.AIAS_SCREENSHOT) app.setPath('userData', path.join(app.getPath('temp'), 'aias-screenshot'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let tray = null;
let manager = null;
let updater = null;
let quitting = false;

const ICON = path.join(__dirname, '..', 'build', 'icon.png');

function makeCrypt() {
  let secure = safeStorage.isEncryptionAvailable();
  // no Linux sem chaveiro (GNOME Keyring/KWallet) o Electron cai num modo fraco
  if (secure && process.platform === 'linux' && safeStorage.getSelectedStorageBackend
    && safeStorage.getSelectedStorageBackend() === 'basic_text') secure = false;
  const label = { win32: 'proteção do Windows (DPAPI)', darwin: 'Keychain do macOS', linux: 'chaveiro do sistema (libsecret/KWallet)' }[process.platform] || 'criptografia do sistema';
  return {
    secure,
    label,
    encrypt: (s) => (secure ? 'v1:' + safeStorage.encryptString(s).toString('base64') : 'b64:' + Buffer.from(s).toString('base64')),
    decrypt: (s) => {
      if (s.startsWith('v1:')) return safeStorage.decryptString(Buffer.from(s.slice(3), 'base64'));
      return Buffer.from(s.replace(/^b64:/, ''), 'base64').toString('utf8');
    },
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 600,
    title: 'AI Account Switcher',
    icon: ICON,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // modo de teste: AIAS_SCREENSHOT=arquivo.png [AIAS_VIEW=claude] captura a tela e fecha
  if (process.env.AIAS_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.AIAS_VIEW) await win.webContents.executeJavaScript(`go(${JSON.stringify(process.env.AIAS_VIEW)})`);
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.AIAS_SCREENSHOT, img.toPNG());
        quitting = true; app.quit();
      }, 1500);
    }, Number(process.env.AIAS_SHOT_DELAY) || 9000));
  }
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function showWindow() {
  if (!win) createWindow();
  win.show(); win.focus();
}

function buildTrayMenu() {
  if (!tray) return;
  const st = manager.state();
  const items = [];
  for (const t of st.tools) {
    const profs = st.profiles.filter((p) => p.tool === t.id);
    items.push({
      label: t.name,
      submenu: profs.length
        ? profs.map((p) => ({
          label: `${p.label}${p.plan ? `  (${p.plan})` : ''}${usageHint(p)}`,
          type: 'radio', checked: p.active,
          click: () => doActivate(p.id),
        }))
        : [{ label: 'Nenhuma conta salva', enabled: false }],
    });
  }
  const up = updater && updater.state;
  if (up && up.status === 'ready') items.push({ type: 'separator' }, { label: `Reiniciar e atualizar para ${up.latest}`, click: () => updater.install() });
  else if (up && up.status === 'available') items.push({ type: 'separator' }, { label: `Baixar versão ${up.latest}`, click: () => updater.install() });
  items.push({ type: 'separator' }, { label: 'Abrir painel', click: showWindow }, { label: 'Sair', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  const active = st.tools.map((t) => {
    const p = st.profiles.find((x) => x.id === t.activeId);
    return `${t.name}: ${p ? p.label : '—'}`;
  }).join('\n');
  tray.setToolTip(`AI Account Switcher\n${active}`.slice(0, 127));
}

function usageHint(p) {
  const w = p.usage && p.usage.windows && p.usage.windows[0];
  return w ? `  — ${Math.round(w.percent)}%` : '';
}

async function doActivate(id) {
  try {
    const prof = manager.profile(id);
    const res = await manager.activate(id);
    if (!res.already && prof && Notification.isSupported()) {
      new Notification({ title: 'Conta trocada', body: `${PROVIDERS[prof.tool].name} agora usa: ${prof.label}\nReinicie sessões abertas do CLI.`, icon: ICON }).show();
    }
    manager.refreshUsage(id, true).catch(() => {});
    return res;
  } catch (e) { return { ok: false, error: e.message }; }
}

let pushTimer = null;
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.send('state', manager.state());
    buildTrayMenu();
  }, 80);
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { ok: false, error: e.message }; }
  });
  h('state', () => manager.state());
  h('updateState', () => updater.state);
  h('checkUpdate', () => updater.check());
  h('installUpdate', () => updater.install());
  h('activate', (id) => doActivate(id));
  h('rename', (id, label) => manager.rename(id, label));
  h('remove', (id) => manager.remove(id));
  h('login', (tool, profileId) => manager.startLogin(tool, profileId));
  h('cancelLogin', (tool) => manager.cancelLogin(tool));
  h('install', (tool) => manager.installCli(tool));
  h('detect', () => manager.detectClis());
  h('refreshUsage', (id) => manager.refreshUsage(id, true));
  h('refreshAll', async () => { await manager.syncAll(); return manager.refreshAllUsage(true); });
  h('exportVault', async (ids, password) => {
    const payload = await manager.buildExport(ids);
    const text = transfer.encryptExport(payload, password);
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: 'Salvar exportação das contas',
      defaultPath: path.join(app.getPath('documents'), `contas-ai-${stamp}.aias`),
      filters: [{ name: 'Exportação AI Account Switcher', extensions: ['aias'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, text, { mode: 0o600 });
    return { ok: true, path: r.filePath, count: payload.profiles.length };
  });
  h('importPick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Escolher arquivo de exportação', properties: ['openFile'],
      filters: [{ name: 'Exportação AI Account Switcher', extensions: ['aias', 'json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const file = r.filePaths[0];
    const head = transfer.readHeader(fs.readFileSync(file, 'utf8'));
    return { ok: true, path: file, name: path.basename(file), createdAt: head.createdAt, summary: head.summary || [] };
  });
  h('importApply', async (file, password, mode) => {
    const payload = transfer.decryptExport(fs.readFileSync(file, 'utf8'), password);
    const res = await manager.importPayload(payload, mode);
    return { ok: true, ...res };
  });
  h('localUsage', (days) => manager.localUsage(days || 30));
  h('openExternal', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
  h('openFolder', (tool) => {
    const dirs = { claude: '.claude', codex: '.codex', cursor: '.cursor' };
    shell.openPath(path.join(require('os').homedir(), dirs[tool] || ''));
  });
}

app.whenReady().then(async () => {
  app.setAppUserModelId('local.ai-account-switcher');
  manager = new Manager(app.getPath('userData'), makeCrypt());
  manager.on('changed', pushState);
  manager.on('openUrl', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(nativeImage.createFromPath(ICON));
  updater = new Updater({ beforeQuit: () => { quitting = true; } });
  updater.on('changed', (s) => {
    if (win && !win.isDestroyed()) win.webContents.send('update', s);
    buildTrayMenu();
    if (s.status === 'ready' && Notification.isSupported() && !updater.notified) {
      updater.notified = true;
      const n = new Notification({ title: 'Atualização pronta', body: `A versão ${s.latest} foi baixada. Clique para reiniciar e atualizar.`, icon: ICON });
      n.on('click', () => updater.install());
      n.show();
    }
  });
  registerIpc();
  createWindow();

  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  buildTrayMenu();

  await manager.syncAll();
  await manager.detectClis();
  manager.refreshAllUsage(false).catch(() => {});
  updater.start();

  // detecta logins/trocas feitos por fora e atualiza o consumo periodicamente
  setInterval(() => manager.syncAll(), 15e3);
  setInterval(() => manager.refreshAllUsage(false).catch(() => {}), 90e3);
});

app.on('second-instance', showWindow);
app.on('activate', showWindow); // macOS: clique no ícone do Dock
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());
