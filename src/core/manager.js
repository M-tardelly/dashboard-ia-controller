'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const U = require('./util');

const PROVIDERS = {
  claude: require('./providers/claude'),
  codex: require('./providers/codex'),
  cursor: require('./providers/cursor'),
};

const USAGE_MIN_INTERVAL = { claude: 3 * 60e3, codex: 60e3, cursor: 60e3 };
const DAY = 24 * 3600e3;

class Manager extends EventEmitter {
  /**
   * @param {string} dataDir pasta onde o cofre é salvo
   * @param {{encrypt:(s:string)=>string, decrypt:(s:string)=>string, secure:boolean}} crypt
   */
  constructor(dataDir, crypt) {
    super();
    this.file = path.join(dataDir, 'vault.json');
    this.crypt = crypt;
    this.busy = {};       // operações em andamento por ferramenta
    this.logins = {};     // logins em andamento
    this.cli = {};        // status de instalação dos CLIs
    this.installLogs = {};
    this.localCache = null;
    this.load();
  }

  // ---------- persistência ----------
  load() {
    const j = U.readJson(this.file);
    this.db = j && j.profiles ? j : { profiles: [], active: {}, history: [], usage: {} };
    this.db.active = this.db.active || {};
    this.db.history = this.db.history || [];
    this.db.usage = this.db.usage || {};
  }
  save() { U.writeJson(this.file, this.db); }

  seal(snap) { return this.crypt.encrypt(JSON.stringify(snap)); }
  open(profile) { return JSON.parse(this.crypt.decrypt(profile.blob)); }

  profile(id) { return this.db.profiles.find((p) => p.id === id); }

  // ---------- estado para a interface ----------
  state() {
    const tools = Object.values(PROVIDERS).map((p) => ({
      id: p.id, name: p.name, color: p.color, cliName: p.cliName, installHint: p.installHint,
      cli: this.cli[p.id] || { installed: null },
      activeId: this.db.active[p.id] || null,
      busy: this.busy[p.id] || null,
      login: this.logins[p.id] ? { profileId: this.logins[p.id].profileId || null, startedAt: this.logins[p.id].startedAt } : null,
      installLog: this.installLogs[p.id] || null,
    }));
    const profiles = this.db.profiles.map((p) => ({
      id: p.id, tool: p.tool, label: p.label, email: p.email, name: p.name, plan: p.plan, org: p.org,
      createdAt: p.createdAt, lastActivatedAt: p.lastActivatedAt,
      active: this.db.active[p.tool] === p.id,
      usage: this.db.usage[p.id] || null,
    }));
    return { tools, profiles, secure: this.crypt.secure, secureLabel: this.crypt.label, platform: U.PLATFORM };
  }
  changed() { this.emit('changed'); }

  // ---------- CLIs ----------
  async detectClis() {
    await U.freshPath();
    await Promise.all(Object.values(PROVIDERS).map(async (p) => {
      const exe = p.findCli();
      let version = null;
      if (exe) {
        const r = await U.run(exe, ['--version'], { timeout: 15000 });
        version = (r.out || r.err || '').trim().split(/\r?\n/)[0] || null;
      }
      this.cli[p.id] = { installed: !!exe, path: exe, version };
    }));
    this.changed();
  }

  async installCli(tool) {
    const p = PROVIDERS[tool];
    if (this.busy[tool]) return;
    this.busy[tool] = 'Instalando…';
    this.installLogs[tool] = { lines: [], running: true, code: null };
    this.changed();
    const { cmd, args } = p.installCommand();
    const push = (l) => {
      const log = this.installLogs[tool];
      log.lines.push(l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
      if (log.lines.length > 400) log.lines.shift();
      this.changed();
    };
    push(`> Instalando ${p.name}…`);
    const code = await U.runStreaming(cmd, args, push);
    await this.detectClis();
    const ok = this.cli[tool] && this.cli[tool].installed;
    push(ok ? `✔ ${p.name} instalado (${this.cli[tool].version || 'ok'}).` : `✖ A instalação terminou com código ${code}. Veja as mensagens acima.`);
    this.installLogs[tool].running = false;
    this.installLogs[tool].code = code;
    this.busy[tool] = null;
    this.changed();
  }

  // ---------- sincronização com o login atual do computador ----------
  /**
   * Lê o login "ao vivo" do CLI. Se pertence a uma conta salva, atualiza os
   * tokens dela (o CLI renova tokens sozinho); se for uma conta nova, importa.
   */
  async syncLive(tool) {
    const p = PROVIDERS[tool];
    // durante um login (no macOS o Keychain é compartilhado) não mexemos no estado
    if (this.logins[tool]) return this.profile(this.db.active[tool]) || null;
    let live = null;
    try { live = await p.readLive(); } catch { live = null; }
    if (!live) {
      if (this.db.active[tool]) { this.db.active[tool] = null; this.save(); }
      return null;
    }
    const ident = p.identity(live);
    let prof = ident.key
      ? this.db.profiles.find((x) => x.tool === tool && x.key === ident.key)
      : this.profile(this.db.active[tool]); // sem identificador: assume a conta ativa
    if (prof) {
      const old = this.open(prof);
      const merged = { ...old, ...live };
      if (JSON.stringify(old) !== JSON.stringify(merged)) prof.blob = this.seal(merged);
      if (ident.email) prof.email = ident.email;
      if (ident.plan) prof.plan = ident.plan;
    } else {
      prof = this.newProfile(tool, live, ident, 'Conta importada');
      const firstForTool = !this.db.history.some((h) => h.tool === tool);
      this.db.history.push({ tool, profileId: prof.id, at: firstForTool ? 0 : Date.now() });
    }
    if (this.db.active[tool] !== prof.id) {
      this.db.active[tool] = prof.id;
      const last = [...this.db.history].reverse().find((h) => h.tool === tool);
      if (!last || last.profileId !== prof.id) this.db.history.push({ tool, profileId: prof.id, at: Date.now() });
    }
    this.save();
    return prof;
  }

  async syncAll() {
    for (const t of Object.keys(PROVIDERS)) { try { await this.syncLive(t); } catch (e) { console.error('sync', t, e); } }
    this.changed();
  }

  newProfile(tool, snap, ident, fallbackLabel) {
    const prof = {
      id: crypto.randomUUID(), tool, key: ident.key,
      label: ident.email || ident.name || fallbackLabel,
      email: ident.email, name: ident.name, plan: ident.plan, org: ident.org,
      createdAt: Date.now(), lastActivatedAt: null,
      blob: this.seal(snap),
    };
    this.db.profiles.push(prof);
    return prof;
  }

  // ---------- trocar de conta ----------
  async activate(profileId) {
    const prof = this.profile(profileId);
    if (!prof) throw new Error('Conta não encontrada');
    const p = PROVIDERS[prof.tool];
    // 1) guarda os tokens mais recentes da conta que está saindo
    if (this.logins[prof.tool]) throw new Error('Aguarde o login em andamento terminar.');
    const current = await this.syncLive(prof.tool);
    if (current && current.id === prof.id) return { ok: true, already: true };
    // 2) escreve o login da conta escolhida nos arquivos do CLI
    await p.writeLive(this.open(prof));
    this.db.active[prof.tool] = prof.id;
    prof.lastActivatedAt = Date.now();
    this.db.history.push({ tool: prof.tool, profileId: prof.id, at: Date.now() });
    if (this.db.history.length > 2000) this.db.history = this.db.history.slice(-2000);
    this.save();
    this.changed();
    return { ok: true };
  }

  rename(profileId, label) {
    const prof = this.profile(profileId);
    if (!prof) return;
    prof.label = String(label || '').trim() || prof.email || 'Conta';
    this.save(); this.changed();
  }

  remove(profileId) {
    const prof = this.profile(profileId);
    if (!prof) return;
    this.db.profiles = this.db.profiles.filter((x) => x.id !== profileId);
    delete this.db.usage[profileId];
    if (this.db.active[prof.tool] === profileId) this.db.active[prof.tool] = null;
    this.save(); this.changed();
  }

  // ---------- adicionar conta / entrar novamente ----------
  async startLogin(tool, profileId = null) {
    const p = PROVIDERS[tool];
    if (this.logins[tool]) throw new Error('Já existe um login em andamento para esta ferramenta.');
    if (!this.cli[tool] || !this.cli[tool].installed) await this.detectClis();
    const exe = this.cli[tool] && this.cli[tool].path;
    if (!exe) throw new Error(`${p.name} não está instalado. Instale pela aba "Instalação".`);

    // guarda os tokens mais recentes da conta atual antes de qualquer coisa
    await this.syncLive(tool);
    const spec = p.loginSpec();
    const login = { spec, profileId, startedAt: Date.now(), cancelled: false };
    this.logins[tool] = login;
    try { if (spec.before) await spec.before(); } catch (e) { delete this.logins[tool]; throw e; }
    const term = U.openLoginTerminal(exe, spec.args, spec.env, `Login - ${p.name}`, { onUrl: (url) => this.emit('openUrl', url) });
    login.term = term;
    this.changed();

    return new Promise((resolve) => {
      const finish = async (result) => {
        if (login.finished) return;
        login.finished = true;
        clearInterval(poll); clearTimeout(timeout);
        term.kill();
        try { if (spec.after) await spec.after(); } catch (e) { console.error('login after', e); }
        delete this.logins[tool];
        U.rmrf(spec.dir);
        this.changed();
        resolve(result);
      };
      // uma coleta por vez; quem chamar durante uma coleta espera o mesmo resultado
      const tryCollect = () => {
        if (login.finished) return Promise.resolve(true);
        if (!login.collecting) login.collecting = collectOnce().catch(() => false).finally(() => { login.collecting = null; });
        return login.collecting;
      };
      const collectOnce = async () => {
        let snap = null;
        try { snap = await spec.collect(); } catch { snap = null; }
        if (!snap) return false;
        // garante que o arquivo terminou de ser escrito
        await new Promise((r) => setTimeout(r, 800));
        try { snap = (await spec.collect()) || snap; } catch { /* */ }
        if (login.finished) return true;
        clearInterval(poll);
        const res = await this.importLogin(tool, snap, profileId, spec);
        await finish({ ok: true, ...res });
        this.refreshUsage(res.profileId, true).catch(() => {});
        return true;
      };
      const poll = setInterval(() => { if (!login.cancelled) tryCollect(); }, 2500);
      const timeout = setTimeout(() => finish({ ok: false, error: 'Tempo esgotado para o login (10 min).' }), 10 * 60e3);
      term.onExit(async () => {
        if (login.cancelled) return finish({ ok: false, error: 'Login cancelado.' });
        setTimeout(async () => {
          if (!this.logins[tool] || this.logins[tool] !== login) return;
          if (!(await tryCollect())) finish({ ok: false, error: 'A janela de login foi fechada antes de concluir.' });
        }, 1500);
      });
      login.cancel = () => { login.cancelled = true; finish({ ok: false, error: 'Login cancelado.' }); };
    });
  }

  cancelLogin(tool) { const l = this.logins[tool]; if (l && l.cancel) l.cancel(); }

  async importLogin(tool, snap, profileId, spec = null) {
    const p = PROVIDERS[tool];
    const ident = p.identity(snap);
    let prof = profileId ? this.profile(profileId) : null;
    if (!prof && ident.key) prof = this.db.profiles.find((x) => x.tool === tool && x.key === ident.key);
    let existed = !!prof;
    if (prof) {
      prof.blob = this.seal(snap);
      prof.key = ident.key || prof.key;
      if (ident.email) prof.email = ident.email;
      if (ident.plan) prof.plan = ident.plan;
      // se é a conta ativa, atualiza também o login do computador
      // (no macOS o "after" do login restaura o Keychain; então gravamos depois dele)
      if (this.db.active[tool] === prof.id) {
        if (spec && spec.after) { const after = spec.after; spec.after = async () => { await after(); await p.writeLive(snap); }; }
        else await p.writeLive(snap);
      }
    } else {
      prof = this.newProfile(tool, snap, ident, `Conta ${this.db.profiles.filter((x) => x.tool === tool).length + 1}`);
      existed = false;
    }
    this.save(); this.changed();
    return { profileId: prof.id, existed, label: prof.label };
  }

  // ---------- exportar / importar ----------
  /** Monta o conteúdo da exportação (tokens em texto, que depois é cifrado com a senha). */
  async buildExport(profileIds) {
    await this.syncAll(); // pega os tokens mais recentes das contas em uso
    const ids = new Set(profileIds && profileIds.length ? profileIds : this.db.profiles.map((p) => p.id));
    const profiles = this.db.profiles.filter((p) => ids.has(p.id)).map((p) => ({
      tool: p.tool, key: p.key, label: p.label, email: p.email, name: p.name, plan: p.plan, org: p.org,
      createdAt: p.createdAt, snap: this.open(p),
    }));
    if (!profiles.length) throw new Error('Selecione ao menos uma conta para exportar.');
    return { app: 'ai-account-switcher', exportedFrom: U.PLATFORM, profiles };
  }

  /**
   * Junta as contas importadas ao cofre.
   * mode 'keep': contas que já existem aqui mantêm os tokens daqui (só as novas entram)
   * mode 'replace': contas repetidas passam a usar os tokens do arquivo
   */
  async importPayload(payload, mode = 'keep') {
    const out = { added: 0, updated: 0, skipped: 0, invalid: 0 };
    const list = (payload && Array.isArray(payload.profiles)) ? payload.profiles : [];
    for (const item of list) {
      const p = PROVIDERS[item.tool];
      if (!p || !item.snap || typeof item.snap !== 'object') { out.invalid++; continue; }
      const ident = p.identity(item.snap);
      const key = ident.key || item.key;
      const existing = key ? this.db.profiles.find((x) => x.tool === item.tool && x.key === key) : null;
      if (existing) {
        if (mode !== 'replace') { out.skipped++; continue; }
        existing.blob = this.seal(item.snap);
        if (item.label) existing.label = item.label;
        if (ident.email) existing.email = ident.email;
        if (ident.plan) existing.plan = ident.plan;
        if (this.db.active[item.tool] === existing.id) await p.writeLive(item.snap);
        delete this.db.usage[existing.id];
        out.updated++;
      } else {
        const prof = this.newProfile(item.tool, item.snap, { ...ident, key }, item.label || 'Conta importada');
        if (item.label) prof.label = item.label;
        if (!prof.plan && item.plan) prof.plan = item.plan;
        out.added++;
      }
    }
    this.save(); this.changed();
    this.refreshAllUsage(true).catch(() => {});
    return out;
  }

  // ---------- consumo ----------
  async refreshUsage(profileId, force = false) {
    const prof = this.profile(profileId);
    if (!prof) return;
    const p = PROVIDERS[prof.tool];
    const prev = this.db.usage[prof.id];
    if (!force && prev && prev.at && Date.now() - prev.at < USAGE_MIN_INTERVAL[prof.tool]) return;

    let snap;
    const isActive = this.db.active[prof.tool] === prof.id;
    if (isActive) { await this.syncLive(prof.tool); }
    snap = this.open(this.profile(profileId) || prof);
    if (!isActive) {
      // contas paradas: renovamos o token aqui mesmo para conseguir consultar
      try {
        const fresh = await p.refreshIfNeeded(snap);
        if (fresh) { snap = fresh; prof.blob = this.seal(fresh); }
      } catch { /* segue com o token atual */ }
    }

    const res = await p.fetchUsage(snap);
    const entry = { at: Date.now(), ...res };
    if (res.error && prev && prev.windows && prev.windows.length) {
      entry.windows = prev.windows; entry.notes = prev.notes; entry.stale = true; entry.dataAt = prev.dataAt || prev.at;
      if (res.rateLimited) entry.at = prev.at + 60e3; // tenta de novo em breve
    } else if (!res.error) {
      entry.dataAt = entry.at;
    }
    if (res.plan) prof.plan = res.plan;
    this.db.usage[prof.id] = entry;
    this.save();
    this.changed();
  }

  async refreshAllUsage(force = false) {
    const list = [...this.db.profiles];
    // em paralelo por ferramenta, em série dentro da mesma ferramenta (evita bloqueios)
    const byTool = {};
    for (const p of list) (byTool[p.tool] = byTool[p.tool] || []).push(p);
    await Promise.all(Object.values(byTool).map(async (arr) => {
      for (const p of arr) { try { await this.refreshUsage(p.id, force); } catch (e) { console.error('usage', e); } }
    }));
  }

  /** Tokens por dia (logs locais), atribuídos à conta que estava ativa naquele momento. */
  localUsage(days = 30) {
    if (this.localCache && Date.now() - this.localCache.at < 60e3 && this.localCache.days === days) return this.localCache.data;
    const since = startOfDay(Date.now() - (days - 1) * DAY);
    const result = { days: [], byProfile: {}, byTool: {} };
    for (let i = 0; i < days; i++) result.days.push(dayKey(since + i * DAY + 3600e3));
    for (const tool of Object.keys(PROVIDERS)) {
      let events = [];
      try { events = PROVIDERS[tool].scanLocalUsage(since); } catch (e) { console.error('scan', tool, e); }
      const hist = this.db.history.filter((h) => h.tool === tool).sort((a, b) => a.at - b.at);
      const toolAgg = result.byTool[tool] = { total: 0, perDay: {} };
      for (const ev of events) {
        const total = ev.input + ev.output + ev.cache;
        let owner = null;
        for (const h of hist) { if (h.at <= ev.t) owner = h.profileId; else break; }
        owner = owner || `unknown:${tool}`;
        const d = dayKey(ev.t);
        const agg = result.byProfile[owner] = result.byProfile[owner] || { tool, total: 0, input: 0, output: 0, cache: 0, today: 0, week: 0, perDay: {} };
        agg.total += total; agg.input += ev.input; agg.output += ev.output; agg.cache += ev.cache;
        agg.perDay[d] = (agg.perDay[d] || 0) + total;
        if (ev.t >= startOfDay(Date.now())) agg.today += total;
        if (ev.t >= Date.now() - 7 * DAY) agg.week += total;
        toolAgg.total += total;
        toolAgg.perDay[d] = (toolAgg.perDay[d] || 0) + total;
      }
    }
    this.localCache = { at: Date.now(), days, data: result };
    return result;
  }
}

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { Manager, PROVIDERS };
