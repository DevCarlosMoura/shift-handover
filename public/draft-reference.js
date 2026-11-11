(function (browser, factory) {
  "use strict";
  const api = factory(browser);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (browser) browser.HandoffDraftReference = api;
})(typeof window !== "undefined" ? window : null, function (browser) {
  "use strict";
  const TTL = 30 * 24 * 60 * 60 * 1000;
  const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9-]{16,64}$/.test(id);
  const validScope = (scope) => scope === "manual" || (typeof scope === "string" && /^[a-f0-9]{64}$/.test(scope));

  function create(storage, now = Date.now) {
    if (storage === undefined) {
      try { storage = browser && browser.localStorage; } catch { storage = null; }
    }
    const key = (scope) => validScope(scope) ? "handovers:last-draft:v1:" + scope : null;
    function recall(scope) {
      const name = key(scope);
      if (!name || !storage) return null;
      try {
        const value = JSON.parse(storage.getItem(name));
        if (!value || value.version !== 1 || !validId(value.id) || !Number.isFinite(value.savedAt)
          || value.savedAt > now() + 60000 || now() - value.savedAt >= TTL) {
          storage.removeItem(name);
          return null;
        }
        return value.id;
      } catch { return null; }
    }
    function remember(scope, id) {
      const name = key(scope);
      if (!name || !validId(id) || !storage) return false;
      try {
        storage.setItem(name, JSON.stringify({ version: 1, id, savedAt: now() }));
        return true;
      } catch { return false; }
    }
    function forget(scope, id) {
      const name = key(scope);
      if (!name || !storage) return;
      try { if (!id || recall(scope) === id) storage.removeItem(name); } catch {}
    }
    return Object.freeze({ recall, remember, forget });
  }

  return Object.freeze({ create });
});
