"use strict";

const crypto = require("node:crypto");
const { readAppConfig } = require("./app-config");

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:4173/auth/jira/callback";
const COOKIE_NAME = "handover_jira_sid";
const STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_DAYS = 30;
const SESSION_TOUCH_INTERVAL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED_SCOPES = ["read:jira-work", "read:jira-user"];
const SCOPES = [...REQUIRED_SCOPES, "offline_access"];
const MAX_PAGES = 100;
const MAX_ISSUES = 10000;

function jiraError(status, code, message, details = {}) {
  return Object.assign(new Error(message), { status, code }, details);
}

function isRealDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function nextCalendarDay(value) {
  if (!isRealDate(value)) throw jiraError(400, "jira_invalid_date", "Escolha uma data válida para importar os chamados.");
  let [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < days) day++;
  else { day = 1; if (month < 12) month++; else { month = 1; year++; } }
  if (year > 9999) throw jiraError(400, "jira_invalid_date", "A data está fora do intervalo consultável no Jira.");
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

function buildImportJql(date, appConfig = readAppConfig()) {
  const next = nextCalendarDay(date);
  const base = "(\n" + appConfig.baseJql + "\n)";
  return {
    pending: base + "\nAND (assignee = currentUser() AND statusCategory != Done)",
    finalized: base + "\nAND (\n  statusCategory = Done\n  AND resolution IS NOT EMPTY\n  AND resolutiondate >= \"" + date + "\"\n  AND resolutiondate < \"" + next + "\"\n  AND resolution CHANGED BY currentUser() DURING (\"" + date + " 00:00\", \"" + next + " 00:00\")\n)",
  };
}

function safeReturnTo(value) {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(value) || /%(?:0a|0d|5c)/i.test(value)) return "/";
  try {
    const url = new URL(value, "http://return.invalid");
    const decodedPath = decodeURIComponent(url.pathname);
    if (url.origin !== "http://return.invalid" || decodedPath.startsWith("//") || decodedPath.includes("\\") || /^\/(?:auth|api)(?:\/|$)/.test(decodedPath)) return "/";
    return url.pathname + url.search;
  } catch { return "/"; }
}

function runtimeConfig(env, appConfig) {
  const clientId = typeof env.JIRA_CLIENT_ID === "string" ? env.JIRA_CLIENT_ID.trim() : "";
  const clientSecret = typeof env.JIRA_CLIENT_SECRET === "string" ? env.JIRA_CLIENT_SECRET.trim() : "";
  let redirect;
  let validRedirect = true;
  try {
    let defaultRedirect = DEFAULT_REDIRECT_URI;
    if (env.APP_ORIGIN) {
      const origin = new URL(env.APP_ORIGIN);
      if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("invalid origin");
      defaultRedirect = origin.origin + "/auth/jira/callback";
    } else if (env.PORT) {
      const port = String(env.PORT);
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("invalid port");
      defaultRedirect = "http://127.0.0.1:" + Number(port) + "/auth/jira/callback";
    }
    redirect = new URL(env.JIRA_REDIRECT_URI || defaultRedirect);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
    if (redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== "/auth/jira/callback" || !(redirect.protocol === "https:" || (redirect.protocol === "http:" && local))) validRedirect = false;
  } catch { validRedirect = false; }
  if (!validRedirect) redirect = new URL(DEFAULT_REDIRECT_URI);
  return {
    clientId,
    clientSecret,
    redirect,
    configured: Boolean(validRedirect && appConfig.siteUrl && clientId && clientSecret),
  };
}

function createJiraIntegration(options = {}) {
  const env = options.env || process.env;
  const appConfig = readAppConfig(env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const makeSid = options.randomUUID || (() => crypto.randomUUID());
  const makeState = options.randomState || (() => crypto.randomBytes(32).toString("base64url"));
  const sessions = options.sessions || new Map();
  const states = options.states || new Map();
  const signalForTimeout = options.signalForTimeout || ((milliseconds) => AbortSignal.timeout(milliseconds));
  const config = runtimeConfig(env, appConfig);
  const days = String(env.JIRA_SESSION_DAYS || DEFAULT_SESSION_DAYS);
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 90) throw jiraError(503, "jira_session_configuration_invalid", "JIRA_SESSION_DAYS deve ser um inteiro entre 1 e 90.");
  const sessionTtlMs = Number(days) * 24 * 60 * 60 * 1000;
  const dormant = new Map();
  let sessionStore = options.sessionStore || null;
  const useDefaultStore = !Object.hasOwn(options, "sessions") && !Object.hasOwn(options, "sessionStore");
  let storeLoaded = false;
  let storeFailure;

  const hashSid = (id) => crypto.createHash("sha256").update("shift-handover:session:" + id).digest("hex");

  function storageError() {
    return jiraError(503, "jira_session_store_unavailable", "Não foi possível manter a conexão Jira no armazenamento protegido. Confira o servidor e conecte novamente.");
  }

  function persistSessions() {
    if (storeFailure) throw storeFailure;
    if (!sessionStore) return;
    const records = new Map(dormant);
    for (const session of sessions.values()) {
      if (session.accessToken && session.cloudId) records.set(hashSid(session.id), {
        sidHash: hashSid(session.id), accessToken: session.accessToken,
        refreshToken: session.refreshToken || null, expiresAt: session.expiresAt,
        cloudId: session.cloudId, lastSeenAt: session.lastSeenAt,
      });
    }
    try {
      sessionStore.save([...records.values()]);
      for (const session of sessions.values()) session.lastPersistedAt = session.lastSeenAt;
    } catch {
      storeFailure = storageError();
      throw storeFailure;
    }
  }

  function ensureStore() {
    if (storeFailure) throw storeFailure;
    if (storeLoaded || !config.configured) return;
    try {
      if (useDefaultStore) sessionStore = require("./jira-session-store").createJiraSessionStore({ env,
        binding: crypto.createHash("sha256").update(config.clientId + "\n" + config.redirect.href + "\n" + appConfig.siteUrl + "\n" + appConfig.projectKey).digest("hex"),
      });
      const records = sessionStore ? sessionStore.load() : [];
      for (const record of records) if (record.lastSeenAt + sessionTtlMs > now()) dormant.set(record.sidHash, record);
      storeLoaded = true;
      if (dormant.size !== records.length) persistSessions();
    } catch {
      storeFailure = storageError();
      throw storeFailure;
    }
  }

  function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(body));
  }

  function redirect(res, location) {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.end();
  }

  function cookie(res, sid, expire = false, ttl = sessionTtlMs) {
    const secure = config.redirect.protocol === "https:" ? "; Secure" : "";
    res.setHeader("Set-Cookie", COOKIE_NAME + "=" + (expire ? "" : sid) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (expire ? "0" : String(ttl / 1000)) + secure);
  }

  function clearAuth(session) {
    session.accessToken = null;
    session.refreshToken = null;
    session.expiresAt = 0;
    session.cloudId = null;
  }

  function cleanup() {
    let removed = false;
    for (const [state, pending] of states) if (pending.expiresAt <= now()) states.delete(state);
    for (const [sid, session] of sessions) {
      if (session.lastSeenAt + (session.accessToken ? sessionTtlMs : STATE_TTL_MS) <= now()) {
        if (session.oauthState) states.delete(session.oauthState);
        sessions.delete(sid);
        if (session.accessToken) removed = true;
      }
    }
    for (const [key, record] of dormant) if (record.lastSeenAt + sessionTtlMs <= now()) { dormant.delete(key); removed = true; }
    if (removed) persistSessions();
  }

  function sessionFromRequest(req, res) {
    const cookies = String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(COOKIE_NAME + "="));
    if (cookies.length !== 1) return null;
    const sid = cookies[0].slice(COOKIE_NAME.length + 1);
    if (!UUID.test(sid)) return null;
    let session = sessions.get(sid);
    if (!session) {
      const key = hashSid(sid);
      const record = dormant.get(key);
      if (record && record.lastSeenAt + sessionTtlMs > now()) {
        session = { ...record, id: sid, lastPersistedAt: record.lastSeenAt };
        sessions.set(sid, session);
        dormant.delete(key);
      }
    }
    if (!session) return null;
    session.lastSeenAt = now();
    if (session.accessToken && session.cloudId) {
      if (res) cookie(res, sid);
      if ((session.lastPersistedAt || 0) + SESSION_TOUCH_INTERVAL_MS <= now()) persistSessions();
    }
    return session;
  }

  function ensureConfigured() {
    if (!config.configured) throw jiraError(503, "jira_not_configured", "A integração Jira ainda precisa ser configurada no servidor.");
  }

  function correctHost(req) {
    return String(req.headers.host || "").toLowerCase() === config.redirect.host.toLowerCase();
  }

  function guardMutation(req) {
    if (!correctHost(req) || req.headers.origin !== config.redirect.origin || !/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
      throw jiraError(403, "jira_csrf_rejected", "A solicitação precisa partir desta aplicação.");
    }
    if (req.headers["sec-fetch-site"] === "cross-site") throw jiraError(403, "jira_csrf_rejected", "A solicitação precisa partir desta aplicação.");
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 4096) throw jiraError(413, "jira_invalid_request", "A solicitação Jira ficou grande demais.");
      chunks.push(Buffer.from(chunk));
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      return body;
    } catch { throw jiraError(400, "jira_invalid_request", "Não foi possível ler a solicitação Jira."); }
  }

  function assertActive(session) {
    if (!session || sessions.get(session.id) !== session || !session.accessToken || !session.cloudId) {
      throw jiraError(401, "jira_auth_required", "Conecte sua conta Jira para importar os chamados.", { loginUrl: "/auth/jira" });
    }
  }

  async function requestJson(url, init, stage, session) {
    const method = init.method || "GET";
    const allowed = (url === TOKEN_URL && method === "POST") ||
      (url === RESOURCES_URL && method === "GET") ||
      (/^https:\/\/api\.atlassian\.com\/ex\/jira\/[0-9a-f-]{36}\/rest\/api\/3\/search\/jql$/i.test(url) && method === "POST");
    if (!allowed) throw jiraError(500, "jira_read_only_guard", "A operação não faz parte da integração de leitura.");
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: "error", signal: signalForTimeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw jiraError(503, "jira_upstream_unavailable", "O Jira não respondeu a tempo. Tente importar novamente mais tarde.");
    }
    if (!response.ok) {
      if (response.status === 401 || (stage === "token" && response.status === 400)) {
        if (session) { clearAuth(session); persistSessions(); }
        throw jiraError(401, "jira_auth_required", "A autorização Jira expirou ou foi revogada. Conecte sua conta novamente.", { loginUrl: "/auth/jira" });
      }
      if (response.status === 403) throw jiraError(403, "jira_forbidden", "Sua conta ou o aplicativo não tem permissão para consultar este filtro.");
      if (response.status === 429) {
        const retryAfter = Number(response.headers && response.headers.get("retry-after"));
        throw jiraError(429, "jira_rate_limited", "O limite de consultas do Jira foi atingido. Aguarde antes de importar novamente.", Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter: Math.min(Math.ceil(retryAfter), 3600) } : {});
      }
      if (response.status >= 500) throw jiraError(503, "jira_upstream_unavailable", "O Jira está temporariamente indisponível.");
      throw jiraError(502, "jira_query_failed", "O Jira recusou a consulta configurada. Peça ao responsável pela integração para revisar o filtro.");
    }
    try { return await response.json(); }
    catch { throw jiraError(503, "jira_upstream_unavailable", "O Jira retornou uma resposta que não pôde ser lida."); }
  }

  function tokenValues(body, previousRefreshToken) {
    const validToken = (value) => typeof value === "string" && value.length > 0 && value.length < 20000 && !/[\r\n]/.test(value);
    if (!body || !validToken(body.access_token) || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw jiraError(503, "jira_oauth_failed", "A autorização Jira não retornou credenciais válidas para o servidor.");
    if (body.refresh_token !== undefined && !validToken(body.refresh_token)) throw jiraError(503, "jira_oauth_failed", "A autorização Jira não retornou credenciais válidas para o servidor.");
    return { accessToken: body.access_token, refreshToken: body.refresh_token || previousRefreshToken || null, expiresAt: now() + Math.min(body.expires_in, 604800) * 1000 };
  }

  async function ensureAccessToken(session) {
    assertActive(session);
    if (session.expiresAt - now() > 60000) return session.accessToken;
    if (!session.refreshToken) {
      clearAuth(session);
      persistSessions();
      throw jiraError(401, "jira_auth_required", "Conecte sua conta Jira novamente.", { loginUrl: "/auth/jira" });
    }
    if (!session.refreshPromise) {
      session.refreshPromise = (async () => {
        const body = await requestJson(TOKEN_URL, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: config.clientId, client_secret: config.clientSecret, refresh_token: session.refreshToken }),
        }, "token", session);
        if (!body || typeof body.refresh_token !== "string" || !body.refresh_token) {
          clearAuth(session);
          persistSessions();
          throw jiraError(401, "jira_auth_required", "Conecte sua conta Jira novamente.", { loginUrl: "/auth/jira" });
        }
        const values = tokenValues(body);
        if (sessions.get(session.id) !== session) throw jiraError(401, "jira_auth_required", "Conecte sua conta Jira novamente.", { loginUrl: "/auth/jira" });
        Object.assign(session, values);
        try { persistSessions(); }
        catch (error) { clearAuth(session); throw error; }
        return session.accessToken;
      })().finally(() => { session.refreshPromise = null; });
    }
    return session.refreshPromise;
  }

  async function searchAll(session, jql, kind) {
    const keys = new Set();
    const seenTokens = new Set();
    let nextPageToken;
    let total = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const accessToken = await ensureAccessToken(session);
      const requestBody = { jql, fields: ["key", "status"], maxResults: 100 };
      if (nextPageToken) requestBody.nextPageToken = nextPageToken;
      const body = await requestJson("https://api.atlassian.com/ex/jira/" + session.cloudId + "/rest/api/3/search/jql", {
        method: "POST",
        headers: { Authorization: "Bearer " + accessToken, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      }, "search", session);
      assertActive(session);
      if (!body || !Array.isArray(body.issues)) throw jiraError(503, "jira_upstream_unavailable", "O Jira retornou uma página inválida de chamados.");
      total += body.issues.length;
      if (total > MAX_ISSUES) throw jiraError(503, "jira_result_limit", "O filtro retornou chamados demais para uma importação segura.");
      for (const issue of body.issues) {
        const category = issue && issue.fields && issue.fields.status && issue.fields.status.statusCategory && issue.fields.status.statusCategory.key;
        if (!issue || typeof issue.key !== "string" || !appConfig.ticketPattern.test(issue.key) || typeof category !== "string" || !category) throw jiraError(503, "jira_upstream_unavailable", "O Jira retornou um chamado fora do projeto configurado ou sem categoria válida.");
        const done = category.toLowerCase() === "done";
        if ((kind === "pending" && !done) || (kind === "finalized" && done)) keys.add(issue.key);
      }
      if (body.isLast === true) return keys;
      if (body.nextPageToken !== undefined && body.nextPageToken !== null && typeof body.nextPageToken !== "string") throw jiraError(503, "jira_upstream_unavailable", "A paginação do Jira não pôde ser concluída.");
      if (!body.nextPageToken) {
        if (body.isLast === false) throw jiraError(503, "jira_upstream_unavailable", "A paginação do Jira não pôde ser concluída.");
        return keys;
      }
      if (body.nextPageToken.length > 10000 || seenTokens.has(body.nextPageToken)) throw jiraError(503, "jira_upstream_unavailable", "O Jira repetiu uma página. Nenhuma lista parcial foi importada.");
      seenTokens.add(body.nextPageToken);
      nextPageToken = body.nextPageToken;
    }
    throw jiraError(503, "jira_result_limit", "O limite de páginas do Jira foi atingido. Nenhuma lista parcial foi importada.");
  }

  function callbackReturn(res, returnTo, code) {
    const target = new URL(safeReturnTo(returnTo), config.redirect.origin);
    target.searchParams.set("jira", code ? "error" : "connected");
    if (code) target.searchParams.set("jira_error", code);
    else target.searchParams.delete("jira_error");
    redirect(res, target.pathname + target.search);
  }

  async function beginAuthorization(req, res, url) {
    ensureConfigured();
    const returnTo = safeReturnTo(url.searchParams.get("returnTo") || "/");
    if (!correctHost(req)) {
      const canonical = new URL("/auth/jira", config.redirect.origin);
      canonical.searchParams.set("returnTo", returnTo);
      redirect(res, canonical.href);
      return;
    }
    let session = sessionFromRequest(req, res);
    if (!session) {
      const sid = makeSid();
      if (!UUID.test(sid)) throw jiraError(500, "jira_session_failed", "Não foi possível iniciar uma sessão segura.");
      session = { id: sid, lastSeenAt: now() };
      sessions.set(sid, session);
    }
    if (session.oauthState) states.delete(session.oauthState);
    const state = makeState();
    if (typeof state !== "string" || state.length < 32 || state.length > 200) throw jiraError(500, "jira_session_failed", "Não foi possível iniciar uma sessão segura.");
    session.oauthState = state;
    states.set(state, { value: state, sid: session.id, returnTo, expiresAt: now() + STATE_TTL_MS });
    cookie(res, session.id, false, session.accessToken ? sessionTtlMs : STATE_TTL_MS);
    const authorize = new URL(AUTHORIZE_URL);
    authorize.search = new URLSearchParams({ audience: "api.atlassian.com", client_id: config.clientId, scope: SCOPES.join(" "), redirect_uri: config.redirect.href, state, response_type: "code", prompt: "consent" }).toString();
    redirect(res, authorize.href);
  }

  async function finishAuthorization(req, res, url) {
    ensureConfigured();
    if (!correctHost(req)) throw jiraError(400, "jira_oauth_state_invalid", "A autorização precisa voltar ao mesmo endereço da aplicação.");
    const state = url.searchParams.get("state");
    const session = sessionFromRequest(req, res);
    const pending = state && states.get(state);
    if (url.searchParams.getAll("state").length !== 1 || !session || !pending || pending.sid !== session.id || pending.expiresAt <= now() || session.oauthState !== state) throw jiraError(400, "jira_oauth_state_invalid", "Esta autorização expirou ou não pertence a esta sessão. Inicie a conexão novamente.");
    states.delete(state);
    session.oauthState = null;
    clearAuth(session);
    persistSessions();
    if (url.searchParams.has("error")) { callbackReturn(res, pending.returnTo, "jira_oauth_denied"); return; }
    const code = url.searchParams.get("code");
    if (url.searchParams.getAll("code").length !== 1 || !code || code.length > 10000) { callbackReturn(res, pending.returnTo, "jira_oauth_failed"); return; }
    try {
      const tokens = await requestJson(TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.redirect.href }),
      }, "token", session);
      const values = tokenValues(tokens);
      const resources = await requestJson(RESOURCES_URL, { method: "GET", headers: { Authorization: "Bearer " + values.accessToken, Accept: "application/json" } }, "resources", session);
      if (!Array.isArray(resources)) throw jiraError(503, "jira_oauth_failed", "Não foi possível confirmar o site Jira autorizado.");
      const resource = resources.find((item) => {
        try { const site = new URL(item.url); return site.origin === appConfig.siteUrl && site.pathname === "/" && !site.search && !site.hash && !site.username && !site.password; }
        catch { return false; }
      });
      if (!resource || typeof resource.id !== "string" || !UUID.test(resource.id) || !Array.isArray(resource.scopes) || REQUIRED_SCOPES.some((scope) => !resource.scopes.includes(scope))) throw jiraError(403, "jira_site_not_authorized", "Autorize o site Jira configurado com as permissões de leitura solicitadas.");
      if (sessions.get(session.id) !== session) throw jiraError(401, "jira_auth_required", "A sessão foi desconectada. Inicie a conexão novamente.");
      const previousId = session.id;
      const nextId = makeSid();
      if (!UUID.test(nextId)) throw jiraError(500, "jira_session_failed", "Não foi possível concluir uma sessão segura.");
      Object.assign(session, values, { id: nextId, cloudId: resource.id, lastSeenAt: now() });
      sessions.delete(previousId);
      sessions.set(nextId, session);
      persistSessions();
      cookie(res, nextId);
      callbackReturn(res, pending.returnTo, null);
    } catch (error) {
      clearAuth(session);
      cookie(res, "", true);
      if (!storeFailure) persistSessions();
      callbackReturn(res, pending.returnTo, error.code || "jira_oauth_failed");
    }
  }

  async function handle(req, res, url) {
    if (!(url.pathname === "/auth/jira" || url.pathname.startsWith("/auth/jira/") || url.pathname.startsWith("/api/jira/"))) return false;
    try {
      ensureStore();
      cleanup();
      if (req.method === "GET" && url.pathname === "/api/jira/status") {
        const session = sessionFromRequest(req, res);
        const result = { configured: config.configured, connected: Boolean(config.configured && session && session.accessToken && session.cloudId), filterLabel: appConfig.filterLabel, siteLabel: appConfig.siteLabel, timezone: "jira-profile" };
        if (config.configured) result.loginUrl = "/auth/jira";
        if (result.connected) result.connectionKey = crypto.createHash("sha256").update("shift-handover:draft:" + session.id).digest("hex");
        json(res, 200, result);
      } else if (req.method === "GET" && url.pathname === "/auth/jira") {
        await beginAuthorization(req, res, url);
      } else if (req.method === "GET" && url.pathname === "/auth/jira/callback") {
        await finishAuthorization(req, res, url);
      } else if (req.method === "POST" && url.pathname === "/api/jira/disconnect") {
        guardMutation(req);
        const body = await readBody(req);
        if (Object.keys(body).length) throw jiraError(400, "jira_invalid_request", "A desconexão não aceita parâmetros.");
        const session = sessionFromRequest(req, res);
        if (session) {
          if (session.oauthState) states.delete(session.oauthState);
          clearAuth(session);
          sessions.delete(session.id);
        }
        cookie(res, "", true);
        persistSessions();
        json(res, 200, { connected: false });
      } else if (req.method === "POST" && url.pathname === "/api/jira/import") {
        ensureConfigured();
        guardMutation(req);
        const session = sessionFromRequest(req, res);
        assertActive(session);
        const body = await readBody(req);
        if (Object.keys(body).some((key) => key !== "date")) throw jiraError(400, "jira_invalid_request", "A importação aceita somente a data da passagem.");
        const queries = buildImportJql(body.date, appConfig);
        const [pendingSet, finalizedSet] = await Promise.all([searchAll(session, queries.pending, "pending"), searchAll(session, queries.finalized, "finalized")]);
        assertActive(session);
        for (const key of pendingSet) finalizedSet.delete(key);
        if (pendingSet.size + finalizedSet.size > MAX_ISSUES) throw jiraError(503, "jira_result_limit", "O filtro retornou chamados demais para uma importação segura.");
        const sortKeys = (keys) => [...keys].sort((a, b) => Number(a.slice(appConfig.ticketPrefix.length + 1)) - Number(b.slice(appConfig.ticketPrefix.length + 1)));
        json(res, 200, { finalized: sortKeys(finalizedSet), pending: sortKeys(pendingSet), date: body.date, filterLabel: appConfig.filterLabel, fetchedAt: new Date(now()).toISOString(), timezone: "jira-profile" });
      } else {
        json(res, 405, { code: "jira_method_not_allowed", error: "Esta rota não aceita a operação solicitada." });
      }
    } catch (error) {
      if (error.code === "jira_auth_required" || error.code === "jira_session_store_unavailable") cookie(res, "", true);
      const body = { code: error.code || "jira_upstream_unavailable", error: error.status ? error.message : "A integração Jira está temporariamente indisponível." };
      if (error.loginUrl) body.loginUrl = error.loginUrl;
      if (error.retryAfter) { body.retryAfter = error.retryAfter; res.setHeader("Retry-After", String(error.retryAfter)); }
      json(res, error.status || 503, body);
    }
    return true;
  }

  return { handle };
}

module.exports = { createJiraIntegration, buildImportJql, isRealDate, nextCalendarDay, safeReturnTo, DEFAULT_REDIRECT_URI };
