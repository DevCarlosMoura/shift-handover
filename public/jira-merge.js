(function (browser, factory) {
  "use strict";
  const configuredPrefix = browser && browser.HandoffConfig && browser.HandoffConfig.ticketPrefix;
  const api = Object.freeze({ ...factory(configuredPrefix || "OPS"), create: factory });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (browser) browser.HandoffJiraMerge = api;
})(typeof window !== "undefined" ? window : null, function (prefix) {
  "use strict";
  prefix = String(prefix === undefined ? "OPS" : prefix).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(prefix)) throw new TypeError("O prefixo do projeto é inválido.");
  const ticketPattern = new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-\\d{1,12}$");

  function normalizeList(value, label) {
    if (!Array.isArray(value)) throw new TypeError(label + " precisa ser uma lista de IDs.");
    const unique = [];
    const seen = new Set();
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] !== "string") {
        throw new TypeError(label + " contém um ID inválido na posição " + (index + 1) + ".");
      }
      const id = value[index].trim().toUpperCase();
      if (!ticketPattern.test(id)) {
        throw new TypeError(label + " contém um ID inválido na posição " + (index + 1) + ".");
      }
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    return unique;
  }

  function normalizeTitles(value, ids, label) {
    if (value === undefined) return {};
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") throw new TypeError(label + " precisa ser um mapa de títulos.");
    const result = {};
    const seen = new Set();
    for (const [rawId, title] of Object.entries(value)) {
      const id = normalizeList([rawId], label)[0];
      if (!ids.has(id) || seen.has(id) || typeof title !== "string") throw new TypeError(label + " contém um chamado ou título inválido.");
      seen.add(id);
      const normalized = title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
      if (normalized.length > 255) throw new TypeError("O título do chamado deve ter até 255 caracteres.");
      if (normalized) result[id] = normalized;
    }
    return result;
  }

  function titlesEqual(left, right) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((id) => left[id] === right[id]);
  }

  function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function merge(current, incoming) {
    if (!current || typeof current !== "object" || Array.isArray(current)
        || !incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      throw new TypeError("Os chamados atuais e a importação precisam ser objetos válidos.");
    }

    // Validate all four lists before computing a result. Nothing is mutated.
    const currentFinalized = normalizeList(current.chamadosAtendidos, "Chamados finalizados atuais");
    const currentPending = normalizeList(current.chamadosPendentesIds, "Chamados pendentes atuais");
    const importedFinalized = normalizeList(incoming.finalized, "Chamados finalizados importados");
    const importedPending = normalizeList(incoming.pending, "Chamados pendentes importados");
    const currentTitles = normalizeTitles(current.chamadosTitulos, new Set(currentFinalized.concat(currentPending)), "Títulos atuais");
    const importedTitles = normalizeTitles(incoming.titles, new Set(importedFinalized.concat(importedPending)), "Títulos importados");

    // Pending wins if an inconsistent source includes one ID in both lists.
    const currentPendingSet = new Set(currentPending);
    const existingFinalized = currentFinalized.filter((id) => !currentPendingSet.has(id));
    const importedPendingSet = new Set(importedPending);
    const finalImports = importedFinalized.filter((id) => !importedPendingSet.has(id));

    const previousStatus = new Map();
    existingFinalized.forEach((id) => previousStatus.set(id, "finalized"));
    currentPending.forEach((id) => previousStatus.set(id, "pending"));
    const nextStatus = new Map(previousStatus);
    finalImports.forEach((id) => nextStatus.set(id, "finalized"));
    importedPending.forEach((id) => nextStatus.set(id, "pending"));

    let added = 0;
    let moved = 0;
    nextStatus.forEach((status, id) => {
      if (!previousStatus.has(id)) added += 1;
      else if (previousStatus.get(id) !== status) moved += 1;
    });

    // Keep the destination's existing order, then its moved existing IDs,
    // then genuinely new IDs in import order. Manual IDs absent from Jira stay.
    const finalExistingOrder = existingFinalized.concat(currentPending);
    const pendingExistingOrder = currentPending.concat(existingFinalized);
    const chamadosAtendidos = finalExistingOrder.filter((id) => nextStatus.get(id) === "finalized")
      .concat(finalImports.filter((id) => !previousStatus.has(id)));
    const chamadosPendentesIds = pendingExistingOrder.filter((id) => nextStatus.get(id) === "pending")
      .concat(importedPending.filter((id) => !previousStatus.has(id)));

    const chamadosTitulos = {};
    for (const id of chamadosAtendidos.concat(chamadosPendentesIds)) {
      const title = currentTitles[id] || importedTitles[id];
      if (title) chamadosTitulos[id] = title;
    }

    return {
      chamadosAtendidos,
      chamadosPendentesIds,
      chamadosTitulos,
      added,
      moved,
      changed: !arraysEqual(chamadosAtendidos, current.chamadosAtendidos)
        || !arraysEqual(chamadosPendentesIds, current.chamadosPendentesIds)
        || !titlesEqual(chamadosTitulos, currentTitles),
    };
  }

  return Object.freeze({ merge });
});
