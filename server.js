const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { readAppConfig, getPublicConfig } = require("./app-config");
const appConfig = readAppConfig();

const HOST = (process.env.HOST || "127.0.0.1").trim().toLowerCase();
const portText = String(process.env.PORT || "4173");
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error("PORT deve ser um inteiro entre 1 e 65535.");
const PORT = Number(portText);
if (HOST !== "localhost" && !net.isIP(HOST)) throw new Error("HOST deve ser localhost ou um endereço IP válido.");
const LOOPBACK = ["localhost", "127.0.0.1", "::1"].includes(HOST);
let appOrigin;
if (process.env.APP_ORIGIN) {
  try {
    appOrigin = new URL(process.env.APP_ORIGIN);
    const localOrigin = ["localhost", "127.0.0.1", "[::1]"].includes(appOrigin.hostname);
    if (appOrigin.username || appOrigin.password || appOrigin.search || appOrigin.hash || appOrigin.pathname !== "/" || !(appOrigin.protocol === "https:" || (LOOPBACK && localOrigin && appOrigin.protocol === "http:" && Number(appOrigin.port || 80) === PORT))) throw new Error("invalid");
  } catch { throw new Error("APP_ORIGIN deve ser a origem HTTPS da aplicação, ou HTTP local na mesma porta."); }
}
if (!LOOPBACK && (process.env.NODE_ENV !== "production" || !appOrigin || appOrigin.protocol !== "https:")) throw new Error("Um bind compartilhado exige NODE_ENV=production e APP_ORIGIN HTTPS explícito.");
const allowedHosts = new Set(appOrigin ? [appOrigin.host.toLowerCase()] : []);
const allowedOrigins = new Set(appOrigin ? [appOrigin.origin] : []);
if (LOOPBACK) {
  for (const hostname of ["127.0.0.1", "localhost", ...(HOST === "::1" ? ["[::1]"] : [])]) {
    allowedHosts.add(hostname + ":" + PORT);
    allowedOrigins.add("http://" + hostname + ":" + PORT);
  }
}
const PUBLIC_DIR = path.join(__dirname, "public");
if (process.env.HANDOFF_DATA_DIR && !path.isAbsolute(process.env.HANDOFF_DATA_DIR)) throw new Error("HANDOFF_DATA_DIR deve ser um caminho absoluto.");
const DATA_DIR = process.env.HANDOFF_DATA_DIR ? path.resolve(process.env.HANDOFF_DATA_DIR) : path.join(__dirname, "data");
const publicLocation = path.resolve(PUBLIC_DIR).toLowerCase();
const dataLocation = DATA_DIR.toLowerCase();
if (dataLocation === publicLocation || dataLocation.startsWith(publicLocation + path.sep)) throw new Error("HANDOFF_DATA_DIR deve ficar fora do diretório público.");
const HANDOFFS_FILE = path.join(DATA_DIR, "handoffs.json");
const MAX_BODY_BYTES = 512 * 1024;
const MAX_CHAT_BYTES = 30000;
const CHAT_REQUEST_TIMEOUT_MS = 15000;
const HANDOFF_TEXT_FIELDS = {
  responsavel: "Responsável",
  turno: "Turno",
  data: "Data",
  estadoGeral: "Estado geral",
  quantidadeServida: "Quantidade servida",
  chamadosResolvidos: "Chamados resolvidos",
  chamadosPendentes: "Chamados pendentes / em aberto",
  atualizacaoHH: "Atualizações técnicas",
  servicosAcompanhados: "Serviços / processos acompanhados",
  principaisAtividades: "Principais atividades executadas",
  instabilidade: "Instabilidade do sistema / infraestrutura",
  equipamentosImpactados: "Equipamentos afetados e situação",
  pontosAtencao: "Pontos de atenção",
  tarefasAgendadas: "Tarefas agendadas",
  proximosPassos: "Próximos passos dos chamados",
  responsavelProximaEtapa: "Responsável pelo próximo passo",
  comunicados: "Avisos e alterações em equipamentos",
};
let handoffWriteQueue = Promise.resolve();
let jiraIntegration;
let storageReady = false;
let shuttingDown = false;

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function allowJsonMutation(req) {
  return allowedOrigins.has(req.headers.origin)
    && /^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))
    && req.headers["sec-fetch-site"] !== "cross-site";
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("PAYLOAD_TOO_LARGE");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("INVALID_JSON");
    error.statusCode = 400;
    throw error;
  }
}

function isRealDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysPerMonth[month - 1];
}

function normalizeTicketList(value, label) {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error('Os "' + label + '" precisam ser enviados em uma lista.');
  }
  const tickets = (value || []).map((ticket) => {
    if (typeof ticket !== "string") {
      throw new Error("Cada chamado precisa ser enviado no formato " + appConfig.ticketPrefix + "-número.");
    }
    return ticket.trim().toUpperCase();
  }).filter(Boolean);
  if (tickets.some((ticket) => !appConfig.ticketPattern.test(ticket))) {
    throw new Error("Use o prefixo " + appConfig.ticketPrefix + "- seguido apenas pelos números do chamado.");
  }
  if (new Set(tickets).size !== tickets.length) {
    throw new Error('Remova os IDs duplicados em "' + label + '".');
  }
  return tickets;
}

function normalizeTicketTitles(value, ticketIds) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Os títulos dos chamados precisam ser enviados em um objeto por ID.");
  const allowed = new Set(ticketIds);
  const titles = {};
  const seen = new Set();
  for (const [rawId, rawTitle] of Object.entries(value)) {
    const id = rawId.trim().toUpperCase();
    if (!allowed.has(id) || seen.has(id)) throw new Error("Associe cada título a um chamado válido presente na ficha, sem repetir o ID.");
    seen.add(id);
    if (typeof rawTitle !== "string") throw new Error("O título do chamado precisa ser um texto de até 255 caracteres.");
    const title = rawTitle.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (title.length > 255) throw new Error("O título do chamado deve ter no máximo 255 caracteres.");
    if (title) titles[id] = title;
  }
  return titles;
}

function normalizeHandoffData(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Envie os dados do formulário em um objeto JSON.");
  }

  const finalized = normalizeTicketList(input.chamadosAtendidos, "Chamados finalizados");
  const pending = normalizeTicketList(input.chamadosPendentesIds, "Chamados pendentes");
  const finalizedIds = new Set(finalized);
  if (pending.some((ticket) => finalizedIds.has(ticket))) {
    throw new Error("Um chamado não pode estar nas listas de finalizados e pendentes ao mesmo tempo.");
  }
  const derivedCounts = {};
  if (options.deriveCounts !== false) {
    if (Object.hasOwn(input, "chamadosAtendidos")) derivedCounts.chamadosResolvidos = String(finalized.length);
    if (Object.hasOwn(input, "chamadosPendentesIds")) derivedCounts.chamadosPendentes = String(pending.length);
  }

  const data = {};
  for (const [field, label] of Object.entries(HANDOFF_TEXT_FIELDS)) {
    if (Object.hasOwn(derivedCounts, field)) {
      data[field] = derivedCounts[field];
      continue;
    }
    if (input[field] !== undefined && typeof input[field] !== "string") {
      throw new Error('O campo "' + label + '" precisa ser enviado como texto.');
    }
    data[field] = (input[field] || "").trim();
  }

  if (!options.draft && (!data.responsavel || !data.turno || !data.data)) {
    throw new Error("Preencha responsável, turno e data antes de enviar.");
  }
  if (data.data && !isRealDate(data.data)) {
    throw new Error("Informe uma data válida no formato AAAA-MM-DD.");
  }

  for (const field of ["chamadosResolvidos", "chamadosPendentes"]) {
    if (!data[field]) continue;
    const count = Number(data[field]);
    if (!/^\d+$/.test(data[field]) || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('O campo "' + HANDOFF_TEXT_FIELDS[field] + '" precisa ser um número inteiro igual ou maior que zero.');
    }
    data[field] = String(count);
  }

  data.chamadosAtendidos = finalized;
  data.chamadosPendentesIds = pending;
  data.chamadosTitulos = normalizeTicketTitles(input.chamadosTitulos, finalized.concat(pending));
  return data;
}

function valueOrDash(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "—";
}

function formatDate(value) {
  const parts = String(value || "").split("-");
  if (parts.length !== 3) return valueOrDash(value);
  return parts.reverse().join("/");
}

function buildChatMessage(data) {
  const line = (label, value) => "* " + label + ": " + valueOrDash(value);
  const section = (title, value) =>
    "*" + title + "*\n" + valueOrDash(value);
  const ticketTitle = (id) => {
    const value = data.chamadosTitulos && data.chamadosTitulos[id];
    return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
      .replace(/</g, "‹").replace(/>/g, "›").replace(/[\\*_~`]/g, "\\$&") : "";
  };
  const ticketLines = (tickets) => Array.isArray(tickets) && tickets.length
    ? tickets.map((ticket) => { const title = ticketTitle(ticket); return "• " + ticket + (title ? " — " + title : ""); }).join("\n")
    : "—";

  return [
    "*Passagem de turno registrada por " + valueOrDash(data.responsavel) + "*",
    "*Turno:* " + valueOrDash(data.turno) + "  •  *Data:* " + formatDate(data.data),
    "",
    "*Métricas do turno*",
    line("Estado geral", data.estadoGeral),
    line("Quantidade servida", data.quantidadeServida),
    line("Chamados resolvidos", data.chamadosResolvidos),
    line("Chamados pendentes / em aberto", data.chamadosPendentes),
    "",
    section("Chamados finalizados", ticketLines(data.chamadosAtendidos)),
    "",
    section("Chamados pendentes", ticketLines(data.chamadosPendentesIds)),
    "",
    section("Atualizações técnicas", data.atualizacaoHH),
    "",
    section("Serviços / processos acompanhados", data.servicosAcompanhados),
    "",
    section("Principais atividades executadas", data.principaisAtividades),
    "",
    "*Intercorrências operacionais*",
    line("Instabilidade do sistema / infraestrutura", data.instabilidade),
    line("Equipamentos afetados e situação", data.equipamentosImpactados),
    line("Pontos de atenção", data.pontosAtencao),
    "",
    "*Pendências e acompanhamento da próxima etapa*",
    line("Tarefas agendadas", data.tarefasAgendadas),
    line("Próximos passos dos chamados", data.proximosPassos),
    line("Responsável pelo próximo passo", data.responsavelProximaEtapa),
    "",
    "*Comunicações gerais*",
    line("Avisos e alterações em equipamentos", data.comunicados),
  ].join("\n");
}

async function readStoredHandoffs() {
  try {
    const contents = await fs.promises.readFile(HANDOFFS_FILE, "utf8");
    const records = JSON.parse(contents);
    if (!Array.isArray(records)) throw new Error("INVALID_HISTORY_FORMAT");
    return records;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeStoredHandoffs(records) {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  const temporaryFile = HANDOFFS_FILE + ".tmp";
  await fs.promises.writeFile(temporaryFile, JSON.stringify(records, null, 2) + "\n", "utf8");
  await fs.promises.rename(temporaryFile, HANDOFFS_FILE);
}

function queueHandoffWrite(operation) {
  const pending = handoffWriteQueue.then(operation);
  handoffWriteQueue = pending.catch(() => {});
  return pending;
}

function operationError(statusCode, message, details = {}) {
  return Object.assign(new Error(message), { statusCode }, details);
}

function recordRevision(record) {
  return record && Number.isSafeInteger(record.revision) && record.revision >= 0 ? record.revision : 0;
}

function clientRecordId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw operationError(400, "Informe um identificador UUID válido para o rascunho.");
  }
  return value.toLowerCase();
}

function clientRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw operationError(400, "Informe uma revisão inteira igual ou maior que zero.");
  }
  return value;
}

function conflictForRecord(record, message) {
  return operationError(409, message, {
    recordId: record.id,
    currentRevision: recordRevision(record),
    deliveryStatus: record.deliveryStatus,
    lifecycle: record.lifecycle || "submitted",
  });
}

function retainedTicketTitles(previousData, data) {
  const previous = previousData && previousData.chamadosTitulos;
  const ids = data.chamadosAtendidos.concat(data.chamadosPendentesIds);
  const retained = previous && typeof previous === "object" && !Array.isArray(previous)
    ? Object.fromEntries(ids.filter((id) => Object.hasOwn(previous, id)).map((id) => [id, previous[id]])) : {};
  return normalizeTicketTitles(retained, ids);
}

function saveDraftRecord(id, data, revision, preserveMissingTitles = false) {
  return queueHandoffWrite(async () => {
    const records = await readStoredHandoffs();
    const index = records.findIndex((item) => item.id === id);
    const existing = index >= 0 ? records[index] : null;
    if (existing && existing.lifecycle !== "draft") {
      throw conflictForRecord(existing, "Esta passagem já foi finalizada e não pode ser sobrescrita como rascunho.");
    }
    if (revision !== recordRevision(existing)) {
      if (existing && revision < recordRevision(existing)) {
        let sameData = false;
        try {
          sameData = JSON.stringify(normalizeHandoffData(existing.data, { draft: true })) === JSON.stringify(data);
        } catch {}
        if (sameData) return { record: existing, duplicate: true };
      }
      throw existing
        ? conflictForRecord(existing, "O rascunho mudou em outra sessão. Reabra o registro mais recente antes de salvar.")
        : operationError(409, "O rascunho ainda não existe. Use a revisão zero para criá-lo.", { recordId: id, currentRevision: 0 });
    }
    if (existing && preserveMissingTitles) data = { ...data, chamadosTitulos: retainedTicketTitles(existing.data, data) };
    const now = new Date().toISOString();
    const record = {
      id,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      lifecycle: "draft",
      deliveryStatus: "rascunho",
      revision: revision + 1,
      data,
    };
    if (existing) records[index] = record;
    else records.unshift(record);
    await writeStoredHandoffs(records);
    return { record, duplicate: false };
  });
}

function prepareHandoffSubmission(input, metadata, webhookConnected) {
  return queueHandoffWrite(async () => {
    const records = await readStoredHandoffs();
    const id = metadata.draftId || crypto.randomUUID();
    const index = records.findIndex((item) => item.id === id);
    const existing = index >= 0 ? records[index] : null;
    if (existing && existing.deliveryStatus === "enviado") {
      return { record: existing, alreadySent: true };
    }
    if (existing && ["enviando", "incerto"].includes(existing.deliveryStatus)) {
      throw conflictForRecord(existing, "A entrega desta passagem ainda não está confirmada. Confira o Google Chat antes de reenviar para evitar duplicação.");
    }
    const closed = existing && existing.lifecycle !== "draft";
    if (closed && !["falha", "sem_webhook"].includes(existing.deliveryStatus)) {
      throw conflictForRecord(existing, "Esta passagem já foi finalizada e não permite um novo envio.");
    }
    if (metadata.draftId && metadata.draftRevision !== recordRevision(existing)) {
      throw existing
        ? conflictForRecord(existing, "O rascunho mudou em outra sessão. Reabra o registro mais recente antes de finalizar.")
        : operationError(409, "O rascunho ainda não existe. Use a revisão zero para iniciar esta passagem.", { recordId: id, currentRevision: 0 });
    }

    let data;
    try {
      data = normalizeHandoffData(closed ? existing.data : input, { deriveCounts: !closed });
      if (!closed && existing && !Object.hasOwn(input, "chamadosTitulos")) data.chamadosTitulos = retainedTicketTitles(existing.data, data);
    } catch (error) {
      throw operationError(400, error.message);
    }
    const message = buildChatMessage(data);
    if (Buffer.byteLength(message, "utf8") > MAX_CHAT_BYTES) {
      throw operationError(413, "O texto da passagem passou do limite seguro para uma mensagem do Chat.");
    }

    const now = new Date().toISOString();
    const record = {
      ...(existing || {}),
      id,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      lifecycle: "submitted",
      deliveryStatus: webhookConnected ? "enviando" : "sem_webhook",
      revision: recordRevision(existing) + 1,
      data: closed ? existing.data : data,
    };
    if (existing) records[index] = record;
    else records.unshift(record);
    await writeStoredHandoffs(records);
    return { record, message, alreadySent: false };
  });
}

function sendOperationError(res, error, fallback) {
  const payload = { error: error.statusCode ? error.message : fallback };
  for (const key of ["recordId", "currentRevision", "deliveryStatus", "lifecycle"]) {
    if (error[key] !== undefined) payload[key] = error[key];
  }
  sendJson(res, error.statusCode || 500, payload);
}

function updateHandoffStatus(recordId, status) {
  return queueHandoffWrite(async () => {
    const records = await readStoredHandoffs();
    const record = records.find((item) => item.id === recordId);
    if (!record) return;
    record.deliveryStatus = status;
    record.updatedAt = new Date().toISOString();
    await writeStoredHandoffs(records);
  });
}

async function tryUpdateHandoffStatus(recordId, status) {
  try {
    await updateHandoffStatus(recordId, status);
    return true;
  } catch {
    return false;
  }
}

async function listHandoffRecords() {
  await handoffWriteQueue;
  return readStoredHandoffs();
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Método não permitido." });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { error: "Caminho inválido." });
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  const publicPrefix = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicPrefix)) {
    sendJson(res, 403, { error: "Acesso negado." });
    return;
  }

  try {
    const contents = await fs.promises.readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : contents);
  } catch {
    sendJson(res, 404, { error: "Arquivo não encontrado." });
  }
}

async function handleRequest(req, res, url) {
  if (["GET", "HEAD"].includes(req.method) && url.pathname === "/runtime-config.js") {
    const value = JSON.stringify(getPublicConfig()).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : "window.HandoffConfig = Object.freeze(" + value + ");\n");
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, getPublicConfig());
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/health") {
    const ready = storageReady && !shuttingDown;
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: ready ? "ok" : "unavailable", storage: storageReady ? "ready" : "unavailable" }));
    return;
  }
  if (!storageReady || shuttingDown) {
    sendJson(res, 503, { error: "O servidor está iniciando ou encerrando. Tente novamente." });
    return;
  }
  if ((req.method === "POST" && url.pathname === "/api/handoffs") || (req.method === "PUT" && url.pathname.startsWith("/api/drafts/"))) {
    if (!allowJsonMutation(req)) {
      sendJson(res, 403, { error: "A solicitação precisa partir desta aplicação e usar JSON." });
      return;
    }
  }

  if (url.pathname === "/auth/jira" || url.pathname.startsWith("/auth/jira/") || url.pathname.startsWith("/api/jira/")) {
    try {
      if (!jiraIntegration) jiraIntegration = require("./jira-client").createJiraIntegration();
      await jiraIntegration.handle(req, res, url);
    } catch {
      sendJson(res, 503, { code: "jira_upstream_unavailable", error: "A integração Jira está temporariamente indisponível." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, {
      mode: process.env.CHAT_WEBHOOK_URL ? "connected" : "preview",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/handoffs") {
    try {
      sendJson(res, 200, { records: await listHandoffRecords() });
    } catch {
      sendJson(res, 500, { error: "Não foi possível carregar os registros salvos." });
    }
    return;
  }

  const draftRoute = /^\/api\/drafts\/([^/]+)$/.exec(url.pathname);
  if (req.method === "PUT" && draftRoute) {
    let input;
    try {
      input = await readJson(req);
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: error.statusCode === 413 ? "O rascunho ficou grande demais." : "Não foi possível ler os dados do rascunho.",
      });
      return;
    }

    let id, revision, data, preserveMissingTitles;
    try {
      id = clientRecordId(decodeURIComponent(draftRoute[1]));
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Envie o rascunho como um objeto JSON.");
      revision = clientRevision(input.revision);
      data = normalizeHandoffData(input.data, { draft: true });
      preserveMissingTitles = !Object.hasOwn(input.data, "chamadosTitulos");
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    try {
      const result = await saveDraftRecord(id, data, revision, preserveMissingTitles);
      sendJson(res, 200, { ok: true, record: result.record, revision: result.record.revision, duplicate: result.duplicate });
    } catch (error) {
      sendOperationError(res, error, "Não foi possível gravar o rascunho no histórico.");
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/handoffs") {
    let input;
    try {
      input = await readJson(req);
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: error.statusCode === 413
          ? "O formulário ficou grande demais."
          : "Não foi possível ler os dados enviados.",
      });
      return;
    }

    let metadata = {};
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Envie os dados do formulário em um objeto JSON.");
      const hasDraftId = input.draftId !== undefined;
      const hasDraftRevision = input.draftRevision !== undefined;
      if (hasDraftId !== hasDraftRevision) throw new Error("Informe o identificador e a revisão do rascunho juntos.");
      if (hasDraftId) {
        metadata = { draftId: clientRecordId(input.draftId), draftRevision: clientRevision(input.draftRevision) };
      }
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    const webhookUrl = process.env.CHAT_WEBHOOK_URL;
    const dataInput = input.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : input;
    let prepared;
    try {
      prepared = await prepareHandoffSubmission(dataInput, metadata, Boolean(webhookUrl));
    } catch (error) {
      sendOperationError(res, error, "Não foi possível gravar a passagem no histórico.");
      return;
    }
    const { record, message } = prepared;

    if (prepared.alreadySent) {
      sendJson(res, 200, {
        ok: true,
        mode: "sent",
        saved: true,
        duplicate: true,
        recordId: record.id,
        revision: recordRevision(record),
        deliveryStatus: "enviado",
        record,
      });
      return;
    }

    if (!webhookUrl) {
      sendJson(res, 200, {
        ok: true,
        mode: "preview",
        saved: true,
        recordId: record.id,
        revision: record.revision,
        deliveryStatus: record.deliveryStatus,
        record,
      });
      return;
    }

    let response;
    try {
      response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ text: message }),
        signal: AbortSignal.timeout(CHAT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const statusUpdated = await tryUpdateHandoffStatus(record.id, "incerto");
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      const payload = {
        error: "Não foi possível confirmar a entrega ao Google Chat. Confira o espaço antes de reenviar para evitar duplicação.",
        saved: true,
        recordId: record.id,
        deliveryStatus: "incerto",
        revision: record.revision,
        record: { ...record, deliveryStatus: "incerto" },
      };
      if (!statusUpdated) payload.warning = "O registro foi salvo, mas a atualização do status no histórico não foi concluída.";
      sendJson(res, timedOut ? 504 : 502, payload);
      return;
    }

    if (!response.ok) {
      const statusUpdated = await tryUpdateHandoffStatus(record.id, "falha");
      const payload = {
        error: "O Google Chat não aceitou a mensagem. Confira a configuração do webhook.",
        saved: true,
        recordId: record.id,
        deliveryStatus: "falha",
        revision: record.revision,
        record: { ...record, deliveryStatus: "falha" },
      };
      if (!statusUpdated) payload.warning = "O registro foi salvo, mas a atualização do status no histórico não foi concluída.";
      sendJson(res, 502, payload);
      return;
    }

    const statusUpdated = await tryUpdateHandoffStatus(record.id, "enviado");
    const payload = {
      ok: true,
      mode: "sent",
      saved: true,
      recordId: record.id,
      deliveryStatus: "enviado",
      revision: record.revision,
      record: { ...record, deliveryStatus: "enviado" },
    };
    if (!statusUpdated) payload.warning = "A mensagem foi publicada no Google Chat, mas o status no histórico não pôde ser atualizado. Não reenvie esta passagem para evitar duplicação.";
    sendJson(res, 200, payload);
    return;
  }

  await serveStatic(req, res, url);
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    if (!allowedHosts.has(String(req.headers.host || "").toLowerCase())) {
      sendJson(res, 403, { error: "Endereço da aplicação não permitido." });
      return;
    }
    if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//")) {
      sendJson(res, 400, { error: "Caminho inválido." });
      return;
    }
    let url;
    try { url = new URL(req.url, appOrigin ? appOrigin.origin : "http://127.0.0.1:" + PORT); }
    catch { sendJson(res, 400, { error: "Caminho inválido." }); return; }
    if (appOrigin && ["GET", "HEAD"].includes(req.method) && ["/", "/index.html"].includes(url.pathname)
      && String(req.headers.host).toLowerCase() !== appOrigin.host.toLowerCase()) {
      res.writeHead(302, { Location: appOrigin.origin + url.pathname + url.search, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    await handleRequest(req, res, url);
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: "Não foi possível concluir a solicitação." });
    else res.end();
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.on("error", (error) => {
  storageReady = false;
  console.error(error.code === "EADDRINUSE" ? "Não foi possível iniciar: a porta configurada já está em uso." : "Não foi possível iniciar o servidor. Confira o endereço e as permissões do ambiente.");
  process.exitCode = 1;
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    console.error("O encerramento atingiu o limite de espera. Confira o histórico antes de reenviar passagens.");
    process.exit(1);
  }, 25000);
  deadline.unref();
  try {
    await new Promise((resolve) => server.close(resolve));
    await handoffWriteQueue;
  } finally { clearTimeout(deadline); }
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

async function startServer() {
  const probeFile = path.join(DATA_DIR, ".startup-" + crypto.randomUUID() + ".tmp");
  const renamedProbe = probeFile + ".ready";
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(probeFile, "startup-check", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.promises.rename(probeFile, renamedProbe);
    await fs.promises.unlink(renamedProbe);
    storageReady = true;
    if (shuttingDown) return;
    server.listen(PORT, HOST, () => {
      const mode = process.env.CHAT_WEBHOOK_URL ? "webhook configurado" : "modo prévia";
      const address = appOrigin ? appOrigin.origin : "http://" + (HOST === "::1" ? "[::1]" : HOST) + ":" + PORT;
      console.log(appConfig.appName + " disponível em " + address);
      console.log("Integração Google Chat: " + mode);
    });
  } catch {
    storageReady = false;
    for (const file of [probeFile, renamedProbe]) {
      try { await fs.promises.unlink(file); } catch {}
    }
    console.error("Não foi possível iniciar: o diretório de dados precisa permitir criar, renomear e remover arquivos.");
    process.exitCode = 1;
  }
}

startServer();
