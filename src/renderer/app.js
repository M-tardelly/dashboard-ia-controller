'use strict';
/* global api */

let S = { tools: [], profiles: [], secure: true };
let L = null; // uso local (tokens por dia)
let UP = null; // estado das atualizações
const ui = { view: 'overview', menu: null, renaming: null, days: 14, table: {}, modal: null };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tool = (id) => S.tools.find((t) => t.id === id);
const profilesOf = (id) => S.profiles.filter((p) => p.tool === id).sort((a, b) => a.createdAt - b.createdAt);
const TOOL_SERIES = { claude: 'var(--s2)', codex: 'var(--s3)', cursor: 'var(--s7)' };
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

// ---------------- formatação ----------------
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace('.', ',') + ' bi';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' mi';
  if (n >= 1e3) return Math.round(n / 1e3) + ' mil';
  return String(n);
}
function fmtReset(iso) {
  if (!iso) return '';
  const t = Date.parse(iso); if (!t) return '';
  const diff = t - Date.now();
  if (diff <= 0) return 'renovando…';
  const h = Math.floor(diff / 3600e3); const m = Math.floor((diff % 3600e3) / 60e3);
  const when = new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (h >= 48) return `renova em ${Math.round(h / 24)} dias (${when})`;
  if (h >= 1) return `renova em ${h}h ${String(m).padStart(2, '0')}min`;
  return `renova em ${m} min`;
}
function ago(t) {
  if (!t) return 'nunca';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'agora mesmo';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} dias`;
}
function initials(p) {
  const s = (p.label || p.email || '?').replace(/@.*/, '');
  const parts = s.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function subLine(p) {
  const parts = [];
  if (p.email && p.email !== p.label) parts.push(p.email);
  if (p.org && !/'s Organization$/i.test(p.org) && !(p.email && p.org.includes(p.email))) parts.push(p.org);
  return parts.join(' · ') || (p.email === p.label ? 'Login salvo' : '');
}
function planName(p) { return p ? String(p).replace(/_/g, ' ') : ''; }

// ---------------- notificações ----------------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5200);
}
async function call(ch, ...args) {
  const r = await api.call(ch, ...args);
  if (r && r.ok === false && r.error) toast(r.error, 'err');
  return r;
}

// ---------------- navegação ----------------
function renderNav() {
  const items = [{ id: 'overview', ico: '◫', name: 'Visão geral' }];
  const nav = $('#nav');
  let html = items.map((i) => navBtn(i.id, `<span class="ico">${i.ico}</span>`, i.name)).join('');
  html += '<div class="nav-sep"></div>';
  for (const t of S.tools) {
    const act = S.profiles.find((p) => p.id === t.activeId);
    const sub = t.cli.installed === false ? 'não instalado' : (act ? act.label : 'sem conta ativa');
    html += navBtn(t.id, `<span class="dot" style="background:var(--${t.id})"></span>`, t.name, sub);
  }
  html += '<div class="nav-sep"></div>';
  html += navBtn('install', '<span class="ico">⇩</span>', 'Instalação dos CLIs');
  html += navBtn('transfer', '<span class="ico">⇄</span>', 'Importar / exportar');
  html += navBtn('updates', '<span class="ico">↻</span>', 'Atualizações', updateSub());
  nav.innerHTML = html;
  nav.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
  $('#secureNote').textContent = S.secure
    ? `🔒 Credenciais criptografadas com o ${S.secureLabel || 'sistema'}.`
    : '⚠ Chaveiro do sistema indisponível — credenciais salvas com proteção fraca. No Linux, instale/ative o GNOME Keyring ou KWallet.';
}
function navBtn(id, icon, name, sub) {
  return `<button class="nav-item ${ui.view === id ? 'active' : ''}" data-nav="${id}">${icon}<span class="grow">${esc(name)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span></button>`;
}
function go(view) { ui.view = view; ui.menu = null; ui.renaming = null; render(); $('#main').scrollTop = 0; }

// ---------------- componentes ----------------
function meter(w) {
  const pct = Math.max(0, Math.min(100, Number(w.percent) || 0));
  const cls = pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : '';
  const flag = pct >= 100 ? '⛔ Limite atingido' : pct >= 90 ? '⚠ Quase no limite' : pct >= 75 ? '△ Atenção' : '';
  return `<div class="meter" data-tip="${esc(`${w.label}: ${pct.toFixed(0)}% usado`)}">
    <div class="meter-head"><span class="lbl">${esc(w.label)}</span><span class="val">${pct.toFixed(0)}%</span></div>
    <div class="meter-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(w.label)}"><div class="meter-fill ${cls}" style="width:${pct}%"></div></div>
    <div class="meter-foot"><span>${esc(fmtReset(w.resetsAt))}</span>${flag ? `<span class="status-flag">${flag}</span>` : ''}</div>
  </div>`;
}

function usageBlock(p) {
  const u = p.usage;
  if (!u) return '<div class="usage-meta">Consultando consumo…</div>';
  let html = '';
  if (u.windows && u.windows.length) html += `<div class="meters">${u.windows.map(meter).join('')}</div>`;
  if (u.notes && u.notes.length) html += `<div class="notes">${u.notes.map((n) => `<span>${esc(n)}</span>`).join('')}</div>`;
  if (u.error) html += `<div class="usage-error">${u.stale ? 'Mostrando o último valor conhecido. ' : ''}${esc(u.error)}</div>`;
  if (!u.error && (!u.windows || !u.windows.length) && (!u.notes || !u.notes.length)) html += '<div class="usage-meta">Sem dados de limite para esta conta.</div>';
  html += `<div class="usage-meta">Atualizado ${ago(u.dataAt || u.at)}</div>`;
  return html;
}

function localStats(p) {
  if (!L || p.tool === 'cursor') return '';
  const a = L.byProfile[p.id];
  return `<div class="stats-row" data-tip="Tokens contados nos registros locais do ${esc(tool(p.tool).name)} enquanto esta conta estava ativa">
    <div><b>${fmtTokens(a ? a.today : 0)}</b><span>tokens hoje</span></div>
    <div><b>${fmtTokens(a ? a.week : 0)}</b><span>7 dias</span></div>
    <div><b>${fmtTokens(a ? a.total : 0)}</b><span>30 dias</span></div>
  </div>`;
}

function accountCard(p, color) {
  const t = tool(p.tool);
  const renaming = ui.renaming === p.id;
  const menuOpen = ui.menu === p.id;
  const loginBusy = !!(t.login);
  return `<div class="card acct ${p.active ? 'is-active' : ''}" data-id="${p.id}">
    <div class="acct-top">
      <div class="avatar" style="background:${color}">${esc(initials(p))}</div>
      <div class="acct-id">
        ${renaming
          ? `<input class="rename-input" id="renameInput" value="${esc(p.label)}" maxlength="60" aria-label="Novo nome">`
          : `<div class="acct-label" title="${esc(p.label)}">${esc(p.label)}</div>`}
        <div class="acct-email selectable">${esc(subLine(p))}</div>
        <div class="acct-badges">
          ${p.active ? '<span class="badge active">Em uso</span>' : ''}
          ${p.plan ? `<span class="badge">${esc(planName(p.plan))}</span>` : ''}
        </div>
      </div>
      <div class="menu-wrap">
        <button class="btn ghost icon" data-act="menu" aria-label="Mais opções">⋯</button>
        ${menuOpen ? `<div class="menu">
          <button data-act="refresh">↻ Atualizar consumo</button>
          <button data-act="rename">✎ Renomear</button>
          <button data-act="relogin" ${loginBusy ? 'disabled' : ''}>⟲ Entrar novamente</button>
          <button data-act="remove" class="danger">🗑 Remover do app</button>
        </div>` : ''}
      </div>
    </div>
    ${usageBlock(p)}
    ${localStats(p)}
    <div class="acct-actions">
      ${p.active
        ? '<span class="muted small">Esta é a conta usada pelo CLI agora.</span>'
        : `<button class="btn primary" data-act="activate">Usar esta conta</button>`}
      <span class="spacer"></span>
      ${renaming ? '<button class="btn small" data-act="saveName">Salvar</button>' : ''}
    </div>
  </div>`;
}

// ---------------- gráfico de barras empilhadas ----------------
/**
 * series: [{id, name, color, perDay:{day:value}}]
 */
function stackedChart(key, title, series, days) {
  const dayKeys = L ? L.days.slice(-days) : [];
  const active = series.filter((s) => dayKeys.some((d) => s.perDay[d]));
  const totals = dayKeys.map((d) => active.reduce((a, s) => a + (s.perDay[d] || 0), 0));
  const max = Math.max(1, ...totals);
  const nice = niceMax(max);
  const W = 1000; const H = 220; const padL = 52; const padB = 24; const padT = 8;
  const plotW = W - padL; const plotH = H - padB - padT;
  const bw = plotW / dayKeys.length;
  const barW = Math.max(4, Math.min(28, bw * 0.62));
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const v = (nice / 4) * i; const y = padT + plotH - (v / nice) * plotH;
    svg += `<line class="${i === 0 ? 'base-line' : 'grid-line'}" x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/>`;
    svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end">${fmtTokens(v)}</text>`;
  }
  dayKeys.forEach((d, i) => {
    const cx = padL + bw * i + bw / 2;
    let y = padT + plotH;
    const segs = active.filter((s) => s.perDay[d]);
    segs.forEach((s, j) => {
      const h = (s.perDay[d] / nice) * plotH;
      const top = j === segs.length - 1;
      const hh = Math.max(1, h - (top ? 0 : 2)); // 2px de respiro entre segmentos
      y -= h;
      svg += top
        ? `<path d="${roundTopRect(cx - barW / 2, y, barW, hh, Math.min(4, hh))}" fill="${s.color}"/>`
        : `<rect x="${cx - barW / 2}" y="${y + 2}" width="${barW}" height="${hh}" fill="${s.color}"/>`;
    });
    const step = dayKeys.length > 16 ? 3 : dayKeys.length > 8 ? 2 : 1;
    if (i % step === 0 || i === dayKeys.length - 1) {
      svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${d.slice(8)}/${d.slice(5, 7)}</text>`;
    }
    svg += `<rect class="hit" x="${padL + bw * i}" y="${padT}" width="${bw}" height="${plotH}" data-day="${d}" data-chart="${key}"/>`;
  });
  chartData[key] = { series: active, dayKeys };
  const legend = active.length > 1 ? `<div class="legend">${active.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  const showTable = !!ui.table[key];
  const sum = totals.reduce((a, b) => a + b, 0);
  return `<div class="card chart-card">
    <div class="chart-head">
      <div><div class="chart-title">${esc(title)}</div><div class="muted small">${fmtTokens(sum)} tokens nos últimos ${days} dias (entrada + saída + cache)</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="seg" role="group" aria-label="Período">${[7, 14, 30].map((n) => `<button class="${days === n ? 'on' : ''}" data-days="${n}">${n}d</button>`).join('')}</div>
        <button class="btn small ghost" data-table="${key}">${showTable ? 'Ver gráfico' : 'Ver tabela'}</button>
      </div>
    </div>
    ${legend}
    ${!active.length ? '<div class="empty small">Nenhum uso registrado nos logs locais deste período.</div>'
      : showTable ? dataTable(active, dayKeys)
        : `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}">${svg}</svg>`}
  </div>`;
}
const chartData = {};
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function roundTopRect(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function dataTable(series, dayKeys) {
  const rows = [...dayKeys].reverse().map((d) => `<tr><td>${d.slice(8)}/${d.slice(5, 7)}</td>${series.map((s) => `<td>${fmtTokens(s.perDay[d] || 0)}</td>`).join('')}<td><b>${fmtTokens(series.reduce((a, s) => a + (s.perDay[d] || 0), 0))}</b></td></tr>`).join('');
  return `<table class="data"><thead><tr><th>Dia</th>${series.map((s) => `<th>${esc(s.name)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------------- páginas ----------------
function pageOverview() {
  const totalAccounts = S.profiles.length;
  const today = L ? Object.values(L.byProfile).reduce((a, x) => a + x.today, 0) : 0;
  const week = L ? Object.values(L.byProfile).reduce((a, x) => a + x.week, 0) : 0;
  const hot = S.profiles.filter((p) => p.active && p.usage && p.usage.windows && p.usage.windows.some((w) => w.percent >= 75)).length;

  let html = `<div class="page-head"><div><h1>Visão geral</h1><p>Conta em uso em cada ferramenta e quanto ainda resta.</p></div>
    <div class="head-actions"><button class="btn" data-global="refreshAll">↻ Atualizar tudo</button></div></div>
    <div class="tiles">
      <div class="card tile"><div class="k">Contas salvas</div><div class="v">${totalAccounts}</div><div class="d">${S.tools.map((t) => `${profilesOf(t.id).length} ${t.name.split(' ')[0]}`).join(' · ')}</div></div>
      <div class="card tile"><div class="k">Tokens hoje (Claude + Codex)</div><div class="v">${fmtTokens(today)}</div><div class="d">segundo os logs locais</div></div>
      <div class="card tile"><div class="k">Tokens em 7 dias</div><div class="v">${fmtTokens(week)}</div><div class="d">todas as contas</div></div>
      <div class="card tile"><div class="k">Contas ativas perto do limite</div><div class="v">${hot}</div><div class="d">${hot ? 'considere trocar de conta' : 'tudo tranquilo'}</div></div>
    </div>
    <h2>Contas em uso</h2>`;

  for (const t of S.tools) {
    const profs = profilesOf(t.id);
    const act = profs.find((p) => p.id === t.activeId);
    html += `<div class="card ov-tool">
      <div class="ov-left">
        <div class="ov-title"><span class="dot" style="background:var(--${t.id})"></span>${esc(t.name)}</div>
        ${t.cli.installed === false
          ? `<div class="muted small">CLI não instalado.</div><button class="btn primary" data-install="${t.id}">Instalar ${esc(t.name)}</button>`
          : profs.length
            ? `<label class="muted small" for="sw-${t.id}">Conta em uso</label>
               <select class="switcher" id="sw-${t.id}" data-switch="${t.id}">
                 ${act ? '' : '<option value="" selected>— nenhuma —</option>'}
                 ${profs.map((p) => `<option value="${p.id}" ${p.id === t.activeId ? 'selected' : ''}>${esc(p.label)}${p.plan ? ` (${esc(planName(p.plan))})` : ''}</option>`).join('')}
               </select>
               <button class="btn small" data-nav-to="${t.id}">Gerenciar contas →</button>`
            : `<div class="muted small">Nenhuma conta salva.</div><button class="btn primary" data-login="${t.id}">+ Adicionar conta</button>`}
      </div>
      <div>${act ? usageBlock(act) : '<div class="muted small" style="padding-top:4px">Nenhuma conta ativa no momento.</div>'}</div>
    </div>`;
  }

  if (L) {
    const series = ['claude', 'codex'].map((id) => ({ id, name: tool(id).name, color: TOOL_SERIES[id], perDay: (L.byTool[id] || {}).perDay || {} }));
    html += `<h2>Consumo diário</h2>${stackedChart('overview', 'Tokens por dia por ferramenta', series, ui.days)}`;
  }
  return html;
}

function pageTool(id) {
  const t = tool(id);
  const profs = profilesOf(id);
  let html = `<div class="page-head"><div><h1><span style="color:var(--${id})">●</span> ${esc(t.name)}</h1>
      <p>${profs.length} conta${profs.length === 1 ? '' : 's'} salva${profs.length === 1 ? '' : 's'}. Ao trocar, o comando <b>${esc(t.cliName)}</b> passa a usar a conta escolhida.</p></div>
    <div class="head-actions">
      <button class="btn" data-global="refreshAll">↻ Atualizar</button>
      <button class="btn primary" data-login="${id}" ${t.cli.installed === false || t.login ? 'disabled' : ''}>+ Adicionar conta</button>
    </div></div>`;
  if (t.cli.installed === false) {
    html += `<div class="banner"><span>⚠</span><div class="grow"><b>${esc(t.name)} não está instalado.</b><div class="muted small">Instale com um clique — depois volte aqui para adicionar contas.</div></div><button class="btn primary" data-install="${id}" ${t.busy ? 'disabled' : ''}>${t.busy ? 'Instalando…' : 'Instalar agora'}</button></div>`;
  }
  if (!profs.length) {
    html += `<div class="card empty"><div class="big">Nenhuma conta do ${esc(t.name)} ainda</div>
      <div>Clique em <b>Adicionar conta</b>: uma janela de login abre, você entra no navegador e a conta aparece aqui.</div></div>`;
  } else {
    html += `<div class="grid">${profs.map((p, i) => accountCard(p, SERIES[i % SERIES.length])).join('')}</div>`;
  }
  if (id !== 'cursor' && L && profs.length) {
    const series = profs.map((p, i) => ({ id: p.id, name: p.label, color: SERIES[i % SERIES.length], perDay: (L.byProfile[p.id] || {}).perDay || {} }));
    const unk = L.byProfile[`unknown:${id}`];
    if (unk) series.push({ id: 'unknown', name: 'Antes de usar o app', color: 'var(--muted)', perDay: unk.perDay });
    html += `<h2>Consumo diário por conta</h2>${stackedChart(id, `Tokens por dia — ${t.name}`, series, ui.days)}`;
  } else if (id === 'cursor' && profs.length) {
    html += '<p class="muted small" style="margin-top:18px">O Cursor não grava tokens localmente; o consumo mostrado vem direto da sua conta no cursor.com (ciclo de cobrança mensal).</p>';
  }
  return html;
}

function pageInstall() {
  let html = `<div class="page-head"><div><h1>Instalação dos CLIs</h1><p>Instale ou atualize cada ferramenta sem abrir o terminal.</p></div>
    <div class="head-actions"><button class="btn" data-global="detect">↻ Verificar novamente</button></div></div><div class="grid">`;
  for (const t of S.tools) {
    const c = t.cli;
    const status = c.installed == null ? '<span class="cli-status">Verificando…</span>'
      : c.installed ? `<span class="cli-status ok">Instalado ${c.version ? `· ${esc(c.version)}` : ''}</span>`
        : '<span class="cli-status missing">Não instalado</span>';
    const log = t.installLog;
    html += `<div class="card install-card">
      <div class="install-top">
        <div class="avatar" style="background:var(--${t.id})">${esc(t.name[0])}</div>
        <div class="grow"><div class="acct-label">${esc(t.name)}</div>${status}${c.path ? `<div class="cli-path selectable" title="${esc(c.path)}">${esc(c.path)}</div>` : ''}</div>
      </div>
      <div class="muted small">${esc(t.installHint)}</div>
      <div class="acct-actions">
        <button class="btn ${c.installed ? '' : 'primary'}" data-install="${t.id}" ${t.busy ? 'disabled' : ''}>${t.busy ? 'Instalando…' : c.installed ? 'Atualizar / reinstalar' : 'Instalar'}</button>
        ${c.installed ? `<button class="btn ghost" data-folder="${t.id}">Abrir pasta de configuração</button>` : ''}
      </div>
      ${log ? `<div class="log" id="log-${t.id}">${esc(log.lines.join('\n'))}</div>` : ''}
    </div>`;
  }
  return html + '</div>';
}

// ---------------- importar / exportar ----------------
const xf = { selected: null, pw1: '', pw2: '', busy: false, imp: null, impPw: '', mode: 'keep', result: null };

function pageTransfer() {
  if (!xf.selected) xf.selected = new Set(S.profiles.map((p) => p.id));
  for (const id of [...xf.selected]) if (!S.profiles.some((p) => p.id === id)) xf.selected.delete(id);
  const pwOk = xf.pw1.length >= 8 && xf.pw1 === xf.pw2;
  let html = `<div class="page-head"><div><h1>Importar / exportar</h1>
    <p>Leve suas contas para outro computador (Windows, macOS ou Linux) com um arquivo protegido por senha.</p></div></div>
    <div class="grid xfer">`;

  // exportar
  html += `<div class="card form-card"><h3>⇪ Exportar contas</h3>
    <p class="muted small">Escolha as contas. O arquivo <b>.aias</b> sai criptografado com a senha que você definir aqui — sem ela ninguém consegue abrir.</p>`;
  if (!S.profiles.length) {
    html += '<div class="usage-error">Nenhuma conta salva para exportar.</div>';
  } else {
    html += '<div class="checklist">';
    for (const t of S.tools) {
      const profs = profilesOf(t.id);
      if (!profs.length) continue;
      html += `<div class="check-group"><span class="dot" style="background:var(--${t.id})"></span>${esc(t.name)}</div>`;
      html += profs.map((p) => `<label class="check"><input type="checkbox" data-xsel="${p.id}" ${xf.selected.has(p.id) ? 'checked' : ''}>
        <span>${esc(p.label)}${p.plan ? ` <span class="badge">${esc(planName(p.plan))}</span>` : ''}</span></label>`).join('');
    }
    html += `</div>
      <label class="field"><span>Senha do arquivo</span><input type="password" data-field="pw1" value="${esc(xf.pw1)}" autocomplete="new-password" placeholder="mínimo 8 caracteres"></label>
      <label class="field"><span>Repita a senha</span><input type="password" data-field="pw2" value="${esc(xf.pw2)}" autocomplete="new-password"></label>
      <div class="field-msg" id="pwMsg">${esc(pwMessage())}</div>
      <div class="usage-error">⚠ O arquivo contém o acesso às suas contas. Guarde-o com cuidado e apague-o depois de importar.</div>
      <div class="acct-actions"><button class="btn primary" data-xact="export" ${!pwOk || !xf.selected.size || xf.busy ? 'disabled' : ''}>
        ${xf.busy === 'export' ? 'Exportando…' : `Exportar ${xf.selected.size} conta${xf.selected.size === 1 ? '' : 's'}…`}</button></div>`;
  }
  html += '</div>';

  // importar
  html += `<div class="card form-card"><h3>⇩ Importar contas</h3>
    <p class="muted small">Abra um arquivo <b>.aias</b> exportado em outro computador. Suas contas atuais não são apagadas.</p>`;
  if (!xf.imp) {
    html += '<div class="acct-actions"><button class="btn primary" data-xact="pick">Escolher arquivo…</button></div>';
  } else {
    const when = xf.imp.createdAt ? new Date(xf.imp.createdAt).toLocaleString('pt-BR') : '';
    html += `<div class="file-box"><b>${esc(xf.imp.name)}</b><span class="muted small">exportado em ${esc(when)} · ${xf.imp.summary.length} conta(s)</span>
        <div class="muted small">${xf.imp.summary.map((s) => `${esc((tool(s.tool) || { name: s.tool }).name)}: ${esc(s.label)}`).join('<br>')}</div></div>
      <label class="field"><span>Senha do arquivo</span><input type="password" data-field="impPw" value="${esc(xf.impPw)}" autocomplete="off"></label>
      <div class="field"><span>Se a conta já existir neste computador</span>
        <label class="radio"><input type="radio" name="xmode" value="keep" ${xf.mode === 'keep' ? 'checked' : ''}> Manter a daqui (recomendado)</label>
        <label class="radio"><input type="radio" name="xmode" value="replace" ${xf.mode === 'replace' ? 'checked' : ''}> Substituir pela do arquivo</label>
      </div>
      <div class="acct-actions">
        <button class="btn" data-xact="clearImp">Trocar arquivo</button>
        <button class="btn primary" data-xact="import" ${!xf.impPw || xf.busy ? 'disabled' : ''}>${xf.busy === 'import' ? 'Importando…' : 'Importar'}</button>
      </div>`;
  }
  if (xf.result) html += `<div class="result-box">${xf.result}</div>`;
  html += `<p class="muted small">Dica: se a mesma conta for usada ao mesmo tempo em dois computadores, um deles pode pedir login de novo
    quando o serviço renovar os tokens. Nesse caso use <b>⋯ → Entrar novamente</b> naquela conta.</p></div>`;
  return html + '</div>';
}

function pwMessage() {
  if (!xf.pw1) return '';
  if (xf.pw1.length < 8) return 'Mínimo de 8 caracteres.';
  if (xf.pw2 && xf.pw1 !== xf.pw2) return 'As senhas não conferem.';
  return '';
}

async function transferAction(act) {
  if (act === 'export') {
    xf.busy = 'export'; render();
    const r = await call('exportVault', [...xf.selected], xf.pw1);
    xf.busy = false;
    if (r && r.ok) { xf.pw1 = ''; xf.pw2 = ''; toast(`${r.count} conta(s) exportada(s) para ${r.path}`, 'ok'); }
    render();
  } else if (act === 'pick') {
    const r = await call('importPick');
    if (r && r.ok) { xf.imp = r; xf.impPw = ''; xf.result = null; render(); }
  } else if (act === 'clearImp') {
    xf.imp = null; xf.impPw = ''; xf.result = null; render();
  } else if (act === 'import') {
    xf.busy = 'import'; render();
    const r = await call('importApply', xf.imp.path, xf.impPw, xf.mode);
    xf.busy = false;
    if (r && r.ok) {
      const parts = [];
      if (r.added) parts.push(`${r.added} nova(s)`);
      if (r.updated) parts.push(`${r.updated} atualizada(s)`);
      if (r.skipped) parts.push(`${r.skipped} já existente(s), mantida(s) como estava(m)`);
      if (r.invalid) parts.push(`${r.invalid} inválida(s)`);
      xf.result = `✔ Importação concluída: ${parts.join(', ') || 'nada a importar'}. Para usar uma conta, abra a página da ferramenta e clique em <b>Usar esta conta</b>.`;
      xf.imp = null; xf.impPw = '';
      toast('Contas importadas.', 'ok');
    }
    render();
  }
}

document.addEventListener('input', (e) => {
  const f = e.target.dataset && e.target.dataset.field;
  if (!f) return;
  xf[f] = e.target.value;
  // atualiza só o botão/mensagem sem perder o foco do campo
  const pwOk = xf.pw1.length >= 8 && xf.pw1 === xf.pw2;
  const exp = document.querySelector('[data-xact="export"]');
  if (exp) exp.disabled = !pwOk || !xf.selected.size || !!xf.busy;
  const imp = document.querySelector('[data-xact="import"]');
  if (imp) imp.disabled = !xf.impPw || !!xf.busy;
  const msg = document.getElementById('pwMsg');
  if (msg) msg.textContent = pwMessage();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.dataset || !e.target.dataset.field) return;
  const btn = document.querySelector(e.target.dataset.field === 'impPw' ? '[data-xact="import"]' : '[data-xact="export"]');
  if (btn && !btn.disabled) btn.click();
});

// ---------------- atualizações ----------------
function updateSub() {
  if (!UP) return '';
  const v = `v${UP.current}`;
  if (UP.status === 'ready') return `${v} · nova versão pronta!`;
  if (UP.status === 'available') return `${v} · versão ${UP.latest} disponível`;
  if (UP.status === 'downloading') return `${v} · baixando ${UP.progress || 0}%`;
  return v;
}

function updateBanner() {
  if (!UP || ui.view === 'updates') return '';
  if (UP.status === 'ready') {
    return `<div class="banner update"><span>⬆</span><div class="grow"><b>Versão ${esc(UP.latest)} pronta para instalar.</b>
      <div class="muted small">Leva só alguns segundos. Ela também é instalada sozinha da próxima vez que você sair do app.</div></div>
      <button class="btn ghost small" data-up="notes">Novidades</button><button class="btn primary" data-up="install">Reiniciar e atualizar</button></div>`;
  }
  if (UP.status === 'available') {
    return `<div class="banner update"><span>⬆</span><div class="grow"><b>Versão ${esc(UP.latest)} disponível.</b>
      <div class="muted small">Baixe o instalador novo e abra-o. Suas contas são mantidas.</div></div>
      <button class="btn ghost small" data-up="notes">Novidades</button><button class="btn primary" data-up="install">Baixar atualização</button></div>`;
  }
  return '';
}

function pageUpdates() {
  const u = UP || {};
  const modeText = {
    auto: 'Atualização automática: versões novas são baixadas em segundo plano e instaladas quando você reinicia o app.',
    notify: u.mode === 'notify' && navigator.platform.startsWith('Mac')
      ? 'No macOS, o app avisa quando há versão nova e baixa o instalador com um clique. A instalação silenciosa exige um app assinado com certificado da Apple.'
      : 'Nesta instalação o app avisa quando há versão nova e baixa o instalador com um clique.',
    dev: 'Você está rodando o app em modo de desenvolvimento (npm start). Atualizações só funcionam no app instalado.',
    unconfigured: 'O repositório do GitHub ainda não foi configurado nesta versão do app.',
  }[u.mode] || '';
  const statusText = {
    idle: 'Ainda não verificado.',
    checking: 'Verificando no GitHub…',
    uptodate: `Você está na versão mais recente.${u.checkedAt ? ` (verificado ${ago(u.checkedAt)})` : ''}`,
    downloading: `Baixando a versão ${esc(u.latest)}… ${u.progress || 0}%`,
    ready: `Versão ${esc(u.latest)} baixada e pronta para instalar.`,
    available: `Versão ${esc(u.latest)} disponível para baixar.`,
    error: `Não foi possível verificar: ${esc(u.error || '')}`,
  }[u.status] || '';
  const canCheck = !['dev', 'unconfigured'].includes(u.mode) && !['checking', 'downloading'].includes(u.status);
  return `<div class="page-head"><div><h1>Atualizações</h1><p>As versões novas vêm do GitHub Releases do projeto.</p></div></div>
    <div class="card form-card" style="max-width:640px">
      <div class="install-top">
        <div class="avatar" style="background:var(--accent)">↻</div>
        <div class="grow"><div class="acct-label">AI Account Switcher v${esc(u.current || '')}</div>
          <div class="muted small">${statusText}</div></div>
      </div>
      ${u.status === 'downloading' ? `<div class="meter-track"><div class="meter-fill" style="width:${u.progress || 0}%"></div></div>` : ''}
      <p class="muted small">${esc(modeText)}</p>
      <div class="acct-actions">
        ${u.status === 'ready' ? '<button class="btn primary" data-up="install">Reiniciar e atualizar</button>' : ''}
        ${u.status === 'available' ? '<button class="btn primary" data-up="install">Baixar atualização</button>' : ''}
        <button class="btn" data-up="check" ${canCheck ? '' : 'disabled'}>${u.status === 'checking' ? 'Verificando…' : 'Verificar agora'}</button>
        ${u.releaseUrl ? '<button class="btn ghost" data-up="notes">Ver todas as versões</button>' : ''}
      </div>
    </div>`;
}

// ---------------- render ----------------
function render() {
  const ae = document.activeElement;
  if (ae && (ae.id === 'renameInput' || (ae.dataset && ae.dataset.field))) return; // não atrapalha a digitação
  renderNav();
  const main = $('#main');
  const scroll = main.scrollTop;
  main.innerHTML = updateBanner() + (ui.view === 'overview' ? pageOverview() : ui.view === 'install' ? pageInstall()
    : ui.view === 'transfer' ? pageTransfer() : ui.view === 'updates' ? pageUpdates() : pageTool(ui.view));
  main.scrollTop = scroll;
  document.querySelectorAll('.log').forEach((el) => { el.scrollTop = el.scrollHeight; });
  const ri = $('#renameInput');
  if (ri && ui.focusRename) { ri.focus(); ri.select(); ui.focusRename = false; }
  renderModal();
}

// ---------------- eventos ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('button, [data-act]');
  if (!e.target.closest('.menu-wrap') && ui.menu) { ui.menu = null; render(); }
  if (!el) return;
  const card = el.closest('.acct');
  const pid = card && card.dataset.id;
  const d = el.dataset;

  if (d.act === 'menu') { ui.menu = ui.menu === pid ? null : pid; render(); return; }
  if (d.act === 'activate') return activate(pid);
  if (d.act === 'refresh') { ui.menu = null; render(); await call('refreshUsage', pid); toast('Consumo atualizado.', 'ok'); return; }
  if (d.act === 'rename') { ui.menu = null; ui.renaming = pid; ui.focusRename = true; render(); return; }
  if (d.act === 'saveName') return saveRename();
  if (d.act === 'relogin') { ui.menu = null; const p = S.profiles.find((x) => x.id === pid); return openLogin(p.tool, pid); }
  if (d.act === 'remove') { ui.menu = null; return confirmRemove(pid); }
  if (d.login) return openLogin(d.login);
  if (d.install) { go('install'); call('install', d.install); return; }
  if (d.folder) return call('openFolder', d.folder);
  if (d.navTo) return go(d.navTo);
  if (d.days) { ui.days = Number(d.days); render(); return; }
  if (d.table) { ui.table[d.table] = !ui.table[d.table]; render(); return; }
  if (d.global === 'refreshAll') {
    el.disabled = true; el.textContent = 'Atualizando…';
    await call('refreshAll'); await loadLocal(true); toast('Consumo atualizado.', 'ok'); return;
  }
  if (d.global === 'detect') { await call('detect'); toast('Verificação concluída.', 'ok'); return; }
  if (d.modal) return modalAction(d.modal);
  if (d.xact) return transferAction(d.xact);
  if (d.up === 'check') { await api.call('checkUpdate'); return; }
  if (d.up === 'install') { await api.call('installUpdate'); return; }
  if (d.up === 'notes' && UP && UP.releaseUrl) { api.call('openExternal', UP.releaseUrl); return; }
});

document.addEventListener('change', (e) => {
  const xs = e.target.dataset && e.target.dataset.xsel;
  if (xs) { if (e.target.checked) xf.selected.add(xs); else xf.selected.delete(xs); render(); return; }
  if (e.target.name === 'xmode') { xf.mode = e.target.value; return; }
  const sw = e.target.closest('[data-switch]');
  if (sw && sw.value) activate(sw.value);
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'renameInput') {
    if (e.key === 'Enter') saveRename();
    if (e.key === 'Escape') { ui.renaming = null; e.target.blur(); render(); }
  }
  if (e.key === 'Escape' && ui.modal && !ui.modal.waiting) { ui.modal = null; renderModal(); }
});

async function activate(id) {
  const p = S.profiles.find((x) => x.id === id);
  const r = await call('activate', id);
  if (r && r.ok) toast(r.already ? `${p.label} já está em uso.` : `Pronto! ${tool(p.tool).name} agora usa ${p.label}. Feche e reabra sessões abertas do CLI.`, 'ok');
}
async function saveRename() {
  const ri = $('#renameInput');
  if (!ri) return;
  const id = ui.renaming; const v = ri.value;
  ui.renaming = null; ri.blur();
  await call('rename', id, v);
}

// ---------------- modais ----------------
function confirmRemove(pid) {
  const p = S.profiles.find((x) => x.id === pid);
  ui.modal = { type: 'remove', pid, title: `Remover “${p.label}”?`, text: p.active
    ? 'Esta conta está em uso. Ela continua logada no CLI, mas deixa de aparecer aqui e não poderá ser reativada pelo app.'
    : 'As credenciais salvas desta conta serão apagadas do app. Para usá-la de novo, será preciso fazer login novamente.' };
  renderModal();
}

function openLogin(toolId, profileId = null) {
  const t = tool(toolId);
  const p = profileId ? S.profiles.find((x) => x.id === profileId) : null;
  ui.modal = { type: 'login', tool: toolId, profileId, waiting: false, title: p ? `Entrar novamente: ${p.label}` : `Adicionar conta do ${t.name}` };
  renderModal();
}

async function modalAction(action) {
  const m = ui.modal;
  if (!m) return;
  if (action === 'close') { ui.modal = null; renderModal(); return; }
  if (action === 'confirmRemove') { await call('remove', m.pid); ui.modal = null; renderModal(); toast('Conta removida do app.', 'ok'); return; }
  if (action === 'cancelLogin') { await call('cancelLogin', m.tool); return; }
  if (action === 'useNow') { const id = m.result.profileId; ui.modal = null; renderModal(); return activate(id); }
  if (action === 'startLogin') {
    m.waiting = true; renderModal();
    const r = await api.call('login', m.tool, m.profileId);
    if (!ui.modal || ui.modal !== m) return;
    m.waiting = false;
    if (r && r.ok) {
      m.result = r;
      const prof = S.profiles.find((x) => x.id === r.profileId);
      m.done = true;
      m.isActive = prof && prof.active;
      m.doneText = r.existed ? `Credenciais de “${r.label}” atualizadas.` : `Conta “${r.label}” adicionada!`;
    } else {
      m.errorText = (r && r.error) || 'Não foi possível concluir o login.';
    }
    renderModal();
  }
}

function renderModal() {
  const root = $('#modalRoot');
  const m = ui.modal;
  if (!m) { root.innerHTML = ''; return; }
  let body = '';
  if (m.type === 'remove') {
    body = `<h3>${esc(m.title)}</h3><p>${esc(m.text)}</p>
      <div class="row"><button class="btn" data-modal="close">Cancelar</button><button class="btn danger" data-modal="confirmRemove">Remover</button></div>`;
  } else if (m.type === 'login') {
    const t = tool(m.tool);
    if (m.done) {
      body = `<h3>✔ ${esc(m.doneText)}</h3>
        <p>${m.isActive ? 'Ela já é a conta em uso.' : `A conta que estava em uso no ${esc(t.name)} continua ativa. Quer trocar para a nova agora?`}</p>
        <div class="row"><button class="btn" data-modal="close">${m.isActive ? 'Fechar' : 'Agora não'}</button>${m.isActive ? '' : '<button class="btn primary" data-modal="useNow">Usar esta conta agora</button>'}</div>`;
    } else {
      body = `<h3>${esc(m.title)}</h3>
        <ol>
          <li>Ao clicar em <b>Abrir login</b>, uma janela do ${esc(t.name)} abre e o navegador mostra a página de login.</li>
          <li>Entre com a conta desejada no navegador e autorize.</li>
          <li>Pronto — a janela fecha sozinha e a conta aparece aqui.</li>
        </ol>
        <p class="small muted">Sua conta atual não é desconectada: o login é feito em uma pasta separada.</p>
        ${m.waiting ? '<div class="waiting"><div class="spinner"></div><span>Aguardando você concluir o login no navegador…</span></div>' : ''}
        ${m.errorText ? `<div class="usage-error">${esc(m.errorText)}</div>` : ''}
        <div class="row">
          ${m.waiting ? '<button class="btn" data-modal="cancelLogin">Cancelar login</button>'
            : `<button class="btn" data-modal="close">Fechar</button><button class="btn primary" data-modal="startLogin">${m.errorText ? 'Tentar de novo' : 'Abrir login'}</button>`}
        </div>`;
    }
  }
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">${body}</div></div>`;
}

// ---------------- tooltip ----------------
const tip = $('#tooltip');
document.addEventListener('mousemove', (e) => {
  const hit = e.target.closest('[data-day]');
  const simple = !hit && e.target.closest('[data-tip]');
  if (!hit && !simple) { tip.style.display = 'none'; return; }
  if (hit) {
    const cd = chartData[hit.dataset.chart]; const d = hit.dataset.day;
    const rows = cd.series.filter((s) => s.perDay[d]).map((s) => `<div class="tt-row"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><b>${fmtTokens(s.perDay[d])}</b></div>`).join('');
    const tot = cd.series.reduce((a, s) => a + (s.perDay[d] || 0), 0);
    const date = new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    tip.innerHTML = `<div class="tt-title">${esc(date)}</div>${rows || '<div class="muted">Sem uso</div>'}${rows ? `<div class="tt-row" style="margin-top:4px"><span class="muted">Total</span><b>${fmtTokens(tot)}</b></div>` : ''}`;
  } else {
    tip.innerHTML = esc(simple.dataset.tip);
  }
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14; let y = e.clientY + 14;
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
});

// ---------------- inicialização ----------------
async function loadLocal() {
  L = await api.call('localUsage', 30);
  render();
}
api.onState((s) => { S = s; render(); });
api.onUpdate((u) => { UP = u; render(); });
(async () => {
  S = await api.call('state');
  UP = await api.call('updateState');
  render();
  loadLocal();
  setInterval(loadLocal, 60e3);
  setInterval(() => { if (!ui.modal) render(); }, 30e3); // atualiza "renova em…"
})();
