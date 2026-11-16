'use strict';
const fs = require('fs');
const path = require('path');
const U = require('../util');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const BETA = 'oauth-2025-04-20';
const UA = 'claude-code/2.1.325';

function configDir() { return process.env.CLAUDE_CONFIG_DIR || path.join(U.HOME, '.claude'); }
function credsPath(dir = configDir()) { return path.join(dir, '.credentials.json'); }
/** Arquivos de configuração global onde o Claude Code guarda o "oauthAccount". */
function globalConfigPaths() {
  const list = [path.join(U.HOME, '.claude.json'), path.join(configDir(), '.claude.json')];
  return [...new Set(list)];
}

const WINDOW_LABELS = {
  five_hour: 'Sessão (5h)',
  seven_day: 'Semanal (todos os modelos)',
  seven_day_opus: 'Semanal Opus',
  seven_day_sonnet: 'Semanal Sonnet',
  seven_day_oauth_apps: 'Semanal apps',
};

/** Nome do item no Keychain do macOS (mesma regra do Claude Code). */
function keychainService(dir = null) {
  const suffix = dir ? `-${require('crypto').createHash('sha256').update(dir.normalize('NFC')).digest('hex').substring(0, 8)}` : '';
  return `Claude Code-credentials${suffix}`;
}
const KC_ACCOUNT = 'claude-code-user';
function liveKeychainService() { return keychainService(process.env.CLAUDE_CONFIG_DIR || null); }

module.exports = {
  id: 'claude',
  name: 'Claude Code',
  cliName: 'claude',
  color: '#d97757',
  installHint: U.IS_WIN ? 'Instalador oficial da Anthropic (PowerShell)' : 'Instalador oficial da Anthropic (install.sh)',

  findCli() {
    return U.findExecutable(['claude'], U.IS_WIN
      ? [path.join(U.HOME, '.local', 'bin', 'claude.exe')]
      : [path.join(U.HOME, '.local', 'bin', 'claude'), path.join(U.HOME, '.claude', 'local', 'claude')]);
  },

  installCommand() {
    return U.shellCommand('irm https://claude.ai/install.ps1 | iex', 'curl -fsSL https://claude.ai/install.sh | bash');
  },

  /** Lê o login que está ativo no computador agora (arquivo ou Keychain do macOS). */
  async readLive() {
    let credentials = null;
    if (U.IS_MAC) credentials = await U.kcGet(liveKeychainService());
    if (!credentials) credentials = U.readText(credsPath());
    if (!credentials) return null;
    let oauthAccount = null;
    for (const f of globalConfigPaths()) {
      const j = U.readJson(f);
      if (j && j.oauthAccount) { oauthAccount = j.oauthAccount; break; }
    }
    return { credentials, oauthAccount };
  },

  async writeLive(snap) {
    if (U.IS_MAC) {
      const svc = liveKeychainService();
      await U.kcSet(svc, (await U.kcAccount(svc)) || KC_ACCOUNT, snap.credentials);
      if (fs.existsSync(credsPath())) U.writeFileAtomic(credsPath(), snap.credentials);
    } else {
      U.writeFileAtomic(credsPath(), snap.credentials);
    }
    for (const f of globalConfigPaths()) {
      const j = U.readJson(f);
      if (!j && f !== globalConfigPaths()[0]) continue;
      const obj = j || {};
      if (snap.oauthAccount) obj.oauthAccount = snap.oauthAccount; else delete obj.oauthAccount;
      U.writeJson(f, obj);
    }
  },

  identity(snap) {
    const c = safeCreds(snap);
    const a = snap.oauthAccount || {};
    return {
      key: a.accountUuid || a.emailAddress || null,
      email: a.emailAddress || null,
      name: a.displayName || a.fullName || null,
      plan: (c && c.subscriptionType) || null,
      org: a.organizationName || null,
    };
  },

  /** Login de uma nova conta em uma pasta isolada (não mexe na conta atual). */
  loginSpec() {
    const dir = U.mkTempDir('claude');
    return {
      dir,
      args: ['auth', 'login'],
      env: { CLAUDE_CONFIG_DIR: dir },
      collect: async () => {
        let credentials = U.readText(credsPath(dir));
        if (!credentials && U.IS_MAC) credentials = await U.kcGet(keychainService(dir));
        if (!credentials) return null;
        let oauthAccount = (U.readJson(path.join(dir, '.claude.json')) || {}).oauthAccount || null;
        if (!oauthAccount) oauthAccount = await fetchProfile(safeCreds({ credentials }));
        return { credentials, oauthAccount };
      },
      // no macOS o login isolado cria um item próprio no Keychain: removemos depois de copiar
      after: async () => { if (U.IS_MAC) await U.kcDelete(keychainService(dir)); },
    };
  },

  /** Renova o token se estiver expirado. Retorna snapshot novo ou null. */
  async refreshIfNeeded(snap) {
    const c = safeCreds(snap);
    if (!c || !c.refreshToken) return null;
    if (c.expiresAt && c.expiresAt - Date.now() > 5 * 60 * 1000) return null;
    for (const url of ['https://console.anthropic.com/v1/oauth/token', 'https://platform.claude.com/v1/oauth/token']) {
      const r = await U.fetchJson(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: CLIENT_ID }),
      });
      if (r.ok && r.json && r.json.access_token) {
        const full = JSON.parse(snap.credentials);
        full.claudeAiOauth = {
          ...full.claudeAiOauth,
          accessToken: r.json.access_token,
          refreshToken: r.json.refresh_token || c.refreshToken,
          expiresAt: Date.now() + (r.json.expires_in || 3600) * 1000,
        };
        return { ...snap, credentials: JSON.stringify(full) };
      }
    }
    return null;
  },

  async fetchUsage(snap) {
    const c = safeCreds(snap);
    if (!c) return { error: 'Credenciais inválidas' };
    if (c.expiresAt && c.expiresAt < Date.now()) return { error: 'Token expirado — abra o Claude Code com esta conta para renovar.' };
    const r = await U.fetchJson('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': BETA, 'User-Agent': UA, 'Content-Type': 'application/json' },
    });
    if (r.status === 429) return { error: 'Servidor limitou as consultas, tentando de novo em alguns minutos.', rateLimited: true };
    if (r.status === 401) return { error: 'Login expirado — use "Entrar novamente".', expired: true };
    if (!r.ok || !r.json) return { error: `Falha ao consultar uso (${r.status})` };
    const windows = [];
    for (const [k, v] of Object.entries(r.json)) {
      if (v && typeof v === 'object' && typeof v.utilization === 'number') {
        windows.push({ key: k, label: WINDOW_LABELS[k] || k, percent: v.utilization, resetsAt: v.resets_at || null });
      }
    }
    const extra = r.json.extra_usage;
    const notes = [];
    if (extra && extra.is_enabled) {
      notes.push(`Uso extra: ${fmtMoney(extra.used_credits)} de ${fmtMoney(extra.monthly_limit)}`);
    }
    return { windows, notes, plan: c.subscriptionType || null };
  },

  /** Tokens usados por dia, lidos dos logs locais do Claude Code. */
  scanLocalUsage(sinceMs) {
    const root = path.join(configDir(), 'projects');
    const events = [];
    const seen = new Set();
    walk(root, (file, stat) => {
      if (!file.endsWith('.jsonl') || stat.mtimeMs < sinceMs) return;
      const text = U.readText(file);
      if (!text) return;
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const m = j.message;
        if (j.type !== 'assistant' || !m || !m.usage) continue;
        const id = `${m.id}:${j.requestId || ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const t = Date.parse(j.timestamp);
        if (!t || t < sinceMs) continue;
        const u = m.usage;
        events.push({
          t,
          input: (u.input_tokens || 0),
          output: (u.output_tokens || 0),
          cache: (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
          model: m.model || '',
        });
      }
    });
    return events;
  },
};

function safeCreds(snap) {
  try { return JSON.parse(snap.credentials).claudeAiOauth || null; } catch { return null; }
}

async function fetchProfile(c) {
  if (!c) return null;
  const r = await U.fetchJson('https://api.anthropic.com/api/oauth/profile', {
    headers: { Authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': BETA, 'User-Agent': UA },
  });
  if (!r.ok || !r.json || !r.json.account) return null;
  const a = r.json.account; const o = r.json.organization || {};
  return {
    accountUuid: a.uuid, emailAddress: a.email, displayName: a.display_name, fullName: a.full_name,
    organizationUuid: o.uuid, organizationName: o.name,
  };
}

function fmtMoney(cents) {
  if (typeof cents !== 'number') return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function walk(dir, fn, depth = 0) {
  if (depth > 6) return;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, fn, depth + 1);
    else { try { fn(full, fs.statSync(full)); } catch { /* skip */ } }
  }
}
module.exports.walk = walk;
