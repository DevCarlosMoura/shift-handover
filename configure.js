"use strict";

const path = require("node:path");
const readline = require("node:readline/promises");
const { Writable } = require("node:stream");
const environment = require("./environment");

async function hiddenQuestion(prompt, fallback) {
  process.stdout.write(prompt);
  const silentOutput = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = readline.createInterface({ input: process.stdin, output: silentOutput, terminal: Boolean(process.stdin.isTTY), historySize: 0 });
  try {
    const value = (await input.question("")).trim();
    process.stdout.write("\n");
    if (!value && fallback === undefined) throw new Error("Valor vazio. A configuração anterior foi preservada.");
    return value || fallback;
  } finally { input.close(); }
}

async function main() {
  environment.loadProjectEnv();
  const args = process.argv.slice(2);
  if (args.some((value) => !["--local", "--chat", "--jira", "--status"].includes(value))) {
    throw new Error("Use --local, --chat, --jira ou --status. Segredos são solicitados em entrada oculta, nunca como argumento.");
  }
  if (!args.length || args.includes("--local")) {
    const previous = environment.readSettings();
    const values = {
      HOST: "127.0.0.1", PORT: "4173", NODE_ENV: "development", APP_ORIGIN: "http://127.0.0.1:4173",
      HANDOFF_DATA_DIR: path.join(__dirname, "data"), JIRA_REDIRECT_URI: "http://127.0.0.1:4173/auth/jira/callback", ...previous,
    };
    environment.saveSettings(values);
    console.log("Configuração local salva. O histórico existente foi preservado.");
  }
  if (args.includes("--chat") || args.includes("--jira")) {
    const settings = { ...environment.readSettings() };
    const values = { ...environment.readSecrets() };
    if (args.includes("--chat")) values.CHAT_WEBHOOK_URL = await hiddenQuestion("Webhook do Google Chat (entrada oculta): ");
    if (args.includes("--jira")) {
      settings.JIRA_SITE_URL = await hiddenQuestion("URL HTTPS do seu Jira Cloud: ");
      settings.JIRA_PROJECT_KEY = (await hiddenQuestion("Chave do projeto Jira [OPS]: ", "OPS")).toUpperCase();
      values.JIRA_CLIENT_ID = await hiddenQuestion("OAuth Client ID em Settings (entrada oculta): ");
      values.JIRA_CLIENT_SECRET = await hiddenQuestion("Client Secret do Jira (entrada oculta): ");
    }
    environment.validateIntegrations({ ...settings, ...values });
    environment.saveSecrets(values);
    environment.saveSettings(settings);
    console.log("Segredos salvos com proteção da conta atual do Windows. Reinicie a aplicação para aplicar.");
  }
  if (args.includes("--status")) {
    const values = environment.loadEnvironment({ ...process.env });
    environment.validateIntegrations(values);
    console.log(JSON.stringify({
      configDirectory: environment.configDirectory(),
      host: values.HOST || "127.0.0.1", port: values.PORT || "4173",
      dataDirectory: values.HANDOFF_DATA_DIR || path.join(__dirname, "data"),
      chatConfigured: Boolean(values.CHAT_WEBHOOK_URL),
      jiraConfigured: Boolean(values.JIRA_SITE_URL && values.JIRA_CLIENT_ID && values.JIRA_CLIENT_SECRET),
      projectKey: require("./app-config").readAppConfig(values).projectKey,
    }, null, 2));
  }
}

main().catch((error) => { console.error("Configuração não concluída: " + error.message); process.exitCode = 1; });
