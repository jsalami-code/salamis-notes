# SALAMI's Notes - web app

A daily journal and tasks tracker.

The phone and browser front end for a set of sticky notes kept as one JSON file per note
in a OneDrive folder. A Windows desktop app (PowerShell + WinForms) reads and writes the
same files; this app exists so the notes are reachable from Android and iOS, where that
one cannot run.

Install it from the browser and it behaves like an app: its own window, no address bar,
and it opens from a cached copy with no network.

## What is in here

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | the two screens: the list, and one open note |
| `notes.js` | the note format - parsing and writing, byte for byte as the desktop app does |
| `store.js` | where notes live on the device, and what sync needs to know about them |
| `sync.js` | two-way sync, including what to do when both sides changed |
| `graph.js` | OneDrive through Microsoft Graph |
| `alarms.js` | countdowns, stopwatches and alarms |
| `sw.js`, `manifest.webmanifest` | installable, and works offline |

Four kinds of note, matching the desktop app: plain text notes that stamp themselves with
the day's date as you write, to-do lists, task trackers, and monthly activity lists.

## No notes are in this repository

The notes themselves live in the folder *above* this one and are never part of it.
`.gitignore` also refuses `note-*.json` outright, in case one is ever copied in.

## Running it

Any static server will do:

    python -m http.server 8777

then open <http://localhost:8777/>.

There are three test pages, all of which should be green:

| Page | Checks |
|---|---|
| `test.html` | every line of every note is re-written byte for byte |
| `sync.test.html` | the sync engine, against a stand-in OneDrive |
| `alarms.test.html` | the timer arithmetic shared with the desktop app |

## Connecting it to OneDrive

The app needs a free Azure app registration - a public single-page app, no secret - and
the `Files.ReadWrite` delegated permission. Register the address you open the app at as a
**Single-page application** redirect URI, then paste the Application (client) ID into the
app's Sync settings. The settings panel shows the exact redirect URI to register.

## Alarms, honestly

While the app is open, or in the background on Android, alarms show as notifications.
When the app has been closed nothing fires at that moment; the alarms you missed appear
the next time you open it. Waking a closed web app needs a push server, which would have
to be trusted with the notes.
