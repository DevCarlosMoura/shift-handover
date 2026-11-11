const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const serverPath = path.resolve(__dirname, "../server.js");
const source = fs.readFileSync(serverPath, "utf8");
const UUID = "11111111-1111-4111-8111-111111111111";
const validData = {
  responsavel: "  Responsável de teste  ",
  turno: " Manhã T4 ",
  data: "2026-11-11",
  chamadosResolvidos: "0002",
  chamadosPendentes: "8",
  chamadosAtendidos: [" ops-001 ", ""],
  chamadosPendentesIds: [" ops-020 "],
  principaisAtividades: "Teste isolado sem rede",
};

function createHarness(options = {}) {
  let handler;
  let stored = options.seed ? JSON.stringify(options.seed) : null;
  let temporary = null;
  let writes = 0;
  let fetchCalls = 0;
  let requestedTimeout;
  let nextId = 1;
  const requests = [];
  const outcomes = (options.fetchOutcomes || []).slice();
  const mockFs = {
    promises: {
      readFile: async () => {
        if (stored === null) {
          const error = new Error("not found");
          error.code = "ENOENT";
          throw error;
        }
        return stored;
      },
      mkdir: async () => {},
      writeFile: async (_file, content) => {
        if (path.basename(_file).startsWith(".startup-")) return;
        writes++;
        if (options.failWrites && options.failWrites(writes)) throw new Error("simulated disk failure");
        temporary = content;
      },
      rename: async (file) => { if (!path.basename(file).startsWith(".startup-")) stored = temporary; },
      unlink: async () => {},
    },
  };
  const environment = { ...(options.noWebhook ? {} : { CHAT_WEBHOOK_URL: "fixture-webhook-endpoint" }), ...(options.env || {}) };
  let boundHost;
  const sandbox = {
    require: (name) => {
      if (name === "./app-config") { const module = require("../app-config"); return { readAppConfig: (env) => module.readAppConfig(env || environment), getPublicConfig: (env) => module.getPublicConfig(env || environment) }; }
      if (name === "node:http") return { createServer: (callback) => { handler = callback; return { listen(_port, host, done) { boundHost = host; if (done) done(); }, on() {}, close(done) { if (done) done(); }, closeAllConnections() {} }; } };
      if (name === "node:fs") return mockFs;
      if (name === "node:path") return path;
      if (name === "node:net") return require("node:net");
      if (name === "node:crypto") return { randomUUID: () => "00000000-0000-4000-8000-" + String(nextId++).padStart(12, "0") };
      throw new Error("Unexpected module: " + name);
    },
    process: { env: environment, on() {}, exit() {} },
    __dirname: path.dirname(serverPath),
    Buffer,
    URL,
    AbortSignal: { timeout: (milliseconds) => { requestedTimeout = milliseconds; return { timeout: milliseconds }; } },
    console: { log() {}, error() {} },
    setTimeout,
    clearTimeout,
    fetch: async (_url, requestOptions) => {
      fetchCalls++;
      requests.push(requestOptions);
      if (options.fetchImpl) return options.fetchImpl(requestOptions);
      const outcome = outcomes.length ? outcomes.shift() : {};
      const errorName = outcome.error || options.fetchError;
      if (errorName) {
        const error = new Error("simulated transport failure");
        error.name = errorName;
        throw error;
      }
      return { ok: outcome.ok !== false && options.rejected !== true, status: outcome.ok === false || options.rejected ? 400 : 200 };
    },
  };
  const ready = vm.runInNewContext(source, sandbox, { filename: serverPath });

  async function request(method, url, data, headers = {}) {
    await ready;
    const req = {
      method,
      url,
      headers: { host: "localhost:4173", origin: "http://localhost:4173", "content-type": "application/json", ...headers },
      async *[Symbol.asyncIterator]() {
        if (data !== undefined) yield Buffer.from(JSON.stringify(data));
      },
    };
    let status;
    let payload;
    const responseHeaders = {};
    const res = {
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
      writeHead(code, head = {}) { status = code; Object.entries(head).forEach(([name, value]) => { responseHeaders[name.toLowerCase()] = value; }); },
      end(content) { if (content === undefined) payload = undefined; else { try { payload = JSON.parse(content); } catch { payload = String(content); } } },
    };
    await handler(req, res);
    return { status, payload, headers: responseHeaders };
  }
  return {
    post: (data) => request("POST", "/api/handoffs", data),
    putDraft: (id, data, revision) => request("PUT", "/api/drafts/" + id, { data, revision }),
    get: () => request("GET", "/api/handoffs"),
    records: () => stored === null ? [] : JSON.parse(stored),
    writes: () => writes,
    fetchCalls: () => fetchCalls,
    timeout: () => requestedTimeout,
    requests: () => requests,
    connectWebhook: () => { environment.CHAT_WEBHOOK_URL = "fixture-webhook-endpoint"; },
    request,
    ready,
    boundHost: () => boundHost,
  };
}

const checks = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
}

async function makeDraft(harness, data = { chamadosAtendidos: ["OPS-001"], chamadosPendentesIds: ["OPS-020"] }) {
  const result = await harness.putDraft(UUID, data, 0);
  assert.equal(result.status, 200);
  return result.payload.record;
}

(async () => {
  await check("health readiness and HEAD contain no records or configuration", async () => {
    const harness = createHarness();
    const result = await harness.request("GET", "/api/health");
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload, { status: "ok", storage: "ready" });
    const head = await harness.request("HEAD", "/api/health");
    assert.equal(head.status, 200);
    assert.equal(head.payload, undefined);
    assert.equal(harness.writes(), 0);
    assert.equal(harness.fetchCalls(), 0);
  });

  await check("page aliases use the configured origin and preserve the draft link", async () => {
    const harness = createHarness({ env: { APP_ORIGIN: "http://127.0.0.1:4173" } });
    const result = await harness.request("GET", "/?draft=" + UUID);
    assert.equal(result.status, 302);
    assert.equal(result.headers.location, "http://127.0.0.1:4173/?draft=" + UUID);
    assert.equal((await harness.request("HEAD", "/index.html")).headers.location, "http://127.0.0.1:4173/index.html");
    assert.equal((await harness.request("GET", "/api/health")).status, 200);
    assert.equal(harness.writes(), 0);
    assert.equal(harness.fetchCalls(), 0);
  });

  await check("production defaults to loopback and sends baseline headers", async () => {
    const harness = createHarness({ env: { NODE_ENV: "production" } });
    const result = await harness.request("GET", "/api/health");
    assert.equal(harness.boundHost(), "127.0.0.1");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
    assert.equal(result.headers["referrer-policy"], "no-referrer");
    assert.match(result.headers["content-security-policy"], /frame-ancestors 'none'/);
  });

  await check("foreign host and malformed URL are rejected before effects", async () => {
    const harness = createHarness();
    assert.equal((await harness.request("GET", "/api/handoffs", undefined, { host: "evil.invalid:4173" })).status, 403);
    assert.equal((await harness.request("GET", "http://localhost:4173/api/handoffs")).status, 400);
    assert.equal((await harness.request("GET", "//evil.invalid/" )).status, 400);
    assert.equal(harness.writes(), 0);
    assert.equal(harness.fetchCalls(), 0);
  });

  await check("JSON mutations require matching origin and content type", async () => {
    const harness = createHarness();
    for (const headers of [
      { origin: undefined }, { origin: "https://evil.invalid" },
      { "content-type": "text/plain" }, { "sec-fetch-site": "cross-site" },
    ]) {
      assert.equal((await harness.request("POST", "/api/handoffs", validData, headers)).status, 403);
      assert.equal((await harness.request("PUT", "/api/drafts/" + UUID, { data: {}, revision: 0 }, headers)).status, 403);
    }
    assert.equal(harness.writes(), 0);
    assert.equal(harness.fetchCalls(), 0);
  });

  await check("unsafe startup settings fail before serving", async () => {
    for (const env of [
      { PORT: "-1" }, { PORT: "65536" }, { PORT: "1e3" },
      { HOST: "bad host" }, { HOST: "0.0.0.0" },
      { HOST: "0.0.0.0", NODE_ENV: "production", APP_ORIGIN: "http://example.invalid" },
      { APP_ORIGIN: "https://example.invalid/with-path" },
      { HANDOFF_DATA_DIR: "relative-data" },
      { HANDOFF_DATA_DIR: path.join(path.dirname(serverPath), "public", "data") },
    ]) assert.throws(() => createHarness({ env }));
  });

  const invalidCases = [
    ["invalid calendar day", { data: "2026-02-30" }],
    ["invalid non-leap day", { data: "2025-02-29" }],
    ["invalid month", { data: "2026-13-01" }],
    ["year zero", { data: "0000-01-01" }],
    ["non-padded date", { data: "2026-2-01" }],
    ["empty required date", { data: "" }],
    ["empty responsible", { responsavel: "   " }],
    ["negative legacy count", { chamadosAtendidos: undefined, chamadosResolvidos: "-1" }],
    ["decimal legacy count", { chamadosPendentesIds: undefined, chamadosPendentes: "1.5" }],
    ["exponent legacy count", { chamadosAtendidos: undefined, chamadosResolvidos: "1e3" }],
    ["unsafe legacy count", { chamadosAtendidos: undefined, chamadosResolvidos: "9007199254740992" }],
    ["legacy count wrong type", { chamadosAtendidos: undefined, chamadosResolvidos: 12 }],
    ["text wrong type", { comunicados: { example: true } }],
    ["finalized list wrong type", { chamadosAtendidos: "OPS-1" }],
    ["pending list wrong type", { chamadosPendentesIds: "OPS-1" }],
    ["ticket member wrong type", { chamadosAtendidos: [12] }],
    ["ticket prefix", { chamadosAtendidos: ["ISS-1"] }],
    ["ticket too long", { chamadosAtendidos: ["OPS-1234567890123"] }],
    ["duplicate finalized", { chamadosAtendidos: ["OPS-1", "ops-1"] }],
    ["duplicate pending", { chamadosPendentesIds: ["OPS-2", " ops-2 "] }],
    ["same ID in both lists", { chamadosAtendidos: ["OPS-1"], chamadosPendentesIds: ["ops-1"] }],
  ];
  for (const [name, patch] of invalidCases) {
    await check(name, async () => {
      const harness = createHarness();
      const result = await harness.post({ ...validData, ...patch });
      assert.equal(result.status, 400, name + ": " + JSON.stringify(result.payload));
      assert.equal(harness.writes(), 0);
      assert.equal(harness.fetchCalls(), 0);
    });
  }

  await check("normalization whitelist and derived counts", async () => {
    const harness = createHarness({ noWebhook: true });
    const result = await harness.post({ ...validData, arbitraryExtra: "must not persist" });
    assert.equal(result.status, 200);
    assert.equal(result.payload.mode, "preview");
    const [record] = harness.records();
    assert.equal(record.lifecycle, "submitted");
    assert.equal(record.deliveryStatus, "sem_webhook");
    assert.equal(record.data.responsavel, "Responsável de teste");
    assert.equal(record.data.turno, "Manhã T4");
    assert.equal(record.data.chamadosResolvidos, "1");
    assert.equal(record.data.chamadosPendentes, "1");
    assert.deepEqual(record.data.chamadosAtendidos, ["OPS-001"]);
    assert.deepEqual(record.data.chamadosPendentesIds, ["OPS-020"]);
    assert.equal(Object.hasOwn(record.data, "arbitraryExtra"), false);
    assert.equal(harness.fetchCalls(), 0);
  });

  await check("legacy counts retained without ID arrays", async () => {
    const harness = createHarness({ noWebhook: true });
    const result = await harness.post({ ...validData, chamadosAtendidos: undefined, chamadosPendentesIds: undefined });
    assert.equal(result.status, 200);
    assert.equal(harness.records()[0].data.chamadosResolvidos, "2");
    assert.equal(harness.records()[0].data.chamadosPendentes, "8");
  });

  await check("present empty arrays derive zero despite stale counts", async () => {
    const harness = createHarness({ noWebhook: true });
    const result = await harness.post({ ...validData, chamadosAtendidos: [], chamadosPendentesIds: [], chamadosResolvidos: -1, chamadosPendentes: {} });
    assert.equal(result.status, 200);
    assert.equal(harness.records()[0].data.chamadosResolvidos, "0");
    assert.equal(harness.records()[0].data.chamadosPendentes, "0");
  });

  await check("valid leap date", async () => {
    const harness = createHarness({ noWebhook: true });
    assert.equal((await harness.post({ ...validData, data: "2024-02-29" })).status, 200);
  });

  await check("accepted delivery and separate lists in message", async () => {
    const harness = createHarness();
    const result = await harness.post(validData);
    assert.equal(result.status, 200);
    assert.equal(result.payload.mode, "sent");
    assert.equal(harness.records()[0].deliveryStatus, "enviado");
    assert.equal(harness.fetchCalls(), 1);
    assert.equal(harness.timeout(), 15000);
    const text = JSON.parse(harness.requests()[0].body).text;
    assert.match(text, /\*Chamados finalizados\*\n• OPS-001/);
    assert.match(text, /\*Chamados pendentes\*\n• OPS-020/);
    assert.ok(harness.requests()[0].signal);
  });

  await check("empty ticket lists use dash in message", async () => {
    const harness = createHarness();
    await harness.post({ ...validData, chamadosAtendidos: [], chamadosPendentesIds: [] });
    const text = JSON.parse(harness.requests()[0].body).text;
    assert.match(text, /\*Chamados finalizados\*\n—/);
    assert.match(text, /\*Chamados pendentes\*\n—/);
  });

  await check("accepted delivery remains success after status persistence failure", async () => {
    const harness = createHarness({ failWrites: (number) => number > 1 });
    const result = await harness.post(validData);
    assert.equal(result.status, 200);
    assert.equal(result.payload.mode, "sent");
    assert.equal(result.payload.saved, true);
    assert.match(result.payload.warning, /Não reenvie/);
    assert.equal(harness.records()[0].deliveryStatus, "enviando");
    assert.equal(harness.fetchCalls(), 1);
  });

  await check("explicit Chat rejection", async () => {
    const harness = createHarness({ rejected: true });
    const result = await harness.post(validData);
    assert.equal(result.status, 502);
    assert.equal(result.payload.deliveryStatus, "falha");
    assert.equal(harness.records()[0].deliveryStatus, "falha");
  });

  await check("timeout marks delivery uncertain", async () => {
    const harness = createHarness({ fetchError: "TimeoutError" });
    const result = await harness.post(validData);
    assert.equal(result.status, 504);
    assert.equal(result.payload.deliveryStatus, "incerto");
    assert.match(result.payload.error, /Confira o espaço antes de reenviar/);
    assert.equal(harness.records()[0].deliveryStatus, "incerto");
    assert.equal(harness.timeout(), 15000);
  });

  await check("transport failure marks delivery uncertain", async () => {
    const harness = createHarness({ fetchError: "TypeError" });
    const result = await harness.post(validData);
    assert.equal(result.status, 502);
    assert.equal(result.payload.deliveryStatus, "incerto");
    assert.equal(harness.records()[0].deliveryStatus, "incerto");
  });

  await check("initial persistence failure prevents delivery", async () => {
    const harness = createHarness({ failWrites: () => true });
    assert.equal((await harness.post(validData)).status, 500);
    assert.equal(harness.fetchCalls(), 0);
    assert.equal(harness.records().length, 0);
  });

  await check("partial IDs-only draft saves and resumes without fetch", async () => {
    const harness = createHarness();
    const draft = await makeDraft(harness);
    assert.equal(draft.id, UUID);
    assert.equal(draft.revision, 1);
    assert.equal(draft.lifecycle, "draft");
    assert.equal(draft.deliveryStatus, "rascunho");
    assert.equal(draft.data.responsavel, "");
    assert.equal(draft.data.data, "");
    assert.deepEqual(draft.data.chamadosPendentesIds, ["OPS-020"]);
    const listed = await harness.get();
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload.records, harness.records());
    const updated = await harness.putDraft(UUID, { ...draft.data, pontosAtencao: "Acompanhar impressora" }, 1);
    assert.equal(updated.status, 200);
    assert.equal(updated.payload.revision, 2);
    assert.equal(updated.payload.record.createdAt, draft.createdAt);
    assert.equal(harness.records().length, 1);
    assert.equal(harness.fetchCalls(), 0);
  });

  await check("different stale revision conflicts without losing draft", async () => {
    const harness = createHarness();
    await makeDraft(harness);
    const before = harness.records();
    const result = await harness.putDraft(UUID, { chamadosAtendidos: ["OPS-777"] }, 0);
    assert.equal(result.status, 409);
    assert.equal(result.payload.currentRevision, 1);
    assert.deepEqual(harness.records(), before);
  });

  await check("identical normalized stale revision is an idempotent save", async () => {
    const harness = createHarness();
    await makeDraft(harness);
    const writesBefore = harness.writes();
    const result = await harness.putDraft(UUID, { chamadosAtendidos: [" ops-001 "], chamadosPendentesIds: ["ops-020"] }, 0);
    assert.equal(result.status, 200);
    assert.equal(result.payload.duplicate, true);
    assert.equal(result.payload.revision, 1);
    assert.equal(harness.writes(), writesBefore);
    assert.equal(harness.records().length, 1);
  });

  await check("future revision cannot be hidden by identical data", async () => {
    const harness = createHarness();
    const draft = await makeDraft(harness);
    assert.equal((await harness.putDraft(UUID, draft.data, 2)).status, 409);
  });

  await check("finalization converts same ID and duplicate submit sends only once", async () => {
    const harness = createHarness();
    await makeDraft(harness);
    const result = await harness.post({ ...validData, draftId: UUID, draftRevision: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.payload.recordId, UUID);
    assert.equal(result.payload.revision, 2);
    assert.equal(result.payload.record.lifecycle, "submitted");
    assert.equal(harness.records().length, 1);
    const repeated = await harness.post({ draftId: UUID, draftRevision: 1 });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.payload.duplicate, true);
    assert.equal(harness.fetchCalls(), 1);
    assert.equal(harness.records().length, 1);
    assert.equal((await harness.putDraft(UUID, { chamadosAtendidos: [] }, 2)).status, 409);
  });

  await check("unsaved client UUID revision zero finalizes stably", async () => {
    const harness = createHarness();
    const result = await harness.post({ data: validData, draftId: UUID, draftRevision: 0 });
    assert.equal(result.status, 200);
    assert.equal(result.payload.recordId, UUID);
    assert.equal(result.payload.revision, 1);
    assert.equal(harness.fetchCalls(), 1);
  });

  await check("required or invalid completion cannot erase partial draft", async () => {
    const harness = createHarness();
    const draft = await makeDraft(harness);
    const before = harness.records();
    for (const invalid of [
      draft.data,
      { ...validData, data: "2026-02-30" },
      { ...validData, chamadosPendentesIds: ["BAD"] },
      { ...validData, principaisAtividades: "x".repeat(31000) },
    ]) {
      const result = await harness.post({ ...invalid, draftId: UUID, draftRevision: 1 });
      assert.ok([400, 413].includes(result.status));
      assert.deepEqual(harness.records(), before);
    }
    assert.equal(harness.fetchCalls(), 0);
  });

  await check("invalid draft data does not overwrite the existing draft", async () => {
    const harness = createHarness();
    await makeDraft(harness);
    const before = harness.records();
    for (const invalid of [
      { data: "2026-02-30" },
      { chamadosPendentesIds: ["BAD"] },
      { chamadosAtendidos: ["OPS-2", "ops-2"] },
      { chamadosAtendidos: ["OPS-2"], chamadosPendentesIds: ["ops-2"] },
    ]) {
      assert.equal((await harness.putDraft(UUID, invalid, 1)).status, 400);
      assert.deepEqual(harness.records(), before);
    }
  });

  await check("draft ID and revision validation", async () => {
    const harness = createHarness();
    assert.equal((await harness.putDraft("not-a-uuid", {}, 0)).status, 400);
    assert.equal((await harness.putDraft(UUID, {}, -1)).status, 400);
    assert.equal((await harness.putDraft(UUID, {}, "0")).status, 400);
    assert.equal((await harness.putDraft(UUID, {}, 1)).status, 409);
    assert.equal((await harness.post({ ...validData, draftId: UUID })).status, 400);
    assert.equal((await harness.post({ ...validData, draftRevision: 0 })).status, 400);
    assert.equal(harness.writes(), 0);
  });

  await check("stale completion conflicts", async () => {
    const harness = createHarness();
    await makeDraft(harness);
    const result = await harness.post({ ...validData, draftId: UUID, draftRevision: 0 });
    assert.equal(result.status, 409);
    assert.equal(harness.fetchCalls(), 0);
    assert.equal(harness.records()[0].lifecycle, "draft");
  });

  await check("concurrent submission cannot post twice", async () => {
    let releaseFetch;
    const harness = createHarness({ fetchImpl: () => new Promise((resolve) => { releaseFetch = resolve; }) });
    await makeDraft(harness);
    const first = harness.post({ ...validData, draftId: UUID, draftRevision: 1 });
    for (let attempts = 0; attempts < 30 && harness.fetchCalls() === 0; attempts++) await new Promise(setImmediate);
    assert.equal(harness.fetchCalls(), 1);
    const second = await harness.post({ ...validData, draftId: UUID, draftRevision: 1 });
    assert.equal(second.status, 409);
    assert.equal(second.payload.deliveryStatus, "enviando");
    releaseFetch({ ok: true });
    assert.equal((await first).status, 200);
    assert.equal(harness.fetchCalls(), 1);
    assert.equal(harness.records().length, 1);
  });

  await check("uncertain delivery blocks blind retry and draft overwrite", async () => {
    const harness = createHarness({ fetchError: "TimeoutError" });
    await makeDraft(harness);
    const first = await harness.post({ ...validData, draftId: UUID, draftRevision: 1 });
    assert.equal(first.status, 504);
    assert.equal(first.payload.revision, 2);
    const repeated = await harness.post({ ...validData, draftId: UUID, draftRevision: 2 });
    assert.equal(repeated.status, 409);
    assert.equal(repeated.payload.deliveryStatus, "incerto");
    assert.equal((await harness.putDraft(UUID, {}, 2)).status, 409);
    assert.equal(harness.fetchCalls(), 1);
  });

  await check("explicit failure can retry same frozen record safely", async () => {
    const harness = createHarness({ fetchOutcomes: [{ ok: false }, { ok: true }] });
    await makeDraft(harness);
    const first = await harness.post({ ...validData, draftId: UUID, draftRevision: 1 });
    assert.equal(first.status, 502);
    const savedData = harness.records()[0].data;
    const second = await harness.post({ responsavel: "changed and ignored", draftId: UUID, draftRevision: 2 });
    assert.equal(second.status, 200);
    assert.equal(second.payload.revision, 3);
    assert.equal(harness.fetchCalls(), 2);
    assert.equal(harness.records().length, 1);
    assert.deepEqual(harness.records()[0].data, savedData);
    assert.equal(harness.requests()[0].body, harness.requests()[1].body);
  });

  await check("saved without webhook can later retry same record", async () => {
    const harness = createHarness({ noWebhook: true });
    await makeDraft(harness);
    const first = await harness.post({ ...validData, draftId: UUID, draftRevision: 1 });
    assert.equal(first.payload.deliveryStatus, "sem_webhook");
    harness.connectWebhook();
    const second = await harness.post({ draftId: UUID, draftRevision: 2 });
    assert.equal(second.status, 200);
    assert.equal(harness.fetchCalls(), 1);
    assert.equal(harness.records().length, 1);
  });

  await check("legacy records remain intact beside new drafts", async () => {
    const legacy = {
      id: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-11-07T10:00:00.000Z",
      deliveryStatus: "enviado",
      data: { responsavel: "Legacy", turno: "T1", data: "2026-11-07", chamadosResolvidos: "4", chamadosAtendidos: ["OPS-9"] },
    };
    const harness = createHarness({ seed: [legacy] });
    await makeDraft(harness);
    const result = await harness.get();
    assert.equal(result.payload.records.length, 2);
    assert.deepEqual(result.payload.records.find((record) => record.id === legacy.id), legacy);
    const repeated = await harness.post({ draftId: legacy.id, draftRevision: 0 });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.payload.duplicate, true);
    assert.equal(harness.fetchCalls(), 0);
    assert.deepEqual(harness.records().find((record) => record.id === legacy.id), legacy);
  });


  await check("another project prefix accepts its own IDs and rejects mismatched project IDs", async () => {
    const harness = createHarness({ noWebhook: true, env: { JIRA_PROJECT_KEY: "HELP" } });
    const accepted = await harness.putDraft(UUID, { chamadosAtendidos: ["HELP-101"], chamadosPendentesIds: ["HELP-202"] }, 0);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.payload.record.data.chamadosResolvidos, "1");
    assert.deepEqual(accepted.payload.record.data.chamadosPendentesIds, ["HELP-202"]);
    const rejected = await harness.putDraft(UUID, { chamadosAtendidos: ["OPS-101"] }, 1);
    assert.equal(rejected.status, 400);
    assert.equal(harness.fetchCalls(), 0);
  });
  await check("runtime browser config exposes only public configuration for each installation", async () => {
    for (const project of ["OPS", "HELP"]) {
      const harness = createHarness({ noWebhook: true, env: { JIRA_PROJECT_KEY: project, APP_NAME: "Fixture Handover", TEAM_NAME: "Fixture Team", JIRA_CLIENT_SECRET: "fixture-private-value", JIRA_BASE_JQL: 'project = "' + project + '" AND labels = internal_fixture' } });
      const response = await harness.request("GET", "/runtime-config.js");
      assert.equal(response.status, 200);
      const sandbox = { window: {} };
      vm.runInNewContext(response.payload, sandbox);
      assert.equal(sandbox.window.HandoffConfig.ticketPrefix, project);
      assert.equal(sandbox.window.HandoffConfig.appName, "Fixture Handover");
      assert.equal(sandbox.window.HandoffConfig.teamName, "Fixture Team");
      assert.ok(!response.payload.includes("fixture-private-value"));
      assert.ok(!response.payload.includes("internal_fixture"));
      assert.deepEqual(Object.keys(sandbox.window.HandoffConfig).sort(), ["appName", "teamName", "ticketPrefix", "jiraFilterLabel", "jiraSiteLabel"].sort());
    }
  });
  console.log(checks.length + " open-source backend checks passed; fake data, no network or live installation access.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
