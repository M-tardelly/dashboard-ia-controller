'use strict';
/**
 * Exportar / importar contas entre computadores.
 * O cofre local usa a criptografia do sistema (presa a esta máquina), então o
 * arquivo exportado é protegido por uma senha escolhida pelo usuário:
 * chave derivada com scrypt + AES-256-GCM (detecta senha errada ou arquivo alterado).
 */
const crypto = require('crypto');

const FORMAT = 'ai-account-switcher-export';
const KDF = { N: 2 ** 16, r: 8, p: 1 };
const MAXMEM = 256 * 1024 * 1024;

function deriveKey(password, salt, kdf = KDF) {
  return crypto.scryptSync(String(password).normalize('NFC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM });
}

function encryptExport(payload, password) {
  if (!password || String(password).length < 8) throw new Error('Use uma senha com pelo menos 8 caracteres.');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const header = { format: FORMAT, version: 1, createdAt: new Date().toISOString() };
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify({
    ...header,
    summary: payload.profiles.map((p) => ({ tool: p.tool, label: p.label })), // só nomes, sem segredos
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: data.toString('base64'),
  }, null, 2);
}

function readHeader(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Arquivo inválido: não é uma exportação do AI Account Switcher.'); }
  if (!j || j.format !== FORMAT) throw new Error('Arquivo inválido: não é uma exportação do AI Account Switcher.');
  if (j.version !== 1) throw new Error('Esta exportação foi feita por uma versão mais nova do app. Atualize o app.');
  return j;
}

function decryptExport(text, password) {
  const j = readHeader(text);
  const key = deriveKey(password, Buffer.from(j.kdf.salt, 'base64'), j.kdf);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.cipher.iv, 'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify({ format: j.format, version: j.version, createdAt: j.createdAt })));
  decipher.setAuthTag(Buffer.from(j.cipher.tag, 'base64'));
  try {
    const out = Buffer.concat([decipher.update(Buffer.from(j.data, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    throw new Error('Senha incorreta (ou arquivo corrompido).');
  }
}

module.exports = { encryptExport, decryptExport, readHeader };
