// app.js - the screens.
//
// Two of them: the list (search, category filter, grouped) and one open note, rendered
// as a text note, a to-do list, a task tracker or a monthly activity list. Everything is
// written back through notes.js so the Windows app reads it unchanged.

import {
  noteKind, KIND_LABEL, noteTitle, parseTodo, formatTodo, splitTask, formatTask,
  parseTracker, formatTracker, sectionTitle, dateHeading, writeStampMin, writeStampSec,
  writeDate, durText, formatHms, STAMP_RX, TODO_RX, readDate,
} from './notes.js';
import { store } from './store.js';
import { syncAll, describe } from './sync.js';
import * as graph from './graph.js';
import { timerState, startTimer, pauseTimer, resetTimer, fmt, checkAlarms, askPermission, notifyState } from './alarms.js';

// the Windows app's palette: background, title bar, text
const PALETTE = [
  ['#FEF3A6', '#F7E06A', '#3A3320'], ['#CFEFC6', '#AEE09F', '#22301E'],
  ['#CDE7FF', '#A4D3FA', '#1D2A36'], ['#FFD8E2', '#FFB6C8', '#3A2129'],
  ['#E6DBFF', '#CBB8FF', '#2A2338'], ['#FFDFC2', '#FFC79A', '#3A2A1B'],
  ['#3A3A3A', '#2B2B2B', '#EDEDED'],
];
const GROUPS = ['today', 'todo', 'tracker', 'monthly', 'note'];
const GROUP_LABEL = { today: "Today's List", todo: 'To-do lists', tracker: 'Task trackers',
                      monthly: 'Monthly activity lists', note: 'Notes' };

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let openId = null;
let saveTimer = null;

// --- the list ----------------------------------------------------------------------------

function notes() {
  return store.all().map(({ id, json }) => ({
    id, json, kind: noteKind(json), text: String(json.text ?? ''),
    name: (json.name ?? '').trim(),
    edited: json.edited ? new Date(json.edited.replace(' ', 'T')) : null,
  })).sort((a, b) => (b.edited?.getTime() || 0) - (a.edited?.getTime() || 0));
}

function matchLines(n, q) {
  if (!q) return [];
  const hay = n.name ? ['[name] ' + n.name, ...n.text.split(/\r?\n/)] : n.text.split(/\r?\n/);
  return hay.filter((l) => l.toLowerCase().includes(q.toLowerCase())).slice(0, 4);
}

// "3 of 7 done", "2/5", the kind of thing the note itself shows
function summary(n) {
  if (n.kind === 'todo' || n.kind === 'today') {
    const rows = parseTodo(n.text).filter((r) => r.type === 'task');
    if (!rows.length) return '';
    return `${rows.filter((r) => r.done).length} of ${rows.length} done`;
  }
  if (n.kind === 'tracker' || n.kind === 'monthly') {
    const t = parseTracker(n.text);
    if (!t.items.length) return '';
    const late = t.items.filter((i) => i.state !== 'done' && i.meta.due && i.meta.due < new Date().setHours(0, 0, 0, 0)).length;
    return `${t.items.filter((i) => i.state === 'done').length}/${t.items.length}` + (late ? ` · ${late} overdue` : '');
  }
  return '';
}

function when(d) {
  if (!d || isNaN(d)) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'today ' + d.toTimeString().slice(0, 5);
  if (diff === 1) return 'yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function renderList() {
  const q = $('#q').value.trim();
  const want = $('#kind').value;
  const all = notes();
  const shown = all.filter((n) => (want === 'all' || n.kind === want) && (!q || matchLines(n, q).length));
  const list = $('#list');
  list.textContent = '';

  $('#countSub').textContent = q || want !== 'all'
    ? `${shown.length} of ${all.length}` : `${all.length} notes`;

  if (!shown.length) {
    list.append(el('div', 'empty', all.length ? 'Nothing matches.'
      : 'No notes here yet. Set up OneDrive sync in the settings to bring yours in, or tap + to start one.'));
    return;
  }
  for (const g of GROUPS) {
    const mine = shown.filter((n) => n.kind === g);
    if (!mine.length) continue;
    const h = el('div', 'group');
    h.append(document.createTextNode(GROUP_LABEL[g] + ' '));
    h.append(el('span', 'n', `(${mine.length})`));
    list.append(h);
    for (const n of mine) list.append(card(n, q));
  }
}

function card(n, q) {
  const b = el('button', 'card');
  b.style.setProperty('--swatch', PALETTE[(n.json.color ?? 0) % PALETTE.length][1]);
  const t = el('div', 't');
  t.append(el('span', null, noteTitle({ ...n, raw: n.json })));
  const s = summary(n);
  if (s) t.append(el('span', 'count', s));
  b.append(t);
  const m = el('div', 'm');
  m.append(el('span', null, when(n.edited) || 'not edited yet'));
  b.append(m);
  for (const line of matchLines(n, q)) {
    const d = el('div', 'hit');
    const i = line.toLowerCase().indexOf(q.toLowerCase());
    d.innerHTML = esc(line.slice(0, i)) + '<mark>' + esc(line.slice(i, i + q.length)) + '</mark>' + esc(line.slice(i + q.length));
    b.append(d);
  }
  b.onclick = () => openNote(n.id);
  return b;
}

// --- opening a note ------------------------------------------------------------------------

function save(id, text, extra = {}) {
  const j = store.get(id);
  if (!j) return;
  if (text != null) { j.text = text; j.edited = writeStampSec(new Date()); }
  Object.assign(j, extra);
  store.put(id, j);
}

function openNote(id) {
  openId = id;
  const j = store.get(id);
  if (!j) return;
  const kind = noteKind(j);
  const [bg, bar, ink] = PALETTE[(j.color ?? 0) % PALETTE.length];
  const screen = $('#noteScreen');
  screen.classList.remove('off');
  $('#listScreen').classList.toggle('on', window.innerWidth >= 900);
  screen.classList.add('on');
  screen.style.setProperty('--noteBg', bg);
  screen.style.setProperty('--noteBar', bar);
  screen.style.setProperty('--noteInk', ink);
  $('#noteBar').style.color = ink;
  $('#noteTitle').firstChild.textContent = noteTitle({ ...parse(j), raw: j }) + ' ';
  $('#noteSub').textContent = KIND_LABEL[kind];
  const body = $('#noteBody');
  body.textContent = '';
  body.style.color = ink;
  body.classList.toggle('pad', kind !== 'note');
  if (kind === 'note') renderText(body, id, j);
  else if (kind === 'todo' || kind === 'today') renderTodo(body, id, j);
  else renderTracker(body, id, j, kind === 'monthly');
}

const parse = (j) => ({ text: String(j.text ?? ''), name: (j.name ?? '').trim(), kind: noteKind(j) });

function closeNote() {
  openId = null;
  $('#noteScreen').classList.add('off');
  if (window.innerWidth < 900) { $('#noteScreen').classList.remove('on'); $('#listScreen').classList.add('on'); }
  $('#noteBody').textContent = '';
  $('#noteBody').append(el('div', 'ph', 'Pick a note'));
  renderList();
}

// --- a plain text note ---------------------------------------------------------------------
// Same journal habit as the Windows app: the first thing typed on a new day, at the end of
// the note, gets today's date written above it.
function renderText(body, id, j) {
  const ta = el('textarea');
  ta.id = 'text';
  ta.value = String(j.text ?? '');
  ta.spellcheck = false;
  body.append(ta);
  let stamped = false;
  ta.addEventListener('beforeinput', (e) => {
    if (stamped || j.journal === false) return;
    if (e.inputType.startsWith('delete')) return;
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    if (!atEnd) return;
    const head = dateHeading();
    if (ta.value.includes(head)) { stamped = true; return; }
    ta.value += (ta.value.trim() ? '\r\n\r\n' : '') + head + '\r\n';
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    stamped = true;
  });
  ta.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(id, ta.value), 400);
  });
}

// --- a to-do list ---------------------------------------------------------------------------
function renderTodo(body, id, j) {
  const rows = parseTodo(j.text);
  const entry = el('div', 'entry');
  const input = el('input');
  input.placeholder = 'Add a task, then Enter';
  input.enterKeyHint = 'done';
  const addBtn = el('button', null, 'Add');
  entry.append(input, addBtn);
  body.append(entry);
  body.append(el('div', 'hint', 'Type times the same way as on the desktop: ~30m for how long, @7:30pm for an alarm.'));

  const addTask = () => {
    const text = input.value.trim();
    if (!text) return;
    const head = dateHeading();
    let out = parseTodo(store.get(id).text ?? '');
    if (!out.some((r) => r.type === 'stamp' && r.raw.includes(head))) {
      if (out.length && out.some((r) => r.raw.trim())) out.push({ type: 'text', raw: '' });
      out.push({ type: 'text', raw: head });
    }
    // put it under today's heading, after the last row that belongs to today
    let at = out.length;
    for (let i = out.length - 1; i >= 0; i--) { if (out[i].raw.includes(head)) { break; } at = i; }
    out.splice(at, 0, { type: 'task', raw: '', indent: '', done: false, task: splitTask(text), dirty: true });
    save(id, formatTodo(out));
    input.value = '';
    openNote(id);
  };
  addBtn.onclick = addTask;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } };

  let n = 0, done = 0, mins = 0;
  rows.forEach((r, i) => {
    if (r.type === 'stamp') { body.append(el('div', 'stamp', r.label)); return; }
    if (r.type === 'text') { if (r.raw.trim()) body.append(el('div', 'stamp', r.raw.trim())); return; }
    n++; if (r.done) done++; else mins += r.task.dur || 0;
    body.append(todoRow(id, rows, i, r));
  });
  const c = el('div', 'count');
  c.textContent = !n ? 'nothing here yet - add a task above'
    : done === n ? `all ${n} done`
    : `${done} of ${n} done` + (mins ? ` - ${durText(mins)} to go` : '');
  body.append(c);
}

function todoRow(id, rows, i, r) {
  const row = el('div', 'row' + (r.done ? ' done' : ''));
  const box = el('div', 'box', r.done ? '✓' : '');
  row.append(box);
  const mid = el('div', 'label');
  mid.append(el('div', null, r.task.title));
  const chips = el('div', 'chips');
  for (const c of taskChips(r.task)) chips.append(c);
  if (chips.children.length) mid.append(chips);

  // Start / pause / reset, writing the same @timer, @paused, @watch and @spent the
  // Windows app reads. Only on tasks still to do.
  if (!r.done) {
    const st = timerState(r.task);
    const moves = el('div', 'move');
    const btn = (label, change) => {
      const b = el('button', null, label);
      b.onclick = (e) => {
        e.stopPropagation();
        const fresh = parseTodo(store.get(id).text ?? '');
        const t = fresh[i];
        if (!t || t.type !== 'task') { openNote(id); return; }
        change(t.task);
        t.dirty = true;
        save(id, formatTodo(fresh));
        openNote(id);
      };
      moves.append(b);
    };
    if (st.running) btn('Pause', (t) => pauseTimer(t));
    else btn(st.kind ? 'Resume' : (r.task.dur ? 'Start ' + durText(r.task.dur, '') : 'Start'), (t) => startTimer(t));
    if (st.kind) btn('Reset', (t) => resetTimer(t));
    mid.append(moves);
  }
  row.append(mid);
  row.onclick = () => {
    const fresh = parseTodo(store.get(id).text ?? '');
    const t = fresh[i];
    if (!t || t.type !== 'task') return;   // the file changed under us; redraw instead
    t.done = !t.done; t.dirty = true;
    save(id, formatTodo(fresh));
    openNote(id);
  };
  return row;
}

const liveChips = new Set();   // timer chips that need a new number every second

function taskChips(t) {
  const out = [];
  const chip = (text, cls) => { const c = el('span', 'chip' + (cls ? ' ' + cls : ''), text); out.push(c); return c; };
  if (t.dur) chip('~' + durText(t.dur, ''));
  if (t.alarm) {
    const late = t.alarm < new Date();
    chip('⏰ ' + t.alarm.toTimeString().slice(0, 5) + (t.daily ? ' daily' : ''), late ? 'late' : '');
  }
  const st = timerState(t);
  if (st.kind) {
    const c = chip((st.kind === 'countdown' ? '⏳ ' : '⏱ ') + fmt(st.secs)
                   + (st.running ? '' : ' paused'), st.kind === 'countdown' && st.secs <= 0 ? 'late' : '');
    if (st.running) { c.dataset.live = st.kind; liveChips.add({ el: c, task: t }); }
  }
  if (t.snooze) chip('zZ ' + t.snooze.toTimeString().slice(0, 5));
  if (t.from) chip('carried from ' + t.from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
  if (t.cal) chip('\u{1f4c5} calendar');
  return out;
}

// --- a task tracker / monthly activity list ---------------------------------------------------
function renderTracker(body, id, j, monthly) {
  const t = parseTracker(j.text);
  const entry = el('div', 'entry');
  const input = el('input');
  input.placeholder = monthly ? 'Add an activity, then Enter' : 'Add an objective, then Enter';
  const addBtn = el('button', null, 'Add');
  entry.append(input, addBtn);
  body.append(entry);
  body.append(el('div', 'hint', 'End with  due 2026-10-07  to give it a deadline.'));

  const add = () => {
    let text = input.value.trim();
    if (!text) return;
    const fresh = parseTracker(store.get(id).text ?? '');
    const meta = { added: new Date(), started: null, finished: null, due: null,
                   alarm: null, daily: false, snooze: null, watch: null, spent: null };
    const m = /\s+(?:due|by)\s+(\d{4}-\d{2}-\d{2})$/i.exec(text);
    if (m) { meta.due = readDate(m[1]); text = text.slice(0, m.index).trim(); }
    fresh.items.push({ state: 'todo', name: text, meta, dirty: true });
    if (!fresh.started) fresh.started = new Date();
    save(id, formatTracker(fresh, monthly));
    input.value = '';
    openNote(id);
  };
  addBtn.onclick = add;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };

  const done = t.items.filter((i) => i.state === 'done').length;
  if (t.items.length) {
    const bar = el('div', 'bar2');
    const fill = el('i');
    fill.style.width = Math.round((done / t.items.length) * 100) + '%';
    bar.append(fill);
    body.append(bar);
    body.append(el('div', 'count', `${done} of ${t.items.length} finished`
      + ` - ${t.items.filter((i) => i.state === 'doing').length} ongoing, ${t.items.filter((i) => i.state === 'todo').length} ${monthly ? 'not started' : 'to do'}`));
  }
  if (t.started) body.append(el('div', 'hint', 'Started ' + writeStampMin(t.started)));

  for (const sec of ['todo', 'doing', 'done']) {
    const mine = t.items.filter((i) => i.state === sec);
    body.append(el('div', 'sec', sectionTitle(sec, monthly) + `  (${mine.length})`));
    if (!mine.length) { body.append(el('div', 'hint', 'nothing here')); continue; }
    for (const it of mine) body.append(trkRow(id, it, monthly));
  }
  if (t.notes != null) {
    body.append(el('div', 'sec', 'NOTES'));
    const pre = el('div');
    pre.style.whiteSpace = 'pre-wrap';
    pre.textContent = t.notes;
    body.append(pre);
  }
}

function trkRow(id, it, monthly) {
  const row = el('div', 'row' + (it.state === 'done' ? ' done' : ''));
  row.append(el('div', 'box', it.state === 'done' ? '✓' : it.state === 'doing' ? '…' : ''));
  const mid = el('div', 'label');
  mid.append(el('div', null, it.name));
  const chips = el('div', 'chips');
  const m = it.meta || {};
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (m.due) {
    const late = m.due < today, soon = !late && (m.due - today) / 86400000 <= 2;
    chips.append(el('span', 'chip' + (late ? ' late' : soon ? ' soon' : ''),
      (late ? 'overdue ' : 'due ') + m.due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })));
  }
  if (m.alarm) chips.append(el('span', 'chip', '⏰ ' + writeStampMin(m.alarm).slice(11) + (m.daily ? ' daily' : '')));
  if (m.watch) chips.append(el('span', 'chip', '▶ running'));
  else if (m.spent != null) chips.append(el('span', 'chip', '⏱ ' + formatHms(m.spent)));
  if (m.finished) chips.append(el('span', 'chip', 'finished ' + writeStampMin(m.finished).slice(5, 10)));
  if (chips.children.length) mid.append(chips);

  const moves = el('div', 'move');
  const step = (to, label) => {
    const b = el('button', null, label);
    b.onclick = (e) => {
      e.stopPropagation();
      const fresh = parseTracker(store.get(id).text ?? '');
      const target = fresh.items.find((x) => x.name === it.name && x.state === it.state);
      if (!target) { openNote(id); return; }
      target.state = to; target.dirty = true;
      if (to === 'doing' && !target.meta.started) target.meta.started = new Date();
      if (to === 'done' && !target.meta.finished) target.meta.finished = new Date();
      if (to === 'todo') { target.meta.started = null; target.meta.finished = null; }
      save(id, formatTracker(fresh, monthly));
      openNote(id);
    };
    moves.append(b);
  };
  if (it.state !== 'doing') step('doing', 'Start');
  if (it.state !== 'done') step('done', 'Finish');
  if (it.state !== 'todo') step('todo', monthly ? 'Not started' : 'To do');
  mid.append(moves);
  row.append(mid);
  return row;
}

// --- wiring -------------------------------------------------------------------------------
$('#q').addEventListener('input', renderList);
$('#kind').addEventListener('change', renderList);
$('#back').onclick = closeNote;
$('#add').onclick = () => $('#sheet').classList.add('on');
$('#sheet').onclick = (e) => { if (e.target.id === 'sheet') $('#sheet').classList.remove('on'); };
for (const b of document.querySelectorAll('#sheet [data-new]')) {
  b.onclick = () => {
    const kind = b.dataset.new;
    const { id, json } = store.create(kind);
    if (kind === 'tracker' || kind === 'monthly') {
      const title = kind === 'monthly'
        ? new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + ' - Activity List'
        : 'New task';
      json.text = formatTracker({ title, started: new Date(), items: [], notes: null }, kind === 'monthly');
      store.put(id, json);
    }
    $('#sheet').classList.remove('on');
    renderList();
    openNote(id);
  };
}
$('#rename').onclick = () => {
  if (!openId) return;
  const j = store.get(openId);
  const name = prompt('Name for this note (empty to use its first line):', j.name ?? '');
  if (name === null) return;
  save(openId, null, { name: name.trim() });
  openNote(openId);
  renderList();
};
$('#colour').onclick = () => {
  if (!openId) return;
  const j = store.get(openId);
  save(openId, null, { color: ((j.color ?? 0) + 1) % PALETTE.length });
  openNote(openId);
  renderList();
};
$('#del').onclick = () => {
  if (!openId) return;
  if (!confirm('Delete this note for good?')) return;
  store.remove(openId);
  closeNote();
};
store.onChange(() => { if (!document.hidden) renderList(); });

// one second: refresh running timers in place, without redrawing the note under your finger
setInterval(() => {
  for (const item of [...liveChips]) {
    if (!item.el.isConnected) { liveChips.delete(item); continue; }
    const st = timerState(item.task);
    item.el.textContent = (st.kind === 'countdown' ? '⏳ ' : '⏱ ') + fmt(st.secs);
    item.el.classList.toggle('late', st.kind === 'countdown' && st.secs <= 0);
  }
}, 1000);

// every half minute: anything due?
async function tickAlarms() {
  try {
    const due = await checkAlarms(store, { parseTodo, parseTracker, noteKind, noteTitle });
    if (due.length) say(`${due[0].what}${due.length > 1 ? ` and ${due.length - 1} more` : ''} - due now`);
  } catch (e) { console.warn('alarm check failed:', e.message); }
}
setInterval(tickAlarms, 30000);
tickAlarms();

// --- OneDrive ------------------------------------------------------------------------------
const line = $('#syncLine');
function say(text, cls = '') {
  line.hidden = !text;
  line.className = 'syncline ' + cls;
  line.textContent = text;
}

async function doSync() {
  if (!graph.config().clientId) { openCfg('Add your Client ID first.'); return; }
  if (!graph.signedInAs()) { openCfg('Sign in first.'); return; }
  say('syncing', 'busy');
  try {
    const r = await syncAll(store, graph.remote);
    store.meta = { ...store.meta, lastSync: new Date().toISOString() };
    const bad = r.errors.length ? ' - ' + r.errors[0].message : '';
    say(describe(r) + bad, r.errors.length ? 'bad' : '');
    if (r.conflicts.length) {
      alert(`${r.conflicts.length} note(s) had been changed in both places.\n\n` +
            'OneDrive’s copy is now the note; what was written here is kept beside it ' +
            'as a "(conflict copy)" so nothing is lost.');
    }
    renderList();
    if (openId && store.get(openId)) openNote(openId);
  } catch (e) {
    say(e.message, 'bad');
  }
}

function openCfg(msg = '') {
  showNotifState();
  const c = graph.config();
  $('#cfgId').value = c.clientId;
  $('#cfgPath').value = c.notesPath;
  $('#cfgRedirect').textContent = location.origin + location.pathname;
  $('#cfgWho').textContent = graph.signedInAs() ? 'Signed in as ' + graph.signedInAs() : 'Not signed in.';
  $('#cfgMsg').textContent = msg;
  $('#cfg').classList.add('on');
}

$('#sync').onclick = doSync;
$('#settings').onclick = () => openCfg();
$('#cfgClose').onclick = () => $('#cfg').classList.remove('on');
$('#cfg').onclick = (e) => { if (e.target.id === 'cfg') $('#cfg').classList.remove('on'); };
$('#cfgSave').onclick = () => {
  graph.setConfig({ clientId: $('#cfgId').value.trim(), notesPath: $('#cfgPath').value.trim() });
  $('#cfgMsg').textContent = 'Saved. Sign in next.';
};
$('#cfgIn').onclick = async () => {
  graph.setConfig({ clientId: $('#cfgId').value.trim(), notesPath: $('#cfgPath').value.trim() });
  try { await graph.signIn(); } catch (e) { $('#cfgMsg').textContent = e.message; }
};
$('#cfgOut').onclick = async () => { try { await graph.signOut(); } catch (e) { $('#cfgMsg').textContent = e.message; } };
$('#cfgSeed').onclick = async () => {
  // only useful when the app is served from the notes folder, as it is on the desktop
  if (!confirm('Re-read every note from the folder this app is served from? Local changes are replaced.')) return;
  try {
    const r = await store.seedFromFolder(true);
    $('#cfgMsg').textContent = `Read ${r.count} notes from the folder.`;
    renderList();
  } catch (e) { $('#cfgMsg').textContent = e.message; }
};
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#cfgInstall').hidden = false;
});
$('#cfgInstall').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const r = await installPrompt.userChoice;
  $('#cfgMsg').textContent = r.outcome === 'accepted' ? 'Installed.' : 'Not installed.';
  installPrompt = null;
  $('#cfgInstall').hidden = true;
};
$('#cfgAsk').onclick = async () => {
  const r = await askPermission();
  showNotifState();
  $('#cfgMsg').textContent = r === 'granted' ? 'Alarms will show as notifications.'
    : r === 'denied' ? 'Blocked - turn notifications back on in the browser’s site settings.'
    : 'This browser cannot show notifications.';
};
function showNotifState() {
  const s = notifyState();
  $('#cfgNotif').textContent =
    s === 'granted' ? 'Notifications are on. Alarms show while the app is open or in the background.'
    : s === 'denied' ? 'Notifications are blocked for this site.'
    : s === 'unsupported' ? 'This browser cannot show notifications.'
    : 'Not asked yet. Alarms still show inside the app.';
}
$('#cfgCheck').onclick = async () => {
  $('#cfgMsg').textContent = 'looking...';
  try {
    const r = await graph.remote.check();
    $('#cfgMsg').textContent = `Found "${r.name}" with ${r.notes} note file(s).`;
  } catch (e) { $('#cfgMsg').textContent = e.message; }
};

// the service worker: offline, installable, and notifications that outlive the tab
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker:', e.message));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-note' && e.data.id && store.get(e.data.id)) openNote(e.data.id);
  });
}

// first run: take a copy of the notes sitting beside this app. Hosted on GitHub Pages
// there is no such folder - that is expected, and notes arrive by syncing instead.
(async () => {
  try {
    const r = await store.seedFromFolder();
    if (!r.skipped) console.log(`seeded ${r.count} notes`);
  } catch (e) {
    console.info('no notes folder beside this app - notes will come from OneDrive:', e.message);
    $('#cfgSeed').hidden = true;
  }
  renderList();
  if (window.innerWidth >= 900) $('#noteScreen').classList.add('on');

  const want = new URLSearchParams(location.search).get('open');
  if (want) {
    const hit = want === 'today'
      ? store.all().find(({ json }) => json.todo && json.today)
      : (store.get(want) ? { id: want } : null);
    if (hit) openNote(hit.id);
  }

  // finish a sign-in that redirected away and came back, then catch up quietly
  try {
    const who = await graph.resume();
    if (who) { say('signed in as ' + who.username); await doSync(); }
  } catch (e) { say(e.message, 'bad'); }
})();
