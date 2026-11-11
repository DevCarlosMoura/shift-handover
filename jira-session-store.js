"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const environment = require("./environment");

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

function unavailable() {
  return Object.assign(new Error("Não foi possível acessar o armazenamento protegido da conexão Jira. Confira o servidor e tente novamente."), { status: 503, code: "jira_session_store_unavailable" });
}

function decode(value, maximum = MAX_FILE_BYTES) {
  if (typeof value !== "string" || value.length > maximum * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw unavailable();
  const result = Buffer.from(value, "base64");
  if (!result.length || result.length > maximum || result.toString("base64") !== value) throw unavailable();
  return result;
}

function validRecords(records) {
  const token = (value) => typeof value === "string" && value.length > 0 && value.length < 20000 && !/[\r\n]/.test(value);
  const keys = new Set();
  if (!Array.isArray(records) || records.length > MAX_SESSIONS) throw unavailable();
  return records.map((record) => {
    if (!record || !HASH.test(record.sidHash || "") || keys.has(record.sidHash) || !token(record.accessToken)
      || !(record.refreshToken === null || token(record.refreshToken)) || !UUID.test(record.cloudId || "")
      || !Number.isFinite(record.expiresAt) || record.expiresAt <= 0 || !Number.isFinite(record.lastSeenAt) || record.lastSeenAt <= 0) throw unavailable();
    keys.add(record.sidHash);
    // Whitelisting excludes raw cookies, OAuth states, promises and application secrets.
    return { sidHash: record.sidHash, accessToken: record.accessToken, refreshToken: record.refreshToken, cloudId: record.cloudId, expiresAt: record.expiresAt, lastSeenAt: record.lastSeenAt };
  });
}

function createJiraSessionStore(options = {}) {
  const env = options.env || process.env;
  const file = options.file || path.join(environment.configDirectory(env), "jira-sessions.dpapi");
  const binding = options.binding;
  const protection = options.protectBytes || environment.protectBytes;
  const fileSystem = options.fs || fs;
  if (!path.isAbsolute(file) || !HASH.test(binding || "")) throw unavailable();
  const publicDirectory = path.resolve(__dirname, "public").toLowerCase() + path.sep;
  if (path.resolve(file).toLowerCase().startsWith(publicDirectory)) throw unavailable();

  let key;
  if (env.JIRA_SESSION_KEY) {
    key = decode(env.JIRA_SESSION_KEY, 32);
    if (key.length !== 32) throw unavailable();
  }
  if (!key && process.platform !== "win32" && !options.protectBytes) throw unavailable();
  const aad = Buffer.from("shift-handover:jira-sessions:1:" + binding, "utf8");
  const blockedFile = file + ".blocked";

  function isBlocked() {
    try { fileSystem.statSync(blockedFile); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw unavailable(); }
  }

  function latchWriteFailure() {
    // A zero-content marker prevents an older token snapshot from being restored
    // after a failed logout/refresh commit, when the filesystem can still create it.
    let descriptor;
    try {
      descriptor = fileSystem.openSync(blockedFile, "a", 0o600);
      fileSystem.fsyncSync(descriptor);
    } catch { /* The caller still fails closed and must not claim durable success. */ }
    finally { if (descriptor !== undefined) { try { fileSystem.closeSync(descriptor); } catch {} } }
  }

  function encodeEnvelope(plain) {
    if (key) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      return { version: 1, scheme: "aes-256-gcm-v1", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), protected: encrypted.toString("base64") };
    }
    const encrypted = protection(plain);
    try { return { version: 1, scheme: "windows-dpapi-v1", protected: encrypted.toString("base64") }; }
    finally { encrypted.fill(0); }
  }

  function decodeEnvelope(envelope) {
    if (!envelope || envelope.version !== 1) throw unavailable();
    const encrypted = decode(envelope.protected);
    try {
      if (envelope.scheme === "aes-256-gcm-v1" && key) {
        const iv = decode(envelope.iv, 12), tag = decode(envelope.tag, 16);
        if (iv.length !== 12 || tag.length !== 16) throw unavailable();
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
      }
      if (envelope.scheme === "windows-dpapi-v1" && !key) return protection(encrypted, true);
      throw unavailable();
    } finally { encrypted.fill(0); }
  }

  function load() {
    let plain;
    if (isBlocked()) throw unavailable();
    try {
      const info = fileSystem.statSync(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw unavailable();
      const envelope = JSON.parse(fileSystem.readFileSync(file, "utf8"));
      plain = decodeEnvelope(envelope);
      const payload = JSON.parse(plain.toString("utf8"));
      if (!payload || payload.version !== 1 || payload.binding !== binding) throw unavailable();
      return validRecords(payload.sessions);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw unavailable();
    } finally { if (plain) plain.fill(0); }
  }

  function save(records) {
    let plain;
    const temporary = file + "." + crypto.randomUUID() + ".tmp";
    let descriptor;
    let writeAttempted = false;
    try {
      if (isBlocked()) throw unavailable();
      const sessions = validRecords(records);
      plain = Buffer.from(JSON.stringify({ version: 1, binding, sessions }), "utf8");
      if (plain.length > MAX_FILE_BYTES / 2) throw unavailable();
      const content = JSON.stringify(encodeEnvelope(plain)) + "\n";
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw unavailable();
      writeAttempted = true;
      fileSystem.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      descriptor = fileSystem.openSync(temporary, "wx", 0o600);
      fileSystem.writeFileSync(descriptor, content, "utf8");
      fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
      fileSystem.renameSync(temporary, file);
    } catch { if (writeAttempted) latchWriteFailure(); throw unavailable(); }
    finally {
      if (plain) plain.fill(0);
      if (descriptor !== undefined) { try { fileSystem.closeSync(descriptor); } catch {} }
      try { fileSystem.unlinkSync(temporary); } catch {}
    }
  }

  return Object.freeze({ load, save });
}

module.exports = { createJiraSessionStore, unavailable };
