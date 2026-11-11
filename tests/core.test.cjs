"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readAppConfig, getPublicConfig } = require("../app-config");
const tickets = require("../public/jira-merge");
const references = require("../public/draft-reference");

test("two installations get independent project, tenant and public labels", () => {
  for (const [project, tenant] of [["OPS", "tenant-alpha"], ["HELP", "tenant-beta"]]) {
    const env = { APP_NAME: "Fixture Handover", TEAM_NAME: "Fixture Team", JIRA_PROJECT_KEY: project, JIRA_SITE_URL: "https://" + tenant + ".atlassian.net" };
    const config = readAppConfig(env);
    assert.equal(config.projectKey, project);
    assert.equal(config.baseJql, 'project = "' + project + '"');
    assert.ok(config.ticketPattern.test(project + "-123"));
    assert.ok(!config.ticketPattern.test((project === "OPS" ? "HELP" : "OPS") + "-123"));
    assert.equal(config.siteUrl, env.JIRA_SITE_URL);
    const publicValues = getPublicConfig({ ...env, JIRA_CLIENT_SECRET: "fixture-secret-value", JIRA_BASE_JQL: "labels = fixture_private_filter" });
    assert.deepEqual(Object.keys(publicValues).sort(), ["appName", "teamName", "ticketPrefix", "jiraFilterLabel", "jiraSiteLabel"].sort());
    assert.equal(publicValues.ticketPrefix, project);
    assert.ok(!JSON.stringify(publicValues).includes("fixture-secret-value"));
    assert.ok(!JSON.stringify(publicValues).includes("fixture_private_filter"));
  }
});

test("misconfigured project keys, site URLs and executable JQL sorting are rejected", () => {
  for (const key of ["1OPS", "OPS;OTHER", "A B", "A".repeat(21)]) assert.throws(() => readAppConfig({ JIRA_PROJECT_KEY: key }));
  for (const site of ["http://tenant-alpha.atlassian.net", "https://user:password@tenant-alpha.atlassian.net", "https://tenant-alpha.atlassian.net/path", "https://tenant-alpha.atlassian.net?token=fixture"]) assert.throws(() => readAppConfig({ JIRA_SITE_URL: site }));
  assert.throws(() => readAppConfig({ JIRA_BASE_JQL: "project = OPS ORDER BY created DESC" }));
  assert.throws(() => readAppConfig({ APP_NAME: "Invalid\nname" }));
});

test("320 project-specific IDs merge without losing manual entries or mutating inputs", () => {
  for (const prefix of ["OPS", "HELP"]) {
    const merge = tickets.create(prefix).merge;
    const finalized = Array.from({ length: 200 }, (_, index) => prefix + "-" + (1000 + index));
    const pending = Array.from({ length: 120 }, (_, index) => prefix + "-" + (2000 + index));
    const current = { chamadosAtendidos: [prefix + "-99"], chamadosPendentesIds: [finalized[0]] };
    const original = JSON.stringify(current);
    const result = merge(current, { finalized, pending });
    assert.equal(result.chamadosAtendidos.length, 201);
    assert.equal(result.chamadosPendentesIds.length, 120);
    assert.equal(result.moved, 1);
    assert.equal(result.added, 319);
    assert.equal(JSON.stringify(current), original);
    assert.equal(new Set(result.chamadosAtendidos.concat(result.chamadosPendentesIds)).size, 321);
    assert.equal(merge(result, { finalized, pending }).changed, false);
    const snapshot = JSON.stringify(result);
    assert.throws(() => merge(result, { finalized: ["WRONG-1"], pending: [] }));
    assert.equal(JSON.stringify(result), snapshot);
  }
});

test("pending precedence and normalized duplicate handling are stable", () => {
  const merge = tickets.create("HELP").merge;
  const result = merge({ chamadosAtendidos: [], chamadosPendentesIds: [] }, { finalized: [" help-12 ", "HELP-12"], pending: ["HELP-12", "HELP-13"] });
  assert.deepEqual(result.chamadosAtendidos, []);
  assert.deepEqual(result.chamadosPendentesIds, ["HELP-12", "HELP-13"]);
});

test("saved draft references survive reopening but remain separate across connections", () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) };
  let time = Date.parse("2026-01-01T12:00:00Z");
  const a = "a".repeat(64), b = "b".repeat(64);
  const idA = "11111111-1111-4111-8111-111111111111", idB = "22222222-2222-4222-8222-222222222222";
  assert.equal(references.create(storage, () => time).remember(a, idA), true);
  const reopened = references.create(storage, () => time);
  assert.equal(reopened.recall(a), idA);
  assert.equal(reopened.recall(b), null);
  assert.equal(reopened.remember(b, idB), true);
  reopened.forget(a, idB);
  assert.equal(reopened.recall(a), idA);
  reopened.forget(a, idA);
  assert.equal(reopened.recall(a), null);
  assert.equal(reopened.recall(b), idB);
  for (const value of saved.values()) assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ["id", "savedAt", "version"]);
  time += 30 * 86400000;
  assert.equal(reopened.recall(b), null);
});

test("unavailable browser storage does not break saving or reading the form", () => {
  const blocked = references.create({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("blocked"); } });
  const a = "a".repeat(64);
  assert.equal(blocked.recall(a), null);
  assert.equal(blocked.remember(a, "11111111-1111-4111-8111-111111111111"), false);
  assert.doesNotThrow(() => blocked.forget(a));
});
