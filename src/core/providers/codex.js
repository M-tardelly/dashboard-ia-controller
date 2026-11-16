'use strict';
const fs = require('fs');
const path = require('path');
const U = require('../util');
const { walk } = require('./claude');

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function codexHome() { return process.env.CODEX_HOME || path.join(U.HOME, '.codex'); }
function authPath(dir = codexHome()) { return path.join(dir, 'auth.json'); }

function windowLabel(w, fallback) {
  const mins = w.window_minutes || (w.limit_window_seconds ? w.limit_window_seconds / 60 : null);
  if (!mins) return fallback;
  if (mins <= 360) return `Sessão (${Math.round(mins / 60)}h)`;
  if (mins >= 10000) return 'Semanal';
  return `Janela ${Math.round(mins / 60)}h`;
}
function resetAt(w) {
  if (w.reset_at) return new Date(w.reset_at * 1000).toISOString();
  if (w.resets_at) return typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : w.resets_at;
  if (w.reset_after_seconds != null) return new Date(Date.now() + w.reset_after_seconds * 1000).toISOString();
  if (w.resets_in_seconds != null) return new Date(Date.now() + w.resets_in_seconds * 1000).toISOString();
  return null;
}

module.exports = {
  id: 'codex',
  name: 'Codex CLI',
  cliName: 'codex',
  color: '#10a37f',
  installHint: 'npm install -g @openai/codex (instala o Node.js antes, se faltar)',

  findCli() {
    return U.findExecutable(['codex'], U.IS_WIN
      ? [path.join(U.APPDATA, 'npm', 'codex.cmd')]
      : [path.join(U.HOME, '.local', 'bin', 'codex'), path.join(U.HOME, '.npm-global', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex']);
  },

  installCommand() {
    const script = [
      "$ErrorActionPreference='Continue'",
      'if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {',
      "  Write-Output 'Node.js nao encontrado. Instalando Node.js LTS via winget...'",
      '  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements',
      "  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
      '}',
      "Write-Output 'Instalando @openai/codex...'",
      'npm install -g @openai/codex',
    ].join('\n');
    const posix = [
      'if ! command -v npm >/dev/null 2>&1; then',
      '  if command -v brew >/dev/null 2>&1; then echo "Node.js nao encontrado. Instalando via Homebrew..."; brew install node;',
      '  else echo "Node.js nao encontrado. Instale em https://nodejs.org e clique em Instalar de novo."; exit 1; fi',
      'fi',
      'echo "Instalando @openai/codex..."',
      // sem permissão na pasta global do npm? instala em ~/.local
      'npm install -g @openai/codex || npm install -g --prefix "$HOME/.local" @openai/codex',
    ].join('\n');
    return U.shellCommand(script, posix);
  },

  readLive() {
    const auth = U.readText(authPath());
    if (!auth) return null;
    return { auth };
  },

  writeLive(snap) {
    U.writeFileAtomic(authPath(), snap.auth);
  },

  identity(snap) {
    const j = safeAuth(snap);
    const tokens = (j && j.tokens) || {};
    const claims = U.decodeJwt(tokens.id_token) || {};
    const oa = claims['https://api.openai.com/auth'] || {};
    const apiKey = j && j.OPENAI_API_KEY;
    return {
      key: (claims.email || '') + ':' + (tokens.account_id || oa.chatgpt_account_id || (apiKey ? String(apiKey).slice(-8) : '')),
      email: claims.email || (apiKey ? `API key …${String(apiKey).slice(-4)}` : null),
      name: claims.name || null,
      plan: oa.chatgpt_plan_type || (apiKey ? 'api-key' : null),
      org: null,
    };
  },

  loginSpec() {
    const dir = U.mkTempDir('codex');
    // força salvar em arquivo (não no cofre do sistema) para podermos guardar a conta
    fs.writeFileSync(path.join(dir, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    return {
      dir,
      args: ['login'],
      env: { CODEX_HOME: dir },
      collect: async () => {
        const auth = U.readText(authPath(dir));
        return auth ? { auth } : null;
      },
    };
  },

  async refreshIfNeeded(snap) {
    const j = safeAuth(snap);
    const t = j && j.tokens;
    if (!t || !t.refresh_token) return null;
    const claims = U.decodeJwt(t.access_token) || {};
    if (claims.exp && claims.exp * 1000 - Date.now() > 5 * 60 * 1000) return null;
    const r = await U.fetchJson('https://auth.openai.com/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: 'openid profile email' }),
    });
    if (!r.ok || !r.json || !r.json.access_token) return null;
    j.tokens = {
      ...t,
      access_token: r.json.access_token,
      id_token: r.json.id_token || t.id_token,
      refresh_token: r.json.refresh_token || t.refresh_token,
    };
    j.last_refresh = new Date().toISOString();
    return { ...snap, auth: JSON.stringify(j, null, 2) };
  },

  async fetchUsage(snap) {
    const j = safeAuth(snap);
    const t = j && j.tokens;
    if (!t || !t.access_token) {
      if (j && j.OPENAI_API_KEY) return { windows: [], notes: ['Conta via API key: consumo cobrado por uso na plataforma OpenAI.'] };
      return { error: 'Credenciais inválidas' };
    }
    const headers = { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'codex_cli_rs', Accept: 'application/json' };
    if (t.account_id) headers['ChatGPT-Account-Id'] = t.account_id;
    const r = await U.fetchJson('https://chatgpt.com/backend-api/wham/usage', { headers });
    if (r.status === 401) return { error: 'Login expirado — use "Entrar novamente".', expired: true };
    if (r.status === 429) return { error: 'Servidor limitou as consultas, tentando de novo em alguns minutos.', rateLimited: true };
    if (!r.ok || !r.json) return { error: `Falha ao consultar uso (${r.status})` };
    const rl = r.json.rate_limit || {};
    const windows = [];
    if (rl.primary_window) windows.push({ key: 'primary', label: windowLabel(rl.primary_window, 'Sessão (5h)'), percent: rl.primary_window.used_percent, resetsAt: resetAt(rl.primary_window) });
    if (rl.secondary_window) windows.push({ key: 'secondary', label: windowLabel(rl.secondary_window, 'Semanal'), percent: rl.secondary_window.used_percent, resetsAt: resetAt(rl.secondary_window) });
    const notes = [];
    const cr = r.json.credits;
    if (cr && cr.has_credits) notes.push(cr.unlimited ? 'Créditos: ilimitados' : `Créditos: ${cr.balance}`);
    if (rl.limit_reached) notes.push('Limite atingido nesta conta.');
    return { windows, notes, plan: r.json.plan_type || null };
  },

  scanLocalUsage(sinceMs) {
    const root = path.join(codexHome(), 'sessions');
    const events = [];
    walk(root, (file, stat) => {
      if (!file.endsWith('.jsonl') || stat.mtimeMs < sinceMs) return;
      const text = U.readText(file);
      if (!text) return;
      for (const line of text.split('\n')) {
        if (!line.includes('token_count')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const p = j.payload;
        if (!p || p.type !== 'token_count' || !p.info || !p.info.last_token_usage) continue;
        const t = Date.parse(j.timestamp);
        if (!t || t < sinceMs) continue;
        const u = p.info.last_token_usage;
        events.push({
          t,
          input: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)),
          output: (u.output_tokens || 0),
          cache: (u.cached_input_tokens || 0),
          model: '',
        });
      }
    });
    return events;
  },
};

function safeAuth(snap) { try { return JSON.parse(snap.auth); } catch { return null; } }
