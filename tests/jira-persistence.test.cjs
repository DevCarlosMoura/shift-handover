"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createJiraSessionStore } = require("../jira-session-store");
const { createJiraIntegration } = require("../jira-client");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jira-persistence-test-"));
const key = crypto.randomBytes(32).toString("base64");
const binding = crypto.createHash("sha256").update("fixture-binding").digest("hex");
const site = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
let clock = Date.parse("2026-11-11T12:00:00Z");
let sequence = 0;
let refreshSequence = 0;
let revoked = false;
const calls = [];
let checks = 0;

function store(name, options = {}) {
  return createJiraSessionStore({ env: { JIRA_SESSION_KEY: key }, file: path.join(root, name), binding, ...options });
}
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } });

function client(storage, overrides = {}) {
  const sessions = new Map();
  const instance = createJiraIntegration({
    env: { JIRA_CLIENT_ID: "fixture-client", JIRA_SITE_URL: "https://tenant-alpha.atlassian.net", JIRA_PROJECT_KEY: "OPS", JIRA_CLIENT_SECRET: "fixture-client-secret", ...(overrides.env || {}) },
    sessionStore: storage, sessions, now: () => clock,
    randomUUID: () => "11111111-1111-4111-8111-" + String(++sequence).padStart(12, "0"),
    randomState: () => "fixture-state-" + String(++sequence).padStart(40, "0"),
    signalForTimeout: (value) => ({ timeout: value }),
    fetchImpl: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ url, grant: body.grant_type });
      assert.equal(options.redirect, "error");
      if (url.endsWith("/oauth/token")) {
        if (body.grant_type === "refresh_token") {
          if (revoked) return response({}, 400);
          const account = body.refresh_token.includes("-a") ? "a" : "b";
          refreshSequence += 1;
          return response({ access_token: "fixture-access-" + account + "-" + refreshSequence, refresh_token: "fixture-refresh-" + account + "-" + refreshSequence, expires_in: 3600 });
        }
        const account = body.code.endsWith("-a") ? "a" : "b";
        return response({ access_token: "fixture-access-" + account, refresh_token: "fixture-refresh-" + account, expires_in: 3600 });
      }
      if (url.endsWith("/accessible-resources")) return response([{ id: site, url: "https://tenant-alpha.atlassian.net", scopes: ["read:jira-work", "read:jira-user"] }]);
      if (url.endsWith("/search/jql")) {
        const token = options.headers.Authorization.slice(7);
        // Every search must use an access token already committed to encrypted storage.
        if (storage && overrides.checkCommitted !== false) assert.ok(storage.load().some((record) => record.accessToken === token));
        const account = token.includes("access-a") ? "a" : "b";
        const pending = body.jql.includes("statusCategory != Done");
        return response({ isLast: true, issues: [{ key: account === "a" ? (pending ? "OPS-101" : "OPS-102") : (pending ? "OPS-201" : "OPS-202"), fields: { status: { statusCategory: { key: pending ? "new" : "done" } } } }] });
      }
      throw new Error("Unexpected mocked endpoint");
    },
  });

  async function request(method, target, data, cookie = "") {
    const headers = { host: "127.0.0.1:4173", ...(cookie ? { cookie } : {}) };
    if (method === "POST") Object.assign(headers, { origin: "http://127.0.0.1:4173", "content-type": "application/json" });
    const output = { headers: {} };
    const result = {
      setHeader(name, value) { output.headers[name.toLowerCase()] = value; },
      writeHead(status, values) { output.status = status; for (const [name, value] of Object.entries(values || {})) output.headers[name.toLowerCase()] = value; },
      end(value) { output.body = value ? JSON.parse(value) : null; },
    };
    await instance.handle({ method, headers, async *[Symbol.asyncIterator]() { if (data !== undefined) yield Buffer.from(JSON.stringify(data)); } }, result, new URL(target, "http://127.0.0.1:4173"));
    return output;
  }

  async function connect(account) {
    const start = await request("GET", "/auth/jira");
    assert.equal(start.status, 302);
    const initialCookie = start.headers["set-cookie"].split(";")[0];
    const state = new URL(start.headers.location).searchParams.get("state");
    const finish = await request("GET", "/auth/jira/callback?state=" + state + "&code=fixture-code-" + account, undefined, initialCookie);
    assert.equal(finish.status, 302);
    assert.equal(new URL(finish.headers.location, "http://127.0.0.1:4173").searchParams.get("jira"), "connected");
    return { cookie: finish.headers["set-cookie"].split(";")[0], response: finish };
  }
  return { request, connect, sessions };
}

async function check(name, operation) { await operation(); checks += 1; }

(async () => {
  const file = "connections.dat";
  let a, b, connectionKeyA;
  await check("two independent browsers persist only hashed IDs in protected payload", async () => {
    const first = client(store(file));
    a = await first.connect("a");
    b = await first.connect("b");
    assert.notEqual(a.cookie, b.cookie);
    assert.match(a.response.headers["set-cookie"], /HttpOnly; SameSite=Lax; Max-Age=2592000/);
    const statusA = await first.request("GET", "/api/jira/status", undefined, a.cookie);
    const statusB = await first.request("GET", "/api/jira/status", undefined, b.cookie);
    connectionKeyA = statusA.body.connectionKey;
    assert.match(connectionKeyA, /^[0-9a-f]{64}$/);
    assert.notEqual(connectionKeyA, statusB.body.connectionKey);
    const contents = fs.readFileSync(path.join(root, file), "utf8");
    for (const value of [a.cookie.split("=")[1], b.cookie.split("=")[1], "fixture-access", "fixture-refresh", "fixture-client-secret"]) assert.equal(contents.includes(value), false);
    const records = store(file).load();
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => /^[0-9a-f]{64}$/.test(record.sidHash) && !Object.hasOwn(record, "id") && !Object.hasOwn(record, "oauthState")));
    assert.equal((await first.request("GET", "/api/jira/status")).body.connected, false);
  });

  await check("restart and reopening preserves each browser connection", async () => {
    clock += 8 * 60 * 60 * 1000 + 1;
    const reopened = client(store(file));
    assert.equal((await reopened.request("GET", "/api/jira/status", undefined, a.cookie)).body.connectionKey, connectionKeyA);
    assert.equal((await reopened.request("GET", "/api/jira/status", undefined, b.cookie)).body.connected, true);
    const importedA = await reopened.request("POST", "/api/jira/import", { date: "2026-11-11" }, a.cookie);
    const importedB = await reopened.request("POST", "/api/jira/import", { date: "2026-11-11" }, b.cookie);
    assert.deepEqual(importedA.body.pending, ["OPS-101"]);
    assert.deepEqual(importedB.body.pending, ["OPS-201"]);
    assert.equal(store(file).load().length, 2);
  });

  await check("rotated refresh survives another restart before further reads", async () => {
    const saved = store(file).load().find((record) => record.refreshToken.includes("-a"));
    assert.notEqual(saved.refreshToken, "fixture-refresh-a");
    clock += 3600000;
    const restarted = client(store(file));
    const before = refreshSequence;
    const result = await restarted.request("POST", "/api/jira/import", { date: "2026-11-11" }, a.cookie);
    assert.equal(result.status, 200);
    assert.equal(refreshSequence, before + 1);
    assert.equal(JSON.stringify(result).includes("fixture-access"), false);
    assert.equal(JSON.stringify(result).includes("fixture-refresh"), false);
  });

  await check("logout is durable and does not disconnect the other browser", async () => {
    const active = client(store(file));
    const result = await active.request("POST", "/api/jira/disconnect", {}, a.cookie);
    assert.equal(result.status, 200);
    assert.match(result.headers["set-cookie"], /Max-Age=0/);
    const restarted = client(store(file));
    assert.equal((await restarted.request("GET", "/api/jira/status", undefined, a.cookie)).body.connected, false);
    assert.equal((await restarted.request("GET", "/api/jira/status", undefined, b.cookie)).body.connected, true);
    assert.equal(store(file).load().length, 1);
  });

  await check("revocation removes persistent auth and survives restart", async () => {
    revoked = true;
    clock += 3600000;
    const active = client(store(file));
    assert.equal((await active.request("POST", "/api/jira/import", { date: "2026-11-11" }, b.cookie)).status, 401);
    assert.equal(store(file).load().length, 0);
    assert.equal((await client(store(file)).request("GET", "/api/jira/status", undefined, b.cookie)).body.connected, false);
    revoked = false;
  });

  await check("sliding touch is batched and expiry deletes durable auth", async () => {
    const storage = store("expiry.dat");
    const active = client(storage, { env: { JIRA_SESSION_DAYS: "1" } });
    const connected = await active.connect("a");
    const initial = storage.load()[0].lastSeenAt;
    clock += 14 * 60 * 1000;
    assert.equal((await active.request("GET", "/api/jira/status", undefined, connected.cookie)).body.connected, true);
    assert.equal(storage.load()[0].lastSeenAt, initial);
    clock += 60 * 1000;
    assert.equal((await active.request("GET", "/api/jira/status", undefined, connected.cookie)).body.connected, true);
    assert.equal(storage.load()[0].lastSeenAt, clock);
    clock += 24 * 60 * 60 * 1000 + 1;
    assert.equal((await client(storage, { env: { JIRA_SESSION_DAYS: "1" } }).request("GET", "/api/jira/status", undefined, connected.cookie)).body.connected, false);
    assert.equal(storage.load().length, 0);
  });

  await check("OAuth state stays transient across restart", async () => {
    const storage = store("states.dat");
    const current = client(storage);
    const start = await current.request("GET", "/auth/jira");
    const cookie = start.headers["set-cookie"].split(";")[0];
    const state = new URL(start.headers.location).searchParams.get("state");
    const before = calls.length;
    const result = await client(storage).request("GET", "/auth/jira/callback?state=" + state + "&code=fixture-code-a", undefined, cookie);
    assert.equal(result.status, 400);
    assert.equal(calls.length, before);
    assert.equal(storage.load().length, 0);
  });

  await check("corrupt protected storage fails only Jira with safe errors", async () => {
    fs.writeFileSync(path.join(root, "broken.dat"), "not-json");
    const result = await client(store("broken.dat")).request("GET", "/api/jira/status");
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "jira_session_store_unavailable");
    assert.equal(JSON.stringify(result).includes("not-json"), false);
  });

  await check("wrong encryption key or app binding cannot restore sessions", async () => {
    await client(store("binding.dat")).connect("a");
    assert.throws(() => store("binding.dat", { env: { JIRA_SESSION_KEY: crypto.randomBytes(32).toString("base64") } }).load(), /armazenamento protegido/);
    assert.throws(() => store("binding.dat", { binding: "f".repeat(64) }).load(), /armazenamento protegido/);
    assert.throws(() => store("binding.dat", { env: { JIRA_SESSION_KEY: "fixture-invalid-key" } }), /armazenamento protegido/);
  });

  await check("saving a newly connected browser preserves dormant accounts", async () => {
    const storage = store("dormant.dat");
    const original = client(storage);
    const first = await original.connect("a");
    const second = await original.connect("b");
    const reopened = client(storage);
    assert.equal((await reopened.request("GET", "/api/jira/status", undefined, first.cookie)).body.connected, true);
    const third = await reopened.connect("b");
    assert.equal(storage.load().length, 3);
    const restarted = client(storage);
    assert.equal((await restarted.request("GET", "/api/jira/status", undefined, second.cookie)).body.connected, true);
    assert.equal((await restarted.request("GET", "/api/jira/status", undefined, third.cookie)).body.connected, true);
  });

  await check("failed atomic write preserves encrypted original and cleans temp", async () => {
    const storage = store("atomic.dat");
    await client(storage).connect("a");
    const before = fs.readFileSync(path.join(root, "atomic.dat"));
    const brokenFs = { ...fs, renameSync() { throw new Error("fixture simulated write denial"); } };
    assert.throws(() => store("atomic.dat", { fs: brokenFs }).save([]), /armazenamento protegido/);
    assert.deepEqual(fs.readFileSync(path.join(root, "atomic.dat")), before);
    assert.equal(fs.readdirSync(root).some((file) => file.endsWith(".tmp")), false);
    assert.equal(fs.existsSync(path.join(root, "atomic.dat.blocked")), true);
    assert.throws(() => store("atomic.dat").load(), /armazenamento protegido/);
  });

  await check("failed callback persistence never publishes an authenticated cookie", async () => {
    const storage = { load: () => [], save(records) { if (records.length) throw new Error("fixture disk failure"); } };
    const current = client(storage);
    const start = await current.request("GET", "/auth/jira");
    const cookie = start.headers["set-cookie"].split(";")[0];
    const state = new URL(start.headers.location).searchParams.get("state");
    const result = await current.request("GET", "/auth/jira/callback?state=" + state + "&code=fixture-code-a", undefined, cookie);
    assert.equal(result.status, 302);
    assert.equal(new URL(result.headers.location, "http://127.0.0.1:4173").searchParams.get("jira"), "error");
    assert.match(result.headers["set-cookie"], /Max-Age=0/);
    assert.equal((await current.request("GET", "/api/jira/status", undefined, cookie)).status, 503);
  });

  await check("failed logout cannot claim success and clears the browser cookie", async () => {
    const real = store("logout-failure.dat");
    let fail = false;
    const storage = { load: () => real.load(), save(records) { if (fail) throw new Error("fixture disk failure"); real.save(records); } };
    const current = client(storage);
    const connected = await current.connect("a");
    fail = true;
    const result = await current.request("POST", "/api/jira/disconnect", {}, connected.cookie);
    assert.equal(result.status, 503);
    assert.match(result.headers["set-cookie"], /Max-Age=0/);
    assert.equal((await current.request("GET", "/api/jira/status", undefined, connected.cookie)).status, 503);
  });

  await check("failed refresh storage blocks Jira searches after token rotation", async () => {
    const real = store("refresh-failure.dat");
    let fail = false;
    const storage = { load: () => real.load(), save(records) { if (fail) throw new Error("fixture disk failure"); real.save(records); } };
    const current = client(storage);
    const connected = await current.connect("a");
    // Leave touch inside the batching window, but expire the access token in the injected clock.
    for (const value of current.sessions.values()) value.expiresAt = clock - 1;
    fail = true;
    const searchesBefore = calls.filter((call) => call.url.endsWith("/search/jql")).length;
    const result = await current.request("POST", "/api/jira/import", { date: "2026-11-11" }, connected.cookie);
    assert.equal(result.status, 503);
    assert.equal(calls.filter((call) => call.url.endsWith("/search/jql")).length, searchesBefore);
  });

  if (process.platform === "win32") await check("Windows DPAPI roundtrip uses only isolated fake records", () => {
    const storage = store("dpapi.dat", { env: {} });
    const records = [{ sidHash: "a".repeat(64), accessToken: "fixture-windows-access", refreshToken: "fixture-windows-refresh", cloudId: site, expiresAt: clock + 3600000, lastSeenAt: clock }];
    storage.save(records);
    assert.deepEqual(storage.load(), records);
    const content = fs.readFileSync(path.join(root, "dpapi.dat"), "utf8");
    assert.equal(content.includes("fixture-windows"), false);
    assert.equal(JSON.parse(content).scheme, "windows-dpapi-v1");
  });

  await check("lifetime configuration is bounded", () => {
    for (const value of ["0", "91", "-1", "1.5", "bad"]) assert.throws(() => client(null, { env: { JIRA_SESSION_DAYS: value } }), /entre 1 e 90/);
  });

  console.log(checks + " Jira persistence checks passed; fake sessions only, isolated encrypted files, no external requests or real credentials.");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  const resolved = path.resolve(root);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("jira-persistence-test-")) fs.rmSync(resolved, { recursive: true, force: true });
});
