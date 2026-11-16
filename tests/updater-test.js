'use strict';
/**
 * Garante que o app INSTALADO sabe de qual repositório buscar atualizações.
 * O electron-builder remove a seção "build" do package.json empacotado — o bug da v1.2.0/1.2.1
 * foi justamente depender dela. Aqui simulamos o app instalado: package.json sem "build"
 * e um resources/app-update.yml como o gerado pelo build.
 *   node tests/updater-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const pkg = require('../package.json');
const pub = pkg.build.publish.find((p) => p.provider === 'github');

const res = fs.mkdtempSync(path.join(os.tmpdir(), 'aias-res-'));
fs.writeFileSync(path.join(res, 'app-update.yml'),
  `owner: ${pub.owner}\nrepo: ${pub.repo}\nprovider: github\nreleaseType: draft\nupdaterCacheDirName: x\n`);
Object.defineProperty(process, 'resourcesPath', { value: res });

const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  if (req === 'electron') return { app: { isPackaged: true, getVersion: () => '1.0.0' }, shell: {} };
  if (req === 'electron-updater') return { autoUpdater: { on() {}, setFeedURL() {} } };
  // package.json como fica dentro do app instalado (sem "build")
  if (req === '../package.json' && parent && parent.filename.endsWith('updater.js')) {
    const { build, ...rest2 } = pkg; return rest2; // eslint-disable-line no-unused-vars
  }
  return orig.call(this, req, parent, ...rest);
};

const { Updater, cmpVersion } = require('../src/updater');
const u = new Updater();
assert.deepStrictEqual(u.repo, { owner: pub.owner, repo: pub.repo }, 'app instalado não encontrou o repositório');
assert.notStrictEqual(u.mode, 'unconfigured', 'app instalado ficaria sem atualização');
assert.ok(cmpVersion('1.10.0', '1.9.9') > 0 && cmpVersion('1.2.1', '1.2.1') === 0 && cmpVersion('v1.2.0', '1.2.1') < 0);
console.log(`✔ atualizador: modo "${u.mode}", repositório ${u.repo.owner}/${u.repo.repo}`);
fs.rmSync(res, { recursive: true, force: true });
