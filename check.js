"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

async function main() {
  const env = require("./environment");
  env.loadEnvironment();
  env.validateIntegrations();
  const dataDirectory = process.env.HANDOFF_DATA_DIR || path.join(__dirname, "data");
  if (!path.isAbsolute(dataDirectory)) throw new Error("HANDOFF_DATA_DIR deve ser absoluto.");
  await fs.mkdir(dataDirectory, { recursive: true });
  const probe = path.join(dataDirectory, ".check-" + crypto.randomUUID());
  try {
    await fs.writeFile(probe, "ok", { flag: "wx", mode: 0o600 });
    await fs.rename(probe, probe + ".ready");
  } finally {
    await Promise.all([probe, probe + ".ready"].map((file) => fs.rm(file, { force: true })));
  }
  console.log("Armazenamento: escrita e gravação atômica disponíveis.");
  console.log("Google Chat: " + (process.env.CHAT_WEBHOOK_URL ? "webhook configurado (nenhuma mensagem enviada)" : "modo prévia"));
  console.log("Jira: " + (process.env.JIRA_CLIENT_ID ? "OAuth configurado; cada usuário precisa conectar sua conta" : "aguardando integração OAuth aprovada"));
  console.log("Nenhuma chamada foi feita ao Google Chat ou ao Jira.");
}

main().catch((error) => { console.error("Verificação falhou: " + error.message); process.exitCode = 1; });
