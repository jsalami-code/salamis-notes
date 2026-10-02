// sync.js - two-way sync between the notes held here and the ones in OneDrive.
//
// The engine talks to a "remote" with four methods, so it can be driven by the real
// Graph backend or by a fake one in the tests:
//
//   list()            -> [{ id, tag }]        every note-<id>.json in the folder
//   get(id)           -> { json, tag }
//   put(id, json, tag) -> { tag }             tag is what we last agreed; null to create
//   del(id, tag)      -> void
//
// A "tag" is OneDrive's cTag: it changes whenever the file's content changes. We send it
// back on write, so OneDrive refuses the write if someone changed the file meanwhile -
// that refusal is what turns a silent overwrite into a conflict we can handle.
//
// The rule when both sides changed: never lose typing. The remote copy wins the file, and
// what was written here is kept beside it as a new note marked "(conflict copy)", exactly
// as OneDrive itself does with documents.

export class Conflict extends Error {}

export async function syncAll(local, remote, { onProgress = () => {} } = {}) {
  const report = { pulled: [], pushed: [], created: [], deletedHere: [], deletedThere: [], conflicts: [], errors: [] };

  const remoteList = await remote.list();
  const remoteById = new Map(remoteList.map((r) => [r.id, r]));
  const localIds = new Set(local.ids());
  const meta = local.syncMeta;
  const tombs = local.tombstones;

  // 1. notes deleted here -> delete there, unless it changed there since
  for (const [id, t] of Object.entries(tombs)) {
    const r = remoteById.get(id);
    try {
      if (!r) { local.forget(id); continue; }       // already gone there
      if (t.tag && r.tag !== t.tag) {               // it moved on there: keep theirs
        const { json, tag } = await remote.get(id);
        local.put(id, json); local.mark(id, tag, json); local.forget(id);
        report.pulled.push(id);
      } else {
        await remote.del(id, t.tag);
        local.forget(id);
        report.deletedThere.push(id);
      }
      remoteById.delete(id);
    } catch (e) { report.errors.push({ id, where: 'delete', message: e.message }); }
  }

  // 2. every note we have here
  for (const id of localIds) {
    const r = remoteById.get(id);
    const m = meta[id];
    const dirty = local.isDirty(id);
    try {
      if (!r) {
        if (!m) {                                   // new here, never sent
          const { tag } = await remote.put(id, local.get(id), null);
          local.mark(id, tag, local.get(id));
          report.created.push(id);
        } else if (dirty) {                         // deleted there, but we changed it: put it back
          const { tag } = await remote.put(id, local.get(id), null);
          local.mark(id, tag, local.get(id));
          report.created.push(id);
        } else {                                    // deleted there, untouched here
          local.remove(id); local.forget(id);
          report.deletedHere.push(id);
        }
        continue;
      }
      remoteById.delete(id);
      const sameAsSynced = m && m.tag === r.tag;
      if (!dirty && sameAsSynced) continue;         // nothing to do
      if (!dirty) {                                 // changed there only
        const got = await remote.get(id);
        local.put(id, got.json); local.mark(id, got.tag, got.json);
        report.pulled.push(id);
        continue;
      }
      if (sameAsSynced) {                           // changed here only
        const { tag } = await remote.put(id, local.get(id), r.tag);
        local.mark(id, tag, local.get(id));
        report.pushed.push(id);
        continue;
      }
      // changed in both places
      const mine = local.get(id);
      const got = await remote.get(id);
      local.put(id, got.json); local.mark(id, got.tag, got.json);
      const copy = local.create(kindOf(mine), {
        ...mine,
        name: ((mine.name || '').trim() || 'Note') + ' (conflict copy)',
      });
      report.conflicts.push({ id, keptAs: copy.id });
      report.pulled.push(id);
    } catch (e) {
      report.errors.push({ id, where: 'sync', message: e.message });
    }
    onProgress(report);
  }

  // 3. anything left there that we have never seen -> bring it here
  for (const [id] of remoteById) {
    try {
      const got = await remote.get(id);
      local.put(id, got.json); local.mark(id, got.tag, got.json);
      report.pulled.push(id);
    } catch (e) { report.errors.push({ id, where: 'pull', message: e.message }); }
  }
  return report;
}

function kindOf(j) {
  if (j.tracker && j.monthly) return 'monthly';
  if (j.tracker) return 'tracker';
  if (j.todo && j.today) return 'today';
  if (j.todo) return 'todo';
  return 'note';
}

export function describe(r) {
  const bits = [];
  if (r.pulled.length) bits.push(`${r.pulled.length} in`);
  if (r.pushed.length + r.created.length) bits.push(`${r.pushed.length + r.created.length} out`);
  if (r.deletedHere.length) bits.push(`${r.deletedHere.length} removed here`);
  if (r.deletedThere.length) bits.push(`${r.deletedThere.length} removed there`);
  if (r.conflicts.length) bits.push(`${r.conflicts.length} conflict copy`);
  if (r.errors.length) bits.push(`${r.errors.length} failed`);
  return bits.length ? bits.join(', ') : 'already up to date';
}
