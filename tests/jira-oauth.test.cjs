"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { createJiraIntegration, buildImportJql, nextCalendarDay, safeReturnTo, DEFAULT_REDIRECT_URI } = require("../jira-client");
const { readAppConfig } = require("../app-config");
const config = readAppConfig({ JIRA_SITE_URL: "https://tenant-alpha.atlassian.net", JIRA_PROJECT_KEY: "OPS" });
const CLOUD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const allRemoteCalls = [];
const checks = [];
const issue = (key, category) => ({ key, fields: { status: { statusCategory: { key: category } }, summary: "fixture-summary-not-for-output" } });
const response = (body, status = 200, retryAfter) => ({ ok: status >= 200 && status < 300, status, headers: { get: (key) => key === "retry-after" ? retryAfter : null }, json: async () => body });

function harness(options = {}) {
  const env = options.missingConfig ? {} : {
    JIRA_CLIENT_ID: "fixture-client-id",
    JIRA_SITE_URL: "https://tenant-alpha.atlassian.net",
    JIRA_PROJECT_KEY: "OPS",
    JIRA_CLIENT_SECRET: "fixture-client-secret",
    ...(options.redirect ? { JIRA_REDIRECT_URI: options.redirect } : {}),
  };
  const origin = new URL(options.redirect || DEFAULT_REDIRECT_URI).origin;
  const host = new URL(origin).host;
  let timestamp = Date.parse("2026-11-11T12:00:00Z");
  let counter = 0;
  let jar = "";
  const calls = [];
  const replies = [];
  const sessions = new Map(), states = new Map();
  const client = createJiraIntegration({
    env, sessions, states, now: () => timestamp,
    randomUUID: () => "11111111-1111-4111-8111-" + String(++counter).padStart(12, "0"),
    randomState: () => "s".repeat(42) + String(++counter),
    signalForTimeout: (milliseconds) => ({ milliseconds }),
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      const call = { url, init, body };
      calls.push(call); allRemoteCalls.push(call);
      assert.equal(init.redirect, "error");
      assert.equal(init.signal.milliseconds, 15000);
      if (options.remote) {
        const custom = await options.remote(call);
        if (custom) return custom;
      }
      if (url === "https://auth.atlassian.com/oauth/token") return response({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", expires_in: 3600 });
      if (url.endsWith("/accessible-resources")) return response([
        { id: CLOUD_ID, url: "https://other.atlassian.net", scopes: ["read:jira-work", "read:jira-user"] },
        { id: CLOUD_ID, url: "https://tenant-alpha.atlassian.net", scopes: ["read:jira-work", "read:jira-user"] },
      ]);
      if (url.endsWith("/search/jql")) return response({ issues: [], isLast: true });
      throw new Error("Unexpected remote endpoint");
    },
  });

  async function request(method, target, body, overrides = {}) {
    const headers = { host, ...(jar ? { cookie: jar } : {}) };
    if (method === "POST") Object.assign(headers, { origin, "content-type": "application/json" });
    Object.assign(headers, overrides.headers || {});
    if (Object.hasOwn(overrides, "cookie")) {
      if (overrides.cookie) headers.cookie = overrides.cookie; else delete headers.cookie;
    }
    const req = { method, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    const out = { headers: {} };
    const res = {
      setHeader: (name, value) => { out.headers[name.toLowerCase()] = value; },
      writeHead: (status, values) => { out.status = status; for (const [key, value] of Object.entries(values)) out.headers[key.toLowerCase()] = value; },
      end: (content) => { out.raw = content || ""; out.body = content ? JSON.parse(content) : null; },
    };
    const handled = await client.handle(req, res, new URL(target, origin));
    assert.equal(handled, true);
    if (out.headers["set-cookie"] && !overrides.noAutoCookie) jar = out.headers["set-cookie"].split(";")[0];
    replies.push(out);
    return out;
  }
  async function start(returnTo = "/?draft=fixture-draft") {
    const out = await request("GET", "/auth/jira?returnTo=" + encodeURIComponent(returnTo));
    assert.equal(out.status, 302);
    return { response: out, state: new URL(out.headers.location).searchParams.get("state"), cookie: jar };
  }
  async function connect() {
    const initiated = await start();
    const out = await request("GET", "/auth/jira/callback?state=" + encodeURIComponent(initiated.state) + "&code=fixture-code");
    assert.equal(out.status, 302);
    assert.equal(new URL(out.headers.location, origin).searchParams.get("jira"), "connected");
    return { initiated, response: out };
  }
  return { request, start, connect, calls, replies, sessions, states, origin, getCookie: () => jar, advance: (ms) => { timestamp += ms; } };
}

async function check(name, operation) {
  await operation();
  checks.push(name);
}

(async () => {
  await check("generic project filter and calendar-day boundaries", () => {
    assert.equal(config.baseJql, 'project = "OPS"');
    const jql = buildImportJql("2024-02-29", config);
    assert.ok(jql.pending.startsWith("(\n" + config.baseJql + "\n)"));
    assert.match(jql.pending, /assignee = currentUser\(\) AND statusCategory != Done/);
    assert.match(jql.finalized, /statusCategory = Done/);
    assert.match(jql.finalized, /resolutiondate >= "2024-02-29"/);
    assert.match(jql.finalized, /resolutiondate < "2024-03-01"/);
    assert.match(jql.finalized, /resolution CHANGED BY currentUser\(\) DURING/);
    assert.ok(jql.finalized.includes('DURING ("2024-02-29 00:00", "2024-03-01 00:00")'));
    assert.equal(nextCalendarDay("2026-12-31"), "2027-01-01");
    assert.equal(nextCalendarDay("2025-02-28"), "2025-03-01");
    assert.throws(() => nextCalendarDay("2026-02-30"));
    assert.throws(() => nextCalendarDay("2026-11-11 OR 1=1"));
  });

  await check("safe returnTo preserves draft and rejects open redirects", () => {
    assert.equal(safeReturnTo("/?draft=abc&other=1"), "/?draft=abc&other=1");
    for (const unsafe of ["https://evil.invalid", "//evil.invalid", "/\\evil", "/%2f%2fevil.invalid", "/x%0d%0aLocation:evil", "/auth/jira", "/api/jira/import"]) assert.equal(safeReturnTo(unsafe), "/");
  });

  await check("missing config is typed and never calls remote", async () => {
    const h = harness({ missingConfig: true });
    const status = await h.request("GET", "/api/jira/status");
    assert.equal(status.body.configured, false);
    assert.equal(status.body.connected, false);
    assert.equal(Object.hasOwn(status.body, "loginUrl"), false);
    const imported = await h.request("POST", "/api/jira/import", { date: "2026-11-11" });
    assert.equal(imported.status, 503);
    assert.equal(imported.body.code, "jira_not_configured");
    assert.equal(h.calls.length, 0);
  });

  await check("unauthenticated import is typed 401", async () => {
    const h = harness();
    const imported = await h.request("POST", "/api/jira/import", { date: "2026-11-11" });
    assert.equal(imported.status, 401);
    assert.equal(imported.body.code, "jira_auth_required");
    assert.equal(h.calls.length, 0);
  });

  await check("OAuth start canonicalizes host before session state", async () => {
    const h = harness();
    const out = await h.request("GET", "/auth/jira?returnTo=%2F%3Fdraft%3Dabc", undefined, { headers: { host: "localhost:4173" } });
    assert.ok(out.headers.location.startsWith("http://127.0.0.1:4173/auth/jira?"));
    assert.equal(new URL(out.headers.location).searchParams.get("returnTo"), "/?draft=abc");
    assert.equal(h.sessions.size, 0);
    assert.equal(h.states.size, 0);
    assert.equal(out.headers["set-cookie"], undefined);
  });

  await check("OAuth flow rotates HttpOnly cookie and preserves draft", async () => {
    const h = harness();
    const started = await h.start();
    assert.match(started.response.headers["set-cookie"], /HttpOnly; SameSite=Lax/);
    assert.equal(started.response.headers["set-cookie"].includes("; Secure"), false);
    const authorize = new URL(started.response.headers.location);
    assert.equal(authorize.origin, "https://auth.atlassian.com");
    assert.equal(authorize.searchParams.get("redirect_uri"), DEFAULT_REDIRECT_URI);
    assert.equal(authorize.searchParams.get("scope"), "read:jira-work read:jira-user offline_access");
    const finished = await h.request("GET", "/auth/jira/callback?state=" + started.state + "&code=fixture-code");
    const back = new URL(finished.headers.location, h.origin);
    assert.equal(back.searchParams.get("draft"), "fixture-draft");
    assert.equal(back.searchParams.get("jira"), "connected");
    assert.notEqual(h.getCookie(), started.cookie);
    assert.equal(h.states.size, 0);
    const status = await h.request("GET", "/api/jira/status");
    assert.equal(status.body.connected, true);
    assert.equal(status.body.siteLabel, "tenant-alpha.atlassian.net");
    assert.equal((await h.request("GET", "/api/jira/status", undefined, { cookie: "" })).body.connected, false);
    const allOutput = JSON.stringify(h.replies);
    for (const secret of ["fixture-client-secret", "fixture-access-token", "fixture-refresh-token", "fixture-code"]) assert.equal(allOutput.includes(secret), false);
  });

  await check("HTTPS sessions set Secure", async () => {
    const h = harness({ redirect: "https://handoff.example.invalid/auth/jira/callback" });
    const started = await h.start();
    assert.match(started.response.headers["set-cookie"], /; Secure$/);
  });

  await check("expired OAuth state is not redeemed", async () => {
    const h = harness();
    const started = await h.start();
    h.advance(600001);
    const out = await h.request("GET", "/auth/jira/callback?state=" + started.state + "&code=fixture-code");
    assert.equal(out.status, 400);
    assert.equal(out.body.code, "jira_oauth_state_invalid");
    assert.equal(h.calls.length, 0);
  });

  await check("forged callback cookie cannot redeem state", async () => {
    const h = harness();
    const started = await h.start();
    const out = await h.request("GET", "/auth/jira/callback?state=" + started.state + "&code=fixture-code", undefined, { cookie: "handover_jira_sid=" + "99999999-9999-4999-8999-999999999999" });
    assert.equal(out.status, 400);
    assert.equal(h.calls.length, 0);
  });

  await check("OAuth state is single-use", async () => {
    const h = harness();
    const connected = await h.connect();
    const previousCalls = h.calls.length;
    const replay = await h.request("GET", "/auth/jira/callback?state=" + connected.initiated.state + "&code=fixture-code");
    assert.equal(replay.status, 400);
    assert.equal(h.calls.length, previousCalls);
  });

  await check("OAuth refusal redirects only safe error code", async () => {
    const h = harness();
    const started = await h.start("/?draft=keep-me");
    const out = await h.request("GET", "/auth/jira/callback?state=" + started.state + "&error=access_denied&error_description=unsafe-description");
    const back = new URL(out.headers.location, h.origin);
    assert.equal(back.searchParams.get("draft"), "keep-me");
    assert.equal(back.searchParams.get("jira_error"), "jira_oauth_denied");
    assert.equal(out.headers.location.includes("unsafe-description"), false);
    assert.equal(h.calls.length, 0);
  });

  await check("wrong authorized site never connects", async () => {
    const h = harness({ remote: (call) => call.url.endsWith("/accessible-resources") ? response([{ id: CLOUD_ID, url: "https://evil.atlassian.net", scopes: ["read:jira-work", "read:jira-user"] }]) : null });
    const started = await h.start();
    const out = await h.request("GET", "/auth/jira/callback?state=" + started.state + "&code=fixture-code");
    assert.equal(new URL(out.headers.location, h.origin).searchParams.get("jira_error"), "jira_site_not_authorized");
    assert.equal((await h.request("GET", "/api/jira/status")).body.connected, false);
  });

  await check("mutating routes reject cross-origin and missing Origin", async () => {
    const h = harness();
    await h.connect();
    const callsBefore = h.calls.length;
    for (const headers of [{ origin: "https://evil.invalid" }, { origin: undefined }, { host: "evil.invalid" }, { "content-type": "text/plain" }, { "sec-fetch-site": "cross-site" }]) {
      const out = await h.request("POST", "/api/jira/import", { date: "2026-11-11" }, { headers });
      assert.equal(out.status, 403);
      assert.equal(out.body.code, "jira_csrf_rejected");
    }
    assert.equal(h.calls.length, callsBefore);
  });

  await check("invalid dates and arbitrary query parameters rejected before search", async () => {
    const h = harness();
    await h.connect();
    const callsBefore = h.calls.length;
    for (const body of [{ date: "2026-02-30" }, { date: "2026-2-01" }, { date: "" }, { date: 123 }, { date: "2026-11-11", jql: "project=OTHER" }, { date: "2026-11-11", site: "https://evil.invalid" }]) {
      const out = await h.request("POST", "/api/jira/import", body);
      assert.equal(out.status, 400);
    }
    assert.equal(h.calls.length, callsBefore);
  });

  await check("enhanced pagination deduplicates IDs and pending wins", async () => {
    const h = harness({ remote: (call) => {
      if (!call.url.endsWith("/search/jql")) return null;
      assert.deepEqual(call.body.fields, ["key", "status", "summary"]);
      if (call.body.jql.includes("assignee = currentUser()")) {
        if (!call.body.nextPageToken) return response({ isLast: false, nextPageToken: "second", issues: [issue("OPS-1", "new"), issue("OPS-2", "indeterminate"), issue("OPS-1", "new")] });
        assert.equal(call.body.nextPageToken, "second");
        return response({ isLast: true, issues: [issue("OPS-3", "new"), issue("OPS-9", "done")] });
      }
      return response({ isLast: true, issues: [issue("OPS-2", "done"), issue("OPS-4", "done"), issue("OPS-4", "done"), issue("OPS-5", "new")] });
    } });
    await h.connect();
    const out = await h.request("POST", "/api/jira/import", { date: "2026-11-11" });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.pending, ["OPS-1", "OPS-2", "OPS-3"]);
    assert.deepEqual(out.body.finalized, ["OPS-4"]);
    assert.equal(out.body.timezone, "jira-profile");
    assert.equal(Object.keys(out.body.titles).length, 4);
    assert.equal(out.body.titles["OPS-4"], "fixture-summary-not-for-output");
    assert.equal(Object.hasOwn(out.body.titles, "OPS-9"), false);
    assert.deepEqual(Object.keys(out.body).sort(), ["date", "fetchedAt", "filterLabel", "finalized", "pending", "titles", "timezone"].sort());
  });

  await check("one failed half returns no partial import", async () => {
    const h = harness({ remote: (call) => call.url.endsWith("/search/jql") ? (call.body.jql.includes("assignee") ? response({ issues: [issue("OPS-1", "new")], isLast: true }) : response({}, 403)) : null });
    await h.connect();
    const out = await h.request("POST", "/api/jira/import", { date: "2026-11-11" });
    assert.equal(out.status, 403);
    assert.equal(out.body.code, "jira_forbidden");
    assert.equal(Object.hasOwn(out.body, "pending"), false);
    assert.equal(Object.hasOwn(out.body, "finalized"), false);
  });

  await check("repeated pagination token aborts without partial list", async () => {
    const h = harness({ remote: (call) => call.url.endsWith("/search/jql") ? response({ issues: [], isLast: false, nextPageToken: "same-token" }) : null });
    await h.connect();
    const out = await h.request("POST", "/api/jira/import", { date: "2026-11-11" });
    assert.equal(out.status, 503);
    assert.equal(Object.hasOwn(out.body, "pending"), false);
  });

  await check("missing category rejects malformed upstream page", async () => {
    const h = harness({ remote: (call) => call.url.endsWith("/search/jql") ? response({ issues: [{ key: "OPS-1", fields: {} }], isLast: true }) : null });
    await h.connect();
    assert.equal((await h.request("POST", "/api/jira/import", { date: "2026-11-11" })).status, 503);
  });

  await check("unfinished page without token is rejected", async () => {
    const h = harness({ remote: (call) => call.url.endsWith("/search/jql") ? response({ issues: [], isLast: false }) : null });
    await h.connect();
    assert.equal((await h.request("POST", "/api/jira/import", { date: "2026-11-11" })).status, 503);
  });

  await check("total result guard rejects oversized import", async () => {
    const issues = Array.from({ length: 10001 }, (_, i) => issue("OPS-" + (i + 1), "new"));
    const h = harness({ remote: (call) => call.url.endsWith("/search/jql") ? response({ issues, isLast: true }) : null });
    await h.connect();
    const out = await h.request("POST", "/api/jira/import", { date: "2026-11-11" });
    assert.equal(out.status, 503);
    assert.equal(out.body.code, "jira_result_limit");
  });

  for (const [status, expectedCode, expectedStatus] of [[401, "jira_auth_required", 401], [403, "jira_forbidden", 403], [429, "jira_rate_limited", 429], [500, "jira_upstream_unavailable", 503]]) {
    await check("upstream status " + status + " is mapped safely", async () => {
      const h = harness({ remote: (call) => call.url.endsWith("/search/jql") ? response({}, status, "30") : null });
      await h.connect();
      const out = await h.request("POST", "/api/jira/import", { date: "2026-11-11" });
      assert.equal(out.status, expectedStatus);
      assert.equal(out.body.code, expectedCode);
      if (status === 429) { assert.equal(out.body.retryAfter, 30); assert.equal(out.headers["retry-after"], "30"); }
      if (status === 401) assert.equal((await h.request("GET", "/api/jira/status")).body.connected, false);
      if (status === 403) assert.equal((await h.request("GET", "/api/jira/status")).body.connected, true);
    });
  }

  await check("transport timeout is a safe read failure", async () => {
    const h = harness({ remote: (call) => { if (call.url.endsWith("/search/jql")) throw Object.assign(new Error("private upstream text"), { name: "TimeoutError" }); return null; } });
    await h.connect();
    const out = await h.request("POST", "/api/jira/import", { date: "2026-11-11" });
    assert.equal(out.status, 503);
    assert.equal(out.body.code, "jira_upstream_unavailable");
    assert.equal(out.raw.includes("private upstream text"), false);
  });

  await check("refresh mutex rotates tokens once per expired session", async () => {
    const refreshes = [];
    const h = harness({ remote: async (call) => {
      if (call.url.endsWith("/oauth/token") && call.body.grant_type === "refresh_token") {
        refreshes.push(call.body.refresh_token);
        await new Promise(setImmediate);
        return response({ access_token: "fixture-new-access-" + refreshes.length, refresh_token: "fixture-rotated-" + refreshes.length, expires_in: 3600 });
      }
      return null;
    } });
    await h.connect();
    h.advance(3600000);
    assert.equal((await h.request("POST", "/api/jira/import", { date: "2026-11-11" })).status, 200);
    assert.deepEqual(refreshes, ["fixture-refresh-token"]);
    h.advance(3600000);
    assert.equal((await h.request("POST", "/api/jira/import", { date: "2026-11-11" })).status, 200);
    assert.deepEqual(refreshes, ["fixture-refresh-token", "fixture-rotated-1"]);
    assert.equal(JSON.stringify(h.replies).includes("fixture-rotated"), false);
  });

  await check("revoked refresh requires reconnect", async () => {
    const h = harness({ remote: (call) => call.url.endsWith("/oauth/token") && call.body.grant_type === "refresh_token" ? response({}, 400) : null });
    await h.connect();
    h.advance(3600000);
    const out = await h.request("POST", "/api/jira/import", { date: "2026-11-11" });
    assert.equal(out.status, 401);
    assert.equal(out.body.code, "jira_auth_required");
    assert.equal((await h.request("GET", "/api/jira/status")).body.connected, false);
  });

  await check("disconnect removes local authentication without remote writes", async () => {
    const h = harness();
    await h.connect();
    const count = h.calls.length;
    const out = await h.request("POST", "/api/jira/disconnect", {});
    assert.equal(out.status, 200);
    assert.equal(out.body.connected, false);
    assert.match(out.headers["set-cookie"], /Max-Age=0/);
    assert.equal(h.calls.length, count);
    assert.equal((await h.request("POST", "/api/jira/import", { date: "2026-11-11" })).status, 401);
  });

  await check("all mocked remote operations are OAuth or Jira read searches", () => {
    for (const call of allRemoteCalls) {
      assert.ok(
        (call.url === "https://auth.atlassian.com/oauth/token" && call.init.method === "POST") ||
        (call.url === "https://api.atlassian.com/oauth/token/accessible-resources" && call.init.method === "GET") ||
        (call.url === "https://api.atlassian.com/ex/jira/" + CLOUD_ID + "/rest/api/3/search/jql" && call.init.method === "POST")
      );
      assert.equal(call.url.includes("/issue/"), false);
    }
  });
  console.log(checks.length + " Jira OAuth/read-only checks passed; all remote responses mocked, no credentials or real issues accessed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
