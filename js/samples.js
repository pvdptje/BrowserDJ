/* BrowserDJ sample store: your own sounds, kept in the browser's IndexedDB and keyed by a fingerprint of the
   file's bytes. The project only stores {hash, name}, so undo steps and autosaves stay small. Saved project
   files carry the audio itself (base64) so they work on any computer. */
window.BDJ = window.BDJ || {};
BDJ.Samples = (() => {
  'use strict';
  const DB = 'browserdj', STORE = 'samples', MAX_BYTES = 12 * 1024 * 1024;
  const memory = new Map(); // fallback when IndexedDB is unavailable (private windows, blocked storage)
  let dbp = null;

  function db() {
    if (!dbp) {
      dbp = new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(STORE);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch (err) { resolve(null); }
      });
    }
    return dbp;
  }
  async function idb(mode, fn) {
    const d = await db();
    if (!d) return undefined;
    return new Promise((resolve) => {
      try {
        const tx = d.transaction(STORE, mode), st = tx.objectStore(STORE), req = fn(st);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch (err) { resolve(undefined); }
    });
  }

  /* a short, stable fingerprint of the bytes */
  async function hashOf(bytes) {
    try {
      if (crypto && crypto.subtle) {
        const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (err) { /* no SubtleCrypto here */ }
    // FNV-1a fallback, plus the length
    const u = new Uint8Array(bytes);
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < u.length; i++) { a ^= u[i]; a = Math.imul(a, 0x01000193) >>> 0; b = Math.imul(b ^ u[i], 0x5bd1e995) >>> 0; }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0') + u.length.toString(16);
  }

  /* store a file's bytes; returns {hash, name} */
  async function put(name, type, bytes) {
    if (bytes.byteLength > MAX_BYTES) throw new Error('too big (' + Math.round(bytes.byteLength / 1048576) + ' MB; the limit is 12 MB)');
    const hash = await hashOf(bytes);
    const rec = { name, type: type || '', bytes };
    memory.set(hash, rec);
    await idb('readwrite', (st) => st.put(rec, hash));
    return { hash, name };
  }
  async function get(hash) {
    if (memory.has(hash)) return memory.get(hash);
    const rec = await idb('readonly', (st) => st.get(hash));
    if (rec) memory.set(hash, rec);
    return rec || null;
  }

  /* ---------- base64 for project files ---------- */
  function toB64(bytes) {
    const u = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64), u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
  }
  /* {hash: {name, type, data}} for the given hashes that we have */
  async function pack(hashes) {
    const out = {};
    for (const h of hashes) {
      const rec = await get(h);
      if (rec) out[h] = { name: rec.name, type: rec.type, data: toB64(rec.bytes) };
    }
    return out;
  }
  /* store everything in a packed object; returns how many were usable */
  async function unpack(obj) {
    let n = 0;
    for (const [h, rec] of Object.entries(obj || {})) {
      if (!rec || typeof rec.data !== 'string') continue;
      try {
        const bytes = fromB64(rec.data);
        if (bytes.byteLength > MAX_BYTES) continue;
        // keep the hash the project refers to, even if this browser would compute it differently
        const r = { name: String(rec.name || 'sample').slice(0, 120), type: String(rec.type || ''), bytes };
        memory.set(h, r);
        await idb('readwrite', (st) => st.put(r, h));
        n++;
      } catch (err) { /* skip a broken entry */ }
    }
    return n;
  }

  return { put, get, pack, unpack, hashOf, MAX_BYTES };
})();
