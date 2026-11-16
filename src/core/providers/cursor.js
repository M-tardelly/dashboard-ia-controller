'use strict';
const path = require('path');
const U = require('../util');

/** Onde o cursor-agent guarda o login: Windows/Linux em arquivo, macOS no Keychain. */
function authPath(base = null) {
  if (U.IS_WIN) return path.join(base || U.APPDATA, 'Cursor', 'auth.json');
  return path.join(base || U.XDG_CONFIG, 'cursor', 'auth.json');
}
const KC = { account: 'cursor-user', access: 'cursor-access-token', refresh: 'cursor-refresh-token' };
async function readMacKeychain() {
  const accessToken = await U.kcGet(KC.access, KC.account);
  if (!accessToken) return null;
  const refreshToken = await U.kcGet(KC.refresh, KC.account);
  return JSON.stringify({ accessToken, refreshToken });
}
async function writeMacKeychain(auth) {
  const a = JSON.parse(auth);
  await U.kcSet(KC.access, KC.account, a.accessToken);
  if (a.refreshToken) await U.kcSet(KC.refresh, KC.account, a.refreshToken);
}
async function clearMacKeychain() { await U.kcDelete(KC.access, KC.account); await U.kcDelete(KC.refresh, KC.account); }
function cliConfigDir() { return process.env.CURSOR_CONFIG_DIR || path.join(U.HOME, '.cursor'); }
function cliConfigPath(dir = cliConfigDir()) { return path.join(dir, 'cli-config.json'); }

function sessionCookie(accessToken) {
  const claims = U.decodeJwt(accessToken) || {};
  const userId = String(claims.sub || '').split('|').pop();
  return `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`;
}
function money(cents) { return typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '—'; }

module.exports = {
  id: 'cursor',
  name: 'Cursor CLI',
  cliName: 'cursor-agent',
  color: '#7c8cff',
  installHint: U.IS_WIN ? 'Instalador oficial do Cursor Agent (PowerShell)' : 'Instalador oficial do Cursor Agent (install.sh)',

  findCli() {
    return U.findExecutable(['cursor-agent', 'agent'], U.IS_WIN
      ? [path.join(U.LOCALAPPDATA, 'cursor-agent', 'cursor-agent.cmd')]
      : [path.join(U.HOME, '.local', 'bin', 'cursor-agent')]);
  },

  installCommand() {
    return U.shellCommand("irm 'https://cursor.com/install?win32=true' | iex", 'curl https://cursor.com/install -fsS | bash');
  },

  async readLive() {
    const auth = U.IS_MAC ? await readMacKeychain() : U.readText(authPath());
    if (!auth) return null;
    const cfg = U.readJson(cliConfigPath()) || {};
    return { auth, authInfo: cfg.authInfo || null };
  },

  async writeLive(snap) {
    if (U.IS_MAC) await writeMacKeychain(snap.auth); else U.writeFileAtomic(authPath(), snap.auth);
    const file = cliConfigPath();
    const cfg = U.readJson(file);
    if (cfg) {
      if (snap.authInfo) cfg.authInfo = snap.authInfo; else delete cfg.authInfo;
      // caches ligados à conta anterior
      delete cfg.privacyCache; delete cfg.serverConfigCache; delete cfg.autoReviewAvailabilityCache;
      U.writeJson(file, cfg);
    }
  },

  identity(snap) {
    const a = safeAuth(snap) || {};
    const claims = U.decodeJwt(a.accessToken) || {};
    const info = snap.authInfo || {};
    return {
      key: claims.sub || info.authId || info.email || null,
      email: info.email || null,
      name: info.displayName || null,
      plan: snap.plan || null,
      org: null,
    };
  },

  loginSpec() {
    const dir = U.mkTempDir('cursor');
    const base = path.join(dir, 'auth');
    const cfgDir = path.join(dir, 'cfg');
    const env = { CURSOR_CONFIG_DIR: cfgDir };
    if (U.IS_WIN) env.APPDATA = base;
    else if (!U.IS_MAC) env.XDG_CONFIG_HOME = base;
    let previous = null;
    return {
      dir,
      args: ['login'],
      env,
      // macOS: o Keychain é um só, então guardamos o login atual, liberamos o espaço
      // para o login novo e devolvemos o login anterior no final.
      before: async () => {
        if (!U.IS_MAC) return;
        previous = await readMacKeychain();
        await clearMacKeychain();
      },
      after: async () => {
        if (!U.IS_MAC) return;
        if (previous) await writeMacKeychain(previous); else await clearMacKeychain();
      },
      collect: async () => {
        const auth = U.IS_MAC ? await readMacKeychain() : U.readText(authPath(base));
        if (!auth) return null;
        const a = safeAuth({ auth }) || {};
        let authInfo = (U.readJson(cliConfigPath(cfgDir)) || {}).authInfo || null;
        if (!authInfo && a.accessToken) {
          const me = await U.fetchJson('https://cursor.com/api/auth/me', { headers: { Cookie: sessionCookie(a.accessToken) } });
          if (me.ok && me.json && me.json.email) {
            authInfo = { email: me.json.email, displayName: me.json.name || me.json.email, authId: me.json.sub };
          }
        }
        return { auth, authInfo };
      },
    };
  },

  async refreshIfNeeded() { return null; },

  async fetchUsage(snap) {
    const a = safeAuth(snap);
    if (!a || !a.accessToken) return { error: 'Credenciais inválidas' };
    const claims = U.decodeJwt(a.accessToken) || {};
    if (claims.exp && claims.exp * 1000 < Date.now()) return { error: 'Login expirado — use "Entrar novamente".', expired: true };
    const headers = { Cookie: sessionCookie(a.accessToken), Origin: 'https://cursor.com', 'Content-Type': 'application/json' };
    // 1) mesmo endpoint do painel do cursor.com — reflete o ciclo real do plano
    //    (alguns planos, ex. os ligados ao Grok, têm ciclo semanal e o usage-summary fica zerado)
    const [cp, r] = await Promise.all([
      U.fetchJson('https://cursor.com/api/dashboard/get-current-period-usage', { method: 'POST', headers, body: '{}' }),
      U.fetchJson('https://cursor.com/api/usage-summary', { headers }),
    ]);
    if ([cp.status, r.status].some((s) => s === 401 || s === 403)) return { error: 'Login expirado — use "Entrar novamente".', expired: true };
    const s = (r.ok && r.json) || {};
    const plan = (s.individualUsage && s.individualUsage.plan) || {};
    const od = (s.individualUsage && s.individualUsage.onDemand) || {};
    const windows = [];
    const notes = [];

    const p = cp.ok && cp.json && cp.json.planUsage;
    if (p && typeof p.totalPercentUsed === 'number') {
      const start = Number(cp.json.billingCycleStart); const endMs = Number(cp.json.billingCycleEnd);
      const end = endMs ? new Date(endMs).toISOString() : null;
      const days = start && endMs ? Math.round((endMs - start) / 864e5) : null;
      const period = days == null ? 'ciclo' : days <= 8 ? 'semana' : days <= 31 ? 'mês' : `${days} dias`;
      windows.push({ key: 'total', label: `Uso incluso no plano (${period})`, percent: p.totalPercentUsed, resetsAt: end });
      if (typeof p.autoPercentUsed === 'number' && Math.abs(p.autoPercentUsed - p.totalPercentUsed) > 0.05) windows.push({ key: 'auto', label: 'Modelo Auto', percent: p.autoPercentUsed, resetsAt: end });
      if (typeof p.apiPercentUsed === 'number') windows.push({ key: 'api', label: 'Modelos escolhidos (API)', percent: p.apiPercentUsed, resetsAt: end });
      if (p.remainingBonus) notes.push('Bônus de uso gratuito disponível');
      const sl = cp.json.spendLimitUsage || {};
      if (typeof sl.individualUsed === 'number' && sl.individualUsed > 0) notes.push(`Uso extra (sob demanda): ${money(sl.individualUsed)}${sl.individualLimit ? ` de ${money(sl.individualLimit)}` : ''}`);
    } else if (r.ok && r.json) {
      // 2) reserva: resumo antigo (mensal)
      const end = s.billingCycleEnd || null;
      if (typeof plan.totalPercentUsed === 'number') windows.push({ key: 'total', label: 'Uso incluso no plano (mês)', percent: plan.totalPercentUsed, resetsAt: end });
      if (typeof plan.autoPercentUsed === 'number') windows.push({ key: 'auto', label: 'Modelo Auto', percent: plan.autoPercentUsed, resetsAt: end });
      if (typeof plan.apiPercentUsed === 'number') windows.push({ key: 'api', label: 'Modelos escolhidos (API)', percent: plan.apiPercentUsed, resetsAt: end });
      if (typeof plan.used === 'number' && typeof plan.limit === 'number') notes.push(`Incluso: ${money(plan.used)} de ${money(plan.limit)}`);
    } else {
      return { error: `Falha ao consultar uso (${cp.status || r.status})` };
    }
    if (od.enabled && od.used) notes.push(`Sob demanda: ${money(od.used)}${od.limit ? ` de ${money(od.limit)}` : ''}`);
    if (s.isUnlimited) notes.push('Plano ilimitado');
    return { windows, notes, plan: s.membershipType || null };
  },

  scanLocalUsage() { return []; },
};

function safeAuth(snap) { try { return JSON.parse(snap.auth); } catch { return null; } }
