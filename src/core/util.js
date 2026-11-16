'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'
const IS_WIN = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
/** Escrita atômica: grava em arquivo temporário e renomeia (permissão 600 fora do Windows). */
function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function writeJson(file, obj) { writeFileAtomic(file, JSON.stringify(obj, null, 2)); }

function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch { return null; }
}

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aias-${prefix}-`));
}
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

// ---------------------------------------------------------------- PATH
/**
 * PATH "de verdade" do usuário. No Windows vem do registro (pega CLIs recém-instalados);
 * no macOS/Linux vem do shell de login (apps gráficos no Mac recebem um PATH mínimo).
 */
let freshPathCache = null;
const EXTRA_POSIX_DIRS = [
  path.join(HOME, '.local', 'bin'), path.join(HOME, '.npm-global', 'bin'), path.join(HOME, '.bun', 'bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
];
function freshPath() {
  return new Promise((resolve) => {
    const finish = (extra) => {
      const parts = [...String(extra || '').trim().split(path.delimiter), ...(process.env.PATH || '').split(path.delimiter)];
      if (!IS_WIN) parts.push(...EXTRA_POSIX_DIRS);
      freshPathCache = [...new Set(parts.filter(Boolean))].join(path.delimiter);
      resolve(freshPathCache);
    };
    if (IS_WIN) {
      execFile('powershell.exe', ['-NoProfile', '-Command',
        "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')"],
      { windowsHide: true, timeout: 15000 }, (err, out) => finish(err ? '' : out));
    } else {
      const shell = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash');
      execFile(shell, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 15000 }, (err, out) => {
        const m = /__P__(.*)__P__/.exec(String(out || ''));
        finish(m ? m[1] : '');
      });
    }
  });
}
function envWithPath(extra = {}) {
  return { ...process.env, PATH: freshPathCache || process.env.PATH, ...extra };
}

/** Procura um executável: primeiro caminhos conhecidos, depois no PATH. */
function findExecutable(names, knownPaths = []) {
  for (const p of knownPaths) if (p && fs.existsSync(p)) return p;
  const dirs = (freshPathCache || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const n of names) {
      for (const e of exts) {
        const full = path.join(dir, n + e);
        try { if (fs.statSync(full).isFile()) return full; } catch { /* next */ }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- processos
/** Executa e devolve stdout/stderr (sem janela). */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const isScript = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
    const base = { windowsHide: true, env: envWithPath(opts.env), cwd: opts.cwd };
    const child = isScript
      ? spawn(`"${cmd}" ${args.join(' ')}`, { ...base, shell: true })
      : spawn(cmd, args, base);
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* */ } }, opts.timeout || 20000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (opts.input != null) { child.stdin.write(opts.input); child.stdin.end(); }
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** Executa mostrando a saída em tempo real via callback (instalações). */
function runStreaming(cmd, args, onLine, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, env: envWithPath(opts.env) });
    const pump = (d) => String(d).split(/\r?\n/).forEach((l) => { if (l.trim()) onLine(l); });
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', (e) => { onLine(`Erro: ${e.message}`); resolve(-1); });
    child.on('close', (code) => resolve(code));
  });
}

/** Comando de shell para instalar algo, no formato certo para cada sistema. */
function shellCommand(winPowershell, posixBash) {
  if (IS_WIN) return { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', winPowershell] };
  return { cmd: '/bin/bash', args: ['-lc', posixBash] };
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Abre o CLI de login em uma janela de terminal própria — o usuário só precisa
 * concluir o login no navegador. Devolve { onExit(cb), kill() }.
 * opts.onUrl(url) é chamado se não houver terminal e o CLI imprimir um link.
 */
function openLoginTerminal(exe, args, env, title = 'Login', opts = {}) {
  const exitCbs = [];
  let exited = false;
  const fireExit = (code) => { if (exited) return; exited = true; exitCbs.forEach((cb) => cb(code)); };
  const handle = { onExit: (cb) => exitCbs.push(cb), kill: () => {} };

  if (IS_WIN) {
    const quoted = [exe, ...args].map((a) => (/[\s&()^]/.test(a) ? `"${a}"` : a)).join(' ');
    const line = `"start "${title}" /wait cmd /d /c "${quoted}""`;
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
      windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore', env: envWithPath(env),
    });
    child.on('exit', fireExit);
    handle.kill = () => { try { spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); } catch { /* */ } };
    return handle;
  }

  // macOS / Linux: script temporário + arquivos de controle (pid e término)
  const dir = mkTempDir('term');
  const pidFile = path.join(dir, 'pid'); const doneFile = path.join(dir, 'done');
  const script = path.join(dir, IS_MAC ? 'login.command' : 'login.sh');
  const envLines = Object.entries({ PATH: envWithPath().PATH, ...env }).map(([k, v]) => `export ${k}=${shq(v)}`);
  fs.writeFileSync(script, [
    '#!/bin/bash', `printf '\\033]0;%s\\007' ${shq(title)}`, `echo $$ > ${shq(pidFile)}`, ...envLines,
    `${[exe, ...args].map(shq).join(' ')}`, `echo $? > ${shq(doneFile)}`, 'exit 0', '',
  ].join('\n'), { mode: 0o755 });

  let child = null;
  if (IS_MAC) {
    child = spawn('open', ['-a', 'Terminal', script], { stdio: 'ignore', detached: true });
  } else {
    const terms = [
      ['x-terminal-emulator', ['-e', 'bash', script]], ['gnome-terminal', ['--', 'bash', script]],
      ['konsole', ['-e', 'bash', script]], ['xfce4-terminal', ['-x', 'bash', script]],
      ['kitty', ['bash', script]], ['alacritty', ['-e', 'bash', script]], ['xterm', ['-e', 'bash', script]],
    ];
    const found = terms.find(([t]) => findExecutable([t]));
    if (found) {
      child = spawn(found[0], found[1], { stdio: 'ignore', detached: true, env: envWithPath() });
    } else {
      // sem emulador de terminal: roda em segundo plano e abre o link no navegador
      child = spawn('bash', [script], { stdio: ['ignore', 'pipe', 'pipe'], env: envWithPath() });
      const scan = (d) => { const m = /(https:\/\/\S+)/.exec(String(d)); if (m && opts.onUrl) opts.onUrl(m[1]); };
      child.stdout.on('data', scan); child.stderr.on('data', scan);
    }
  }
  if (child) child.unref && child.unref();
  const started = Date.now();
  const timer = setInterval(() => {
    if (fs.existsSync(doneFile)) { clearInterval(timer); fireExit(Number(readText(doneFile)) || 0); rmrf(dir); return; }
    // o terminal foi fechado no meio (o processo do script sumiu)
    const pid = Number(readText(pidFile));
    if (pid) { try { process.kill(pid, 0); } catch { clearInterval(timer); fireExit(-1); rmrf(dir); } }
    else if (Date.now() - started > 60e3) { clearInterval(timer); fireExit(-1); rmrf(dir); }
  }, 1000);
  handle.kill = () => {
    const pid = Number(readText(pidFile));
    if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* */ } } }
  };
  return handle;
}

// ---------------------------------------------------------------- Keychain (macOS)
async function kcAccount(service) {
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', service]);
  if (r.code !== 0) return null;
  const m = /"acct"<blob>="([^"]*)"/.exec(r.out);
  return m ? m[1] : null;
}
async function kcGet(service, account) {
  const args = ['find-generic-password', '-s', service, '-w'];
  if (account) args.splice(3, 0, '-a', account);
  const r = await run('/usr/bin/security', args);
  return r.code === 0 ? r.out.replace(/\n$/, '') : null;
}
/** Grava sem expor o segredo na linha de comando (usa o modo interativo do `security`). */
async function kcSet(service, account, value) {
  const hex = Buffer.from(String(value), 'utf8').toString('hex');
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  const r = await run('/usr/bin/security', ['-i'], { input: line });
  if (r.code !== 0) throw new Error(`Keychain: ${r.err || r.out}`);
}
async function kcDelete(service, account) {
  const args = ['delete-generic-password', '-s', service];
  if (account) args.push('-a', account);
  await run('/usr/bin/security', args);
}

// ---------------------------------------------------------------- HTTP
async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: e.message };
  } finally { clearTimeout(t); }
}

module.exports = {
  PLATFORM, IS_WIN, IS_MAC, HOME, APPDATA, LOCALAPPDATA, XDG_CONFIG,
  readJson, readText, writeJson, writeFileAtomic, decodeJwt, mkTempDir, rmrf,
  freshPath, envWithPath, findExecutable, run, runStreaming, shellCommand, openLoginTerminal,
  kcAccount, kcGet, kcSet, kcDelete, fetchJson,
};
