"use strict";

try {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Instale o Node.js 24 ou superior.");
  const environment = require("./environment");
  environment.loadEnvironment();
  environment.validateIntegrations();
  require("./server");
} catch (error) {
  console.error("Não foi possível iniciar a aplicação: " + error.message);
  process.exitCode = 1;
}
