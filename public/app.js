const form = document.getElementById("handoff-form");
const publicConfig = window.HandoffConfig || {};
const appName = typeof publicConfig.appName === "string" && publicConfig.appName.trim() ? publicConfig.appName.trim() : "Shift Handover";
const teamName = typeof publicConfig.teamName === "string" && publicConfig.teamName.trim() ? publicConfig.teamName.trim() : "Sua equipe";
let jiraFilterLabel = typeof publicConfig.jiraFilterLabel === "string" && publicConfig.jiraFilterLabel.trim() ? publicConfig.jiraFilterLabel.trim() : "Projeto configurado";
document.title = appName;
document.querySelectorAll("[data-app-name]").forEach((element) => { element.textContent = appName; });
document.querySelectorAll("[data-team-name]").forEach((element) => { element.textContent = teamName; });
document.querySelectorAll("[data-app-aria]").forEach((element) => element.setAttribute("aria-label", appName));
document.getElementById("jira-filter-heading").textContent = "Jira · " + jiraFilterLabel;
const dateInput = document.getElementById("handoff-date");
const toast = document.getElementById("toast");
const toastMessage = document.getElementById("toast-message");
const toastIcon = document.getElementById("toast-icon");
const connectionStatus = document.getElementById("connection-status");
const submitButton = form.querySelector('button[type="submit"]');
const formState = window.HandoffForm;
const draftReferences = window.HandoffDraftReference.create();
const saveDraftButton = document.getElementById("save-draft");
const connectJiraButton = document.getElementById("connect-jira");
const importJiraButton = document.getElementById("import-jira");
const disconnectJiraButton = document.getElementById("disconnect-jira");
const jiraStatus = document.getElementById("jira-status");
const profileMenuButton = document.getElementById("profile-menu-button");
const utilityMenu = document.getElementById("utility-menu");
const previewDialog = document.getElementById("preview-dialog");
const previewMessage = document.getElementById("message-preview");
const recordsDialog = document.getElementById("records-dialog");
const recordsList = document.getElementById("records-list");
const recordsCount = document.getElementById("records-count");
const recordsDateFilter = document.getElementById("records-date-filter");
const recordsTypeFilter = document.getElementById("records-type-filter");
let storedRecords = [];
let activeDraftRevision = 0;
let isDirty = false;
let saveAsCopy = false;
let isBusy = false;
let lastSubmittedSignature = null;
let jiraConfigured = false;
let jiraConnected = false;
let jiraConnectionKey = null;
let jiraStatusKnown = false;
let toastTimer;

function draftReferenceScope() {
  if (jiraConnected && jiraConnectionKey) return jiraConnectionKey;
  return jiraStatusKnown && !jiraConfigured ? "manual" : null;
}

function rememberActiveDraft(id = formState.getDraftId()) {
  draftReferences.remember(draftReferenceScope(), id);
}

function getFormData() {
  return formState.read();
}

function localDateValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function showToast(message, kind) {
  window.clearTimeout(toastTimer);
  toastMessage.textContent = message;
  toast.classList.toggle("error", kind === "error");
  toastIcon.textContent = kind === "error" ? "!" : "✓";
  toast.classList.add("visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 5600);
}

async function updateConnectionStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const data = await response.json();
    if (data.mode === "connected") {
      connectionStatus.classList.add("connected");
      connectionStatus.innerHTML = "<i></i> Google Chat configurado";
    } else {
      connectionStatus.classList.remove("connected");
      connectionStatus.innerHTML = "<i></i> Webhook do Chat não conectado";
    }
  } catch {
    connectionStatus.classList.remove("connected");
    connectionStatus.innerHTML = "<i></i> Servidor indisponível";
  }
}

function refreshJiraControls() {
  connectJiraButton.hidden = jiraConnected;
  connectJiraButton.disabled = isBusy || !jiraConfigured;
  importJiraButton.disabled = isBusy || !jiraConnected;
  disconnectJiraButton.hidden = !jiraConnected;
  disconnectJiraButton.disabled = isBusy;
}

async function updateJiraStatus() {
  try {
    const response = await fetch("/api/jira/status", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error("jira_status_unavailable");
    jiraConfigured = result.configured === true;
    jiraConnected = result.connected === true;
    if (typeof result.filterLabel === "string" && result.filterLabel.trim()) jiraFilterLabel = result.filterLabel.trim();
    document.getElementById("jira-filter-heading").textContent = "Jira · " + jiraFilterLabel;
    jiraStatusKnown = true;
    jiraConnectionKey = jiraConnected && typeof result.connectionKey === "string" && /^[a-f0-9]{64}$/.test(result.connectionKey) ? result.connectionKey : null;
    jiraStatus.textContent = !jiraConfigured
      ? "A integração Jira ainda precisa ser configurada no servidor."
      : (jiraConnected ? "Sua conta do Jira está conectada · " + jiraFilterLabel + "." : "Conecte sua conta do Jira para importar seus chamados.");
  } catch {
    jiraConfigured = false;
    jiraConnected = false;
    jiraStatusKnown = false;
    jiraConnectionKey = null;
    jiraStatus.textContent = "Não foi possível verificar a conexão com o Jira. Atualize a página quando o servidor estiver disponível.";
  }
  refreshJiraControls();
}

function showJiraReturnStatus() {
  const url = new URL(window.location.href);
  const result = url.searchParams.get("jira");
  if (!result) return;
  if (result === "connected" && jiraConnected) showToast("Jira conectado. Use Importar do Jira para preencher o rascunho.", "success");
  else if (result === "error") {
    jiraStatus.textContent = "A conexão com o Jira não foi concluída. Confira a configuração e tente conectar novamente.";
    showToast(jiraStatus.textContent, "error");
  }
  url.searchParams.delete("jira");
  url.searchParams.delete("jira_error");
  window.history.replaceState(null, "", url.href);
}

function connectJira() {
  if (isBusy || !jiraConfigured) return;
  if (isDirty) {
    showToast("Salve o rascunho antes de conectar ao Jira para retomar o preenchimento depois.", "error");
    return;
  }
  const returnUrl = new URL(window.location.href);
  returnUrl.searchParams.delete("jira");
  returnUrl.searchParams.delete("jira_error");
  const returnTo = returnUrl.pathname + returnUrl.search;
  window.location.assign("/auth/jira?returnTo=" + encodeURIComponent(returnTo));
}

async function disconnectJira() {
  if (isBusy) return;
  setBusy(true);
  try {
    const response = await fetch("/api/jira/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error("disconnect_failed");
    draftReferences.forget(draftReferenceScope());
    showToast("Conta do Jira desconectada. Seus rascunhos foram preservados.", "success");
  } catch {
    showToast("Não foi possível desconectar o Jira. Tente novamente.", "error");
  } finally {
    setBusy(false);
    await updateJiraStatus();
  }
}

async function importFromJira() {
  if (isBusy || !jiraConnected || !formState.validateTickets()) return;
  if (saveAsCopy) {
    showToast("Salve uma cópia do rascunho antes de importar para preservar as alterações desta ficha.", "error");
    return;
  }
  if (!dateInput.reportValidity()) return;
  const selectedDate = dateInput.value;
  let importResult;
  let merged;
  setBusy(true);
  importJiraButton.textContent = "Importando…";
  jiraStatus.textContent = "Consultando finalizados e pendentes no Jira…";
  try {
    const response = await fetch("/api/jira/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: selectedDate }),
    });
    importResult = await response.json();
    if (!response.ok) {
      if (response.status === 401) jiraConnected = false;
      throw new Error(importResult.error || "Não foi possível importar os chamados do Jira.");
    }
    if (dateInput.value !== selectedDate) throw new Error("A data da ficha mudou. Confira a data e importe novamente.");
    merged = formState.mergeTickets(importResult);
    isDirty = isDirty || merged.changed;
  } catch (error) {
    jiraStatus.textContent = error.message || "Falha na importação. As listas atuais foram preservadas.";
    showToast(jiraStatus.textContent, "error");
  } finally {
    importJiraButton.textContent = "↓ Importar do Jira";
    setBusy(false);
  }
  if (!merged) return;
  const found = importResult.finalized.length + " finalizados em " + previewDate(selectedDate) + " e " + importResult.pending.length + " pendentes atuais no Jira";
  if (!isDirty && formState.getDraftId()) {
    jiraStatus.textContent = found + ". A ficha já estava atualizada.";
    showToast("Listas já atualizadas. O rascunho foi preservado.", "success");
    return;
  }
  const current = getFormData();
  if (!isDirty && current.chamadosAtendidos.length === 0 && current.chamadosPendentesIds.length === 0) {
    jiraStatus.textContent = "Nenhum chamado encontrado para a data e o filtro " + jiraFilterLabel + ".";
    showToast(jiraStatus.textContent, "success");
    return;
  }
  formState.setDraftStatus("Chamados importados · salvando rascunho…");
  const record = await saveDraft({ silent: true });
  if (record) {
    jiraStatus.textContent = found + ". Rascunho salvo para revisão.";
    showToast("Importação concluída e rascunho salvo. Nenhuma mensagem foi enviada ao Chat.", "success");
  } else {
    jiraStatus.textContent = "Chamados importados no formulário, mas o salvamento não foi confirmado. Use Salvar rascunho.";
  }
}

function previewDate(value) {
  const parts = String(value || "").split("-");
  return parts.length === 3 ? parts.reverse().join("/") : previewValue(value);
}

function previewValue(value) {
  const normalized = String(value || "").trim();
  return normalized || "—";
}

function formatTicketLabel(data, ticket, forChat = false) {
  const value = data.chamadosTitulos && data.chamadosTitulos[ticket];
  let title = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (forChat) title = title.replace(/</g, "‹").replace(/>/g, "›").replace(/[\\*_~`]/g, "\\$&");
  return ticket + (title ? " — " + title : "");
}

function buildChatPreview(data) {
  const line = (label, value) => "* " + label + ": " + previewValue(value);
  const section = (title, value) => "*" + title + "*\n" + previewValue(value);
  const ticketLines = data.chamadosAtendidos.length
    ? data.chamadosAtendidos.map((ticket) => "• " + formatTicketLabel(data, ticket, true)).join("\n")
    : "—";

  return [
    "*Passagem de turno registrada por " + previewValue(data.responsavel) + "*",
    "*Turno:* " + previewValue(data.turno) + "  •  *Data:* " + previewDate(data.data),
    "",
    "*Métricas do turno*",
    line("Estado geral", data.estadoGeral),
    line("Quantidade servida", data.quantidadeServida),
    line("Chamados finalizados", data.chamadosResolvidos),
    line("Chamados pendentes / em aberto", data.chamadosPendentes),
    "",
    section("Chamados finalizados", ticketLines),
    "",
    section("Chamados pendentes", (data.chamadosPendentesIds || []).map((ticket) => "• " + formatTicketLabel(data, ticket, true)).join("\n")),
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

function refreshChatPreview() {
  previewMessage.textContent = buildChatPreview(getFormData());
}

function recordStatusText(status) {
  const labels = {
    rascunho: "Rascunho · não enviado",
    enviado: "Enviado ao Chat",
    sem_webhook: "Salvo · sem webhook",
    falha: "Falha no envio",
    incerto: "Entrega incerta · conferir Chat",
    enviando: "Enviando",
  };
  return labels[status] || "Status indisponível";
}

function renderRecords() {
  recordsList.replaceChildren();
  const selectedDate = recordsDateFilter.value;
  const selectedType = recordsTypeFilter.value;
  const visibleRecords = storedRecords.filter((record) =>
    (!selectedDate || (record.data && record.data.data === selectedDate))
    && (selectedType === "all" || (selectedType === "draft") === isDraftRecord(record))
  );

  recordsCount.textContent = storedRecords.length === 0
    ? "Nenhuma passagem registrada ainda."
    : `${visibleRecords.length} de ${storedRecords.length} passagens`;

  if (visibleRecords.length === 0) {
    const empty = document.createElement("p");
    empty.className = "records-empty";
    empty.textContent = storedRecords.length ? "Nenhum registro neste filtro." : "Os rascunhos e as passagens concluídas aparecerão aqui.";
    recordsList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  visibleRecords.forEach((record) => {
    const data = record.data || {};
    const details = document.createElement("details");
    details.className = "record-card";

    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.className = "record-title";
    title.textContent = `${previewValue(data.responsavel)} · ${previewValue(data.turno)} · ${previewDate(data.data)}`;
    const status = document.createElement("span");
    status.className = "record-status status-" + (record.deliveryStatus || "unknown");
    status.textContent = recordStatusText(record.deliveryStatus);
    summary.append(title, status);
    details.append(summary);

    const savedAt = document.createElement("p");
    savedAt.className = "record-saved-at";
    const created = new Date(isDraftRecord(record) ? (record.updatedAt || record.createdAt) : record.createdAt);
    savedAt.textContent = Number.isNaN(created.getTime())
      ? ""
      : (isDraftRecord(record) ? "Rascunho salvo em " : "Registrado em ") + new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(created);
    details.append(savedAt);

    const fields = [
      ["Estado geral", data.estadoGeral],
      ["Quantidade servida", data.quantidadeServida],
      ["Quantidade de finalizados", data.chamadosResolvidos],
      ["Chamados pendentes / em aberto", data.chamadosPendentes],
      ["Chamados finalizados", Array.isArray(data.chamadosAtendidos) ? data.chamadosAtendidos.map((ticket) => formatTicketLabel(data, ticket)).join("\n") : ""],
      ["Chamados pendentes", Array.isArray(data.chamadosPendentesIds) ? data.chamadosPendentesIds.map((ticket) => formatTicketLabel(data, ticket)).join("\n") : ""],
      ["Atualizações técnicas", data.atualizacaoHH],
      ["Serviços / processos acompanhados", data.servicosAcompanhados],
      ["Principais atividades", data.principaisAtividades],
      ["Instabilidade", data.instabilidade],
      ["Equipamentos afetados e situação", data.equipamentosImpactados],
      ["Pontos de atenção", data.pontosAtencao],
      ["Tarefas agendadas", data.tarefasAgendadas],
      ["Próximos passos dos chamados", data.proximosPassos],
      ["Responsável pelo próximo passo", data.responsavelProximaEtapa],
      ["Avisos e alterações em equipamentos", data.comunicados],
    ];
    const definitionList = document.createElement("dl");
    definitionList.className = "record-fields";
    fields.forEach(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = previewValue(value);
      row.append(term, description);
      definitionList.append(row);
    });
    details.append(definitionList);
    if (isDraftRecord(record)) {
      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "secondary-button record-resume";
      resume.textContent = "Continuar preenchimento";
      resume.addEventListener("click", () => resumeDraft(record));
      details.append(resume);
    }
    fragment.append(details);
  });
  recordsList.append(fragment);
}

async function loadRecords() {
  recordsCount.textContent = "Carregando registros…";
  recordsList.replaceChildren();
  try {
    const response = await fetch("/api/handoffs", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Falha ao carregar");
    storedRecords = Array.isArray(result.records) ? result.records : [];
    renderRecords();
  } catch {
    recordsCount.textContent = "Não foi possível carregar os registros.";
  }
}

function isDraftRecord(record) {
  return record.lifecycle === "draft" || record.deliveryStatus === "rascunho";
}

function setBusy(busy) {
  isBusy = busy;
  form.inert = busy;
  saveDraftButton.disabled = busy;
  submitButton.disabled = busy;
  refreshJiraControls();
}

function savedDraftLabel(record) {
  const date = new Date(record.updatedAt || record.createdAt);
  const time = Number.isNaN(date.getTime()) ? "" : " às " + new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
  return "Rascunho salvo" + time + " · não enviado ao Chat";
}

function resumeDraft(record, scroll = true) {
  if (isBusy || isDirty) {
    showToast("Salve o rascunho atual antes de abrir outra ficha para preservar suas alterações.", "error");
    return;
  }
  if (!isDraftRecord(record)) return;
  formState.load(record.data || {});
  formState.setDraft(record.id);
  activeDraftRevision = record.revision || 1;
  saveAsCopy = false;
  isDirty = false;
  saveDraftButton.textContent = "Salvar rascunho";
  formState.setDraftStatus(savedDraftLabel(record));
  rememberActiveDraft(record.id);
  if (recordsDialog.open) recordsDialog.close();
  if (scroll) document.getElementById("metricas").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function restoreActiveDraft() {
  if (isDirty || isBusy) return;
  const explicitDraftId = formState.getDraftId();
  const draftId = explicitDraftId || draftReferences.recall(draftReferenceScope());
  if (!draftId) return;
  setBusy(true);
  formState.setDraftStatus("Abrindo o rascunho salvo…");
  try {
    const response = await fetch("/api/handoffs", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error("load_failed");
    storedRecords = Array.isArray(result.records) ? result.records : [];
    const record = storedRecords.find((item) => item.id === draftId);
    setBusy(false);
    if (record && isDraftRecord(record)) resumeDraft(record, false);
    else {
      draftReferences.forget(draftReferenceScope(), draftId);
      formState.setDraft(null);
      formState.setDraftStatus("Este rascunho não está disponível ou já foi concluído. Inicie uma nova ficha.");
    }
  } catch {
    setBusy(false);
    saveDraftButton.disabled = true;
    submitButton.disabled = true;
    formState.setDraftStatus("Não foi possível abrir o rascunho. Atualize a página quando o servidor estiver disponível.");
  }
}

async function saveDraft(options = {}) {
  if (isBusy || !formState.validateTickets()) return;
  if (saveAsCopy || !formState.getDraftId()) {
    formState.setDraft(formState.createId());
    activeDraftRevision = 0;
    saveAsCopy = false;
  }
  const data = getFormData();
  const signature = JSON.stringify(data);
  setBusy(true);
  saveDraftButton.textContent = "Salvando…";
  try {
    const response = await fetch("/api/drafts/" + encodeURIComponent(formState.getDraftId()), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data, revision: activeDraftRevision }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409) saveAsCopy = true;
      throw new Error(result.error || "Não foi possível salvar o rascunho.");
    }
    activeDraftRevision = result.record.revision;
    rememberActiveDraft(result.record.id);
    isDirty = signature !== JSON.stringify(getFormData());
    formState.setDraftStatus(isDirty ? "Versão salva · há alterações novas ainda não salvas" : savedDraftLabel(result.record));
    if (!options.silent) showToast("Rascunho salvo. Você pode continuar depois; nenhuma mensagem foi enviada.", "success");
    return result.record;
  } catch (error) {
    formState.setDraftStatus(saveAsCopy ? "A ficha mudou em outra sessão. Salve uma cópia para preservar suas alterações." : "Gravação não confirmada. Seus dados continuam no formulário; tente salvar novamente.");
    showToast(error.message || "Não foi possível salvar o rascunho.", "error");
    return null;
  } finally {
    setBusy(false);
    saveDraftButton.textContent = saveAsCopy ? "Salvar cópia do rascunho" : "Salvar rascunho";
  }
}

function setTodayLabel() {
  const today = new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date());
  document.getElementById("today-label").textContent = today.replace(".", "");
}

form.addEventListener("input", () => {
  if (previewDialog.open) refreshChatPreview();
  if (!isBusy) {
    isDirty = true;
    formState.setDraftStatus("Alterações ainda não salvas · clique em Salvar rascunho para continuar depois.");
  }
});
form.addEventListener("change", () => {
  if (previewDialog.open) refreshChatPreview();
});
saveDraftButton.addEventListener("click", saveDraft);
connectJiraButton.addEventListener("click", connectJira);
importJiraButton.addEventListener("click", importFromJira);
disconnectJiraButton.addEventListener("click", disconnectJira);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isBusy || !formState.validateTickets() || !form.reportValidity()) return;
  const payload = getFormData();
  const signature = JSON.stringify(payload);
  if (signature === lastSubmittedSignature) {
    showToast("Esta ficha já foi concluída. Altere o preenchimento para iniciar outra passagem.", "error");
    return;
  }
  if (!formState.getDraftId()) { formState.setDraft(formState.createId()); activeDraftRevision = 0; }
  payload.draftId = formState.getDraftId();
  payload.draftRevision = activeDraftRevision;
  setBusy(true);
  submitButton.querySelector("span:first-child").textContent = "Enviando…";
  try {
    const response = await fetch("/api/handoffs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (result.saved && result.recordId) {
      lastSubmittedSignature = signature;
      draftReferences.forget(draftReferenceScope(), result.recordId);
      formState.setDraft(null);
      activeDraftRevision = 0;
      isDirty = false;
      saveAsCopy = false;
      formState.setDraftStatus(result.mode === "sent"
        ? "Passagem concluída e publicada no Google Chat."
        : "Ficha registrada. Consulte o status de entrega em Registros antes de reenviar.");
    }
    if (!response.ok) {
      if (response.status === 409 && formState.getDraftId()) saveAsCopy = true;
      const savedNote = result.saved ? " O registro continua disponível em Registros." : "";
      showToast((result.error || "Não foi possível enviar a passagem.") + savedNote, "error");
      return;
    }
    showToast(result.mode === "sent"
      ? (result.warning || "Passagem publicada no Google Chat e salva em Registros.")
      : "Passagem concluída em Registros; webhook ausente, sem envio ao Google Chat.", result.mode === "sent" ? "success" : "error");
    await updateConnectionStatus();
  } catch {
    formState.setDraftStatus("Não foi possível confirmar o envio. Confira Registros e o Chat antes de tentar novamente.");
    showToast("Não foi possível confirmar a resposta do servidor. Confira o Chat antes de reenviar.", "error");
  } finally {
    setBusy(false);
    saveDraftButton.textContent = saveAsCopy ? "Salvar cópia do rascunho" : "Salvar rascunho";
    submitButton.querySelector("span:first-child").textContent = "Enviar passagem";
  }
});

document.getElementById("toast-close").addEventListener("click", () => {
  toast.classList.remove("visible");
});

profileMenuButton.addEventListener("click", () => {
  const open = utilityMenu.hidden;
  utilityMenu.hidden = !open;
  profileMenuButton.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (!utilityMenu.hidden && !utilityMenu.contains(event.target) && event.target !== profileMenuButton) {
    utilityMenu.hidden = true;
    profileMenuButton.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !utilityMenu.hidden) {
    utilityMenu.hidden = true;
    profileMenuButton.setAttribute("aria-expanded", "false");
  }
});

document.querySelectorAll("[data-open-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.openDialog);
    utilityMenu.hidden = true;
    profileMenuButton.setAttribute("aria-expanded", "false");
    if (dialog === previewDialog) refreshChatPreview();
    if (dialog === recordsDialog) loadRecords();
    if (dialog && !dialog.open) dialog.showModal();
  });
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

document.querySelectorAll(".app-dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

recordsDateFilter.addEventListener("change", renderRecords);
recordsTypeFilter.addEventListener("change", renderRecords);
document.getElementById("clear-record-filter").addEventListener("click", () => {
  recordsDateFilter.value = "";
  recordsTypeFilter.value = "all";
  renderRecords();
});

document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});

dateInput.value = localDateValue();
setTodayLabel();
updateConnectionStatus();
updateJiraStatus().then(async () => {
  showJiraReturnStatus();
  await restoreActiveDraft();
});
window.addEventListener("beforeunload", (event) => {
  if (!isDirty) return;
  event.preventDefault();
  event.returnValue = "";
});
