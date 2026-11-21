/* BrowserDJ share links: the whole song packed into the link itself, after the '#', so no server ever sees it.
   The project JSON is deflate-compressed (CompressionStream) and written as URL-safe base64.
   Token format: 'z' + base64url(deflate-raw(json)), or 'j' + base64url(json) where compression is missing.
   Works in the browser and in Node 18+ (for tests). */
(function (root) {
  'use strict';

  function toB64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  async function pipe(bytes, Stream, kind) {
    const stream = new Blob([bytes]).stream().pipeThrough(new Stream(kind));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  /* project (plain object) -> token. Your own samples cannot travel in a link, so their audio is left out. */
  async function encode(project) {
    const lean = Object.assign({}, project);
    delete lean.sampleData;
    const json = new TextEncoder().encode(JSON.stringify(lean));
    if (canCompress()) return 'z' + toB64url(await pipe(json, CompressionStream, 'deflate-raw'));
    return 'j' + toB64url(json);
  }

  /* token -> project object (not yet validated: run it through BDJ.Project.normalize) */
  async function decode(token) {
    if (typeof token !== 'string' || token.length < 2) throw new Error('empty link');
    const kind = token[0], body = fromB64url(token.slice(1));
    let json;
    if (kind === 'z') {
      if (!canCompress()) throw new Error('this browser cannot unpack compressed links');
      json = await pipe(body, DecompressionStream, 'deflate-raw');
    } else if (kind === 'j') json = body;
    else throw new Error('unknown link format');
    return JSON.parse(new TextDecoder().decode(json));
  }

  const api = { encode, decode, PARAM: 's' };
  root.BDJ = root.BDJ || {};
  root.BDJ.Share = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
