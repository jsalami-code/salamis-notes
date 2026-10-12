// dashview.js - the Dashboards screen: Today, Journal, Quarter, Streaks.
//
// Drawn into the note area (beside the list on a wide screen, instead of it on a phone).
// The numbers and suggestions come from dash.js; acting on a suggestion edits the notes in
// this device's store, and they reach the desktop with the next sync like any other edit.

import {
  readNotes, findTodayList, todayStats, todaySuggestions, journalStats, quarterView, quarterSuggestions,
  trackerStreaks, mainList, addTaskToTodayText, moveTaskToTodayText, addActivityText, monthlyListText,
  startOfDay, addDays, shortDay, hhmm, quarterStart,
} from './dash.js';
import { durText, writeDate, STAMP_RX, readHeadingDate, KIND_LABEL } from './notes.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const MONTH = (d) => d.toLocaleDateString('en-GB', { month: 'long' });

// "Not relevant": hidden for two weeks, on this device
const HIDDEN = 'sn:hidden';
function hidden() {
  let h = {};
  try { h = JSON.parse(localStorage.getItem(HIDDEN)) || {}; } catch { h = {}; }
  const cut = Date.now() - 14 * 86400000;
  return new Set(Object.entries(h).filter(([, at]) => Date.parse(at) > cut).map(([k]) => k));
}
function hide(key) {
  let h = {};
  try { h = JSON.parse(localStorage.getItem(HIDDEN)) || {}; } catch { h = {}; }
  h[key] = new Date().toISOString();
  localStorage.setItem(HIDDEN, JSON.stringify(h));
}

let state = { tab: 'today', q0: quarterStart(), journalDay: null, streakSel: null, monthly: false, said: '' };
let ctx = null;   // { store, openNote, body }

export function openDashboard(body, tab, context) {
  ctx = { ...context, body };
  if (tab) state.tab = tab;
  state.said = '';
  draw();
}
export const dashboardTab = () => state.tab;
export function redrawDashboard() { if (ctx && ctx.body.isConnected && ctx.body.querySelector('.dash')) draw(); }

function save(id, text) {
  const j = ctx.store.get(id);
  if (!j) return;
  j.text = text;
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  j.edited = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  ctx.store.put(id, j);
}

function draw() {
  const body = ctx.body;
  body.textContent = '';
  body.classList.add('pad');
  const wrap = el('div', 'dash');
  const tabs = el('div', 'tabs');
  for (const [k, label] of [['today', 'Today'], ['journal', 'Journal'], ['quarter', 'Quarter'], ['streaks', 'Streaks']]) {
    const b = el('button', state.tab === k ? 'on' : '', label);
    b.onclick = () => { state.tab = k; state.said = ''; draw(); };
    tabs.append(b);
  }
  wrap.append(tabs);
  const notes = readNotes(ctx.store.all());
  ({ today: drawToday, journal: drawJournal, quarter: drawQuarter, streaks: drawStreaks })[state.tab](wrap, notes);
  body.append(wrap);
}

function tile(value, caption, ratio = null, cls = '') {
  const t = el('div', 'tile' + (cls ? ' ' + cls : ''));
  t.append(el('b', null, value), el('small', null, caption));
  if (ratio != null) { const p = el('i', 'pb'); p.style.width = Math.round(Math.min(1, ratio) * 100) + '%'; t.append(p); }
  return t;
}
const tiles = (...ts) => { const g = el('div', 'tiles'); g.append(...ts); return g; };
const said = (wrap) => { if (state.said) wrap.append(el('div', 'said', state.said)); };

// --- Today ------------------------------------------------------------------------------------
function drawToday(wrap, notes) {
  const tl = findTodayList(notes);
  const now = new Date();
  wrap.append(el('h2', null, 'Today  ·  ' + now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })));
  if (!tl) {
    wrap.append(el('p', 'hint', "No to-do list yet. Make Today's List and it fills up from here."));
    const b = el('button', 'act', "Make Today's List");
    b.onclick = () => { const { id } = ctx.store.create('today'); state.said = "Today's List made."; ctx.openNote(id); };
    wrap.append(b);
    return;
  }
  const st = todayStats(tl, now);
  const s = st.streak;
  wrap.append(tiles(
    tile(`${st.done} / ${st.total}`, !st.total ? 'nothing on today yet' : st.done === st.total ? 'all done today' : 'done today', st.total ? st.done / st.total : 0),
    tile(st.togo ? durText(st.togo) : '-', st.togo ? 'left to do (tasks with a duration)' : 'no durations on what is left'),
    tile(plural(s.current, 'day'), s.atRisk ? 'in a row - finish one today to keep it' : s.current ? `in a row with a task done (best ${s.best})` : `finish a task to start a streak (best ${s.best})`, null, s.atRisk ? 'warn' : ''),
    tile(st.next ? (+startOfDay(st.next) === +startOfDay(now) ? hhmm(st.next) : `${shortDay(st.next).slice(0, 3)} ${hhmm(st.next)}`) : '-', st.next ? 'next alarm: ' + st.nextTitle : 'no alarms coming up'),
  ));
  const bits = [];
  if (st.carried) bits.push(`${st.carried} carried over`);
  if (st.cal) bits.push(`${st.cal} from your calendar`);
  bits.push(`${st.weekDone} finished in the last 7 days`);
  wrap.append(el('div', 'line', bits.join('  ·  ')));
  // the week
  const chart = el('div', 'week');
  const max = Math.max(1, ...st.week.map((w) => w.n));
  st.week.forEach((w, i) => {
    const c = el('div', 'col' + (i === 6 ? ' now' : ''));
    const bar = el('i');
    bar.style.height = Math.max(3, Math.round((w.n / max) * 72)) + 'px';
    c.append(el('span', 'n', String(w.n)), bar, el('span', 'd', i === 6 ? 'Today' : w.day.toLocaleDateString('en-GB', { weekday: 'short' })));
    chart.append(c);
  });
  wrap.append(el('div', 'cap', 'Tasks finished, last 7 days'), chart);

  // For today
  const head = el('div', 'h3');
  head.append(el('span', null, 'For today'), el('small', null, 'suggestions from all your lists, most urgent first'));
  wrap.append(head);
  said(wrap);
  const sug = todaySuggestions(notes, tl, hidden(), now);
  if (!sug.length) { wrap.append(el('p', 'hint', 'No suggestions - you are all caught up.')); return; }
  sug.forEach((s, k) => {
    if (k === 0) wrap.append(el('div', 'grp', 'Most relevant'));
    if (k === 7) wrap.append(el('div', 'grp', 'More suggestions'));
    const r = el('div', 'sug' + (s.rank === 1 ? ' late' : ''));
    const txt = el('div', 'txt');
    txt.append(el('div', 't', s.title), el('div', 'w', `${s.why}  ·  ${s.from}`));
    txt.onclick = () => ctx.openNote(s.src);
    const add = el('button', 'act', s.action === 'move' ? 'Move to today' : '+ Add');
    add.onclick = () => {
      const fresh = ctx.store.get(tl.id);
      let text = null;
      if (s.action === 'move') text = moveTaskToTodayText(fresh.text ?? '', s.title, s.rowDay, new Date());
      else text = addTaskToTodayText(fresh.text ?? '', { title: s.title, dur: s.dur, alarm: s.alarm }, new Date());
      if (text == null) { state.said = 'That task has changed meanwhile - nothing moved.'; draw(); return; }
      save(tl.id, text);
      state.said = `${s.action === 'move' ? 'Moved' : 'Added'} "${s.title}" to today.`;
      draw();
    };
    const no = el('button', 'quiet', 'Not relevant');
    no.onclick = () => { hide(s.key); state.said = 'Hidden for two weeks.'; draw(); };
    const btns = el('div', 'btns');
    btns.append(add, no);
    r.append(txt, btns);
    wrap.append(r);
  });
}

// --- Journal ----------------------------------------------------------------------------------
function drawJournal(wrap, notes) {
  const now = new Date();
  const j = journalStats(notes, now);
  wrap.append(el('h2', null, 'Journal' + (j.writtenToday ? '  ✓ written today' : '')));
  const s = j.streak;
  wrap.append(tiles(
    tile(plural(s.current, 'day'), s.atRisk ? `journal streak - write today to keep it (best ${s.best})` : s.current ? `journal streak, in a row (best ${s.best})` : `write today to start a streak (best ${s.best})`, null, s.atRisk ? 'warn' : ''),
    tile(`${j.monthDays} of ${j.dayOfMonth}`, 'days written this month', j.monthDays / j.dayOfMonth),
    tile(String(j.words), 'words in your journal this month' + (j.monthDays ? ` (${Math.round(j.words / j.monthDays)} a day)` : '')),
    tile(`${j.week} of ${j.weekDays}`, 'days written this week' + (j.any.current > s.current ? `; any note: ${j.any.current} in a row` : '')),
  ));
  // 16 weeks, a square a day, Monday at the top
  const today = startOfDay(now);
  const start = addDays(today, -(7 * 15) - ((today.getDay() + 6) % 7));
  wrap.append(el('div', 'cap', 'The last 16 weeks - darker = more written in your journal; blue = other notes only. Tap a day to read it.'));
  const heat = el('div', 'heat');
  for (let i = 0; i < 16 * 7; i++) {
    const d = addDays(start, i);
    const c = el('button', 'c');
    if (d > today) { c.classList.add('future'); c.disabled = true; heat.append(c); continue; }
    const info = j.days.get(writeDate(d));
    if (info?.journal) c.classList.add('j' + Math.min(3, Math.floor(info.words / 40)));
    else if (info) c.classList.add('o');
    if (+d === +today) c.classList.add('today');
    if (state.journalDay && +d === +state.journalDay) c.classList.add('sel');
    c.title = d.toDateString() + (info ? (info.journal ? ` - ${info.words} words in your journal` : ' - other notes') : ' - nothing written');
    c.onclick = () => { state.journalDay = d; draw(); };
    heat.append(c);
  }
  wrap.append(heat);
  const otd = el('div', 'otd');
  for (const o of j.onThisDay) {
    const b = el('button', 'link', `${o.label} (${shortDay(o.day)}): ${o.info ? (o.info.journal ? 'read it' : 'other notes') : 'nothing written'}`);
    b.disabled = !o.info;
    b.onclick = () => { state.journalDay = o.day; draw(); };
    otd.append(b);
  }
  wrap.append(otd);
  if (j.top.length) wrap.append(el('div', 'line', 'Most written in this month (days): ' + j.top.map((t) => `${t.name} (${t.days})`).join(', ')));

  // the chosen day, as the desktop journal pane shows it
  const day = state.journalDay || today;
  wrap.append(el('div', 'h3', day.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })));
  let any = false;
  for (const n of notes) {
    const lines = entriesOn(n.text, day);
    if (!lines.length) continue;
    any = true;
    const box = el('div', 'entry2');
    const h = el('button', 'who', n.id === 'journal' && !n.name ? 'Daily Journal' : n.title);
    h.onclick = () => ctx.openNote(n.id);
    box.append(h, el('div', 'body', lines.join('\n')));
    wrap.append(box);
  }
  if (!any) wrap.append(el('p', 'hint', 'Nothing was written on this day.'));
}

function entriesOn(text, day) {
  const out = [];
  let on = false;
  for (const line of String(text).split(/\r?\n/)) {
    const m = STAMP_RX.exec(line);
    if (m) { const d = readHeadingDate(m[1]); on = !!d && +startOfDay(d) === +day; continue; }
    if (on) out.push(line);
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

// --- Quarter ----------------------------------------------------------------------------------
function drawQuarter(wrap, notes) {
  const now = new Date();
  const v = quarterView(notes, state.q0, now);
  const nav = el('div', 'qnav');
  const prev = el('button', 'quiet', '◀'), next = el('button', 'quiet', '▶'), cur = el('button', 'quiet', 'This quarter');
  prev.onclick = () => { state.q0 = new Date(state.q0.getFullYear(), state.q0.getMonth() - 3, 1); draw(); };
  next.onclick = () => { state.q0 = new Date(state.q0.getFullYear(), state.q0.getMonth() + 3, 1); draw(); };
  cur.onclick = () => { state.q0 = quarterStart(); draw(); };
  const last = new Date(v.q0.getFullYear(), v.q0.getMonth() + 2, 1);
  nav.append(prev, next, el('h2', null, `${v.label}  ·  ${MONTH(v.q0)} – ${MONTH(last)} ${last.getFullYear()}` + (v.inThis ? '  (this quarter)' : '')), cur);
  wrap.append(nav);
  const today = startOfDay(now);
  wrap.append(tiles(
    tile(`${v.done} / ${v.total}`, v.total ? `activities finished (${Math.round(v.ratio * 100)}%)` : 'no activities yet', v.ratio),
    tile(v.inThis ? `Day ${v.gone} of ${v.days}` : `${v.days} days`, v.pace, v.timeRatio, v.pace.startsWith('behind') ? 'warn' : ''),
    tile(String(v.late), v.late ? 'overdue - past their deadline' : 'nothing overdue', null, v.late ? 'bad' : ''),
    tile(String(v.soon.length), v.soon.length ? `due in the next 14 days - first: ${v.soon[0].it.name}, ${shortDay(v.soon[0].it.meta.due)}` : 'due in the next 14 days'),
    tile(String(v.doing), 'ongoing now'),
    tile(fmtWorked(v.worked), 'worked on activities this quarter (their timers)'),
  ));
  // the three months
  const cols = el('div', 'months');
  for (const m of v.months) {
    const col = el('div', 'mcol');
    const head = el('div', 'mhead');
    const tot = m.n.todo + m.n.doing + m.n.done;
    head.append(el('b', null, m.month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + (m.current ? '  - this month' : '')));
    head.append(el('small', null, !m.lists.length ? 'no list for this month yet'
      : `${m.n.done} of ${tot} finished` + (m.n.doing ? ` - ${m.n.doing} ongoing` : '') + (m.late ? ` - ${m.late} overdue` : '') + (m.lists.length > 1 ? ` - ${m.lists.length} lists` : '')));
    const pb = el('i', 'pb'); pb.style.width = (tot ? Math.round((m.n.done / tot) * 100) : 0) + '%';
    head.append(pb);
    const ob = el('button', 'quiet', m.lists.length ? 'Open list' : 'Create list');
    ob.onclick = () => {
      if (m.lists.length) { ctx.openNote(mainList(m.lists).id); return; }
      const id = newMonthly(m.month);
      state.said = `Created the ${MONTH(m.month)} list.`;
      ctx.openNote(id);
    };
    head.append(ob);
    col.append(head);
    for (const [st, label] of [['doing', 'Ongoing'], ['todo', 'Not started'], ['done', 'Finished']]) {
      const mine = m.items.filter((x) => x.it.state === st);
      if (!mine.length) continue;
      col.append(el('div', 'grp', `${label} (${mine.length})`));
      for (const x of mine) {
        const r = el('button', 'act-row' + (st === 'done' ? ' done' : ''));
        r.append(el('span', 't', x.it.name), el('span', 'due' + (st !== 'done' && x.it.meta.due && x.it.meta.due < today ? ' late' : ''), dueText(x.it, today)));
        r.onclick = () => ctx.openNote(x.list.id);
        col.append(r);
      }
    }
    const add = el('input', 'madd');
    add.placeholder = `+ Add an activity to ${MONTH(m.month)}`;
    add.enterKeyHint = 'done';
    add.onkeydown = (e) => {
      if (e.key !== 'Enter' || !add.value.trim()) return;
      e.preventDefault();
      const id = m.lists.length ? mainList(m.lists).id : newMonthly(m.month);
      save(id, addActivityText(ctx.store.get(id).text ?? '', true, { name: add.value.trim() }));
      state.said = `Added "${add.value.trim()}" to ${MONTH(m.month)}.`;
      draw();
    };
    col.append(add);
    cols.append(col);
  }
  wrap.append(cols);

  // suggestions for the quarter
  const head = el('div', 'h3');
  head.append(el('span', null, 'Suggestions for this quarter'));
  wrap.append(head);
  said(wrap);
  const sug = quarterSuggestions(notes, v, hidden(), now);
  if (!sug.length) { wrap.append(el('p', 'hint', 'No suggestions for this quarter - all in order.')); return; }
  for (const s of sug) {
    const r = el('div', 'sug' + (s.rank === 1 ? ' late' : ''));
    const txt = el('div', 'txt');
    txt.append(el('div', 't', s.title), el('div', 'w', s.why));
    const go = el('button', 'act', s.doText);
    go.onclick = () => {
      if (s.action === 'today') {
        save(s.id, addTaskToTodayText(ctx.store.get(s.id).text ?? '', { title: s.title, alarm: s.alarm }, new Date()));
        state.said = `Added "${s.title}" to Today's List.`;
      } else if (s.action === 'carry') {
        const lists = v.all.filter((l) => +l.month === +s.month);
        const id = lists.length ? mainList(lists).id : newMonthly(s.month);
        const due = s.it.meta.due && s.it.meta.due >= startOfDay() ? s.it.meta.due : null;
        save(id, addActivityText(ctx.store.get(id).text ?? '', true, { name: s.title, due }));
        state.said = `Carried "${s.title}" over to ${MONTH(s.month)}.`;
      } else if (s.action === 'create') {
        newMonthly(s.month);
        state.said = `Created the ${MONTH(s.month)} list.`;
      } else { ctx.openNote(s.id); return; }
      hide(s.key);   // done with: it does not come back
      draw();
    };
    const no = el('button', 'quiet', 'Not relevant');
    no.onclick = () => { hide(s.key); state.said = 'Hidden for two weeks.'; draw(); };
    const btns = el('div', 'btns');
    btns.append(go, no);
    r.append(txt, btns);
    wrap.append(r);
  }
}

function newMonthly(month) {
  const { id, json } = ctx.store.create('monthly');
  json.text = monthlyListText(month);
  ctx.store.put(id, json);
  return id;
}

function dueText(it, today) {
  const m = it.meta;
  if (it.state === 'done') return m.finished ? 'done ' + m.finished.getDate() + ' ' + m.finished.toLocaleDateString('en-GB', { month: 'short' }) : 'done';
  if (!m.due) return '';
  const dd = Math.round((startOfDay(m.due) - today) / 86400000);
  if (dd < 0) return `overdue ${-dd}d`;
  if (dd === 0) return 'due today';
  if (dd === 1) return 'due tmrw';
  return 'due ' + m.due.getDate() + ' ' + m.due.toLocaleDateString('en-GB', { month: 'short' });
}

function fmtWorked(sec) {
  if (!sec) return '-';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h${m ? ' ' + m + 'm' : ''}` : `${m}m`;
}

// --- Streaks ----------------------------------------------------------------------------------
function drawStreaks(wrap, notes) {
  const now = new Date();
  const today = startOfDay(now);
  const s = trackerStreaks(notes, { monthly: state.monthly }, now);
  wrap.append(el('h2', null, 'Tracker streaks'));
  wrap.append(tiles(
    tile(`${s.todayCount} of ${s.rows.length}`, 'trackers worked on today', s.rows.length ? s.todayCount / s.rows.length : 0),
    tile(s.lead && s.lead.st.current ? plural(s.lead.st.current, 'day') : '-', s.lead && s.lead.st.current ? 'longest streak now: ' + s.lead.name : 'no streak going - work on a tracker today'),
    tile(s.best ? plural(s.best.st.best, 'day') : '-', s.best ? 'best streak ever: ' + s.best.name : ''),
    tile(`${s.monthDays} of ${today.getDate()}`, 'days this month with tracker work', s.monthDays / today.getDate()),
  ));
  const risk = el('div', 'line' + (s.atRisk.length ? ' warn' : ''));
  risk.textContent = s.atRisk.length
    ? 'Keep it going: ' + s.atRisk.map((r) => `${r.name} (${r.st.current})`).join(', ') + ' - do one thing on it today, or the streak ends tonight.'
    : s.todayCount ? `Good work - ${plural(s.todayCount, 'tracker')} worked on today.`
    : 'Nothing at risk. Start a streak: add, start or finish an objective, or write a note, in any tracker.';
  wrap.append(risk);
  const opt = el('label', 'opt');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.monthly;
  cb.onchange = () => { state.monthly = cb.checked; draw(); };
  opt.append(cb, document.createTextNode(' Include monthly activity lists'));
  wrap.append(opt);
  wrap.append(el('div', 'cap', 'A day counts when you add, start or finish an objective, or write notes under that day. Tap a tracker for its last 20 weeks.'));
  for (const r of s.rows) {
    const row = el('button', 'srow' + (r.st.atRisk ? ' warn' : r.st.current ? '' : ' dim') + (state.streakSel === r.id ? ' sel' : ''));
    const top = el('div', 'top');
    top.append(el('b', null, r.name + (r.monthly ? '  (monthly)' : '')),
      el('span', 'num', r.st.current ? plural(r.st.current, 'day') + (r.st.atRisk ? ' (at risk)' : r.st.today ? ' ✓' : '') : '-'));
    const meta = el('div', 'meta', `${r.done}/${r.total} finished · best ${r.st.best} · ${r.d30} of 30 days · last ${lastText(r.st.last, today)}` + (r.worked ? ` · ${fmtWorked(r.worked)} on its timers` : ''));
    const dots = el('div', 'dots');
    for (let k = 13; k >= 0; k--) dots.append(el('i', r.set.has(writeDate(addDays(today, -k))) ? 'on' : ''));
    row.append(top, meta, dots);
    row.onclick = () => { state.streakSel = state.streakSel === r.id ? null : r.id; draw(); };
    wrap.append(row);
    if (state.streakSel === r.id) {
      const box = el('div', 'heatbox');
      const start = addDays(today, -(7 * 19) - ((today.getDay() + 6) % 7));
      const heat = el('div', 'heat');
      for (let i = 0; i < 20 * 7; i++) {
        const d = addDays(start, i);
        const c = el('i', 'c' + (d > today ? ' future' : r.set.has(writeDate(d)) ? ' b' : '') + (+d === +today ? ' today' : ''));
        heat.append(c);
      }
      const open = el('button', 'act', 'Open the tracker');
      open.onclick = (e) => { e.stopPropagation(); ctx.openNote(r.id); };
      box.append(el('div', 'cap', `${r.name} - the last 20 weeks`), heat, open);
      wrap.append(box);
    }
  }
  if (!s.rows.length) wrap.append(el('p', 'hint', 'No task trackers yet.'));
}

function lastText(d, today) {
  if (!d) return 'never';
  const n = Math.round((today - startOfDay(d)) / 86400000);
  return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
}

export const DASH_FOR_KIND = { today: 'today', todo: 'today', monthly: 'quarter', tracker: 'streaks' };
export { KIND_LABEL };
