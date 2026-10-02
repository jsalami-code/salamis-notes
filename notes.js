// notes.js - the note format, shared by every screen of the web app.
//
// This is the contract with StickyNote.ps1: the Windows app and this one read and write
// the same note-<id>.json files in the same folder. Anything written here must come back
// out of the PowerShell reader unchanged, so the parsing and the writing below mirror
// Split-Task / Format-Task and Read-TrkLine / Get-TrackerText line for line.
//
// Guiding rule: a line we did not edit is written back exactly as it came in. Only lines
// the user actually changes are re-formatted.

export const INV = 'en-GB';

// --- small helpers -------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

// 'yyyy-MM-dd HH:mm' or 'yyyy-MM-dd HH:mm:ss' -> Date (local), mirroring Write-Stamp
export function writeStamp(d) {
  const s = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.getSeconds() ? `${s}:${pad2(d.getSeconds())}` : s;
}
export function writeStampSec(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
export function writeStampMin(d) {   // Write-TrkStamp: always to the minute
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function writeDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function readDate(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
export function readStamp(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim().replace(/\s+/g, ' '));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
}
// Format-Hms: 754 -> "0:12:34"
export function formatHms(sec) {
  return `${Math.floor(sec / 3600)}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
}
// Get-DurText: 90 -> "1h30m" (gap '') or "1h 30m" (gap ' ')
export function durText(min, gap = ' ') {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}h${gap}${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// --- which kind of note ----------------------------------------------------------------
// Same precedence StickyNote.ps1 applies when it loads one: tracker beats todo, and a
// monthly activity list is a tracker with the monthly flag.
export const KINDS = ['today', 'todo', 'tracker', 'monthly', 'note'];
export const KIND_LABEL = {
  today: "Today's List", todo: 'To-do list', tracker: 'Task tracker',
  monthly: 'Monthly activity list', note: 'Note',
};
export function noteKind(j) {
  if (j.tracker && j.monthly) return 'monthly';
  if (j.tracker) return 'tracker';
  if (j.todo && j.today) return 'today';
  if (j.todo) return 'todo';
  return 'note';
}

// --- date stamps ("--- Thursday, 1 October 2026 ---") ------------------------------------
export const STAMP_RX = /^\s*---\s+(.+?)\s+---\s*$/;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function dateHeading(d = new Date()) {
  return `--- ${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ---`;
}
// "Thursday, 1 October 2026" -> Date, for grouping the journal by day
export function readHeadingDate(s) {
  const m = /^(?:\w+,\s*)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m[2].slice(0, 3).toLowerCase()));
  return mon < 0 ? null : new Date(+m[3], mon, +m[1]);
}

// --- to-do task lines --------------------------------------------------------------------
// "[ ] Read ch. 3 ~30m @7:30pm @from 2026-10-01"
export const TODO_RX = /^(\s*)\[([ xX]?)\]\s?(.*)$/;

const FROM_RX = /\s+@from\s+(\d{4}-\d{2}-\d{2})$/i;
const CAL_RX = /\s+@cal\s+([0-9a-f]{8})$/i;
const SNOOZE_RX = /\s+@snooze\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/i;
const TIMER_RX = /\s+@timer\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/i;
const WATCH_RX = /\s+@watch\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/i;
const PAUSED_RX = /\s+@(paused|spent)\s+(\d+):(\d{2}):(\d{2})$/i;
const DUR_RX = /\s+~\s?(?:(\d+)\s?(?:hours?|hrs?|h))?\s?(?:(\d+)\s?(?:minutes?|mins?|m)?)?$/i;
const ALARM_RX = /\s+@(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2})(?::?(\d{2}))?(?::(\d{2}))?\s*(am|pm)?(\s+daily)?$/i;

function emptyTask(title) {
  return { title, dur: 0, alarm: null, daily: false, timer: null, snooze: null,
           left: null, watch: null, spent: null, from: null, cal: null };
}

// Split-Task: read the tokens off the end of the line, last written wins.
export function splitTask(line) {
  const m = emptyTask(line.trim());
  let s = ' ' + line.trim();
  let gotDur = false, gotAlarm = false, gotTimer = false, gotSnooze = false;
  for (let n = 0; n < 14; n++) {
    let x = FROM_RX.exec(s);
    if (x) { if (!m.from) m.from = readDate(x[1]); s = s.slice(0, x.index); continue; }
    x = CAL_RX.exec(s);
    if (x) { if (!m.cal) m.cal = x[1].toLowerCase(); s = s.slice(0, x.index); continue; }
    x = SNOOZE_RX.exec(s);
    if (x) {
      if (!gotSnooze) { m.snooze = stampFrom(x, 1); gotSnooze = true; }
      s = s.slice(0, x.index); continue;
    }
    const t = TIMER_RX.exec(s), w = WATCH_RX.exec(s);
    if (t || w) {
      const y = t || w;
      if (!gotTimer) { const at = stampFrom(y, 1); if (t) m.timer = at; else m.watch = at; gotTimer = true; }
      s = s.slice(0, y.index); continue;
    }
    x = PAUSED_RX.exec(s);
    if (x) {
      if (!gotTimer) {
        const secs = +x[2] * 3600 + +x[3] * 60 + +x[4];
        if (x[1].toLowerCase() === 'paused') m.left = secs; else m.spent = secs;
        gotTimer = true;
      }
      s = s.slice(0, x.index); continue;
    }
    x = DUR_RX.exec(s);
    if (x && (x[1] !== undefined || x[2] !== undefined)) {
      if (!gotDur) { m.dur = (+x[1] || 0) * 60 + (+x[2] || 0); gotDur = true; }
      s = s.slice(0, x.index); continue;
    }
    x = ALARM_RX.exec(s);
    // a bare "@7" is too likely to be ordinary text: an alarm needs minutes or am/pm
    if (x && (x[3] !== undefined || x[5] !== undefined)) {
      let h = +x[2]; const mi = +(x[3] || 0), sec = +(x[4] || 0);
      const ap = (x[5] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12; else if (ap === 'am' && h === 12) h = 0;
      if (h <= 23 && mi <= 59 && sec <= 59) {
        let a;
        if (x[1]) { const d = readDate(x[1]); a = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi, sec); }
        else {
          const now = new Date();
          a = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi);
          if (a <= now) a.setDate(a.getDate() + 1);
        }
        if (!gotAlarm) { m.alarm = a; m.daily = !!x[6]; gotAlarm = true; }
        s = s.slice(0, x.index); continue;
      }
    }
    break;
  }
  if (s.trim()) m.title = s.trim();
  else return emptyTask(line.trim());   // tokens alone: keep it all as the name
  return m;
}

function stampFrom(x, i) {
  const d = readDate(x[i]);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), +x[i + 1], +x[i + 2], +(x[i + 3] || 0));
}

// Format-Task: name, then its tokens, in this order
export function formatTask(m) {
  let s = (m.title || '').trim();
  if (m.dur) s += ' ~' + durText(m.dur, '');
  if (m.alarm) s += ' @' + writeStamp(m.alarm) + (m.daily ? ' daily' : '');
  if (m.snooze) s += ' @snooze ' + writeStamp(m.snooze);
  if (m.timer) s += ' @timer ' + writeStamp(m.timer);
  else if (m.left != null) s += ' @paused ' + formatHms(m.left);
  else if (m.watch) s += ' @watch ' + writeStamp(m.watch);
  else if (m.spent != null) s += ' @spent ' + formatHms(m.spent);
  if (m.cal) s += ' @cal ' + m.cal;
  if (m.from) s += ' @from ' + writeDate(m.from);
  return s;
}

// A to-do note as rows. Anything that is not a task or a date heading is kept verbatim,
// so writing the note back cannot disturb it.
export function parseTodo(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => {
    const st = STAMP_RX.exec(line);
    if (st) return { type: 'stamp', raw: line, label: st[1], date: readHeadingDate(st[1]) };
    const td = TODO_RX.exec(line);
    if (td) {
      return { type: 'task', raw: line, indent: td[1], done: td[2].toLowerCase() === 'x',
               task: splitTask(td[3]) };
    }
    return { type: 'text', raw: line };
  });
}
export function formatTodo(rows) {
  return rows.map((r) => {
    if (r.type !== 'task' || !r.dirty) return r.raw;
    return `${r.indent || ''}[${r.done ? 'x' : ' '}] ${formatTask(r.task)}`;
  }).join('\r\n');
}

// --- task trackers and monthly activity lists ----------------------------------------------
//   TASK: Surv Popoola MSc thesis | started 2026-10-01 15:40
//   == OBJECTIVES ==            (a monthly list calls this NOT STARTED)
//   [ ] Draft chapter 3 | added 2026-10-01 15:42 | due 2026-10-07
export const TRK_TASK_RX = /^\s*TASK:\s?(.*?)(?:\s+\|\s+started\s+(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}))?\s*$/;
export const TRK_ITEM_RX = /^\s*\[([ ~xX])\]\s?(.*?)((?:\s+\|\s+(?:added|started|finished|timer|snooze|spent|alarm|due)\s+[^|]*?)*)\s*$/;
export const TRK_HEAD_RX = /^\s*==\s*(.+?)\s*==\s*$/;
const TRK_STAMP_RX = /(added|started|finished)\s+(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})/g;
const TRK_ALARM_RX = /alarm\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(\s+daily)?/;
const TRK_DUE_RX = /due\s+(\d{4}-\d{2}-\d{2})/;
const TRK_SNOOZE_RX = /snooze\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
const TRK_TIMER_RX = /timer\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/;
const TRK_SPENT_RX = /spent\s+(\d+):(\d{2}):(\d{2})/;

export const TRK_SECTIONS = [
  { state: 'todo', title: 'OBJECTIVES', monthlyTitle: 'NOT STARTED' },
  { state: 'doing', title: 'ONGOING', monthlyTitle: 'ONGOING' },
  { state: 'done', title: 'FINISHED', monthlyTitle: 'FINISHED' },
];
export function sectionTitle(state, monthly) {
  const s = TRK_SECTIONS.find((x) => x.state === state);
  return monthly ? s.monthlyTitle : s.title;
}

function readTrkMeta(parts) {
  const m = { added: null, started: null, finished: null, due: null, alarm: null,
              daily: false, snooze: null, watch: null, spent: null };
  if (!parts) return m;
  let x;
  TRK_STAMP_RX.lastIndex = 0;
  while ((x = TRK_STAMP_RX.exec(parts)) !== null) m[x[1]] = readStamp(x[2]);
  if ((x = TRK_DUE_RX.exec(parts))) m.due = readDate(x[1]);
  if ((x = TRK_ALARM_RX.exec(parts))) { m.alarm = stampFrom(x, 1); m.daily = !!x[5]; }
  if ((x = TRK_SNOOZE_RX.exec(parts))) m.snooze = stampFrom(x, 1);
  if ((x = TRK_TIMER_RX.exec(parts))) m.watch = stampFrom(x, 1);
  else if ((x = TRK_SPENT_RX.exec(parts))) m.spent = +x[1] * 3600 + +x[2] * 60 + +x[3];
  return m;
}

export function parseTracker(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const t = { title: '', started: null, items: [], notes: null, head: lines[0] ?? '' };
  let state = 'todo', inNotes = false;
  const notes = [];
  lines.forEach((line, i) => {
    if (inNotes) { notes.push(line); return; }
    if (i === 0) {
      const m = TRK_TASK_RX.exec(line);
      if (m) { t.title = m[1].trim(); t.started = m[2] ? readStamp(m[2]) : null; return; }
    }
    const h = TRK_HEAD_RX.exec(line);
    if (h) {
      const title = h[1].trim().toUpperCase();
      if (title === 'NOTES') { inNotes = true; return; }
      if (title === 'ONGOING') state = 'doing';
      else if (title === 'FINISHED') state = 'done';
      else state = 'todo';
      return;
    }
    const it = TRK_ITEM_RX.exec(line);
    if (it) {
      const mark = it[1].toLowerCase();
      t.items.push({
        raw: line, state: mark === '~' ? 'doing' : mark === 'x' ? 'done' : state === 'done' ? 'done' : state,
        name: it[2].trim(), meta: readTrkMeta(it[3]),
      });
    }
  });
  if (inNotes) t.notes = notes.join('\r\n');
  return t;
}

// Get-TrackerText, exactly: heading, then each section, then Notes last.
export function formatTracker(t, monthly) {
  const out = [];
  let head = 'TASK: ' + (t.title || '').trim();
  if (t.started) head += ' | started ' + writeStampMin(t.started);
  out.push(head);
  for (const sec of TRK_SECTIONS) {
    out.push('');
    out.push('== ' + sectionTitle(sec.state, monthly) + ' ==');
    for (const it of t.items.filter((x) => x.state === sec.state)) {
      if (!it.dirty && it.raw != null) { out.push(it.raw.trim()); continue; }
      const mark = it.state === 'doing' ? '[~] ' : it.state === 'done' ? '[x] ' : '[ ] ';
      let s = mark + (it.name || '').trim();
      const m = it.meta || {};
      for (const k of ['added', 'started', 'finished']) if (m[k]) s += ` | ${k} ` + writeStampMin(m[k]);
      if (m.due) s += ' | due ' + writeDate(m.due);
      if (m.alarm) s += ' | alarm ' + writeStamp(m.alarm) + (m.daily ? ' daily' : '');
      if (m.snooze) s += ' | snooze ' + writeStampSec(m.snooze);
      if (m.watch) s += ' | timer ' + writeStampSec(m.watch);
      else if (m.spent != null) s += ' | spent ' + formatHms(m.spent);
      out.push(s);
    }
  }
  if (t.notes && t.notes.length) { out.push(''); out.push('== NOTES =='); out.push(t.notes); }
  return out.join('\r\n');
}

// --- the note file ----------------------------------------------------------------------
// Unknown fields are carried through untouched: the Windows app owns some of them
// (notesh, upopen, ...) and this app must not drop what it does not understand.
export function parseNote(id, json) {
  return { id, kind: noteKind(json), raw: json, text: String(json.text ?? ''),
           name: (json.name ?? '').trim(), edited: json.edited ? readStamp(json.edited) : null };
}
export function serializeNote(note, changes = {}) {
  const j = { ...note.raw, ...changes };
  if (changes.text !== undefined) j.edited = writeStampSec(new Date());
  return j;
}

// The title the search pane shows: its name, else its first real line.
export function noteTitle(note) {
  if (note.name) return note.name;
  if (note.kind === 'tracker' || note.kind === 'monthly') {
    const m = TRK_TASK_RX.exec(note.text.split(/\r?\n/)[0] || '');
    if (m && m[1].trim()) return m[1].trim();
  }
  const first = note.text.split(/\r?\n/).find((l) => l.trim() && !STAMP_RX.test(l));
  if (!first) return '(empty note)';
  const td = TODO_RX.exec(first);
  return (td ? splitTask(td[3]).title : first).trim();
}
