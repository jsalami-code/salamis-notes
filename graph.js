// graph.js - OneDrive, through Microsoft Graph.
//
// Presents the same four methods sync.js expects (list/get/put/del), so the sync engine
// neither knows nor cares that this is the real thing rather than the test's fake.
//
// Signing in uses MSAL's redirect flow: more reliable than a popup on a phone, where
// popups are often blocked outright. There is no client secret - a web app cannot keep
// one - so the Azure registration must be a *public client / SPA*, which is exactly what
// the setup notes in the README ask for.

const MSAL_URL = 'https://alcdn.msauth.net/browser/3.10.0/js/msal-browser.min.js';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const CFG_KEY = 'sn:cfg';

export const defaults = {
  clientId: '',                                     // from your Azure app registration
  notesPath: 'Personal Development/StickyNotes',    // the folder inside your OneDrive
  scopes: ['Files.ReadWrite', 'User.Read'],
};

export function config() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { /* first run */ }
  return { ...defaults, ...saved };
}
export function setConfig(patch) {
  localStorage.setItem(CFG_KEY, JSON.stringify({ ...config(), ...patch }));
}

let msal = null;      // the MSAL application, once signed in
let account = null;

function loadScript(src) {
  return new Promise((ok, bad) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => bad(new Error('cannot load MSAL - are you offline?'));
    document.head.append(s);
  });
}

async function app() {
  if (msal) return msal;
  const { clientId } = config();
  if (!clientId) throw new Error('No Client ID yet - add it in Sync settings.');
  await loadScript(MSAL_URL);
  msal = new msalBrowser.PublicClientApplication({
    auth: {
      clientId,
      authority: 'https://login.microsoftonline.com/common',
      redirectUri: location.origin + location.pathname,
    },
    cache: { cacheLocation: 'localStorage' },   // so a phone keeps you signed in
  });
  await msal.initialize();
  return msal;
}

// Call once at start-up: finishes a sign-in that redirected away and came back.
export async function resume() {
  if (!config().clientId) return null;
  try {
    const m = await app();
    const res = await m.handleRedirectPromise();
    account = res?.account || m.getAllAccounts()[0] || null;
    if (account) m.setActiveAccount(account);
    return account;
  } catch (e) {
    console.warn('sign-in could not resume:', e.message);
    return null;
  }
}

export function signedInAs() { return account?.username || null; }

export async function signIn() {
  const m = await app();
  await m.loginRedirect({ scopes: config().scopes });   // leaves the page; resume() picks it up
}

export async function signOut() {
  const m = await app();
  account = null;
  await m.logoutRedirect();
}

async function token() {
  const m = await app();
  const acct = account || m.getAllAccounts()[0];
  if (!acct) throw new Error('not signed in');
  try {
    const r = await m.acquireTokenSilent({ scopes: config().scopes, account: acct });
    return r.accessToken;
  } catch {
    await m.acquireTokenRedirect({ scopes: config().scopes, account: acct });
    throw new Error('signing in again...');
  }
}

async function call(url, opts = {}) {
  const t = await token();
  const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    ...opts,
    headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) },
  });
  if (res.status === 412) throw new Error('changed in OneDrive since we last looked');
  if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 180)}`);
  return res;
}

// The folder, as a Graph path. Each segment is encoded; the slashes stay.
function base() {
  const p = config().notesPath.replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/');
  return `/me/drive/root:/${p}`;
}
const fileOf = (id) => `${base()}/note-${encodeURIComponent(id)}.json`;

// cTag changes when the content changes; eTag is what if-match wants. Keep both.
const tagOf = (item) => `${item.cTag || ''}|${item.eTag || ''}`;
const etagOf = (tag) => (tag || '').split('|')[1] || undefined;

export const remote = {
  async list() {
    const out = [];
    let url = `${base()}:/children?$select=name,cTag,eTag&$top=200`;
    while (url) {
      const page = await (await call(url)).json();
      for (const item of page.value || []) {
        const m = /^note-(.+)\.json$/i.exec(item.name || '');
        if (m) out.push({ id: m[1], tag: tagOf(item) });
      }
      url = page['@odata.nextLink'] || null;
    }
    return out;
  },

  async get(id) {
    const item = await (await call(fileOf(id))).json();
    const json = await (await call(`${fileOf(id)}:/content`)).json();
    return { json, tag: tagOf(item) };
  },

  async put(id, json, tag) {
    const headers = { 'Content-Type': 'application/json' };
    const etag = etagOf(tag);
    if (etag) headers['if-match'] = etag;
    const res = await call(`${fileOf(id)}:/content`, {
      method: 'PUT', headers, body: JSON.stringify(json, null, 4),
    });
    return { tag: tagOf(await res.json()) };
  },

  async del(id, tag) {
    const headers = {};
    const etag = etagOf(tag);
    if (etag) headers['if-match'] = etag;
    const res = await fetch(GRAPH + fileOf(id), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + (await token()), ...headers },
    });
    if (res.status === 404) return;            // already gone: nothing to do
    if (res.status === 412) throw new Error('changed in OneDrive since we last looked');
    if (!res.ok) throw new Error(`Graph ${res.status}`);
  },

  // Does the folder exist, and can we see it? Used by the settings screen.
  async check() {
    const item = await (await call(base())).json();
    const kids = await (await call(`${base()}:/children?$select=name&$top=200`)).json();
    const notes = (kids.value || []).filter((f) => /^note-.+\.json$/i.test(f.name || '')).length;
    return { name: item.name, path: config().notesPath, notes };
  },
};
