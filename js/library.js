/* BrowserDJ song library ("My songs"): every song you have worked on, kept in this browser's IndexedDB.
   Records: {id, name, updated (ms), bpm, secs, json (the project)}. Falls back to memory when IndexedDB is
   unavailable (private windows), so the page keeps working; the list then lasts until the tab closes. */
window.BDJ = window.BDJ || {};
BDJ.Library = (() => {
  'use strict';
  const DB = 'browserdj-songs', STORE = 'songs', MAX = 200;
  const memory = new Map();
  let dbp = null;

  function db() {
    if (!dbp) {
      dbp = new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch (err) { resolve(null); }
      });
    }
    return dbp;
  }
  async function run(mode, fn) {
    const d = await db();
    if (!d) return undefined;
    return new Promise((resolve) => {
      try {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch (err) { resolve(undefined); }
    });
  }

  const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* the list, newest first, without the (big) project data */
  async function list() {
    let all = await run('readonly', (st) => st.getAll());
    if (!all) all = [...memory.values()];
    return all.map(({ json, ...meta }) => meta).sort((a, b) => b.updated - a.updated);
  }
  async function get(id) {
    const rec = (await run('readonly', (st) => st.get(id))) || memory.get(id);
    return rec ? JSON.parse(rec.json) : null;
  }
  /* store a project under id (the project's own name, tempo and length go into the list) */
  async function put(id, project, secs) {
    const rec = { id, name: project.name || 'Untitled', updated: Date.now(), bpm: project.bpm, secs: Math.round(secs || 0), json: JSON.stringify(project) };
    memory.set(id, rec);
    await run('readwrite', (st) => st.put(rec));
    // keep the list to a sensible size: drop the oldest
    const all = await list();
    for (const old of all.slice(MAX)) await remove(old.id);
  }
  async function rename(id, name) {
    const rec = (await run('readonly', (st) => st.get(id))) || memory.get(id);
    if (!rec) return;
    rec.name = name;
    const p = JSON.parse(rec.json);
    p.name = name;
    rec.json = JSON.stringify(p);
    memory.set(id, rec);
    await run('readwrite', (st) => st.put(rec));
  }
  async function remove(id) {
    memory.delete(id);
    await run('readwrite', (st) => st.delete(id));
  }

  return { list, get, put, rename, remove, newId };
})();
