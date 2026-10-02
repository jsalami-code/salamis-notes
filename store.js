// store.js - where notes live, behind one small interface.
//
// The UI only ever calls the store, never a backend directly, so stage 3 can drop in a
// OneDrive/Graph backend without the screens changing. Today there is one backend: a
// local copy in localStorage, seeded once from the notes folder served beside this app.
//
// A note is kept exactly as its note-<id>.json file: whatever fields the Windows app
// wrote stay on the object, so writing it back cannot lose anything we do not understand.

const PREFIX = 'sn:note:';
const META = 'sn:meta';
const SYNC = 'sn:sync';     // per note: the tag OneDrive gave us, and what we sent
const GONE = 'sn:deleted';  // notes deleted here, not yet deleted there

// A cheap fingerprint (FNV-1a) of a note, to tell "changed here" from "untouched".
function fingerprint(json) {
  const s = JSON.stringify(json);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function newId() {
  // the Windows app uses 8 hex characters from a GUID; match that so ids look alike
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class LocalStore {
  constructor() { this.listeners = new Set(); }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _fire() { for (const fn of this.listeners) fn(); }

  get meta() { try { return JSON.parse(localStorage.getItem(META)) || {}; } catch { return {}; } }
  set meta(v) { localStorage.setItem(META, JSON.stringify(v)); }

  ids() {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length));
  }

  all() {
    return this.ids().map((id) => {
      try { return { id, json: JSON.parse(localStorage.getItem(PREFIX + id)) }; }
      catch { return null; }
    }).filter(Boolean);
  }

  get(id) {
    try { return JSON.parse(localStorage.getItem(PREFIX + id)); } catch { return null; }
  }

  put(id, json) {
    localStorage.setItem(PREFIX + id, JSON.stringify(json));
    this._fire();
    return json;
  }

  remove(id) {
    localStorage.removeItem(PREFIX + id);
    const m = this.syncMeta;
    if (m[id]) {   // it existed in OneDrive: remember to delete it there too
      const t = this.tombstones;
      t[id] = { tag: m[id].tag, at: new Date().toISOString() };
      this.tombstones = t;
      delete m[id]; this.syncMeta = m;
    }
    this._fire();
  }

  // A new note of the given kind, with the same defaults the Windows app uses.
  create(kind, extra = {}) {
    const id = newId();
    const base = {
      text: '', x: -99999, y: -99999, w: 300, h: 280, color: 0, top: true,
      font: 11, opacity: 1.0, edited: '', journal: true, name: '',
    };
    if (kind === 'todo' || kind === 'today') { base.todo = true; base.today = kind === 'today'; base.color = 1; }
    if (kind === 'tracker' || kind === 'monthly') {
      base.tracker = true; base.monthly = kind === 'monthly';
      base.color = kind === 'monthly' ? 4 : 2;
      base.w = 420; base.h = 360;
    }
    return { id, json: this.put(id, { ...base, ...extra }) };
  }

  // Seed from the folder this app is served from, once. The dev server lists the
  // directory, which is how we learn the file names; a real backend will not need this.
  async seedFromFolder(force = false) {
    if (!force && this.meta.seeded) return { skipped: true, count: this.ids().length };
    const res = await fetch('../');
    if (!res.ok) throw new Error('cannot read the notes folder (HTTP ' + res.status + ')');
    const names = [...new Set([...(await res.text()).matchAll(/note-[A-Za-z0-9_-]+\.json/g)].map((m) => m[0]))];
    let count = 0;
    for (const name of names) {
      try {
        const json = await (await fetch('../' + name)).json();
        this.put(name.replace(/^note-|\.json$/g, ''), json);
        count++;
      } catch { /* a note we cannot read is left alone rather than replaced with a broken one */ }
    }
    this.meta = { ...this.meta, seeded: new Date().toISOString() };
    return { skipped: false, count };
  }

  clear() {
    for (const id of this.ids()) localStorage.removeItem(PREFIX + id);
    this.meta = {};
    localStorage.removeItem(SYNC);
    localStorage.removeItem(GONE);
    this._fire();
  }

  // --- what sync needs to know ------------------------------------------------------
  // For each note: the tag OneDrive gave us when we last agreed, and a fingerprint of
  // what we sent. If the note no longer matches that fingerprint, it changed here.

  get syncMeta() { try { return JSON.parse(localStorage.getItem(SYNC)) || {}; } catch { return {}; } }
  set syncMeta(v) { localStorage.setItem(SYNC, JSON.stringify(v)); }

  mark(id, tag, json) {
    const m = this.syncMeta;
    m[id] = { tag, hash: fingerprint(json), at: new Date().toISOString() };
    this.syncMeta = m;
  }
  unmark(id) { const m = this.syncMeta; delete m[id]; this.syncMeta = m; }

  isDirty(id) {
    const j = this.get(id);
    if (!j) return false;
    const m = this.syncMeta[id];
    return !m || m.hash !== fingerprint(j);
  }

  // Notes deleted here, remembered until the deletion has been carried to OneDrive.
  get tombstones() { try { return JSON.parse(localStorage.getItem(GONE)) || {}; } catch { return {}; } }
  set tombstones(v) { localStorage.setItem(GONE, JSON.stringify(v)); }
  forget(id) { const t = this.tombstones; delete t[id]; this.tombstones = t; }
}

export const store = new LocalStore();
