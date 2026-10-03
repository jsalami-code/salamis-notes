// github.js - notes kept in a private GitHub repository.
//
// Offers the same four methods sync.js expects (list/get/put/del), so the sync engine and
// all its tested behaviour - including conflict copies - work here unchanged.
//
// GitHub's contents API fits this well: every file read comes with a blob `sha`, and a
// write must quote the sha it is replacing. If someone else changed the file meanwhile,
// GitHub refuses with 409, which is exactly the signal sync.js turns into a conflict copy
// rather than an overwrite. That sha is what we store as the note's "tag".
//
// The token is a fine-grained personal access token limited to this one repository. It
// lives in this device's browser storage - see the README on what that means.

const API = 'https://api.github.com';
const CFG = 'sn:gh';

export const defaults = { owner: '', repo: '', path: 'notes', token: '' };

export function config() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CFG)) || {}; } catch { /* first run */ }
  return { ...defaults, ...saved };
}
export function setConfig(patch) {
  localStorage.setItem(CFG, JSON.stringify({ ...config(), ...patch }));
}
export function configured() {
  const c = config();
  return !!(c.owner && c.repo && c.token);
}

// GitHub's base64 carries newlines, and notes may hold characters outside Latin-1, so
// neither atob nor btoa can be used on their own.
function decode(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}
function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function call(url, opts = {}) {
  const c = config();
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + c.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('GitHub rejected the token - check it has not expired');
  if (res.status === 403) throw new Error('GitHub refused: the token may lack Contents write on this repo');
  if (res.status === 409) throw new Error('changed in GitHub since we last looked');
  if (res.status === 422) throw new Error('changed in GitHub since we last looked');
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res;
}

function dir() {
  const c = config();
  return c.path.replace(/^\/+|\/+$/g, '');
}
function fileOf(id) {
  const d = dir();
  return `/repos/${encodeURIComponent(config().owner)}/${encodeURIComponent(config().repo)}/contents/`
    + (d ? d.split('/').map(encodeURIComponent).join('/') + '/' : '') + `note-${encodeURIComponent(id)}.json`;
}

export const remote = {
  async list() {
    const d = dir();
    const url = `/repos/${encodeURIComponent(config().owner)}/${encodeURIComponent(config().repo)}/contents/`
      + d.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const res = await call(url);
    if (res.status === 404) return [];      // the folder is not there yet: nothing to sync down
    const items = await res.json();
    if (!Array.isArray(items)) throw new Error('that path is a file, not a folder');
    return items
      .filter((f) => f.type === 'file' && /^note-.+\.json$/i.test(f.name))
      .map((f) => ({ id: f.name.replace(/^note-|\.json$/g, ''), tag: f.sha }));
  },

  async get(id) {
    const res = await call(fileOf(id));
    if (res.status === 404) throw new Error('note not found in GitHub');
    const item = await res.json();
    return { json: JSON.parse(decode(item.content)), tag: item.sha };
  },

  async put(id, json, tag) {
    const body = {
      message: `note ${id} from ${navigator.platform || 'the web app'}`,
      content: encode(JSON.stringify(json, null, 4)),
    };
    if (tag) body.sha = tag;                 // replacing a known version
    const res = await call(fileOf(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 404) throw new Error('cannot write - check the repository and path');
    return { tag: (await res.json()).content.sha };
  },

  async del(id, tag) {
    if (!tag) {                              // we never knew its sha: look it up first
      const res = await call(fileOf(id));
      if (res.status === 404) return;
      tag = (await res.json()).sha;
    }
    const res = await call(fileOf(id), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `delete note ${id}`, sha: tag }),
    });
    if (res.status === 404) return;          // already gone
  },

  // Used by the settings screen before the first sync.
  async check() {
    const c = config();
    const r = await call(`/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`);
    if (r.status === 404) throw new Error('repository not found, or the token cannot see it');
    const repo = await r.json();
    const notes = await this.list();
    return { repo: repo.full_name, private: repo.private, path: dir() || '(root)', notes: notes.length };
  },
};
