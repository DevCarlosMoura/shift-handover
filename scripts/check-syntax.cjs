"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "data", "coverage"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(?:js|cjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (result.status !== 0) { console.error(path.relative(root, file) + ": syntax check failed"); process.exitCode = 1; }
    }
  }
}
visit(root);
if (!process.exitCode) console.log("JavaScript syntax checks passed.");
