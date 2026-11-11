"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

function request(port, target, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request({ hostname: "127.0.0.1", port, path: target, method: options.method || "GET", headers: { ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}), ...options.headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("Local test server timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

async function ready(child, port, output) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Fixture server exited: " + output());
    try { if ((await request(port, "/api/health")).status === 200) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fixture server was not ready: " + output());
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

test("clean installation runs with configurable project, private storage and no remote requests", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shift-handover-server-test-"));
  const sourceProject = path.resolve(__dirname, "..");
  const project = path.join(directory, "app");
  fs.mkdirSync(path.join(project, "public"), { recursive: true });
  // Copy source files explicitly. Never read an installer's .env, data or local stores.
  for (const name of ["start.js", "server.js", "environment.js", "app-config.js", "jira-client.js", "jira-session-store.js"]) {
    fs.copyFileSync(path.join(sourceProject, name), path.join(project, name));
  }
  fs.copyFileSync(path.join(sourceProject, "public", "index.html"), path.join(project, "public", "index.html"));
  const marker = path.join(directory, "remote-call-blocked.txt");
  const preload = path.join(directory, "block-remote.cjs");
  fs.writeFileSync(preload, "globalThis.fetch = async () => { require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'blocked'); throw new Error('Remote requests are disabled in this fixture'); };\n");
  const dataDirectory = path.join(directory, "records");
  const configDirectory = path.join(directory, "config");
  let child;
  let port;
  let captured = "";
  const appName = "Fixture </script><script>notExecuted()</script>";
  async function launch() {
    port = await unusedPort();
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(?:JIRA_|CHAT_WEBHOOK_URL$|HANDOVER_CONFIG_DIR$|APP_|TEAM_|HOST$|PORT$|NODE_ENV$|HANDOFF_DATA_DIR$|NODE_OPTIONS$)/i.test(key)) delete env[key];
    Object.assign(env, { HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test", APP_ORIGIN: "http://127.0.0.1:" + port,
      HANDOVER_CONFIG_DIR: configDirectory, HANDOFF_DATA_DIR: dataDirectory, JIRA_PROJECT_KEY: "HELP", APP_NAME: appName, TEAM_NAME: "Fixture Team" });
    captured = "";
    child = spawn(process.execPath, ["--require", preload, "start.js"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", (chunk) => { captured += chunk; });
    child.stderr.on("data", (chunk) => { captured += chunk; });
    await ready(child, port, () => captured);
  }
  try {
    await launch();
    await t.test("health and disabled integrations have no secrets", async () => {
      assert.deepEqual((await request(port, "/api/health")).body, { status: "ok", storage: "ready" });
      assert.equal((await request(port, "/api/status")).body.mode, "preview");
      assert.equal((await request(port, "/api/jira/status")).body.configured, false);
      assert.equal(fs.existsSync(path.join(dataDirectory, "handoffs.json")), false);
    });
    await t.test("runtime config supports the project and treats names as data", async () => {
      const runtime = await request(port, "/runtime-config.js");
      assert.equal(runtime.status, 200);
      assert.ok(!runtime.text.includes("</script>"));
      const sandbox = { window: {} };
      vm.runInNewContext(runtime.text, sandbox);
      assert.equal(sandbox.window.HandoffConfig.ticketPrefix, "HELP");
      assert.equal(sandbox.window.HandoffConfig.appName, appName);
      assert.deepEqual(Object.keys(sandbox.window.HandoffConfig).sort(), ["appName", "teamName", "ticketPrefix", "jiraFilterLabel", "jiraSiteLabel"].sort());
      assert.equal((await request(port, "/api/config")).body.ticketPrefix, "HELP");
      assert.equal((await request(port, "/")).status, 200);
    });
    await t.test("private files and hostile origins cannot access storage", async () => {
      for (const target of ["/.env", "/environment.js", "/settings.json", "/secrets.dpapi", "/data/handoffs.json"]) assert.equal((await request(port, target)).status, 404);
      assert.equal((await request(port, "/api/health", { headers: { Host: "not-this-app.invalid" } })).status, 403);
      const id = crypto.randomUUID();
      assert.equal((await request(port, "/api/drafts/" + id, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://another-site.invalid" }, body: { revision: 0, data: {} } })).status, 403);
      assert.equal(fs.existsSync(path.join(dataDirectory, "handoffs.json")), false);
    });
    const id = crypto.randomUUID();
    const data = { principaisAtividades: "Synthetic notes survive restart", chamadosAtendidos: Array.from({ length: 200 }, (_, i) => "HELP-" + (1000 + i)), chamadosPendentesIds: Array.from({ length: 120 }, (_, i) => "HELP-" + (2000 + i)) };
    await t.test("partial draft with 320 IDs is persisted without sending", async () => {
      const saved = await request(port, "/api/drafts/" + id, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:" + port }, body: { revision: 0, data } });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.record.data.chamadosResolvidos, "200");
      assert.equal(saved.body.record.data.chamadosPendentes, "120");
      assert.equal(saved.body.record.lifecycle, "draft");
      assert.equal(fs.existsSync(marker), false);
    });
    await stop(child);
    await launch();
    await t.test("server restart reads the same draft from isolated storage", async () => {
      const history = await request(port, "/api/handoffs");
      assert.equal(history.status, 200);
      assert.equal(history.body.records.length, 1);
      const saved = history.body.records[0];
      assert.equal(saved.id, id);
      assert.equal(saved.data.principaisAtividades, data.principaisAtividades);
      assert.deepEqual(saved.data.chamadosAtendidos, data.chamadosAtendidos);
      assert.deepEqual(saved.data.chamadosPendentesIds, data.chamadosPendentesIds);
      assert.equal(fs.existsSync(marker), false);
    });
  } finally {
    await stop(child);
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("shift-handover-server-test-")) throw new Error("Unsafe fixture cleanup target");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
