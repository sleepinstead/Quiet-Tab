'use strict';

const QuietTabStorage = (() => {
  const { DEFAULT, normalizeSettings, mergeValue } = QuietTabState;
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  /* ---------- storage: small settings in chrome.storage, images as blobs in IndexedDB ---------- */
  const store = {
    async get(keys) {
      if (hasChrome) return chrome.storage.local.get(keys);
      const values = {};
      for (const key of keys) {
        const item = localStorage.getItem(key);
        if (item !== null) {
          try { values[key] = JSON.parse(item); } catch { /* Ignore corrupt preview data. */ }
        }
      }
      return values;
    },
    async set(values) {
      if (hasChrome) return chrome.storage.local.set(values);
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
    },
    async remove(key) {
      if (hasChrome) return chrome.storage.local.remove(key);
      for (const name of [].concat(key)) localStorage.removeItem(name);
    }
  };
  let dbp;
  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      const request = indexedDB.open('quiettab', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('blobs');
      request.onsuccess = () => {
        const connection = request.result;
        connection.onversionchange = () => { connection.close(); dbp = null; };
        connection.onclose = () => { dbp = null; };
        resolve(connection);
      };
      request.onerror = () => { dbp = null; reject(request.error); };
    });
    return dbp;
  }
  const idb = (mode, fn) => db().then(connection => new Promise((resolve, reject) => {
    const tx = connection.transaction('blobs', mode);
    let request;
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = () => reject(tx.error || new Error('Image transaction aborted'));
    try { request = fn(tx.objectStore('blobs')); }
    catch (error) { tx.abort(); reject(error); }
  }));
  const blobs = {
    get: key => idb('readonly', store => store.get(key)),
    put: (key, value) => idb('readwrite', store => store.put(value, key)),
    del: key => idb('readwrite', store => store.delete(key))
  };

  const draftPrefix = 'qt-pending-';
  const draftKey = draftPrefix + crypto.randomUUID();
  const select = (keys, values) => Object.fromEntries(keys.map(key => [key, values[key]]));

  // pagehide and visibilitychange do not keep a page alive for an async storage
  // write. Save its pending edits synchronously for the next lock holder.
  function journalEdits(generation, keys, base, edits) {
    localStorage.setItem(draftKey, JSON.stringify({
      generation, keys, base: select(keys, base), edits: select(keys, edits), time: Date.now()
    }));
  }

  async function commitEdits(generation, keys, base, edits) {
    const latest = await store.get([...keys, 'generation']);
    if ((latest.generation || '') !== generation) return false;
    const remote = normalizeSettings(latest);
    const patch = Object.fromEntries(keys.map(key => [key, mergeValue(base[key], edits[key], remote[key])]));
    // The active background and its asset key are one logical setting.
    if (keys.includes('bgKey')) { patch.bgKey = edits.bgKey; patch.hasImg = edits.hasImg; }
    await store.set(patch);
    const unused = [];
    if (patch.board) {
      const kept = new Set(patch.board.map(item => item.id));
      for (const item of remote.board) if (item.type === 'img' && !kept.has(item.id)) unused.push(item.id);
    }
    if ((patch.bgKey && patch.bgKey !== remote.bgKey) || patch.hasImg === false) unused.push(remote.bgKey);
    if (unused.length) await idb('readwrite', assets => { for (const key of unused) assets.delete(key); }).catch(() => {});
    return true;
  }

  async function recoverEdits() {
    const drafts = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name?.startsWith(draftPrefix)) continue;
      try {
        const raw = localStorage.getItem(name);
        const draft = JSON.parse(raw);
        if (!Array.isArray(draft.keys) || !draft.base || !draft.edits) continue;
        drafts.push({ name, raw, draft });
      } catch { /* An invalid draft cannot be applied. */ }
    }
    drafts.sort((a, b) => a.draft.time - b.draft.time);
    for (const { name, raw, draft } of drafts) {
      const keys = draft.keys.filter(key => Object.hasOwn(DEFAULT, key) && key !== 'generation');
      if (keys.length) await commitEdits(draft.generation, keys, normalizeSettings(draft.base), normalizeSettings(draft.edits));
      if (localStorage.getItem(name) === raw) localStorage.removeItem(name);
    }
  }

  const withWriteLock = fn => navigator.locks.request('quiet-tab-storage', async () => {
    await recoverEdits();
    return fn();
  });
  return { hasChrome, store, blobs, idb, journalEdits, withWriteLock, commitEdits };
})();
