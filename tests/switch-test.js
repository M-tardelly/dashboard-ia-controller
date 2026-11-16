'use strict';
/**
 * Teste de troca de contas com contas FICTÍCIAS em uma pasta HOME falsa
 * (não toca nos seus logins reais). Roda no Windows e no Linux:
 *   node tests/switch-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// ---- HOME falsa: precisa ser definida antes de carregar os módulos ----
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'aias-test-home-'));
process.env.HOME = FAKE; process.env.USERPROFILE = FAKE;
process.env.APPDATA = path.join(FAKE, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(FAKE, 'AppData', 'Local');
process.env.XDG_CONFIG_HOME = path.join(FAKE, '.config');
delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME; delete process.env.CURSOR_CONFIG_DIR;
if (process.platform === 'darwin') { console.log('No macOS o teste usaria o Keychain real; pulei.'); process.exit(0); }

const { Manager, PROVIDERS } = require('../src/core/manager');
const U = require('../src/core/util');
assert.ok(U.HOME === FAKE, 'HOME falsa não aplicada');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
const future = Math.floor(Date.now() / 1000) + 3600 * 24;

const accounts = {
  A: { email: 'alice@example.com', uuid: 'uuid-alice', sub: 'auth0|user_alice', acct: 'acct-alice' },
  B: { email: 'bob@example.com', uuid: 'uuid-bob', sub: 'auth0|user_bob', acct: 'acct-bob' },
};
function snapFor(tool, who, tokenTag = '1') {
  const a = accounts[who];
  if (tool === 'claude') {
    return {
      credentials: JSON.stringify({ claudeAiOauth: { accessToken: `at-${who}-${tokenTag}`, refreshToken: `rt-${who}-${tokenTag}`, expiresAt: Date.now() + 3600e3, subscriptionType: 'pro' } }),
      oauthAccount: { accountUuid: a.uuid, emailAddress: a.email },
    };
  }
  if (tool === 'codex') {
    return { auth: JSON.stringify({ OPENAI_API_KEY: null, tokens: {
      id_token: jwt({ email: a.email, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: a.acct } }),
      access_token: jwt({ exp: future, tag: tokenTag }), refresh_token: `rt-${who}-${tokenTag}`, account_id: a.acct,
    } }) };
  }
  return { auth: JSON.stringify({ accessToken: jwt({ sub: a.sub, exp: future, tag: tokenTag }), refreshToken: `rt-${who}-${tokenTag}` }), authInfo: { email: a.email, displayName: who } };
}
const liveKey = async (tool) => PROVIDERS[tool].identity(await PROVIDERS[tool].readLive()).key;

(async () => {
  const fakeCrypt = { secure: false, encrypt: (s) => `b64:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };
  const vaultDir = path.join(FAKE, 'vault'); fs.mkdirSync(vaultDir);

  // config do Claude com outras chaves que precisam ser preservadas
  fs.writeFileSync(path.join(FAKE, '.claude.json'), JSON.stringify({ numStartups: 7, projects: { x: 1 } }));
  fs.mkdirSync(path.join(FAKE, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(FAKE, '.cursor', 'cli-config.json'), JSON.stringify({ version: 1, editor: { vimMode: true } }));

  for (const tool of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[tool];
    // 1) conta A logada no CLI
    await p.writeLive(snapFor(tool, 'A'));
    const m = new Manager(vaultDir, fakeCrypt);
    await m.syncAll();
    const profA = m.db.profiles.find((x) => x.tool === tool);
    assert.ok(profA, `${tool}: conta A não importada`);
    assert.strictEqual(m.db.active[tool], profA.id, `${tool}: A deveria estar ativa`);

    // 2) adiciona a conta B (como se o login tivesse terminado)
    const { profileId: idB } = await m.importLogin(tool, snapFor(tool, 'B'));
    assert.notStrictEqual(idB, profA.id, `${tool}: B virou a mesma conta que A`);
    assert.strictEqual(await liveKey(tool), p.identity(snapFor(tool, 'A')).key, `${tool}: adicionar B não pode mexer no login atual`);

    // 3) troca para B
    await m.activate(idB);
    assert.strictEqual(await liveKey(tool), p.identity(snapFor(tool, 'B')).key, `${tool}: login ao vivo deveria ser B`);

    // 4) o CLI renova o token de B sozinho; ao voltar para A, o token novo de B fica guardado
    await p.writeLive(snapFor(tool, 'B', 'renovado'));
    await m.activate(profA.id);
    assert.strictEqual(await liveKey(tool), p.identity(snapFor(tool, 'A')).key, `${tool}: deveria voltar para A`);
    const savedB = JSON.stringify(m.open(m.profile(idB)));
    assert.ok(savedB.includes('renovado'), `${tool}: token renovado de B não foi guardado`);

    // 5) volta para B e confere que o CLI recebe o token renovado
    await m.activate(idB);
    assert.ok(JSON.stringify(await p.readLive()).includes('renovado'), `${tool}: B deveria voltar com o token renovado`);
    console.log(`✔ ${tool}: A → B → A → B ok (tokens renovados preservados)`);
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(FAKE, '.claude.json'), 'utf8'));
  assert.strictEqual(cfg.numStartups, 7, 'claude: outras chaves do .claude.json foram perdidas');
  const ccfg = JSON.parse(fs.readFileSync(path.join(FAKE, '.cursor', 'cli-config.json'), 'utf8'));
  assert.strictEqual(ccfg.editor.vimMode, true, 'cursor: outras chaves do cli-config.json foram perdidas');
  console.log('✔ configurações dos CLIs preservadas');
  console.log(`Todos os testes passaram (${process.platform}). Pasta temporária: ${FAKE}`);
  U.rmrf(FAKE);
})().catch((e) => { console.error('✖', e.message); process.exit(1); });
