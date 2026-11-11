"use strict";

const fs = require("node:fs/promises");
const constants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");

async function main() {
  require("./environment").loadEnvironment();
  const directory = process.env.HANDOFF_DATA_DIR || path.join(__dirname, "data");
  if (!path.isAbsolute(directory)) throw new Error("HANDOFF_DATA_DIR deve ser absoluto.");
  const source = path.join(directory, "handoffs.json");
  try { await fs.access(source); }
  catch (error) { if (error.code === "ENOENT") { console.log("Ainda não há histórico para copiar."); return; } throw error; }
  const backups = path.join(directory, "backups");
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backups, "handoffs-" + stamp + "-" + crypto.randomUUID() + ".json");
  await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  console.log("Backup do histórico salvo em " + destination);
}

main().catch(() => { console.error("Não foi possível criar o backup. Confira o diretório de dados e suas permissões."); process.exitCode = 1; });
