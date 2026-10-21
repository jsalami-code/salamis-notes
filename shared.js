// One task in two lists: Today's List and this month's activity list share their items by
// name - the same name is the same task. Either list can send an item to the other (it stays
// where it was too), both share one task tracker, and finishing it in one marks it finished
// in the other. The same rules as the Windows app's StickyData.ps1 (Find-SdTrackerFor,
// Send-SdToToday, Send-SdToMonth, Complete-SdTaskEverywhere -Only), on the same saved text.
import {
  noteKind, parseTodo, formatTodo, parseTracker, formatTracker, dateHeading,
  writeStampSec,
} from './notes.js';

// Get-SdKey: ignoring case, spacing and punctuation
export function taskKey(title) {
  return String(title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Test-SdConflictCopy: "7f0a0210-SALAMI-TOSIN-JULIUS" or "7f0a0210 (2)" - never written into
export function isConflictCopy(id) { return /-[A-Za-z0-9][A-Za-z0-9-]*$/.test(id) || /[()]/.test(id); }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
                'september', 'october', 'november', 'december'];

function notesOf(store) {
  return store.all().map(({ id, json }) => ({ id, json, kind: noteKind(json), edited: String(json.edited || '') }));
}
const latestFirst = (a, b) => (a.edited < b.edited ? 1 : a.edited > b.edited ? -1 : 0);

// Find-SdTodayList: the marked one, else the to-do list edited last
export function findTodayList(store) {
  const all = notesOf(store).filter((n) => !isConflictCopy(n.id));
  return all.filter((n) => n.kind === 'today').sort(latestFirst)[0]
      || all.filter((n) => n.kind === 'todo').sort(latestFirst)[0] || null;
}

// Get-SdListMonth: the month it was started in, else a month named in its title
function listMonth(n) {
  const t = parseTracker(n.json.text);
  if (t.started) return new Date(t.started.getFullYear(), t.started.getMonth(), 1);
  const m = new RegExp('\\b(' + MONTHS.join('|') + ')\\b\\D*(\\d{4})?', 'i').exec(t.title);
  const ed = /^(\d{4})-(\d{2})/.exec(n.edited);
  if (m) return new Date(m[2] ? +m[2] : ed ? +ed[1] : new Date().getFullYear(), MONTHS.indexOf(m[1].toLowerCase()), 1);
  return ed ? new Date(+ed[1], +ed[2] - 1, 1) : null;
}

// Find-SdMonthList: this month's activity list (the latest edited); with create, made if none
export function findMonthList(store, when = new Date(), create = false) {
  const m0 = new Date(when.getFullYear(), when.getMonth(), 1);
  const hit = notesOf(store).filter((n) => n.kind === 'monthly' && !isConflictCopy(n.id))
    .filter((n) => { const d = listMonth(n); return d && d.getTime() === m0.getTime(); })
    .sort(latestFirst)[0];
  if (hit || !create) return hit || null;
  const { id, json } = store.create('monthly', { w: 440, h: 540, upopen: true, notesh: 120 });
  json.text = formatTracker({
    title: m0.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + ' - Activity List',
    started: m0, items: [], notes: null,
  }, true);
  json.edited = writeStampSec(new Date());
  store.put(id, json);
  return { id, json, kind: 'monthly', edited: json.edited };
}

// Find-SdTrackerFor: its own link, then a link on the same-named item in another list,
// then a tracker of that name (an unfinished one first, then the latest). '' if none.
export function trackerFor(store, title, link = '') {
  const key = taskKey(title);
  const all = notesOf(store);
  const kindOf = new Map(all.map((n) => [n.id, n.kind]));
  if (link && kindOf.has(link)) return link;
  if (!key) return '';
  for (const n of all) {
    if (isConflictCopy(n.id)) continue;
    if (n.kind === 'today' || n.kind === 'todo') {
      for (const r of parseTodo(n.json.text)) {
        if (r.type === 'task' && r.task.trk && taskKey(r.task.title) === key && kindOf.get(r.task.trk) === 'tracker') return r.task.trk;
      }
    } else if (n.kind === 'monthly') {
      for (const it of parseTracker(n.json.text).items) {
        if (it.meta.trk && taskKey(it.name) === key && kindOf.get(it.meta.trk) === 'tracker') return it.meta.trk;
      }
    }
  }
  let best = null;
  for (const n of all) {
    if (n.kind !== 'tracker' || isConflictCopy(n.id)) continue;
    const t = parseTracker(n.json.text);
    if (taskKey(t.title) !== key) continue;
    const open = t.finished ? 0 : 1;
    if (!best || open > best.open || (open === best.open && n.edited > best.edited)) best = { id: n.id, open, edited: n.edited };
  }
  return best ? best.id : '';
}

// New-SdTracker: a tracker of its own for one task, the work already under way - the
// objective in Ongoing, stamped, its timer running from now. Returns the new id.
export function newTracker(store, title, now = new Date()) {
  const { id, json } = store.create('tracker', { h: 420 });
  json.text = formatTracker({
    title, started: now, notes: null,
    items: [{ state: 'doing', name: title, dirty: true, meta: { added: now, started: now, watch: now } }],
  }, false);
  json.edited = writeStampSec(now);
  store.put(id, json);
  return id;
}

// a to-do task with nothing but its name (and tracker link): emptyTask in notes.js
function plainTask(title, trk) {
  return { title, dur: 0, alarm: null, daily: false, timer: null, snooze: null,
           left: null, watch: null, spent: null, from: null, cal: null, every: '', trk: trk || null };
}

function stamp(store, id, text) {
  const j = store.get(id);
  j.text = text;
  j.edited = writeStampSec(new Date());
  store.put(id, j);
}

// Send-SdToToday: on Today's List under today's heading, unless an unticked one of the same
// name is already there. -> { result: 'added' | 'there' | 'none', id, title }
export function sendToToday(store, title, trk = '') {
  const tl = findTodayList(store);
  if (!tl) return { result: 'none', id: '', title: '' };
  const key = taskKey(title);
  const rows = parseTodo(tl.json.text);
  if (rows.some((r) => r.type === 'task' && !r.done && taskKey(r.task.title) === key)) return { result: 'there', id: tl.id, title: "Today's List" };
  // Add-SdTaskToText: at the end of today's section; today's heading made if needed, in date order
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const row = { type: 'task', raw: '', indent: '', done: false, task: plainTask(title, trk), dirty: true };
  let start = -1, before = -1;
  rows.forEach((r, i) => {
    if (r.type !== 'stamp' || !r.date) return;
    const d = new Date(r.date); d.setHours(0, 0, 0, 0);
    if (d.getTime() === today.getTime()) start = i;
    else if (d > today && before < 0) before = i;
  });
  if (rows.length === 1 && !rows[0].raw) rows.length = 0;
  if (start >= 0) {
    let at = start + 1;
    while (at < rows.length && rows[at].type !== 'stamp') at++;
    while (at > start + 1 && !rows[at - 1].raw.trim()) at--;
    rows.splice(at, 0, row);
  } else {
    const head = { type: 'text', raw: dateHeading(today) };
    if (before >= 0) rows.splice(before, 0, head, row, { type: 'text', raw: '' });
    else { if (rows.length && rows[rows.length - 1].raw.trim()) rows.push({ type: 'text', raw: '' }); rows.push(head, row); }
  }
  stamp(store, tl.id, formatTodo(rows));
  return { result: 'added', id: tl.id, title: "Today's List" };
}

// Send-SdToMonth: among this month's not-started (the list made if there is none), unless one
// of the same name is there and not finished. -> { result, id, title }
export function sendToMonth(store, title, trk = '') {
  const ml = findMonthList(store, new Date(), true);
  const t = parseTracker(ml.json.text);
  const key = taskKey(title);
  const name = t.title || 'this month\'s list';
  if (t.items.some((it) => it.state !== 'done' && taskKey(it.name) === key)) return { result: 'there', id: ml.id, title: name };
  const now = new Date(); now.setSeconds(0, 0);
  t.items.push({ state: 'todo', name: title, dirty: true, meta: { added: now, trk: trk || '' } });
  if (!t.started) t.started = now;
  stamp(store, ml.id, formatTracker(t, true));
  return { result: 'added', id: ml.id, title: name };
}

// Get-SdNextEvery: the day a repeat next falls on, after `from`
export function nextEvery(key, from) {
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  const add = (n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  if (key === 'day') return add(1);
  if (key === 'week') return add(7);
  if (key === '2weeks') return add(14);
  if (key === 'month') { const x = new Date(d); x.setMonth(x.getMonth() + 1); return x; }
  const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(key);
  if (want < 0) return null;
  let step = (want - d.getDay() + 7) % 7;
  if (step === 0) step = 7;
  return add(step);
}

// Complete-SdTaskEverywhere -Only: mark the task finished in the lists of the given kinds
// ('monthly' when it was ticked in Today's List, 'today' when it was finished in a monthly
// list), never in `selfId`. Matching is by the tracker link first, then the name. Returns
// how many items were marked.
export function finishElsewhere(store, title, trk, kinds, selfId, when = new Date()) {
  const key = taskKey(title);
  if (!key) return 0;
  let count = 0;
  const today = new Date(when); today.setHours(0, 0, 0, 0);
  for (const n of notesOf(store)) {
    if (n.id === selfId || !kinds.includes(n.kind) || isConflictCopy(n.id)) continue;
    if (n.kind === 'today' || n.kind === 'todo') {
      const rows = parseTodo(n.json.text);
      let day = null, hit = 0;
      for (const r of rows) {
        if (r.type === 'stamp') { day = r.date; continue; }
        if (r.type !== 'task' || r.done) continue;
        const t = r.task;
        if (t.every && day && day > today) continue;   // a routine's later turns wait theirs
        if (!((trk && t.trk === trk) || taskKey(t.title) === key)) continue;
        // ticking does what the list does: a countdown goes, a stopwatch keeps its time
        if (t.watch) { t.spent = Math.max(0, Math.round((when - t.watch) / 1000)); t.watch = null; }
        t.timer = null; t.left = null; t.snooze = null;
        r.done = true; r.dirty = true; hit++;
      }
      if (hit) { stamp(store, n.id, formatTodo(rows)); count += hit; }
    } else {
      const t = parseTracker(n.json.text);
      const nm = new Date(when); nm.setSeconds(0, 0);
      let hit = 0;
      const next = [], moved = [];
      for (const it of [...t.items]) {
        if (it.state === 'done' || !((trk && it.meta.trk === trk) || taskKey(it.name) === key)) continue;
        const m = it.meta;
        if (m.watch) { m.spent = Math.max(0, Math.round((when - m.watch) / 1000)); m.watch = null; }
        m.snooze = null;
        if (!m.started) m.started = nm;
        m.finished = nm;
        it.state = 'done'; it.dirty = true; hit++;
        moved.push(it);   // goes to the end of Finished, as Set-SdTrkFinished puts it
        if (m.every) {   // a routine comes round again: its next turn among the not started
          const base = m.due || today;
          let nd = nextEvery(m.every, base);
          while (nd && nd < today) nd = nextEvery(m.every, nd);
          if (nd) {
            const shift = (d) => { const x = new Date(nd); x.setDate(x.getDate() + Math.round((d - (m.due || d)) / 86400000)); return x; };
            const meta = { added: nm, every: m.every, due: nd, start: m.start ? (m.due ? shift(m.start) : nd) : null,
                           alarm: null, daily: m.daily };
            if (m.alarm) { meta.alarm = new Date(nd); meta.alarm.setHours(m.alarm.getHours(), m.alarm.getMinutes(), 0, 0); }
            next.push({ state: 'todo', name: it.name, dirty: true, meta });
          }
        }
      }
      if (hit) {
        t.items = t.items.filter((x) => !moved.includes(x)).concat(moved, next);
        stamp(store, n.id, formatTracker(t, true));
        count += hit;
      }
    }
  }
  return count;
}
