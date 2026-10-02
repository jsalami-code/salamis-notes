// alarms.js - the countdowns, stopwatches and alarms that ride on a task's line.
//
// The tokens are shared with the Windows app, so the arithmetic has to match it exactly:
//
//   ~30m                 how long the task should take
//   @timer <stamp>       a countdown running: the moment it *would* have started had it
//                        never been paused, so remaining = duration - (now - stamp)
//   @paused 0:12:34      a countdown stopped, with that much left
//   @watch <stamp>       a stopwatch counting up since then
//   @spent 0:05:12       a stopwatch stopped, with that much on it
//
// Notifications fire while the app is open. A phone cannot wake a web app that is closed
// without a push server, so a closed app catches up when you next open it - see the README.

const FIRED = 'sn:fired';

export function fmt(secs) {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
           : `${m}:${String(ss).padStart(2, '0')}`;
}

// What the task's timer is doing right now.
export function timerState(t, now = new Date()) {
  if (t.timer) {
    const total = (t.dur || 0) * 60;
    return { kind: 'countdown', running: true, secs: total - (now - t.timer) / 1000 };
  }
  if (t.left != null) return { kind: 'countdown', running: false, secs: t.left };
  if (t.watch) return { kind: 'stopwatch', running: true, secs: (now - t.watch) / 1000 };
  if (t.spent != null) return { kind: 'stopwatch', running: false, secs: t.spent };
  return { kind: null, running: false, secs: 0 };
}

// Start: a task with a duration counts down, one without counts up.
export function startTimer(t, now = new Date()) {
  const st = timerState(t, now);
  if (t.dur) {
    const left = st.kind === 'countdown' ? Math.max(0, st.secs) : t.dur * 60;
    t.timer = new Date(now.getTime() - (t.dur * 60 - left) * 1000);
    t.left = null; t.watch = null; t.spent = null;
  } else {
    const done = st.kind === 'stopwatch' ? st.secs : 0;
    t.watch = new Date(now.getTime() - done * 1000);
    t.timer = null; t.left = null; t.spent = null;
  }
  return t;
}

export function pauseTimer(t, now = new Date()) {
  const st = timerState(t, now);
  if (st.kind === 'countdown') { t.left = Math.max(0, Math.round(st.secs)); t.timer = null; }
  else if (st.kind === 'stopwatch') { t.spent = Math.max(0, Math.round(st.secs)); t.watch = null; }
  return t;
}

export function resetTimer(t) {
  t.timer = null; t.left = null; t.watch = null; t.spent = null;
  return t;
}

// --- notifications ----------------------------------------------------------------------

export function canNotify() { return 'Notification' in window; }
export function notifyState() { return canNotify() ? Notification.permission : 'unsupported'; }

export async function askPermission() {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

function fired() { try { return JSON.parse(localStorage.getItem(FIRED)) || {}; } catch { return {}; } }
function markFired(key) {
  const f = fired();
  f[key] = Date.now();
  // keep this from growing for ever: drop anything older than a week
  const cutoff = Date.now() - 7 * 86400000;
  for (const k of Object.keys(f)) if (f[k] < cutoff) delete f[k];
  localStorage.setItem(FIRED, JSON.stringify(f));
}

async function show(title, body, noteId) {
  const opts = { body, icon: './icon-192.png', badge: './icon-192.png', tag: noteId,
                 data: { noteId }, requireInteraction: false };
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) return reg.showNotification(title, opts);   // survives the page being backgrounded
  return new Notification(title, opts);
}

// Everything due now, across every note. Returns what it fired, so the caller can show it
// in the app too (a notification you have not granted still deserves to be visible).
export async function checkAlarms(store, { parseTodo, parseTracker, noteKind, noteTitle },
                                  now = new Date()) {
  const due = [];
  const f = fired();
  for (const { id, json } of store.all()) {
    const kind = noteKind(json);
    const title = noteTitle({ text: String(json.text ?? ''), name: (json.name ?? '').trim(), kind, raw: json });
    const add = (when, what, key) => {
      if (!when || when > now) return;
      if (now - when > 12 * 3600 * 1000) return;     // long past: do not shout about it now
      const k = `${id}|${key}|${when.getTime()}`;
      if (f[k]) return;
      due.push({ noteId: id, noteTitle: title, what, when, key: k });
    };
    if (kind === 'todo' || kind === 'today') {
      for (const r of parseTodo(json.text)) {
        if (r.type !== 'task' || r.done) continue;
        const t = r.task;
        add(t.snooze || t.alarm, t.title, 'a:' + t.title);
        const st = timerState(t, now);
        if (st.kind === 'countdown' && st.running && st.secs <= 0) add(now, t.title + ' - time is up', 'z:' + t.title);
      }
    } else if (kind === 'tracker' || kind === 'monthly') {
      for (const it of parseTracker(json.text).items) {
        if (it.state === 'done') continue;
        add(it.meta.snooze || it.meta.alarm, it.name, 'a:' + it.name);
      }
    }
  }
  for (const d of due) {
    markFired(d.key);
    try { await show(d.noteTitle, d.what, d.noteId); } catch { /* permission withdrawn mid-flight */ }
  }
  return due;
}
