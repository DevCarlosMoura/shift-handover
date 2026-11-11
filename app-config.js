"use strict";

function setting(env, name, fallback = "", maximum = 200, multiline = false) {
  const value = env[name] === undefined ? fallback : env[name];
  const invalidControl = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== "string" || value.length > maximum || invalidControl.test(value)) {
    throw new Error(name + " contém uma configuração inválida.");
  }
  return value.trim();
}

function readAppConfig(env = process.env) {
  const appName = setting(env, "APP_NAME", "Shift Handover", 100) || "Shift Handover";
  const teamName = setting(env, "TEAM_NAME", "Sua equipe", 100) || "Sua equipe";
  const projectKey = (setting(env, "JIRA_PROJECT_KEY", "OPS", 20) || "OPS").toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(projectKey)) throw new Error("JIRA_PROJECT_KEY deve conter uma chave de projeto válida, começando com uma letra.");
  const configuredSite = setting(env, "JIRA_SITE_URL", "", 2048);
  let siteUrl = "";
  let siteLabel = "Jira";
  if (configuredSite) {
    let site;
    try { site = new URL(configuredSite); } catch { throw new Error("JIRA_SITE_URL deve ser a origem HTTPS do seu site Jira Cloud."); }
    if (site.protocol !== "https:" || site.username || site.password || site.search || site.hash || site.pathname !== "/" || site.port) {
      throw new Error("JIRA_SITE_URL deve ser a origem HTTPS do seu site Jira Cloud, sem caminho, credenciais ou parâmetros.");
    }
    siteUrl = site.origin;
    siteLabel = site.hostname;
  }
  const defaultJql = "project = \"" + projectKey + "\"";
  const baseJql = setting(env, "JIRA_BASE_JQL", defaultJql, 8192, true) || defaultJql;
  if (/\border\s+by\b/i.test(baseJql)) throw new Error("JIRA_BASE_JQL deve conter apenas as condições do filtro, sem ORDER BY.");
  const filterLabel = setting(env, "JIRA_FILTER_LABEL", "Projeto " + projectKey, 100) || "Projeto " + projectKey;
  return Object.freeze({ appName, teamName, projectKey, ticketPrefix: projectKey,
    ticketPattern: new RegExp("^" + projectKey + "-\\d{1,12}$"), siteUrl, siteLabel, baseJql, filterLabel });
}

function getPublicConfig(env = process.env) {
  const config = readAppConfig(env);
  return Object.freeze({ appName: config.appName, teamName: config.teamName, ticketPrefix: config.ticketPrefix,
    jiraFilterLabel: config.filterLabel, jiraSiteLabel: config.siteLabel });
}

module.exports = { readAppConfig, getPublicConfig };
