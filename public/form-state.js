(function (global) {
  "use strict";
  const configuredPrefix = global.HandoffConfig && global.HandoffConfig.ticketPrefix;
  const ticketPrefix = /^[A-Z][A-Z0-9_]{0,19}$/.test(configuredPrefix || "") ? configuredPrefix : "OPS";
  const escapedPrefix = ticketPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefixStart = new RegExp("^" + escapedPrefix + "-", "i");
  const searchPrefixStart = new RegExp("^" + escapedPrefix + "[\\s-]*", "i");
  const form = document.getElementById("handoff-form");
  const groups = [
    { list: document.getElementById("ticket-list"), add: document.getElementById("add-ticket"), key: "chamadosAtendidos", label: "finalizado", pending: false, search: document.getElementById("ticket-search"), count: document.getElementById("ticket-count"), results: document.getElementById("ticket-results"), empty: document.getElementById("ticket-empty") },
    { list: document.getElementById("pending-ticket-list"), add: document.getElementById("add-pending-ticket"), key: "chamadosPendentesIds", label: "pendente", pending: true, search: document.getElementById("pending-ticket-search"), count: document.getElementById("pending-ticket-count"), results: document.getElementById("pending-ticket-results"), empty: document.getElementById("pending-ticket-empty") },
  ];
  let activeDraftId = new URL(global.location.href).searchParams.get("draft");
  if (activeDraftId && !/^[a-zA-Z0-9-]{16,64}$/.test(activeDraftId)) activeDraftId = null;

  function numbers(group) {
    return Array.from(group.list.querySelectorAll(".ticket-number"))
      .map((input) => input.value.trim()).filter(Boolean);
  }

  function filterRows(group, focusedElement = document.activeElement) {
    const query = group.search.value.trim().toUpperCase().replace(searchPrefixStart, "");
    let total = 0;
    let matches = 0;
    let visible = 0;
    group.list.querySelectorAll(".ticket-row").forEach((row) => {
      const value = row.querySelector(".ticket-number").value.trim();
      const matchesQuery = !query || value.includes(query);
      if (value) { total += 1; if (matchesQuery) matches += 1; }
      // Keep an edited row available until focus leaves it; filtering never removes data.
      row.hidden = !matchesQuery && !row.contains(focusedElement);
      if (!row.hidden) visible += 1;
    });
    group.count.textContent = String(total);
    group.results.textContent = query ? matches + " de " + total + " chamados" : total + (total === 1 ? " chamado na lista" : " chamados na lista");
    group.empty.hidden = !query || visible > 0;
  }

  function clearSearch(group) {
    group.search.value = "";
    group.list.scrollTop = 0;
  }

  function sync() {
    groups.forEach((group) => {
      const rows = group.list.querySelectorAll(".ticket-row");
      rows.forEach((row) => {
        row.querySelector(".ticket-remove").hidden = rows.length === 1;
        const complete = row.querySelector(".ticket-complete");
        if (complete) complete.disabled = !row.querySelector(".ticket-number").value.trim();
      });
      filterRows(group);
    });
    form.elements.namedItem("chamadosResolvidos").value = String(numbers(groups[0]).length);
    form.elements.namedItem("chamadosPendentes").value = String(numbers(groups[1]).length);
  }

  function changed() {
    groups.forEach((group) => group.list.querySelectorAll(".ticket-number").forEach((input) => input.setCustomValidity("")));
    sync();
    form.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function makeRow(group, value) {
    const row = document.createElement("div");
    row.className = "ticket-row";
    const prefix = document.createElement("span");
    prefix.className = "ticket-prefix";
    prefix.setAttribute("aria-hidden", "true");
    prefix.textContent = ticketPrefix + "-";
    const input = document.createElement("input");
    input.className = "ticket-number";
    input.type = "text";
    input.inputMode = "numeric";
    input.pattern = "[0-9]+";
    input.maxLength = 12;
    input.autocomplete = "off";
    input.placeholder = "Número";
    input.value = String(value || "").replace(prefixStart, "");
    input.setAttribute("aria-label", "Número do chamado " + group.label);
    row.append(prefix, input);
    if (group.pending) {
      const complete = document.createElement("button");
      complete.type = "button";
      complete.className = "ticket-complete";
      complete.textContent = "✓";
      complete.title = "Mover para chamados finalizados";
      complete.setAttribute("aria-label", "Marcar chamado como finalizado");
      row.append(complete);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ticket-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remover chamado " + group.label);
    row.append(remove);
    return row;
  }

  function fill(group, values) {
    clearSearch(group);
    const fragment = document.createDocumentFragment();
    (Array.isArray(values) && values.length ? values : [""]).forEach((value) => fragment.append(makeRow(group, value)));
    group.list.replaceChildren(fragment);
  }

  function validateTickets() {
    const seen = new Set();
    groups.forEach((group) => group.list.querySelectorAll(".ticket-number").forEach((input) => input.setCustomValidity("")));
    for (const group of groups) {
      for (const input of group.list.querySelectorAll(".ticket-number")) {
        const number = input.value.trim();
        if (number && !/^\d{1,12}$/.test(number)) input.setCustomValidity("Informe somente os números do chamado, com até 12 dígitos.");
        if (number && seen.has(number)) input.setCustomValidity("Este chamado já está na ficha. Use apenas uma das listas para cada chamado.");
        if (!input.checkValidity()) {
          clearSearch(group);
          filterRows(group);
          input.focus();
          input.reportValidity();
          return false;
        }
        if (number) seen.add(number);
      }
    }
    return true;
  }

  groups.forEach((group) => {
    group.search.placeholder = "Buscar " + ticketPrefix + "-número";
    fill(group, []);
    group.search.addEventListener("input", (event) => {
      event.stopPropagation();
      group.list.scrollTop = 0;
      filterRows(group);
    });
    group.search.addEventListener("change", (event) => event.stopPropagation());
    group.search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
    group.add.addEventListener("click", () => {
      clearSearch(group);
      const row = makeRow(group, "");
      group.list.append(row);
      changed();
      row.querySelector(".ticket-number").focus();
    });
    group.list.addEventListener("input", () => {
      groups.forEach((item) => item.list.querySelectorAll(".ticket-number").forEach((input) => input.setCustomValidity("")));
      sync();
    });
    group.list.addEventListener("focusout", (event) => filterRows(group, event.relatedTarget));
    group.list.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const row = button.closest(".ticket-row");
      if (!row) return;
      const input = row.querySelector(".ticket-number");
      const visibleRows = Array.from(group.list.querySelectorAll(".ticket-row")).filter((item) => !item.hidden);
      const position = visibleRows.indexOf(row);
      let destination;
      if (button.classList.contains("ticket-complete")) {
        if (!validateTickets() || !input.value.trim()) return;
        clearSearch(groups[0]);
        const target = Array.from(groups[0].list.querySelectorAll(".ticket-number")).find((field) => !field.value.trim());
        if (target) { target.value = input.value.trim(); destination = target; }
        else {
          const newRow = makeRow(groups[0], input.value.trim());
          groups[0].list.append(newRow);
          destination = newRow.querySelector(".ticket-number");
        }
      }
      if (group.list.querySelectorAll(".ticket-row").length === 1) { input.value = ""; clearSearch(group); }
      else row.remove();
      changed();
      if (destination) destination.focus();
      else {
        const remaining = Array.from(group.list.querySelectorAll(".ticket-row")).filter((item) => !item.hidden);
        const next = remaining[Math.min(Math.max(position, 0), remaining.length - 1)];
        if (next) next.querySelector(".ticket-number").focus();
        else group.search.focus();
      }
    });
  });

  function read() {
    sync();
    const data = Object.fromEntries(new FormData(form).entries());
    groups.forEach((group) => { data[group.key] = numbers(group).map((number) => ticketPrefix + "-" + number); });
    return data;
  }

  function load(data) {
    form.querySelectorAll("[name]").forEach((field) => {
      if (field.tagName === "BUTTON") return;
      const value = data && data[field.name];
      field.value = typeof value === "string" || typeof value === "number" ? String(value) : "";
    });
    groups.forEach((group) => fill(group, data && data[group.key]));
    sync();
  }

  function mergeTickets(incoming) {
    if (!global.HandoffJiraMerge) throw new Error("A integração de listas ainda não foi carregada. Atualize a página.");
    const merged = global.HandoffJiraMerge.merge({
      chamadosAtendidos: numbers(groups[0]).map((number) => ticketPrefix + "-" + number),
      chamadosPendentesIds: numbers(groups[1]).map((number) => ticketPrefix + "-" + number),
    }, incoming);
    if (merged.changed) {
      fill(groups[0], merged.chamadosAtendidos);
      fill(groups[1], merged.chamadosPendentesIds);
      changed();
    }
    return merged;
  }

  function setDraft(id) {
    activeDraftId = id || null;
    try {
      const url = new URL(global.location.href);
      if (activeDraftId) url.searchParams.set("draft", activeDraftId);
      else url.searchParams.delete("draft");
      global.history.replaceState(null, "", url.href);
    } catch { /* Saving still works if URL updates are unavailable. */ }
  }

  function createId() {
    if (global.crypto.randomUUID) return global.crypto.randomUUID();
    const bytes = global.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  sync();
  global.HandoffForm = Object.freeze({
    read, load, validateTickets, mergeTickets, createId, setDraft,
    getDraftId: () => activeDraftId,
    setDraftStatus: (text) => { document.getElementById("draft-status").textContent = text; },
  });
})(window);
