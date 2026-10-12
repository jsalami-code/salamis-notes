// dash.js - the dashboards' arithmetic: Today's List (stats and "For today" suggestions), the
// journal, the quarter, and task-tracker streaks.
//
// A port of the desktop app's StickyData.ps1 and its dashboards, so both give the same
// answers from the same notes. Pure functions over the store's notes; the only writers are
// the add/move helpers at the end, which go through notes.js so the Windows app reads the
// result unchanged.

import {
  noteKind, noteTitle, parseTodo, formatTodo, splitTask, formatTask, parseTracker, formatTracker,
  STAMP_RX, readHeadingDate, dateHeading, writeDate,
} from './notes.js';

const DAY = 86400000;
export const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayKey = (d) => writeDate(d);
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const shortDay = (d) => `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
export const hhmm = (d) => d.toTimeString().slice(0, 5);

// Two titles are "the same task" ignoring case, spacing and punctuation (Get-SdKey)
export const taskKey = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// --- reading every note --------------------------------------------------------------------
export function readNotes(all) {
  return all.map(({ id, json }) => {
    const kind = noteKind(json);
    const text = typeof json.text === 'string' ? json.text : '';
    const edited = json.edited ? new Date(String(json.edited).replace(' ', 'T')) : null;
    const n = { id, json, kind, text, name: (json.name ?? '').trim(), edited };
    n.title = kind === 'today' && !n.name ? "Today's List" : noteTitle({ ...n, raw: json });
    return n;
  });
}

// A to-do note's tasks with their day: [{ day, done, title, key, dur, alarm, cal, from, task }]
export function todoTasks(text) {
  let day = null;
  const out = [];
  for (const r of parseTodo(text)) {
    if (r.type === 'stamp') { day = r.date ? startOfDay(r.date) : day; continue; }
    if (r.type !== 'task' || !r.task.title) continue;
    out.push({ day, done: r.done, title: r.task.title, key: taskKey(r.task.title), dur: r.task.dur || 0,
               alarm: r.task.alarm, daily: r.task.daily, snooze: r.task.snooze, cal: !!r.task.cal, from: r.task.from, task: r.task });
  }
  return out;
}

// The Today's List note: the marked one (edited last), else the to-do list edited last
export function findTodayList(notes) {
  const by = (k) => notes.filter((n) => n.kind === k).sort((a, b) => (b.edited || 0) - (a.edited || 0));
  return by('today')[0] || by('todo')[0] || null;
}

// --- streaks --------------------------------------------------------------------------------
// Over a set of days: current (ending today, or yesterday - "at risk" until something is done
// today), best, and whether today counts already.
export function streak(days, today = startOfDay()) {
  const set = new Set([...days].map((d) => dayKey(startOfDay(d))));
  const sorted = [...set].sort();
  let best = 0, run = 0, prev = null;
  for (const k of sorted) {
    const d = new Date(k + 'T00:00:00');
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  const doneToday = set.has(dayKey(today));
  let cur = 0;
  for (let d = doneToday ? today : addDays(today, -1); set.has(dayKey(d)); d = addDays(d, -1)) cur++;
  return { current: cur, best, today: doneToday, atRisk: !doneToday && cur > 0,
           last: sorted.length ? new Date(sorted[sorted.length - 1] + 'T00:00:00') : null };
}

// --- trackers and monthly lists ---------------------------------------------------------------
// Days something happened in a tracker: started, an objective added/started/finished, notes
export function trackerDays(t) {
  const out = [];
  if (t.started) out.push(t.started);
  for (const it of t.items) for (const k of ['added', 'started', 'finished']) if (it.meta[k]) out.push(it.meta[k]);
  for (const line of String(t.notes ?? '').split(/\r?\n/)) {
    const m = STAMP_RX.exec(line);
    if (m) { const d = readHeadingDate(m[1]); if (d) out.push(d); }
  }
  return out;
}

// The month a monthly list is for: the month it started in, else a month named in its title
export function listMonth(n, t) {
  if (t.started) return new Date(t.started.getFullYear(), t.started.getMonth(), 1);
  const m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\D*(\d{4})?/i.exec(t.title);
  if (m) {
    const mo = MON.findIndex((x) => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
    return new Date(m[2] ? +m[2] : (n.edited || new Date()).getFullYear(), mo, 1);
  }
  const e = n.edited || new Date();
  return new Date(e.getFullYear(), e.getMonth(), 1);
}
export const quarterStart = (d = new Date()) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);

// A reminder today: a daily alarm (from its first day on), or a one-off alarm today
function reminderToday(meta, today) {
  if (!meta.alarm) return null;
  if (meta.daily && startOfDay(meta.alarm) <= today) {
    const r = new Date(today); r.setHours(meta.alarm.getHours(), meta.alarm.getMinutes(), 0, 0); return r;
  }
  if (+startOfDay(meta.alarm) === +today) return meta.alarm;
  return null;
}

// --- Today's List: the numbers ------------------------------------------------------------
export function todayStats(todayNote, now = new Date()) {
  const today = startOfDay(now);
  const tasks = todayNote ? todoTasks(todayNote.text) : [];
  const mine = tasks.filter((t) => t.day && +t.day === +today);
  const st = { total: mine.length, done: 0, togo: 0, carried: 0, cal: 0, next: null, nextTitle: '' };
  for (const t of mine) {
    if (t.done) st.done++; else st.togo += t.dur;
    if (t.from) st.carried++;
    if (t.cal) st.cal++;
  }
  for (const t of tasks) {
    if (t.done && !t.daily) continue;
    const a = t.snooze || t.alarm;
    if (a && a >= now && (!st.next || a < st.next)) { st.next = a; st.nextTitle = t.title; }
  }
  const per = new Map();
  for (const t of tasks) if (t.done && t.day) per.set(dayKey(t.day), (per.get(dayKey(t.day)) || 0) + 1);
  st.week = [];
  for (let k = 6; k >= 0; k--) { const d = addDays(today, -k); st.week.push({ day: d, n: per.get(dayKey(d)) || 0 }); }
  st.weekDone = st.week.reduce((s, w) => s + w.n, 0);
  st.streak = streak([...per.keys()].map((k) => new Date(k + 'T00:00:00')), today);
  return st;
}

// --- Today's List: "For today" ------------------------------------------------------------------
// As on the desktop (after Microsoft To Do's My Day suggestions), most urgent first:
//   1 overdue  2 due today  3 reminder today  4 due tomorrow  5 planned for a later day here,
//   or left unfinished on an earlier day (the phone does not carry tasks over)  6 ongoing
//   7 due this week  8 habit (done on 3+ of the last 7 days)  9 unfinished in another list
// Each: { title, why, from, rank, when, key, match, action 'add'|'move', src, dur, alarm, rowDay }
export function todaySuggestions(notes, todayNote, hidden = new Set(), now = new Date()) {
  const today = startOfDay(now);
  const FAR = new Date(8640000000000000);
  const have = new Set();
  const ownTasks = todayNote ? todoTasks(todayNote.text) : [];
  for (const t of ownTasks) if (t.day && +t.day === +today) have.add(t.key);
  const cand = [];

  for (const n of notes) {
    if (todayNote && n.id === todayNote.id) continue;
    if (n.kind === 'tracker' || n.kind === 'monthly') {
      const t = parseTracker(n.text);
      const from = (t.title || n.title).replace(/\s+-\s+Activity List\s*$/i, ' list');
      for (const it of t.items) {
        if (it.state === 'done' || !it.name) continue;
        const m = it.meta, k = taskKey(it.name);
        const rem = reminderToday(m, today);
        const s = { title: it.name, from, src: n.id, match: k, key: `trk:${n.id}:${k}`, action: 'add', dur: 0,
                    alarm: rem && rem > now ? rem : null, when: FAR };
        if (m.due && m.due < today) {
          const late = daysBetween(m.due, today);
          Object.assign(s, { rank: 1, when: m.due, why: `Overdue by ${late} day${late === 1 ? '' : 's'}` });
        } else if (m.due && +m.due === +today) Object.assign(s, { rank: 2, when: today, why: 'Due today' });
        else if (rem) Object.assign(s, { rank: 3, when: rem, why: `Reminder at ${hhmm(rem)}${m.daily ? ' (daily)' : ''}` });
        else if (m.due && +m.due === +addDays(today, 1)) Object.assign(s, { rank: 4, when: m.due, why: 'Due tomorrow' });
        else if (it.state === 'doing') Object.assign(s, { rank: 6, when: m.started || FAR, why: 'In progress' + (m.started ? ` since ${m.started.getDate()} ${MON[m.started.getMonth()]}` : '') });
        else if (m.due && m.due <= addDays(today, 7)) Object.assign(s, { rank: 7, when: m.due, why: `Due ${shortDay(m.due)}` });
        else continue;
        cand.push(s);
      }
    } else if (n.kind === 'todo' || n.kind === 'today') {
      let k = 0;
      for (const t of todoTasks(n.text)) {
        if (t.done || t.cal || (t.day && t.day > today) || k >= 6) continue;
        k++;
        cand.push({ title: t.title, from: n.name || 'Another to-do list', src: n.id, match: t.key, key: `todo:${n.id}:${t.key}`,
                    action: 'add', dur: t.dur, alarm: null, rank: 9, when: t.day || FAR, why: 'Not done yet' });
      }
    }
  }
  // this list: planned for the next seven days, or left unfinished on an earlier day
  for (const t of ownTasks) {
    if (t.done || !t.day || +t.day === +today) continue;
    if (t.day > today && t.day <= addDays(today, 7)) {
      cand.push({ title: t.title, from: 'This list', src: todayNote.id, match: t.key, key: `later:${t.key}`, action: 'move',
                  rowDay: t.day, dur: 0, alarm: null, rank: 5, when: t.day, why: `Planned for ${shortDay(t.day)}` });
    } else if (t.day < today && !t.cal) {
      cand.push({ title: t.title, from: 'This list', src: todayNote.id, match: t.key, key: `earlier:${t.key}`, action: 'move',
                  rowDay: t.day, dur: 0, alarm: null, rank: 5, when: t.day, why: `Not done on ${shortDay(t.day)}` });
    }
  }
  // habits: done on 3 or more of the last 7 days here
  const byKey = new Map();
  for (const t of ownTasks) {
    if (!t.done || !t.day || t.day >= today || t.day < addDays(today, -7)) continue;
    const h = byKey.get(t.key) || { days: new Set(), title: t.title, dur: 0 };
    h.days.add(dayKey(t.day)); h.title = t.title; if (t.dur) h.dur = t.dur;
    byKey.set(t.key, h);
  }
  for (const [k, h] of byKey) {
    if (h.days.size < 3) continue;
    cand.push({ title: h.title, from: 'Your habits', src: todayNote.id, match: k, key: `habit:${k}`, action: 'add',
                dur: h.dur, alarm: null, rank: 8, when: addDays(today, -h.days.size), why: `Done on ${h.days.size} of the last 7 days` });
  }
  cand.sort((a, b) => a.rank - b.rank || a.when - b.when);
  const seen = new Set(), out = [];
  for (const s of cand) {
    if (have.has(s.match) || seen.has(s.match) || hidden.has(s.key)) continue;
    seen.add(s.match);
    out.push(s);
  }
  return out;
}

// --- the journal ---------------------------------------------------------------------------
// Every dated entry of every note, per day: Map 'yyyy-MM-dd' -> { words (journal), journal, other }
export function journalDays(notes) {
  const days = new Map();
  for (const n of notes) {
    const isJournal = n.id === 'journal';
    let day = null, lines = 0, words = 0;
    const flush = () => {
      if (!day || !lines) return;
      const k = dayKey(day);
      const d = days.get(k) || { words: 0, journal: false, other: false, notes: new Set() };
      if (isJournal) { d.journal = true; d.words += words; } else d.other = true;
      d.notes.add(n.id);
      days.set(k, d);
    };
    for (const line of n.text.split(/\r?\n/)) {
      const m = STAMP_RX.exec(line);
      if (m) { flush(); day = readHeadingDate(m[1]); lines = 0; words = 0; continue; }
      if (line.trim()) { lines++; words += line.trim().split(/\s+/).length; }
    }
    flush();
  }
  return days;
}

export function journalStats(notes, now = new Date()) {
  const today = startOfDay(now);
  const days = journalDays(notes);
  const jdays = [...days].filter(([, v]) => v.journal).map(([k]) => new Date(k + 'T00:00:00'));
  const st = streak(jdays, today);
  const any = streak([...days.keys()].map((k) => new Date(k + 'T00:00:00')), today);
  const month = jdays.filter((d) => d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth());
  const words = month.reduce((s, d) => s + days.get(dayKey(d)).words, 0);
  const weekStart = addDays(today, -((today.getDay() + 6) % 7));
  const week = jdays.filter((d) => d >= weekStart).length;
  const per = new Map();
  for (const [k, v] of days) {
    const d = new Date(k + 'T00:00:00');
    if (d.getFullYear() !== today.getFullYear() || d.getMonth() !== today.getMonth()) continue;
    for (const id of v.notes) per.set(id, (per.get(id) || 0) + 1);
  }
  const names = new Map(notes.map((n) => [n.id, n.id === 'journal' && !n.name ? 'Daily Journal' : n.title]));
  const top = [...per].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, c]) => ({ name: names.get(id) || id, days: c }));
  const onThisDay = [['A week ago', addDays(today, -7)], ['A month ago', new Date(today.getFullYear(), today.getMonth() - 1, today.getDate())],
                     ['A year ago', new Date(today.getFullYear() - 1, today.getMonth(), today.getDate())]]
    .map(([label, d]) => ({ label, day: d, info: days.get(dayKey(d)) || null }));
  return { days, streak: st, any, monthDays: month.length, words, week, weekDays: daysBetween(weekStart, today) + 1,
           dayOfMonth: today.getDate(), top, onThisDay, writtenToday: st.today };
}

// --- the quarter ---------------------------------------------------------------------------
export function monthlyLists(notes) {
  return notes.filter((n) => n.kind === 'monthly').map((n) => {
    const t = parseTracker(n.text);
    return { id: n.id, note: n, trk: t, month: listMonth(n, t), items: t.items, edited: n.edited || new Date(0) };
  });
}
// The list new activities for a month go to: the one with most in it, then the newest
export const mainList = (lists) => [...lists].sort((a, b) => b.items.length - a.items.length || b.edited - a.edited)[0] || null;

export function quarterView(notes, q0, now = new Date()) {
  const today = startOfDay(now);
  const all = monthlyLists(notes);
  const months = [0, 1, 2].map((i) => {
    const m = new Date(q0.getFullYear(), q0.getMonth() + i, 1);
    const lists = all.filter((l) => +l.month === +m);
    const items = lists.flatMap((l) => l.items.map((it) => ({ it, list: l })));
    const n = { todo: 0, doing: 0, done: 0 };
    for (const x of items) n[x.it.state]++;
    const late = items.filter((x) => x.it.state !== 'done' && x.it.meta.due && x.it.meta.due < today).length;
    return { month: m, lists, items, n, late, current: m.getFullYear() === today.getFullYear() && m.getMonth() === today.getMonth() };
  });
  const items = months.flatMap((m) => m.items);
  const q1 = new Date(q0.getFullYear(), q0.getMonth() + 3, 1);
  const days = daysBetween(q0, q1);
  const gone = Math.max(0, Math.min(days, daysBetween(q0, today) + 1));
  const done = items.filter((x) => x.it.state === 'done').length;
  const open = items.filter((x) => x.it.state !== 'done');
  const soon = open.filter((x) => x.it.meta.due && x.it.meta.due >= today && x.it.meta.due <= addDays(today, 14))
    .sort((a, b) => a.it.meta.due - b.it.meta.due);
  const ratio = items.length ? done / items.length : 0, timeRatio = gone / days;
  const pace = today < q0 ? `starts in ${daysBetween(today, q0)} days`
    : today >= q1 ? 'quarter over: review time'
    : !items.length ? 'add activities to measure the pace'
    : `${ratio + 0.10 >= timeRatio ? 'on track' : 'behind'} - ${Math.round(ratio * 100)}% done, ${Math.round(timeRatio * 100)}% of the time gone`;
  return {
    q0, q1, label: `Q${Math.floor(q0.getMonth() / 3) + 1} ${q0.getFullYear()}`, months, all, items,
    total: items.length, done, doing: items.filter((x) => x.it.state === 'doing').length,
    late: open.filter((x) => x.it.meta.due && x.it.meta.due < today).length, soon,
    worked: items.reduce((s, x) => s + (x.it.meta.spent || 0), 0), days, gone, ratio, timeRatio, pace,
    inThis: today >= q0 && today < q1,
  };
}

// Suggestions for a quarter, most urgent first:
//   to Today's List (overdue, due within 2 days, reminder today, due within the week); carry
//   last months' unfinished over to this month; create a missing list; no deadline; stalled;
//   a month kept in several lists, some empty.
// Each: { title, why, doText, action 'today'|'carry'|'create'|'open', rank, key, it, month, id, alarm }
export function quarterSuggestions(notes, view, hidden = new Set(), now = new Date()) {
  const today = startOfDay(now);
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const out = [];
  const tl = findTodayList(notes);
  const onToday = new Set();
  if (tl) for (const t of todoTasks(tl.text)) if (!t.day || +t.day === +today) onToday.add(t.key);
  if (tl) {
    for (const { it } of view.items) {
      if (it.state === 'done' || onToday.has(taskKey(it.name))) continue;
      const m = it.meta, rem = reminderToday(m, today);
      let why = null, rank = 0;
      if (m.due && m.due < today) { why = `Overdue since ${shortDay(m.due)}`; rank = 1; }
      else if (m.due && m.due <= addDays(today, 2)) { why = +m.due === +today ? 'Due today' : `Due ${shortDay(m.due)}`; rank = 2; }
      else if (rem) { why = `Reminder today at ${hhmm(rem)}`; rank = 3; }
      else if (m.due && m.due <= addDays(today, 7)) { why = `Due ${shortDay(m.due)}`; rank = 4; }
      else continue;
      out.push({ title: it.name, why, doText: "Add to Today's List", action: 'today', rank, it, id: tl.id,
                 alarm: rem && rem > now ? rem : null, key: 'q:today:' + taskKey(it.name) });
    }
  }
  if (view.inThis) {
    const cur = view.all.filter((l) => +l.month === +thisMonth);
    const curKeys = new Set(cur.flatMap((l) => l.items.map((it) => taskKey(it.name))));
    const back3 = new Date(thisMonth.getFullYear(), thisMonth.getMonth() - 3, 1);
    for (const l of view.all.filter((x) => x.month < thisMonth && x.month >= back3)) {
      for (const it of l.items) {
        if (it.state === 'done' || curKeys.has(taskKey(it.name))) continue;
        out.push({ title: it.name, why: `Unfinished in ${l.month.toLocaleDateString('en-GB', { month: 'long' })}`,
                   doText: `Carry over to ${thisMonth.toLocaleDateString('en-GB', { month: 'long' })}`, action: 'carry',
                   rank: 5, it, month: thisMonth, key: 'q:carry:' + taskKey(it.name) });
      }
    }
    for (const mm of view.months) {
      if (mm.month < thisMonth || mm.lists.length) continue;
      const name = mm.month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      out.push({ title: `${name} - Activity List`, why: `No activity list for ${mm.month.toLocaleDateString('en-GB', { month: 'long' })} yet`,
                 doText: 'Create the list', action: 'create', rank: +mm.month === +thisMonth ? 2 : 6, month: mm.month,
                 key: 'q:create:' + writeDate(mm.month).slice(0, 7) });
    }
    for (const l of cur) {
      for (const it of l.items) {
        if (it.state === 'todo' && !it.meta.due) {
          out.push({ title: it.name, why: 'No deadline yet', doText: 'Open to set one', action: 'open', rank: 7, id: l.id, key: 'q:nodue:' + taskKey(it.name) });
        } else if (it.state === 'doing' && it.meta.started && daysBetween(it.meta.started, today) >= 14) {
          out.push({ title: it.name, why: `Ongoing for ${daysBetween(it.meta.started, today)} days`, doText: 'Open to finish or review',
                     action: 'open', rank: 6, id: l.id, key: 'q:stalled:' + taskKey(it.name) });
        }
      }
    }
    for (const mm of view.months) {
      const empty = mm.lists.filter((l) => !l.items.length);
      if (mm.lists.length > 1 && empty.length) {
        out.push({ title: `${mm.month.toLocaleDateString('en-GB', { month: 'long' })} has ${mm.lists.length} activity lists, ${empty.length} of them empty`,
                   why: 'Everything shows here together, but one list is easier to keep', doText: 'Open an empty one', action: 'open',
                   rank: 8, id: empty[0].id, key: `q:lists:${writeDate(mm.month).slice(0, 7)}:${mm.lists.length}` });
      }
    }
  }
  const seen = new Set(), res = [];
  for (const s of out.sort((a, b) => a.rank - b.rank)) {
    if (hidden.has(s.key) || seen.has(s.key)) continue;
    seen.add(s.key); res.push(s);
  }
  return res;
}

// --- tracker streaks -------------------------------------------------------------------------
export function trackerStreaks(notes, { monthly = false } = {}, now = new Date()) {
  const today = startOfDay(now);
  const rows = notes.filter((n) => n.kind === 'tracker' || (monthly && n.kind === 'monthly')).map((n) => {
    const t = parseTracker(n.text);
    const days = trackerDays(t);
    const set = new Set(days.map((d) => dayKey(d)));
    const st = streak(days, today);
    const done = t.items.filter((i) => i.state === 'done').length;
    return { id: n.id, name: t.title || n.title, monthly: n.kind === 'monthly', st, set,
             d30: [...set].filter((k) => new Date(k + 'T00:00:00') > addDays(today, -30)).length,
             worked: t.items.reduce((s, i) => s + (i.meta.spent || 0), 0), done, total: t.items.length,
             finished: t.items.length > 0 && done === t.items.length, days };
  });
  rows.sort((a, b) => b.st.current - a.st.current || (b.st.last || 0) - (a.st.last || 0));
  const monthSet = new Set();
  for (const r of rows) for (const k of r.set) if (k.slice(0, 7) === writeDate(today).slice(0, 7)) monthSet.add(k);
  return { rows, todayCount: rows.filter((r) => r.st.today).length, monthDays: monthSet.size,
           lead: [...rows].sort((a, b) => b.st.current - a.st.current)[0] || null,
           best: [...rows].sort((a, b) => b.st.best - a.st.best)[0] || null,
           atRisk: rows.filter((r) => r.st.atRisk && !r.finished) };
}

// --- writing (through notes.js, so the Windows app reads it unchanged) ---------------------------

// A task at the end of today's section; today's heading is made, in date order, if missing
export function addTaskToTodayText(text, { title, dur = 0, alarm = null }, now = new Date()) {
  const today = startOfDay(now);
  const line = '[ ] ' + formatTask({ ...splitTask('x'), title, dur, alarm, daily: false });
  return insertUnderDay(text, today, line);
}

function insertUnderDay(text, day, line) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length === 1 && !lines[0]) lines.length = 0;
  let start = -1, before = -1;
  lines.forEach((l, i) => {
    const m = STAMP_RX.exec(l);
    if (!m) return;
    const d = readHeadingDate(m[1]);
    if (!d) return;
    if (+startOfDay(d) === +day) start = i;
    else if (startOfDay(d) > day && before < 0) before = i;
  });
  if (start >= 0) {
    let at = start + 1;
    while (at < lines.length && !STAMP_RX.test(lines[at])) at++;
    while (at > start + 1 && !lines[at - 1].trim()) at--;   // before the blank line that ends the day
    lines.splice(at, 0, line);
  } else if (before >= 0) {
    lines.splice(before, 0, dateHeading(day), line, '');
  } else {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push(dateHeading(day), line);
  }
  return lines.join('\r\n');
}

// Move an unfinished task from another day of this list to today (a one-off alarm moves to
// the same time today if that is still to come; a snooze is dropped), and a day left with
// nothing in it loses its heading - as Move-TaskToDay does on the desktop.
export function moveTaskToTodayText(text, title, fromDay, now = new Date()) {
  const today = startOfDay(now);
  const rows = parseTodo(text);
  let day = null, hit = -1;
  rows.forEach((r, i) => {
    if (r.type === 'stamp') { day = r.date ? startOfDay(r.date) : day; return; }
    if (hit < 0 && r.type === 'task' && !r.done && day && +day === +fromDay && r.task.title === title) hit = i;
  });
  if (hit < 0) return null;
  const r = rows[hit];
  const t = { ...r.task };
  let changed = false;
  if (t.alarm && !t.daily) {
    const na = new Date(today); na.setHours(t.alarm.getHours(), t.alarm.getMinutes(), t.alarm.getSeconds(), 0);
    if (na > now && +na !== +t.alarm) { t.alarm = na; changed = true; }
  }
  if (t.snooze) { t.snooze = null; changed = true; }
  const line = changed ? `${r.indent || ''}[ ] ${formatTask(t)}` : r.raw;
  rows.splice(hit, 1);
  // drop a heading left with no tasks under it, and the blank line before it; the blank
  // line after it stays, as the gap between the days either side
  const kept = [];
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i];
    if (x.type === 'stamp') {
      let j = i + 1, any = false;
      while (j < rows.length && rows[j].type !== 'stamp') { if (rows[j].raw.trim()) any = true; j++; }
      if (!any) { while (kept.length && !kept[kept.length - 1].raw.trim()) kept.pop(); continue; }
    }
    kept.push(x);
  }
  while (kept.length && !kept[0].raw.trim()) kept.shift();
  return insertUnderDay(formatTodo(kept).replace(/(\r\n)+$/, ''), today, line);
}

// An activity, not started yet, at the end of the first section (Objectives / Not started)
export function addActivityText(text, monthly, { name, due = null, alarm = null }, now = new Date()) {
  const t = parseTracker(text);
  t.items.push({ state: 'todo', name, dirty: true,
                 meta: { added: now, started: null, finished: null, due, alarm, daily: false, snooze: null, watch: null, spent: null } });
  if (!t.started) t.started = now;
  return formatTracker(t, monthly);
}

// A new monthly list's text, started on the 1st of its month (as the desktop makes them)
export function monthlyListText(month) {
  const title = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + ' - Activity List';
  return formatTracker({ title, started: new Date(month.getFullYear(), month.getMonth(), 1), items: [], notes: null }, true);
}
