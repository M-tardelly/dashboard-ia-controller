'use strict';
/**
 * Atualizações via GitHub Releases.
 * - Windows e Linux (AppImage): baixa em segundo plano e instala ao reiniciar (electron-updater).
 * - macOS e Linux .deb: a atualização silenciosa exige app assinado/permissão de root,
 *   então avisamos e baixamos o instalador novo com um clique.
 */
const { app, shell } = require('electron');
const { EventEmitter } = require('events');
const pkg = require('../package.json');

const CHECK_EVERY = 4 * 3600e3;

/**
 * Repositório de onde vêm as atualizações.
 * No app instalado o electron-builder REMOVE a seção "build" do package.json,
 * então lemos o resources/app-update.yml (gerado pelo build a partir do "publish").
 * Em modo dev (npm start) usamos o package.json.
 */
function repoInfo() {
  try {
    const path = require('path');
    const fs = require('fs');
    const yml = fs.readFileSync(path.join(process.resourcesPath || '', 'app-update.yml'), 'utf8');
    const get = (k) => { const m = new RegExp(`^${k}:\\s*['"]?([^'"\\r\\n]+)`, 'm').exec(yml); return m ? m[1].trim() : null; };
    if (get('provider') === 'github' && get('owner') && get('repo')) return { owner: get('owner'), repo: get('repo') };
  } catch { /* sem app-update.yml: modo dev */ }
  const pub = [].concat((pkg.build && pkg.build.publish) || []).find((p) => p.provider === 'github') || {};
  return { owner: pub.owner, repo: pub.repo };
}
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

class Updater extends EventEmitter {
  constructor({ beforeQuit } = {}) {
    super();
    this.beforeQuit = beforeQuit || (() => {});
    const { owner, repo } = repoInfo();
    this.repo = owner && repo && !/SEU_USUARIO/.test(owner) ? { owner, repo } : null;
    // teste local: AIAS_UPDATE_FEED=http://127.0.0.1:porta/ usa um servidor local no lugar do GitHub
    this.testFeed = app.isPackaged ? process.env.AIAS_UPDATE_FEED : null;
    if (this.testFeed) this.repo = { owner: 'teste-local', repo: 'feed' };
    this.mode = !app.isPackaged ? 'dev'
      : !this.repo ? 'unconfigured'
        : (process.platform === 'win32' || (process.platform === 'linux' && process.env.APPIMAGE)) ? 'auto' : 'notify';
    this.state = {
      mode: this.mode, current: app.getVersion(), status: 'idle', latest: null, progress: null,
      error: null, checkedAt: null, releaseUrl: this.repo ? `https://github.com/${this.repo.owner}/${this.repo.repo}/releases` : null,
    };
    if (this.mode === 'auto') this.setupAuto();
  }

  set(patch) { Object.assign(this.state, patch); this.emit('changed', this.state); }

  setupAuto() {
    const { autoUpdater } = require('electron-updater');
    this.au = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    if (this.testFeed) autoUpdater.setFeedURL({ provider: 'generic', url: this.testFeed });
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'uptodate', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', latest: info.version, progress: 0, checkedAt: Date.now(), releaseUrl: this.tagUrl(info.version) }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', latest: info.version, progress: 100 }));
    autoUpdater.on('error', (e) => this.set({ status: 'error', error: friendly(e) }));
  }

  tagUrl(v) { return this.repo ? `https://github.com/${this.repo.owner}/${this.repo.repo}/releases/tag/v${v}` : null; }

  async check() {
    if (this.mode === 'dev' || this.mode === 'unconfigured') return this.state;
    if (['checking', 'downloading'].includes(this.state.status)) return this.state;
    if (this.mode === 'auto') {
      try { await this.au.checkForUpdates(); } catch (e) { this.set({ status: 'error', error: friendly(e) }); }
      return this.state;
    }
    // modo "avisar": consulta a API pública do GitHub
    this.set({ status: 'checking', error: null });
    try {
      const res = await fetch(`https://api.github.com/repos/${this.repo.owner}/${this.repo.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ai-account-switcher' },
      });
      if (res.status === 404) return this.set({ status: 'uptodate', checkedAt: Date.now() }), this.state;
      if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
      const rel = await res.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      if (!latest || cmpVersion(latest, this.state.current) <= 0) {
        this.set({ status: 'uptodate', checkedAt: Date.now() });
      } else {
        this.set({ status: 'available', latest, checkedAt: Date.now(), releaseUrl: rel.html_url, downloadUrl: pickAsset(rel.assets || []) || rel.html_url });
      }
    } catch (e) { this.set({ status: 'error', error: friendly(e) }); }
    return this.state;
  }

  /** Reinicia e instala (auto) ou abre o download do instalador novo (avisar). */
  install() {
    if (this.mode === 'auto' && this.state.status === 'ready') {
      this.beforeQuit();
      setImmediate(() => this.au.quitAndInstall(false, true));
      return { ok: true };
    }
    if (this.state.downloadUrl || this.state.releaseUrl) shell.openExternal(this.state.downloadUrl || this.state.releaseUrl);
    return { ok: true };
  }

  start() {
    setTimeout(() => this.check(), 15e3);
    setInterval(() => this.check(), CHECK_EVERY);
  }
}

function pickAsset(assets) {
  const names = assets.map((a) => ({ name: a.name, url: a.browser_download_url }));
  let want;
  if (process.platform === 'darwin') want = (n) => n.endsWith('.dmg') && n.includes(process.arch === 'arm64' ? 'arm64' : 'x64');
  else if (process.platform === 'linux') want = (n) => n.endsWith('.deb');
  else want = (n) => n.endsWith('.exe');
  const hit = names.find((a) => want(a.name)) || (process.platform === 'darwin' ? names.find((a) => a.name.endsWith('.dmg')) : null);
  return hit ? hit.url : null;
}

function friendly(e) {
  const msg = String((e && e.message) || e || '');
  if (/404|Cannot find latest|No published versions/i.test(msg)) return 'Nenhuma versão publicada no GitHub ainda.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/i.test(msg)) return 'Sem conexão com o GitHub agora. Tento de novo mais tarde.';
  return msg.split('\n')[0].slice(0, 200);
}

module.exports = { Updater, cmpVersion };
