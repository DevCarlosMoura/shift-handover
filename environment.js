"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SETTINGS_KEYS = ["HOST", "PORT", "NODE_ENV", "APP_ORIGIN", "HANDOFF_DATA_DIR", "JIRA_REDIRECT_URI", "APP_NAME", "TEAM_NAME", "JIRA_SITE_URL", "JIRA_PROJECT_KEY", "JIRA_BASE_JQL", "JIRA_FILTER_LABEL", "JIRA_SESSION_DAYS"];
const SECRET_KEYS = ["CHAT_WEBHOOK_URL", "JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET", "JIRA_SESSION_KEY"];

function configDirectory(env = process.env) {
  const directory = env.HANDOVER_CONFIG_DIR || (process.platform === "win32"
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ShiftHandover")
    : path.join(os.homedir(), ".config", "shift-handover"));
  if (!path.isAbsolute(directory)) throw new Error("HANDOVER_CONFIG_DIR deve ser um caminho absoluto.");
  return directory;
}

function readJsonFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) throw new Error();
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("A configuração local está inválida ou não pôde ser lida. Execute npm run configure para revisá-la.");
  }
}

function validateValues(values, allowed) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Formato de configuração local inválido.");
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.includes(key) || typeof value !== "string" || value.length > 16384 || value.includes("\0")) {
      throw new Error("A configuração local contém uma opção inválida.");
    }
  }
  return values;
}

function protectBytes(bytes, decrypt = false) {
  if (process.platform !== "win32") throw new Error("O cofre local usa a proteção do Windows. Neste servidor, configure segredos pelo ambiente aprovado.");
  const operation = decrypt ? "Unprotect" : "Protect";
  // Only this fixed command is passed to PowerShell. Secret values travel through stdin.
  const command = "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; "
    + "$source=[Convert]::FromBase64String([Console]::In.ReadToEnd()); "
    + "$entropy=[Text.Encoding]::UTF8.GetBytes('shift-handover:1'); "
    + "$result=[Security.Cryptography.ProtectedData]::" + operation + "($source,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
    + "[Console]::Out.Write([Convert]::ToBase64String($result)); [Array]::Clear($source,0,$source.Length); [Array]::Clear($result,0,$result.Length) "
    + "} catch { [Console]::Error.Write('Falha na protecao local do Windows.'); exit 1 }";
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    input: bytes.toString("base64"), encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.stdout || "")) {
    throw new Error("Não foi possível acessar o cofre local do Windows. Use a mesma conta que configurou a aplicação e mantenha as políticas corporativas.");
  }
  return Buffer.from(result.stdout, "base64");
}

function readSettings(env = process.env) {
  const file = readJsonFile(path.join(configDirectory(env), "settings.json"));
  return file ? validateValues(file.values, SETTINGS_KEYS) : {};
}

function readSecrets(env = process.env) {
  const file = readJsonFile(path.join(configDirectory(env), "secrets.dpapi"));
  if (!file) return {};
  if (typeof file.protected !== "string" || file.protected.length > 131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.protected)) throw new Error("O cofre local está inválido.");
  const bytes = protectBytes(Buffer.from(file.protected, "base64"), true);
  try { return validateValues(JSON.parse(bytes.toString("utf8")), SECRET_KEYS); }
  catch { throw new Error("Não foi possível ler os segredos do cofre local."); }
  finally { bytes.fill(0); }
}

function writeFileAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function saveSettings(values, env = process.env) {
  validateValues(values, SETTINGS_KEYS);
  writeFileAtomic(path.join(configDirectory(env), "settings.json"), { version: 1, values });
}

function saveSecrets(values, env = process.env) {
  validateValues(values, SECRET_KEYS);
  const bytes = Buffer.from(JSON.stringify(values), "utf8");
  try {
    const encrypted = protectBytes(bytes);
    writeFileAtomic(path.join(configDirectory(env), "secrets.dpapi"), { version: 1, protected: encrypted.toString("base64") });
    encrypted.fill(0);
  } finally { bytes.fill(0); }
}

function loadEnvironment(env = process.env) {
  if (env === process.env) loadProjectEnv();
  const saved = { ...readSettings(env), ...readSecrets(env) };
  for (const [key, value] of Object.entries(saved)) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

function loadProjectEnv() {
  const file = path.join(__dirname, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function validateIntegrations(env = process.env) {
  const config = require("./app-config").readAppConfig(env);
  if (env.CHAT_WEBHOOK_URL) {
    let webhook;
    try { webhook = new URL(env.CHAT_WEBHOOK_URL); } catch { throw new Error("CHAT_WEBHOOK_URL não é uma URL válida do Google Chat."); }
    if (webhook.protocol !== "https:" || webhook.hostname !== "chat.googleapis.com" || webhook.port || webhook.username || webhook.password
      || webhook.hash || !/^\/v1\/spaces\/[^/]+\/messages$/.test(webhook.pathname)
      || !webhook.searchParams.get("key") || !webhook.searchParams.get("token")) {
      throw new Error("CHAT_WEBHOOK_URL deve ser um webhook HTTPS completo do Google Chat.");
    }
  }
  const id = Boolean(env.JIRA_CLIENT_ID && env.JIRA_CLIENT_ID.trim());
  const secret = Boolean(env.JIRA_CLIENT_SECRET && env.JIRA_CLIENT_SECRET.trim());
  if (id !== secret) throw new Error("A configuração Jira está incompleta. Configure JIRA_CLIENT_ID e JIRA_CLIENT_SECRET juntos.");
  if (id && !config.siteUrl) throw new Error("Configure JIRA_SITE_URL junto com as credenciais da integração Jira.");
  if (env.JIRA_SESSION_KEY) {
    const key = Buffer.from(env.JIRA_SESSION_KEY, "base64");
    const valid = key.length === 32 && key.toString("base64") === env.JIRA_SESSION_KEY;
    key.fill(0);
    if (!valid) throw new Error("JIRA_SESSION_KEY deve conter exatamente 32 bytes em base64.");
  }
  if (id && process.platform !== "win32" && !env.JIRA_SESSION_KEY) throw new Error("Configure JIRA_SESSION_KEY no gerenciador de segredos para proteger as sessões neste servidor.");
  if (env.JIRA_SESSION_DAYS && (!/^\d+$/.test(env.JIRA_SESSION_DAYS) || Number(env.JIRA_SESSION_DAYS) < 1 || Number(env.JIRA_SESSION_DAYS) > 90)) throw new Error("JIRA_SESSION_DAYS deve ser um inteiro entre 1 e 90.");
  if (env.JIRA_REDIRECT_URI) {
    let redirect;
    try { redirect = new URL(env.JIRA_REDIRECT_URI); } catch { throw new Error("JIRA_REDIRECT_URI inválido."); }
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname);
    if (redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== "/auth/jira/callback"
      || !(redirect.protocol === "https:" || (redirect.protocol === "http:" && local))) throw new Error("JIRA_REDIRECT_URI deve usar o callback autorizado da aplicação.");
    if (env.APP_ORIGIN && redirect.origin !== env.APP_ORIGIN) throw new Error("O callback Jira deve usar a mesma origem configurada em APP_ORIGIN.");
  }
}

module.exports = { configDirectory, readSettings, readSecrets, saveSettings, saveSecrets, loadEnvironment, loadProjectEnv, validateIntegrations, protectBytes };
