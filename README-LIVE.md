# VIRTUS // LIVE SYNC & NETLIFY DEPLOYMENT

**Live sharing is built-in and needs zero setup.** The tracker ships
pre-connected to a shared Firebase Realtime Database (the same project
that powers *Schungzie's Radar System*), exactly like the radar app:
open the page → you're live.

---

## 1 · Deploy on Netlify (only task)

1. Netlify → **Add new site → Deploy manually**.
2. Drag & drop the `afterlight-tracker/` folder (index.html at its root).
3. Share the URL with your group. Done — it is live for everyone.

(`netlify.toml` is included: static publish, long caching for the map JPEGs.)

## 2 · Using boards

- The app **auto-connects** on load to the default board (`public`).
- Click **◉ LIVE** to switch boards: any group on the same **BOARD CODE**
  shares the same markers. You can also link straight to a board:
  `https://your-site.netlify.app/?board=virtus-crew`
- Set your **call sign** in the LIVE panel — the panel and status bar show
  how many operators are online right now.

## 3 · What syncs

Every screen on the same board updates in about a second:

- place / move / rename / hide / delete **characters**
- **near-live dragging** — others watch the marker glide
- create / rename / recolor / delete **locations**
- **pings** — including their auto-expiry, simultaneously for everyone
- **JSON import** while live → mass-syncs the whole setup to the board
- **timeline calendar layers** — each active date (2085–2100) syncs its own
  character positions and story pings to everyone on that date. Roster
  entries and Locations stay global. Peers sitting on a different date (or
  on NO DATE) never see another date's layer — until they press that date
  in the CAL drawer and it loads for them too
- **NO DATE is the atlas view** — character markers are hidden there;
  only fixed Locations and story pings show. All dated pings appear as
  dashed ghost markers with their date under the label (and in the sidebar
  list). Click one → ◷ PROCEED TO DATE jumps straight into that timeline
  and lets you place characters
- new joiners receive the full shared reality first, and anything that
  exists only on their device is uploaded for everyone

Conflicts resolve **last-writer-wins per marker**. Character avatars must be
image *URLs* for others to see them; user-uploaded map images stay local
(sync covers markers on the built-in hosted maps).

If the network or Firebase is unreachable, the app silently behaves like the
classic offline build (LocalStorage autosave + JSON export/import) and
re-syncs when connectivity returns.

## 4 · Optional: your own private database

Want your markers on a database you own? Create a free Firebase project with
a **Realtime Database** (test mode rules), then paste its config in
**LIVE → ADVANCED: CUSTOM FIREBASE CONFIG**. Empty the box to return to the
built-in database at any time.

## 5 · Optional hardening for the built-in database

The built-in database is open for easy sharing (same posture as the radar).
If you ever want to require signed-in users on it, set its Realtime Database
rules to:

```json
{
  "rules": {
    "afterlight": {
      "boards": {
        "$board": { ".read": true, ".write": true }
      }
    },
    ".read": false,
    ".write": false
  }
}
```

and enable Anonymous authentication — ask if you'd like that wired up.
