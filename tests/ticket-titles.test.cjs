"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function backend(project, prefix, seed) {
  const serverPath = path.join(project, "server.js");
  const source = fs.readFileSync(serverPath, "utf8");
  let handler, stored = seed ? JSON.stringify(seed) : null, temporary, writes = 0;
  const outgoing = [];
  const env = { JIRA_PROJECT_KEY: prefix, CHAT_WEBHOOK_URL: "fixture-webhook-endpoint" };
  const mockFs = { promises: {
    readFile: async () => { if (stored !== null) return stored; throw Object.assign(new Error("fixture missing"), { code: "ENOENT" }); },
    mkdir: async () => {},
    writeFile: async (file, content) => { if (!path.basename(file).startsWith(".startup-")) { writes += 1; temporary = content; } },
    rename: async (file) => { if (!path.basename(file).startsWith(".startup-")) stored = temporary; },
    unlink: async () => {},
  } };
  let uuid = 0;
  const context = {
    require: (name) => {
      if (name === "./app-config") { const config = require(path.join(project, "app-config")); return { readAppConfig: (value) => config.readAppConfig(value || env), getPublicConfig: (value) => config.getPublicConfig(value || env) }; }
      if (name === "node:fs") return mockFs;
      if (name === "node:http") return { createServer: (callback) => { handler = callback; return { on() {}, listen(_port, _host, done) { if (done) done(); }, close(done) { if (done) done(); }, closeAllConnections() {} }; } };
      if (name === "node:crypto") return { randomUUID: () => "99999999-9999-4999-8999-" + String(++uuid).padStart(12, "0") };
      return require(name);
    },
    __dirname: project, process: { env, on() {}, exit() {} }, Buffer, URL, setTimeout, clearTimeout,
    AbortSignal: { timeout: () => ({ fixture: true }) }, console: { log() {}, error() {} },
    fetch: async (_url, options) => { outgoing.push(JSON.parse(options.body)); return { ok: true, status: 200 }; },
  };
  const ready = vm.runInNewContext(source, context, { filename: serverPath });
  async function request(method, target, body) {
    await ready;
    const req = { method, url: target, headers: { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173", "content-type": "application/json" }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    const output = {};
    const res = { setHeader() {}, writeHead(status) { output.status = status; }, end(content) { output.body = content ? JSON.parse(content) : undefined; } };
    await handler(req, res);
    return output;
  }
  return { request, outgoing, writes: () => writes, records: () => stored === null ? [] : JSON.parse(stored) };
}

function jira(project, prefix, siteUrl, remote) {
  const { createJiraIntegration } = require(path.join(project, "jira-client"));
  let jar = "", sequence = 0;
  const calls = [];
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } });
  const client = createJiraIntegration({
    env: { JIRA_CLIENT_ID: "fixture-client", JIRA_CLIENT_SECRET: "fixture-secret-value", JIRA_PROJECT_KEY: prefix, JIRA_SITE_URL: siteUrl },
    sessions: new Map(), states: new Map(), randomUUID: () => "88888888-8888-4888-8888-" + String(++sequence).padStart(12, "0"), randomState: () => "fixture-state-" + String(++sequence).padStart(40, "0"),
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, "error");
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push(body);
      if (url.endsWith("/oauth/token")) return response({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 });
      if (url.endsWith("/accessible-resources")) return response([{ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", url: siteUrl, scopes: ["read:jira-work", "read:jira-user"] }]);
      assert.ok(url.endsWith("/search/jql"));
      assert.deepEqual(body.fields, ["key", "status", "summary"]);
      return remote(body, response);
    },
  });
  async function request(method, target, body) {
    const req = { method, headers: { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173", "content-type": "application/json", ...(jar ? { cookie: jar } : {}) }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    const output = { headers: {} };
    const res = { setHeader(name, value) { output.headers[name.toLowerCase()] = value; }, writeHead(status, headers = {}) { output.status = status; for (const [name, value] of Object.entries(headers)) output.headers[name.toLowerCase()] = value; }, end(content) { output.body = content ? JSON.parse(content) : undefined; } };
    await client.handle(req, res, new URL(target, "http://127.0.0.1:4173"));
    if (output.headers["set-cookie"]) jar = output.headers["set-cookie"].split(";")[0];
    return output;
  }
  async function connect() {
    const start = await request("GET", "/auth/jira");
    const state = new URL(start.headers.location).searchParams.get("state");
    const connected = await request("GET", "/auth/jira/callback?state=" + state + "&code=fixture-code");
    assert.equal(new URL(connected.headers.location, "http://127.0.0.1:4173").searchParams.get("jira"), "connected");
  }
  return { request, connect, calls };
}

function registerContractTests({ project, prefix = "OPS", siteUrl = "https://tenant-title.example" }) {
  const id = "11111111-1111-4111-8111-111111111111";
  const key = (number) => prefix + "-" + number;
  const item = (number, category, summary) => ({ key: key(number), fields: { status: { statusCategory: { key: category } }, ...(summary === undefined ? {} : { summary }) } });
  test("ticket titles persist alongside unchanged ID arrays and support older drafts", async () => {
    const previous = { id, lifecycle: "draft", deliveryStatus: "rascunho", revision: 1, createdAt: "2026-01-01T12:00:00Z", data: { chamadosAtendidos: [key(1)], chamadosPendentesIds: [key(2)] } };
    const h = backend(project, prefix, [previous]);
    assert.equal((await h.request("GET", "/api/handoffs")).body.records[0].data.chamadosTitulos, undefined);
    const result = await h.request("PUT", "/api/drafts/" + id, { revision: 1, data: { ...previous.data, chamadosTitulos: { [key(1).toLowerCase()]: "  Fixture\n printer\tadjustment  ", [key(2)]: "Fixture pending" } } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.record.data.chamadosAtendidos, [key(1)]);
    assert.deepEqual(result.body.record.data.chamadosTitulos, { [key(1)]: "Fixture printer adjustment", [key(2)]: "Fixture pending" });
    const reopened = backend(project, prefix, h.records());
    assert.deepEqual((await reopened.request("GET", "/api/handoffs")).body.records[0].data.chamadosTitulos, result.body.record.data.chamadosTitulos);
    assert.equal(h.outgoing.length, 0);
  });
  test("invalid, orphaned or oversized title maps fail before writing or sending", async () => {
    for (const titles of [null, [], "bad", { [key(1)]: 42 }, { [key(9)]: "Fixture orphan" }, { [key(1)]: "x".repeat(256) }, { [key(1)]: "one", [key(1).toLowerCase()]: "two" }, JSON.parse('{"__proto__":"fixture"}')]) {
      const h = backend(project, prefix);
      const result = await h.request("PUT", "/api/drafts/" + id, { revision: 0, data: { chamadosAtendidos: [key(1)], chamadosTitulos: titles } });
      assert.equal(result.status, 400);
      assert.equal(h.writes(), 0);
      assert.equal(h.outgoing.length, 0);
    }
  });
  test("older clients retain existing titles without bypassing revisions, while explicit empty maps clear them", async () => {
    const h = backend(project, prefix);
    const original = { chamadosAtendidos: [key(1)], chamadosPendentesIds: [key(2)], chamadosTitulos: { [key(1)]: "Fixture retained title", [key(2)]: "Fixture removed title" } };
    assert.equal((await h.request("PUT", "/api/drafts/" + id, { revision: 0, data: original })).status, 200);
    const legacy = { chamadosAtendidos: [key(1)], chamadosPendentesIds: [key(2)], principaisAtividades: "Fixture legacy edit" };
    const retained = await h.request("PUT", "/api/drafts/" + id, { revision: 1, data: legacy });
    assert.equal(retained.status, 200);
    assert.deepEqual(retained.body.record.data.chamadosTitulos, original.chamadosTitulos);
    const beforeConflict = JSON.stringify(h.records());
    assert.equal((await h.request("PUT", "/api/drafts/" + id, { revision: 1, data: legacy })).status, 409);
    assert.equal(JSON.stringify(h.records()), beforeConflict);
    const removed = await h.request("PUT", "/api/drafts/" + id, { revision: 2, data: { ...legacy, chamadosPendentesIds: [] } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.record.data.chamadosTitulos, { [key(1)]: original.chamadosTitulos[key(1)] });
    const cleared = await h.request("PUT", "/api/drafts/" + id, { revision: 3, data: { chamadosAtendidos: [key(1)], chamadosTitulos: {} } });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.record.data.chamadosTitulos, {});
    assert.equal((await h.request("PUT", "/api/drafts/" + id, { revision: 4, data: { chamadosAtendidos: [key(1)], chamadosTitulos: { [key(1)]: "Fixture retained title" } } })).status, 200);
    const submitted = await h.request("POST", "/api/handoffs", { draftId: id, draftRevision: 5, responsavel: "Fixture operator", turno: "Fixture shift", data: "2026-01-01", chamadosAtendidos: [key(1)] });
    assert.equal(submitted.status, 200);
    assert.deepEqual(h.records()[0].data.chamadosTitulos, { [key(1)]: "Fixture retained title" });
    assert.ok(h.outgoing[0].text.includes("• " + key(1) + " — Fixture retained title"));
  });
  test("submitted messages include titles as one line without executable mention syntax", async () => {
    const h = backend(project, prefix);
    const data = { responsavel: "Fixture operator", turno: "Fixture shift", data: "2026-01-01", chamadosAtendidos: [key(1), key(2)], chamadosPendentesIds: [key(3)], chamadosTitulos: { [key(1)]: "<users/all>\n*Fixture*", [key(3)]: "Fixture pending" } };
    const result = await h.request("POST", "/api/handoffs", data);
    assert.equal(result.status, 200);
    assert.equal(h.outgoing.length, 1);
    const message = h.outgoing[0].text;
    assert.ok(message.includes("• " + key(1) + " — ‹users/all› \\*Fixture\\*"));
    assert.ok(message.includes("• " + key(2) + "\n"));
    assert.ok(message.includes("• " + key(3) + " — Fixture pending"));
    assert.ok(!message.includes("<users/all>"));
    assert.equal(h.records()[0].data.chamadosTitulos[key(1)], "<users/all> *Fixture*");
  });
  test("320 long UTF-8 titles fit draft requests while the Chat limit remains explicit", async () => {
    const h = backend(project, prefix);
    const ids = Array.from({ length: 320 }, (_, i) => key(i + 1));
    const data = { responsavel: "Fixture operator", turno: "Fixture shift", data: "2026-01-01", chamadosAtendidos: ids.slice(0, 200), chamadosPendentesIds: ids.slice(200), chamadosTitulos: Object.fromEntries(ids.map((ticket) => [ticket, "機".repeat(255)])) };
    assert.ok(Buffer.byteLength(JSON.stringify(data)) > 96 * 1024);
    const saved = await h.request("PUT", "/api/drafts/" + id, { revision: 0, data });
    assert.equal(saved.status, 200);
    assert.equal(Object.keys(saved.body.record.data.chamadosTitulos).length, 320);
    const submitted = await h.request("POST", "/api/handoffs", { ...data, draftId: id, draftRevision: 1 });
    assert.equal(submitted.status, 413);
    assert.equal(h.outgoing.length, 0);
    assert.equal(h.records()[0].lifecycle, "draft");
    assert.equal(Object.keys(h.records()[0].data.chamadosTitulos).length, 320);
  });
  test("Jira pagination returns only titles associated with accepted final and pending IDs", async () => {
    const h = jira(project, prefix, siteUrl, (body, response) => {
      if (body.jql.includes("assignee")) return body.nextPageToken
        ? response({ isLast: true, issues: [item(2, "new", "Fixture\npending"), item(99, "done", "Not selected")] })
        : response({ isLast: false, nextPageToken: "fixture-next", issues: [item(1, "new", "Fixture first")] });
      return response({ isLast: true, issues: [item(2, "done", "Stale final title"), item(3, "done", "Fixture final"), item(4, "done"), item(5, "done", null)] });
    });
    await h.connect();
    const result = await h.request("POST", "/api/jira/import", { date: "2026-01-01" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.finalized, [key(3), key(4), key(5)]);
    assert.deepEqual(result.body.pending, [key(1), key(2)]);
    assert.deepEqual(result.body.titles, { [key(3)]: "Fixture final", [key(1)]: "Fixture first", [key(2)]: "Fixture pending" });
  });
  test("Jira page failures and malformed summaries never return partial titles", async () => {
    for (const problem of ["later-page", "wrong-type", "too-long"]) {
      const h = jira(project, prefix, siteUrl, (body, response) => {
        if (!body.jql.includes("assignee")) return response({ isLast: true, issues: [item(3, "done", "Fixture final")] });
        if (problem === "later-page") return body.nextPageToken ? response({}, 403) : response({ isLast: false, nextPageToken: "fixture-next", issues: [item(1, "new", "Fixture partial")] });
        return response({ isLast: true, issues: [item(1, "new", problem === "wrong-type" ? {} : "x".repeat(256))] });
      });
      await h.connect();
      const result = await h.request("POST", "/api/jira/import", { date: "2026-01-01" });
      assert.ok(result.status >= 400);
      assert.equal(Object.hasOwn(result.body, "titles"), false);
      assert.equal(Object.hasOwn(result.body, "finalized"), false);
      assert.equal(Object.hasOwn(result.body, "pending"), false);
    }
  });
}

if (require.main === module) registerContractTests({ project: path.resolve(__dirname, "..") });
module.exports = { registerContractTests };
