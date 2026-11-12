"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { create } = require("../public/jira-merge");

for (const prefix of ["OPS", "HELP"]) {
  test(prefix + ": imported titles fill blanks, preserve manual titles and follow status moves", () => {
    const key = (number) => prefix + "-" + number;
    const current = { chamadosAtendidos: [key(1)], chamadosPendentesIds: [key(2)], chamadosTitulos: { [key(1)]: "Manual fixture title" } };
    const incoming = { finalized: [key(1), key(2), key(3)], pending: [key(4)], titles: { [key(1)]: "Changed provider title", [key(2)]: "Resolved fixture", [key(3)]: "New fixture", [key(4)]: "Pending fixture" } };
    const original = JSON.stringify({ current, incoming });
    const merge = create(prefix).merge;
    const result = merge(current, incoming);
    assert.deepEqual(result.chamadosAtendidos, [key(1), key(2), key(3)]);
    assert.deepEqual(result.chamadosPendentesIds, [key(4)]);
    assert.equal(result.chamadosTitulos[key(1)], "Manual fixture title");
    assert.equal(result.chamadosTitulos[key(2)], "Resolved fixture");
    assert.equal(result.chamadosTitulos[key(4)], "Pending fixture");
    assert.equal(result.added, 2);
    assert.equal(result.moved, 1);
    assert.equal(result.changed, true);
    assert.equal(JSON.stringify({ current, incoming }), original);
    assert.equal(merge(result, incoming).changed, false);
  });
}

test("a title-only import saves once, while absent provider titles preserve existing data", () => {
  const merge = create("OPS").merge;
  const current = { chamadosAtendidos: ["OPS-1"], chamadosPendentesIds: [] };
  const result = merge(current, { finalized: ["OPS-1"], pending: [], titles: { "OPS-1": "First title" } });
  assert.equal(result.added, 0);
  assert.equal(result.moved, 0);
  assert.equal(result.changed, true);
  assert.equal(merge(result, { finalized: ["OPS-1"], pending: [] }).changed, false);
  assert.equal(merge(result, { finalized: ["OPS-1"], pending: [] }).chamadosTitulos["OPS-1"], "First title");
  assert.equal(merge(current, { finalized: ["OPS-1"], pending: [] }).changed, false);
});

test("invalid title maps reject the import atomically", () => {
  const merge = create("HELP").merge;
  const current = { chamadosAtendidos: ["HELP-1"], chamadosPendentesIds: [], chamadosTitulos: { "HELP-1": "Manual fixture" } };
  for (const titles of [null, [], "invalid", { "HELP-2": "Orphan" }, { "OTHER-1": "Wrong project" }, { "HELP-1": 42 }, { "HELP-1": "x".repeat(256) }, { "HELP-1": "a", "help-1": "a" }]) {
    const snapshot = JSON.stringify(current);
    assert.throws(() => merge(current, { finalized: ["HELP-1"], pending: [], titles }));
    assert.equal(JSON.stringify(current), snapshot);
  }
  const result = merge({ chamadosAtendidos: [], chamadosPendentesIds: [] }, { finalized: ["HELP-1"], pending: [], titles: { "HELP-1": "  Fixture\n title\twith  spaces  " } });
  assert.equal(result.chamadosTitulos["HELP-1"], "Fixture title with spaces");
});

test("preview includes optional titles, keeps legacy IDs and neutralizes imported mentions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("function previewDate("), source.indexOf("function recordStatusText(")), context);
  const data = { chamadosAtendidos: ["HELP-1"], chamadosPendentesIds: ["HELP-2"], chamadosTitulos: { "HELP-1": "Manual fixture title", "HELP-2": "<users/all> *fixture*" } };
  const preview = context.buildChatPreview(data);
  assert.ok(preview.includes("HELP-1 — Manual fixture title"));
  assert.ok(preview.includes("HELP-2 — ‹users/all› \\*fixture\\*"));
  assert.ok(!preview.includes("<users/all>"));
  assert.equal(context.formatTicketLabel(data, "HELP-2"), "HELP-2 — <users/all> *fixture*");
  assert.ok(context.buildChatPreview({ chamadosAtendidos: ["HELP-3"] }).includes("HELP-3"));
});
