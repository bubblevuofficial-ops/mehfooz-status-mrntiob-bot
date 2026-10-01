# Mehfooz Status Control — by Mehfooz Ahmad

> **Credit:** Mehfooz Ahmad · **Brand:** Saif Chishti — Chishti Brothers.
> Shown in the web panel's sidebar, footer, and login screen.

A **real-time WhatsApp Group Status broadcast & group-management dashboard**.
It posts a **real WhatsApp Group Status** (image/video/text) to one group or
to many groups at once, using the WhatsApp **Group Status mechanism**
(`groupStatusMessageV2`), with a live progress monitor, fast search across
large group lists, group-leave management, and operation history — all driven
by real backend events over Server-Sent Events (no fake progress bars).

```
WhatsApp Login (QR / pairing code)
     ↓
Dashboard  ──────────────► live stats + recent activity
     ↓
Groups  ── search / select one, many, or all (virtualized for 1,500+ groups)
     ↓                                  ↓
Broadcast Control Center        Leave Groups (confirm → live progress)
(media / text → 1..N groups,
 live SSE progress, stop/cancel)
     ↓
History — every run, with full per-group results
```

This is still a **single-user, local-first tool**: no multi-account
management, no scraping, no database server — group/broadcast
history is a small JSON file on disk (see [`src/history.js`](src/history.js)).
It now also runs a `.`-command **Group Command Bot** (Antilink, Warn/Kick,
Welcome, and more — see [Group Command Bot](#-group-command-bot--menu-commands-antilink-warnkick-welcome-and-more) below) alongside the dashboard.

---

## ⚠️ Honest research findings first (read this)

This tool was **not** built on assumptions. The group-status mechanism was
investigated across every currently maintained Baileys implementation before any
code was written. Findings (verified August 2026):

| Implementation | Last activity | Group Status support? | Mechanism |
|---|---|---|---|
| `@whiskeysockets/baileys` (mainline) | Jul 2026 (7.0.0-rc14) | ❌ none — proto fields exist, send path has zero support | — |
| `@yemo-dev/yebail` | Apr 2026 (v4.2.12) | ⚠️ claims support | auto-routes group sends to `status@broadcast` + **member** audience → produces an audience-limited **personal** status, not a group status |
| `@realvare/baileys` | Jun 2026 (v1.0.6) | ⚠️ partial | `groupStatusMessage` (v1) wrapper, no meta attrs |
| `Vkazee/Baileys` | May 2026 | ✅ | `groupStatusMessageV2` → group JID |
| `gifted-baileys` | Mar 2026 (v2.5.8) | ✅ | `groupStatusMessageV2` → group JID |
| **`@itsliaaa/baileys`** | **Jun 2026 (v0.3.18-final)** | ✅ **most complete** | **`groupStatusMessageV2` → group JID + `contextInfo.isGroupStatus` + `<meta is_group_status="true"/>`** |

### What the real WhatsApp Group Status mechanism is

The official WhatsApp **"Add group status"** feature (rolling out to users since
beta 2.25.22.11, Aug 2025) works like this:

1. The status media/text is wrapped in a **`groupStatusMessageV2`**
   (`Message.groupStatusMessageV2 = field 103`, a `FutureProofMessage` — confirmed
   in the official WAWeb protobufs mirrored by `go.mau.fi/whatsmeow`, updated
   Aug 2026).
2. The wrapped message is sent **to the group JID itself** (`…@g.us`) — **not** to
   `status@broadcast`.
3. `contextInfo.isGroupStatus = true` is set on the inner message, and the stanza
   carries a `<meta is_group_status="true"/>` attribute.
4. The WhatsApp server publishes it as a **group status**: only group members see
   it, it appears **under the group's name/avatar** in the Updates tab, and the
   **group's DP in the chat list gets the status ring** when the receiving client
   supports the feature.

### What is explicitly NOT the group-status mechanism

`sendMessage('status@broadcast', …, { statusJidList: [group members…] })` only
creates an **audience-limited personal status** — it appears under **your** avatar,
has **no group association**, and **never** produces the group-DP ring. This tool
therefore does **not** use that path for the main feature. It is exposed only as an
explicitly labelled **Diagnostic mode** (see [Post Group Status](#-post-group-status))
so you can prove your session/media pipeline works if the server ever rejects the
real mechanism.

> ⚠️ What **cannot** be proven from a lab: whether WhatsApp's servers currently
> accept the group-status wrapper for your account, app version, and region. The
> official feature is still rolling out and requires recent WhatsApp clients.
> That is exactly what the [Verification](#-verification-on-phone-b) section below
> tests — honestly, with PASS / PARTIAL / FAIL outcomes.

---

## Requirements

- **Node.js ≥ 20** (the engine is ESM-only)
- npm
- A WhatsApp account (the phone that will post) and **a second phone** that is a
  member of the test group (for verification)
- Optional: `ffmpeg` on PATH — only used to generate the tiny video thumbnail;
  without it videos still post (WhatsApp shows a generic thumbnail)
- Group admin rights if you want to use **Set Group DP**

## Installation

```bash
cd mehfooz-status-control
npm install
```

Optionally copy the environment file and tweak values:

```bash
cp .env.example .env
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Web UI port |
| `HOST` | `0.0.0.0` | Bind address (`0.0.0.0` = reachable from other devices on your LAN) |
| `SESSION_DIR` | `./session` | Where the WhatsApp session/auth data is stored |
| `DATA_DIR` | `./data` | Where `history.json` (broadcast/bulk/leave history) is stored |
| `LOG_LEVEL` | `info` | Baileys log level (`silent`…`trace`) |
| `MAX_UPLOAD_BYTES` | `314572800` | Max media upload size (300 MB) |
| `PANEL_USERNAME` | `admin` | Login username for the whole panel |
| `PANEL_PASSWORD` | *(auto-generated)* | Login password. Leave unset and one is generated for you on first run — see **Panel Login** below |

Uploaded media is now handled entirely in memory (never written to disk),
so there's no `UPLOAD_DIR` to configure anymore.

## Start the app

```bash
npm start
# or: npm run dev   (auto-restarts on file changes)
```

Open **http://localhost:3000** in your browser — your browser will prompt for
a username/password (see **Panel Login** below).

---

## 🔒 Panel Login

The whole panel — the dashboard page itself, every API route, the live SSE
feed — is behind a single username/password (plain HTTP Basic Auth, no
extra dependency). It's on by default; there's no way to start the app
without it.

- **First run, no `PANEL_PASSWORD` set**: the panel starts with the default
  `admin` / `admin`. No file is written just for starting the app.
- **Change it from the dashboard**: open the **Settings** tab → **Change
  Password**. This takes effect immediately (no restart needed) and is saved
  to **`panel-password.txt`** in the project root so it survives restarts.
- **Set your own via `.env`**: put `PANEL_USERNAME=` / `PANEL_PASSWORD=` in
  `.env`. This always takes priority over anything saved in
  `panel-password.txt`, and disables the in-panel change-password form (since
  `.env` is meant to be the fixed override) — remove it from `.env` if you
  want to go back to changing the password from the dashboard.
- Your browser caches the credentials after the first successful login and
  resends them automatically — including for the live SSE connection, which
  has no way to carry a custom header itself. Nothing extra needed there.
- This protects the panel from *access* by someone else on your network/the
  internet. It's a login screen, not encryption — treat `panel-password.txt`
  and your `.env` the way you'd treat any other password file (don't commit
  them, don't share them).

---

## 🔐 Login (QR or pairing code)

1. **Start** the app (`npm start`) and open the web UI.
2. The app connects to WhatsApp and shows a **QR code** in Step 1.
3. On **Phone A** (the account that will post): open WhatsApp → **Settings →
   Linked Devices → Link a Device** → scan the QR.
4. The badge turns **● Connected** and Step 2 appears automatically.
5. If the QR is slow to appear, wait a few seconds — the connection refreshes
   automatically (a new QR replaces the old one).

**Pairing code alternative:**

1. In Step 1 click **“Use pairing code instead”**.
2. Enter your phone number in international format without `+` or spaces
   (e.g. `923001234567` for Pakistan) and click **Request pairing code**.
3. WhatsApp displays the **8-character code** on screen (also printed in the
   server terminal as `PAIRING CODE`).
4. On Phone A: **Settings → Linked Devices → Link a Device → Link with phone
   number instead** → enter the code.

**Session persistence & reconnection**

- All auth data (creds, keys, session) is stored in **`SESSION_DIR`** (default
  `./session`). The app reconnects automatically on next start — **no re-scan**.
- If the connection drops, the app reconnects automatically with backoff
  (5s → 10s → 20s → 30s).
- To force a fresh login: click **Log out / clear session** in the UI, or delete
  the `session` folder.

---

## 👥 Groups — search, select one/many/all

1. After connecting, the **Groups** tab lists **every group your account
   participates in** (fetched via `groupFetchAllParticipating()` — the
   server-side group catalog, so even groups you haven't opened recently are
   listed). The list is **virtualized**, so it stays smooth even at
   1,500+ groups — only the rows actually on screen are rendered.
2. Each row shows the **group name**, **member count**, a permission badge
   (see **Group Detection** below), a **⭐ priority toggle**, and a
   **📋 Copy ID** button for the raw JID (`120363xxxxxxxx@g.us`).
3. **Search** filters by name as you type (debounced, client-side — no
   extra server round-trips per keystroke).
4. **Selection**, top-right of the tab:
   - **Select all groups** — ticks every group on the account, regardless of
     the current search/filter.
   - **Select search results** — ticks only what's currently filtered/visible.
   - **Clear selection**.
   - Or tick individual checkboxes one at a time.
   - Filter chips (**All / Selected / Unselected / 🟢 Open / 🔒 Admin-only /
     ⚠️ Can't broadcast**) narrow the list to match.
5. The selection you build here is what **Broadcast** and **Leave Groups**
   both act on — it persists as you switch tabs.

```
1,247 Groups Found · 86 Selected
[Search: "University"]  → University Students, University Help, University Lahore…
```

---

## 🔎 Group Detection — open vs. admin-only, and broadcast eligibility

Every group listed anywhere in the app is tagged using WhatsApp's own
`announce` flag (from `groupFetchAllParticipating()`) plus your own admin
status inside that group:

- **🟢 Open** — `announce` is `false`. Any member, including this account,
  can post a message/status there.
- **🔒 Admin-only** — `announce` is `true` (an "announcement" group). Only
  group admins can send. The badge shows regardless of whether *this*
  account is an admin.
- **⚠️ Can't broadcast** — appears alongside the 🔒 badge specifically when
  the group is admin-only **and this account is not an admin in it**. A
  broadcast to that group will always fail with a `not-authorized`/
  `forbidden` error, so it's flagged before you spend a send attempt on it.

This detection runs entirely off data already returned with the group list
— no extra API calls, no extra load time.

---

## ⭐ Priority Groups — pick up to 20, choose the order

The **Priority** tab lets you hand-pick up to **20 groups** and set the exact
order a broadcast processes them in:

1. Tap the ⭐ on up to 20 group rows (Groups tab, or the priority list itself).
2. Open the **Priority** tab to reorder with **▲ / ▼**, or remove one with **✕**.
3. Tick **"Use this order for my next broadcast"**. The Broadcast tab will
   then show a **⭐ Priority order active** badge and send to your priority
   groups first, in that exact order — any additional groups you've selected
   on the Groups tab (beyond the 20 priority ones) are appended after them.
4. Leave the checkbox off and Broadcast behaves exactly as before — whatever
   you've ticked on the Groups tab, in selection order.

**✨ Auto-fill** — the **Priority** tab also has an "Auto-fill remaining
slots" button. It fills only the *empty* slots left in your 20-group list —
it never touches or reorders groups you've already starred yourself — with
🟢 open groups not already in the list, largest member count first. Run it
again later and it just tops up whatever room is left; it's a one-time,
bounded action you trigger, not an automatic background process, and it
never selects more than 20 groups total or considers 🔒 admin-only groups.

The priority list is saved in your browser (not on the server), so it's
local to whichever browser/device you set it up on, and survives a page
refresh or app restart.

---

## 🎯 Knowing which groups you're about to post to

The Broadcast Control Center now shows the actual **group names** you're
targeting, not just a count — a line under "Target: N group(s) selected"
lists the first several names (with "+N more" if it's a long list), updating
live as you change your selection, priority order, or switch between the
Media/Text/Bulk tabs. Once a broadcast is running, the **Live Broadcast
Monitor** also names the exact group currently being sent to.

---

## 🖼️ Set Group DP (optional)

Set a group's profile picture via `updateProfilePicture(groupJid, image)` —
the same `w:profile:picture` IQ the official client uses. **You must be a
group admin**; otherwise WhatsApp rejects it. (This is a lower-level API call
— use it from a short script against `src/wa-client.js`'s `setGroupDp()`, or
wire it into the UI yourself if you use it often; it's exposed at
`POST /api/group/dp` on the server already.)

---

## 📤 Broadcast Control Center — post to one group or many

Flow: **Groups (select target(s)) → Broadcast tab → Compose → Start → watch
the live monitor**.

1. Select one, several, or all groups on the **Groups** tab.
2. Open the **Broadcast** tab — it shows how many groups are targeted.
3. Compose either:
   - **Media** — pick an image/video, optional caption; or
   - **Text** — type the status text, pick a background color.
4. Keep the mechanism on **Group Status — `groupStatusMessageV2` (REAL group
   status)**, or switch to **Diagnostic** (see below) to test the pipeline.
5. Pick a **delay between groups** (1–5 s; the server enforces an ~800 ms
   floor regardless, so a broadcast to a large list can never be turned into
   a rapid-fire spam loop from the UI).
6. Click **📤 Start Broadcast**. The right-hand **Live Broadcast Monitor**
   updates in real time over Server-Sent Events — current group, a
   sent/failed/unavailable/remaining counter, a progress bar, and a
   scrolling activity log. Nothing there is simulated; it mirrors exactly
   what the server is doing, group by group.
7. **⏹ Stop** cancels the run after the item currently in flight — already-sent
   groups stay sent, the rest are marked "skipped (stopped)" in the log and
   in History.

What happens on the wire for each group (verified against the fork's implementation):

```
<message to="120363xxxxxxxx@g.us" …>
  <meta is_group_status="true"/>
  <enc>{
    groupStatusMessageV2: {
      message: {
        imageMessage | videoMessage | conversation { …, contextInfo: { isGroupStatus: true }, … }
      }
    }
  }</enc>
</message>
```

The media is uploaded to WhatsApp's servers first (`waUploadToServer`), then the
wrapped message is relayed to each group JID in turn, with the configured delay
between sends.

**Diagnostic mode** — posts via `status@broadcast` + `statusJidList` (the
group's members) instead. It is **not** a group status and will **not** show
the ring; use it only to prove the session/media pipeline works if the real
mechanism is rejected.

---

## 🚪 Leave Groups

**Auto-Leave suggestions** — the top of this tab automatically lists every
group that's 🔒 admin-only where this account **isn't** an admin (i.e. groups
flagged ⚠️ **Can't broadcast** — see **Group Detection** above). Since a
broadcast can never reach those groups, they're surfaced here so you can prune
them:
- **🚪 Leave** on any single row leaves just that group immediately (with a
  one-line confirmation).
- **🚪 Select all N for leaving** ticks all of them on the Groups tab at once,
  so you can review the list before using the bulk flow below.

**Manual/bulk leave** — works on whatever you've selected on the Groups tab
(auto-detected or hand-picked, doesn't matter):
1. Select the group(s) to leave on the **Groups** tab.
2. Open the **Leave Groups** tab → **🚪 Leave selected groups**.
3. A confirmation dialog states exactly how many groups will be left and warns
   this may not be reversible. Nothing happens until you confirm.
4. The same live-monitor pattern as Broadcast shows progress
   (left/failed/unavailable/remaining, activity log), and **⏹ Stop** works the
   same way. The group list is refreshed automatically once the run finishes.

---

## 🛡️ Anti-Status Guard — stop other members from posting a status in your groups

This watches groups you turn it on for, and when someone who isn't an admin
posts a WhatsApp Group Status there, it:
1. **Deletes it** — admin delete-for-everyone, the same "delete for everyone"
   WhatsApp itself gives admins. It removes the message from the group chat
   going forward; it can't un-deliver something already seen or saved before
   the delete runs, on this or any platform.
2. **Removes the sender** from the group.
3. **Posts your configured message** to the group afterward.

**Where it can act, enforced in code, not just described here:**
- Only in groups you explicitly enable (**Anti-Status** tab → tick a group in
  "Groups being watched"). Nothing is on by default.
- Only groups where **this account is currently a verified admin** — checked
  fresh, right before every action, never from a cached group list. If you
  enabled a group and then lost admin there, it logs a warning and does
  nothing rather than fail loudly.
- Only on messages actually flagged as a **group status** post — it never
  touches, deletes, or reacts to an ordinary chat message, image, or file.
- **Never on another admin's post** — even in a watched group.
- A short cooldown per group prevents one burst of events from triggering
  repeated actions.

**⚠️ Please read before relying on this**: detecting *another member's*
incoming group-status post depends on how this fork surfaces it on receive —
something that couldn't be verified against a live WhatsApp connection while
this was built (everything else in this app was verified live; this one
piece specifically could not be). The detection checks the same wrapper this
app uses when *sending* a group status, plus a defensive fallback, but you
should confirm it actually fires before trusting it: turn it on for one small
test group, have a second number post a status there, and check the
**Activity Log** on the Anti-Status tab (and that group's entry in
**History**) to see whether it caught it. If it doesn't, that means this
particular fork isn't surfacing the event the way the detection expects —
open an issue against `@itsliaaa/baileys` or check for a newer version, since
that's a library-level gap, not something this app can paper over.

**Turning off broadcasting from non-admins entirely, without any of the
above** — a fully-reliable, purely preventive alternative is to make the
group **admin-only** (WhatsApp's own "announcement group" setting): nobody
but admins can send *anything*, status included, enforced by WhatsApp
itself rather than detected-and-reacted-to. This is a stronger, blunter tool
(it blocks normal chat too, not just statuses) — exposed at
`POST /api/group/dp`'s sibling `setGroupAnnounceOnly(jid, true)` in
`src/wa-client.js` if you want to wire a button to it; it's not yet in the
dashboard UI.

### Running it standalone (separate command file)

The same logic also ships as its own command,
**`scripts/anti-status-guard.mjs`**, so it can run in the background without
the full dashboard open:

```bash
npm run anti-status
# or directly:
node scripts/anti-status-guard.mjs
```

It shares the same session (`SESSION_DIR`) and the same config file
(`DATA_DIR/anti-status-config.json`) as the main panel — turning a group on
from the dashboard's Anti-Status tab, or editing the config file directly,
affects both. First time with no session yet, it will prompt for your phone
number in the terminal and print a pairing code (no QR support in the
terminal — link via the dashboard once if you'd rather scan a QR, then this
script reuses that session).

**⚠️ Never run this at the same time as `npm start`** against the same
`SESSION_DIR` — WhatsApp only supports one active connection per linked
session, and two processes racing to write the same session files will
disconnect each other. Either run the panel (which already includes this
feature) or this standalone command, not both — unless you deliberately
point this script at a second, separately-linked `SESSION_DIR` for a
moderation-only device.

---

## 🤖 Group Command Bot — `.menu` commands (Antilink, Warn/Kick, Welcome, and more)

Runs automatically alongside the dashboard (`src/groupBot.js`) and listens
for `.`-prefixed commands in any group this account is in. Send `.menu` in a
group to see the full, categorized list from inside WhatsApp.

**Who can control it — read this before relying on it**: this is deliberately
**not** admin-controlled. Every command that changes a setting or takes an
action (kick, promote, mute, `.antilink on`, …) works **only** for:
1. the WhatsApp number this bot is running as (**OWNER** — you), and
2. one hardcoded **developer number** (see below).

No one else — including current WhatsApp group admins — can change a
setting or run an action command, in either bot mode (`.mode public` or
`.mode private`), no matter how they ask. `.mode public` only opens up a
handful of **read-only** commands (`.menu`, `.admins`, `.groupinfo`,
`.activity`, `.warnings`) to ordinary members; everything else always
requires OWNER or the developer number. Attempted commands from anyone else
are silently ignored (not replied to) and logged — check `.activity`.

**Developer number**: hardcoded in `src/groupBot.js` as `DEV_NUMBER`, derived
from the number you gave (`03204854766`) converted to international format
by assuming Pakistan (+92): `923204854766`. **Double-check this is right** —
if it isn't, open `src/groupBot.js` and edit `HARDCODED_DEV_NUMBER` near the
top of the file (digits only: country code + number, no `+`, no leading 0,
no spaces), then run `npm run integrity:generate` again so the integrity
check doesn't flag the edit as tampering.

**If the developer number still isn't recognized**: WhatsApp's newer `@lid`
privacy system can show someone in a group under an opaque pseudonymous ID
instead of their real phone number, with no way for this fork to reverse
that back to a phone number. The durable fix is **`.setdev`**: from the
OWNER's own number, reply to any message the developer number sent with
`.setdev` — the bot captures whatever raw ID that account actually messages
with (phone or `@lid`, whichever WhatsApp uses for them) and remembers it
permanently, no matter which form it takes. `.devlist` shows everything
currently recognized; `.removedev` (reply to a message, or `.removedev all`)
undoes it. This project's own server logs already showed one such `@lid` for
your developer number, which is pre-seeded in `HARDCODED_DEV_LIDS` in
`src/groupBot.js` so it works immediately — `.setdev` is there for if that
ever changes (new device, reinstalled WhatsApp, etc.).

**Auto-moderation vs. commands**: features like Antilink or Antisticker run
automatically once turned on — that's the bot enforcing a setting OWNER/DEV
already chose, against ordinary members. Current group admins, OWNER, and
DEV are exempt from these auto-filters (same convention most moderation
bots use), so turning on `.antilink` won't touch an admin's own links.

### Full command list

| Category | Commands |
|---|---|
| Protection | `.antilink`, `.antisticker`, `.antispam`, `.antibadword`, `.antispecificword`, `.autophoto`, `.autovideo`, `.antimention`, `.antiflood`, `.antibot`, `.antiforward`, `.antimedia`, `.antinsfw`, `.antidelete`, `.anticall` (global), `.antivoice`, `.antichannel` |
| Membership | `.welcome`, `.goodbye`, `.approve`, `.autokick` |
| Warnings/moderation | `.warn`, `.warnings`, `.resetwarn`, `.kick`, `.add`, `.promote`, `.demote`, `.mute`, `.unmute`, `.tagall` |
| Group | `.admins`, `.groupinfo`, `.grouplink`, `.revokelink`, `.groupopen`, `.groupclose`, `.lock`, `.unlock`, `.activity` |
| Bot | `.mode`, `.menu` |

Send `.menu` for exact syntax on each (most toggles are `.command on|off`,
targeting commands accept `@mention`, a reply to the target's message, or a
raw phone number).

**Honest limitations** (same standard as the rest of this README):
- **Mute/Unmute** is a *soft* mute — WhatsApp has no per-member mute, so this
  just makes the bot auto-delete that member's future messages here.
- **Antibot** and **Antinsfw** have no reliable offline detection available.
  Antinsfw is a wired-up but inert hook (`classifyImageNSFW()` in
  `src/groupBot.js`) — plug in a real image-moderation API/model there if you
  want it to actually block anything; right now turning it on changes
  nothing. Antibot only catches the rare non-standard bot JID this fork
  happens to expose.
- **Approve** (auto-approve join requests) and **Anticall** (auto-reject
  calls) depend on `@itsliaaa/baileys` exposing
  `groupRequestParticipantsList` / `sock.rejectCall` — not verified against a
  live connection while this was built (no network access in the build
  environment). Both fail silently and log at debug level if unsupported,
  rather than crashing.
- Kicking/muting reconstructs a phone-number JID from digits; accounts on
  WhatsApp's newer `@lid` privacy system may not match and could fail to
  kick — the same limitation already documented for `checkAdminStatus` in
  `src/wa-client.js`.

Settings live in `DATA_DIR/group-bot-config.json`, warning counts in
`DATA_DIR/group-bot-warnings.json`, and every action is logged to
`DATA_DIR/group-bot-activity.json` (readable via `.activity` in-chat).

### Dashboard panel — toggle any command per group, without typing in WhatsApp

Click the 🤖 button on any row in the **Groups** tab to open that group's
Group Bot settings: every toggle (Antilink, Antisticker, Welcome, …) with a
live on/off switch, plus the numeric/text settings (warn limit, antiflood
rate, welcome/goodbye messages, autokick list) under **Save advanced
settings**. Backed by `GET`/`POST /api/group-bot/settings` (see
`src/server.js`) — reads and writes the exact same `group-bot-config.json`
file the chat commands use, so either side's changes show up on the other
immediately.

---


## ✅ Verification on Phone B

**Setup:** Phone A = the logged-in account (posts). Phone B = another member of
the selected group, with an **up-to-date** WhatsApp client.

| # | Step on Phone B | 
|---|---|
| 1 | Open WhatsApp (chat list). |
| 2 | Check whether the **selected group's avatar shows the status ring** (green circle around the group DP). |
| 3 | Tap the ring / group avatar, or open the **Updates (Status) tab** — the status should appear **under the group's name/avatar**. |
| 4 | Open it — it must be **your media + caption**, viewable only by group members, gone after 24 h. |
| 5 | Confirm it is **NOT** a normal message in the group chat and **NOT** a personal status under your name. |

### Report the outcome honestly

- **PASS** — the group's DP shows the expected **status ring** and the Group Status
  opens correctly under the group.
- **PARTIAL** — the Group Status was created and is visible to members, but the
  current WhatsApp client does **not** render the group-DP ring (client/version/
  rollout dependent — the ring is a client-side UI feature of the official apps).
- **FAIL** — WhatsApp treated it as a normal broadcast status/message instead of a
  Group Status. Run the **Diagnostic mode** once: if the diagnostic personal status
  reaches Phone B, your account/session/media pipeline is fine and the group-status
  wrapper was ignored/rejected by the server for your account/version/region.

> The green ring is **never simulated** in this app. The ring is rendered by the
> official WhatsApp client when the server delivers a genuine group status. If it
> doesn't appear, the report is PARTIAL or FAIL — that's the point of the test.

---

## 🧯 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| **QR not appearing** | Outbound connection to WhatsApp Web blocked / slow; app behind proxy/firewall | Wait 10–20 s; check terminal logs (`LOG_LEVEL=debug`). Ensure no VPN/firewall blocks `web.whatsapp.com` and `web.whatsapp.com:443`/`wss`. Restart the app. |
| **Pairing failure** | Wrong number format; number not on WhatsApp; already registered | Use international format digits only (e.g. `923001234567`). If `creds.registered` is true, no pairing is possible — log out first. Watch the server terminal for `PAIRING CODE`. |
| **Auth/session failure** | Corrupted session files; session used from another machine/IP | Click **Log out** in the sidebar or delete `./session` and scan the QR again. |
| **Connection keeps disconnecting** | Network instability; session conflict with too many linked devices | Check `lastDisconnectReason` in `/api/state` (logged out = `401`). Reconnect is automatic (5–30 s backoff). Delete old linked devices in WhatsApp. |
| **Group list empty** | Account really has no groups; history sync off | Verify on Phone A that you're in a group. `groupFetchAllParticipating()` returns server-side group metadata — no local history needed. If you *just* joined a group, wait a few seconds and press the **↻ refresh** button top-right. |
| **Group JID problems** | Wrong group selected; JID not ending in `@g.us` | The app only accepts `…@g.us` JIDs — the group list and the 📋 Copy ID button always give you the exact JID in use. |
| **Media upload failure** | File too large; unsupported codec/format; network | WhatsApp limits: images ≈ 16 MB, videos ≈ 64 MB (web). Use MP4/H.264 for video, JPEG/PNG for images. Check `MAX_UPLOAD_BYTES`. Retry. |
| **Browser keeps asking for username/password, or "Authentication required"** | Wrong credentials, or you don't know the auto-generated one | Check `panel-password.txt` in the project root (or your `.env` if you set `PANEL_PASSWORD`). Username defaults to `admin`. If you want to reset to a fresh auto-generated password, stop the server, delete `panel-password.txt`, and start it again — the new one will be printed to the console. |
| **Anti-Status Guard isn't catching a test status** | Most likely: this fork isn't surfacing the incoming group-status event the way the detection expects — see the honesty caveat in the Anti-Status Guard section above. Also check: is the group actually enabled on the **Anti-Status** tab? Is this account still an admin there (re-check the Groups tab)? Was the poster themselves an admin (never moderated)? Did an action already fire in the last few seconds (cooldown)? | Check the server logs for `anti-status:` entries — they explain exactly why it did or didn't act. If it's genuinely not detecting the message type at all, that's a library-level gap in `@itsliaaa/baileys`, not something fixable from this app's code. |
| **A group you admin shows you as not-admin / Anti-Status says it's not eligible, everywhere** | WhatsApp's newer phone-number-privacy system ("LID") can list group participants — including yourself — under an opaque `@lid` identifier instead of your normal phone JID. Admin-matching now checks both forms, but if it's still wrong: `GET /api/anti-status/config` won't tell you why, but `GET /api/debug/group-admin?jid=<the group's JID>` (basic-auth protected, same as everything else) returns the raw, unmatched data — your account's own `id`/`lid` plus every participant's raw `id`/`jid`/`lid`/`admin` fields, exactly as the library reports them. | Hit that endpoint for the affected group and compare: your own `id`/`lid` against the participant list. If none of your identifiers appear anywhere in the participant list at all, that's a deeper library-level issue (this account's own membership not being resolved), not just a format mismatch — worth reporting upstream to the fork with that raw data attached. |
| **Group Status not appearing** | Feature still rolling out for your account/version/region; receiving client outdated | Update WhatsApp on **both** phones. Retry later — server-side rollout is gradual. Run **Diagnostic mode** to prove the pipeline itself works. |
| **Group DP not showing the ring** | Client-side rendering depends on the official app version & rollout; also true when the status was delivered correctly | This is the **PARTIAL** outcome — the status was created; the ring UI isn't supported on that client yet. Update the receiving app. |
| **WhatsApp rejecting/ignoring Group Status** | Server doesn't (yet) accept the wrapper for your account; wrapper mis-negotiated | Compare with **Diagnostic mode**: if the diagnostic reaches Phone B but the group status doesn't, the server ignored the wrapper — retry later or on a different account. |
| **Baileys protocol/version incompatibility** | Using another Baileys version than the one pinned | `package.json` pins `@itsliaaa/baileys@0.3.18-final` (June 2026). Do not mix engines; `npm install` exactly as documented. |
| **Live Broadcast Monitor stuck on "Starting…"** | SSE connection didn't establish (proxy/CDN buffering `text/event-stream`) | If you're running behind Nginx/Cloudflare, disable buffering for `/api/events` (Nginx: `proxy_buffering off;`) and make sure the proxy allows long-lived connections. Locally this should never happen. |
| **"Select all groups" feels slow to render** | Rendering 1,000+ DOM rows at once | It shouldn't — the group list is virtualized (only visible rows render). If it's still slow, check the browser console for errors and confirm you're on a reasonably recent Chrome/Edge/Firefox. |
| **Broadcast/leave results missing from History** | `DATA_DIR`/`data/history.json` not writable | Check the process has write access to `DATA_DIR` (default `./data`); check server logs for a write error. |
| **Red "Core integrity check failed" banner (blocking)** | A protected file (`src/server.js`, `src/wa-client.js`, `src/history.js`, `src/integrity.js`) or `package.json`'s dependencies genuinely don't match `integrity.json` | If the edit was intentional: `npm run integrity:generate`, then restart the server. If you didn't make the edit, treat it as a real tamper signal — check `GET /api/integrity` for which file changed, and diff it against a known-good copy before trusting it again. |
| **Yellow "couldn't fully verify" banner, or `unreadable/corrupt: EMFILE…`** | Nothing was confirmed altered — this is the non-blocking path. `EMFILE`/`ENFILE` specifically means the process ran out of file descriptors. Two things now reduce this a lot: the periodic integrity re-check pauses itself entirely while a broadcast/bulk/leave is running, and uploaded media is handled in memory rather than written to disk, so a broadcast no longer opens a temp file at all. If you still see it, it's likely coming from outside the app (antivirus scanning, or Baileys' own session-credential writes on an account in a lot of groups). | Nothing is disabled — broadcasting etc. keep working, and this re-checks itself automatically once the operation finishes. If it persists afterward: restart the server to release any lingering handles; on Windows, temporarily excluding the project folder from real-time antivirus scanning often resolves it. If `integrity.json` itself is the problem, `npm run integrity:generate` rewrites it cleanly. |

---

## Project layout

```
mehfooz-status-control/
├── package.json
├── integrity.json       # sha256 baseline for protected files — see Code Integrity below
├── panel-password.txt   # created at runtime if PANEL_PASSWORD isn't set in .env
├── .env.example
├── README.md
├── scripts/
│   ├── generate-integrity.mjs   # regenerates integrity.json after a legitimate edit
│   └── anti-status-guard.mjs    # standalone Anti-Status command — see below
├── src/
│   ├── wa-client.js     # WhatsApp engine wrapper (login, groups, DP, group status, leave, moderation actions)
│   ├── history.js       # tiny JSON-file history store (broadcast/bulk/leave/anti-status runs)
│   ├── integrity.js     # tamper/integrity check (hashing + verification)
│   ├── auth.js          # panel login (HTTP Basic Auth)
│   ├── moderation.js    # Anti-Status Guard core logic (shared by panel + standalone command)
│   └── server.js        # Express API + SSE event stream + static UI
├── public/
│   └── index.html       # single-page dashboard UI (no framework, no build step)
└── data/                # created at runtime — history.json, anti-status-config.json live here
```

## 🛡️ Code Integrity — tamper detection on core files

`integrity.json` (shipped in the repo) stores a sha256 hash of each protected
file — `src/server.js`, `src/wa-client.js`, `src/history.js`, `src/integrity.js`
— plus a separate hash of just the `dependencies` block in `package.json`
(so a version/description bump in `package.json` doesn't trip it, but a
swapped-in dependency does).

The check recomputes these hashes at every startup and on every poll of
`GET /api/integrity` (every ~15s from the dashboard), and reacts differently
depending on **what** it finds:

- **🔴 Confirmed change (blocking)** — a protected file's hash, or the
  dependency hash, genuinely doesn't match the baseline, or a protected file
  is confirmed gone. A red banner appears and the sensitive routes
  (**broadcast, bulk post, leave groups, set group DP**) return `503` until
  it's resolved. Read-only things — the dashboard, group list, history —
  keep working either way.
- **🟡 Couldn't verify (non-blocking)** — `integrity.json` is missing/corrupt,
  or a file briefly couldn't be read (e.g. the process hit an OS file-handle
  limit — `EMFILE`/`ENFILE` — under load, most often from antivirus scanning
  every file access on Windows, or Baileys' own session-file writes for
  accounts in a lot of groups). This shows a milder yellow banner but
  **doesn't disable anything** — "unable to check" isn't evidence of
  tampering, and this self-heals automatically on the next poll (~15s) once
  the transient condition clears. If it doesn't self-heal, see the
  Troubleshooting table below.
- **The periodic re-check pauses itself during a broadcast/bulk/leave run** —
  so it never competes with the run's own disk/network activity for file
  handles, and won't flip the banner just because the system was briefly busy
  doing the thing you asked it to do. It resumes checking as soon as the run
  finishes.

**After a legitimate code change** to any protected file, regenerate the
baseline:
```bash
npm run integrity:generate
```
Then restart the server. Skipping this after an intentional edit is the
most common reason you'd see the red (blocking) banner.

This is a tamper/supply-chain check, not an access-control system — it
verifies the code hasn't silently changed since you last approved it, it
doesn't restrict *who* can use the panel (see **Scope & disclaimers** below
for that gap).

---

## Scope & disclaimers

- Single-user, local tool — no database server (history is a flat JSON file).
  The web panel is protected by a login (see **Panel Login** above), but it's
  still a single shared account for whoever knows the password, not
  per-person accounts/roles.
- Uses the unofficial WhatsApp Web protocol (Baileys). It can break if WhatsApp
  changes the protocol; the pinned fork is the most recently maintained one with
  group-status support at the time of writing.
- **Use only with accounts and groups you own, administer, or are otherwise
  authorized to post to and manage.** The broadcast and leave-groups features
  act on whatever groups the logged-in account already belongs to — they do
  not join, discover, or message groups the account isn't already in.
- This tool deliberately does **not** try to evade WhatsApp's rate limits or
  spam detection: the server enforces a minimum delay between sends in any
  multi-group run, on top of whatever delay you pick in the UI.
- The group-status feature is end-to-end encrypted; media you post is held in
  memory only for the duration of the request and sent straight to WhatsApp's
  official upload endpoint — nothing is written to a temp folder on disk.
- The panel login (HTTP Basic Auth) protects *access* to the panel, not the
  traffic itself beyond TLS you add yourself — if you expose this past your
  LAN, put it behind HTTPS (a reverse proxy with a real certificate) rather
  than relying on Basic Auth over plain HTTP.

## ✨ What's new in v2 — the full dashboard rewrite

This build is a ground-up redesign, not a reskin. Kept: the same underlying
WhatsApp engine (`@itsliaaa/baileys`), the same `groupStatusMessageV2`
mechanism, the same login flow. Everything around it changed:

- **Rebranded** — "Mehfooz Status Control," credited to **Mehfooz Ahmad** and
  **Saif Chishti (Chishti Brothers)** throughout the sidebar, footer, and
  login screen.
- **New dashboard** — connection status, total/selected group counts, last
  operation summary, and a live activity feed, all in one view.
- **Fast search + virtualized group list** — comfortably handles 1,500+
  groups; only visible rows are rendered, search is debounced client-side.
- **Selection system** — select all groups, select just the current
  search/filter results, clear selection, or tick individually; filter chips
  for All / Selected / Unselected.
- **Broadcast Control Center** — post one status (media or text) to however
  many groups you've selected, with a **live progress monitor** driven by
  real Server-Sent Events from the backend: current group, sent/failed/
  unavailable/remaining counts, a progress bar, and a scrolling activity log.
  Nothing is simulated — if you watch the network tab you'll see the same
  `op-item` events the UI renders.
- **Stop/cancel** — a running broadcast or leave operation can be stopped
  between items; already-processed groups keep their result, the rest are
  marked "skipped."
- **Leave Groups management** — select groups, confirm via a dialog that
  states exactly how many you're about to leave, then watch the same live
  progress pattern.
- **History** — every broadcast/bulk/leave run is recorded to a small JSON
  file (`data/history.json`, capped at 200 entries) with full per-group
  results, browsable and clickable from the History tab.
- **Copy Group ID** — a 📋 button on every group row copies the JID straight
  to the clipboard.
- **Instagram button** — links to `@snugglewhine` from the sidebar.
- **Dependency cleanup** — dropped the unused `jimp` dependency that shipped
  in the original `package.json`.
- **A rate-limit floor, not a bypass** — the server enforces a minimum ~800 ms
  delay between sends in a broadcast/leave run regardless of what the UI
  requests. This tool does not attempt to evade WhatsApp's spam detection or
  rate limits, and won't be extended to.
- **Group Detection** — every group is tagged 🟢 Open or 🔒 Admin-only from
  WhatsApp's `announce` flag, plus a ⚠️ **Can't broadcast** flag when it's
  admin-only and this account isn't an admin there.
- **Priority Groups** — pick up to 20 groups, set the exact order a broadcast
  sends to them in, from a dedicated Priority tab (⭐ toggle on any group row).
- **Auto-Leave suggestions** — the Leave Groups tab automatically surfaces
  admin-only groups this account can't broadcast to, with one-click leave per
  group or bulk-select for all of them.
- **Code Integrity check** — sha256 baseline (`integrity.json`) over the core
  server files; if any of them are altered outside of a deliberate
  `npm run integrity:generate`, broadcasting/bulk/leave/set-DP are disabled
  and a banner shows on the dashboard until it's resolved.
- **Panel login** — the whole panel is behind HTTP Basic Auth by default, with
  an auto-generated password on first run (saved to `panel-password.txt`) or
  your own via `PANEL_USERNAME`/`PANEL_PASSWORD` in `.env`.
- **In-memory uploads, no disk writes** — media you post now goes straight
  from your upload into RAM and out to WhatsApp, with no temp file written to
  disk and nothing to clean up afterward. Faster, and it removes a real
  source of file-handle pressure during large broadcasts (see the
  Troubleshooting entry on `EMFILE` below).
- **One automatic retry per item** — a broadcast/bulk/leave item that fails
  with a transient-looking error is retried once automatically before being
  marked failed (a confirmed "not authorized"/group-gone error is never
  retried — that's not something a retry fixes).
- **Target names, not just a count** — the Broadcast Control Center shows
  which groups you're actually about to post to, not only how many.
- **Priority Auto-fill** — a button that tops up the remaining slots in your
  20-group priority list with the largest open groups not already in it,
  without touching what you've already picked yourself.
- **Anti-Status Guard** — watches groups you enable for non-admins posting a
  status, and deletes it, removes the sender, and posts your message — only
  where this account is a verified admin. Ships both inside the dashboard and
  as its own standalone command (`npm run anti-status`). See its own section
  above for the honesty caveat on live detection.

## 🛠️ A few suggestions to make it even better (not yet implemented)

- **Retry queue** for items that failed due to a transient error, instead of
  requiring a full re-broadcast.
- **Group allow-list / favorites** so "Select all" doesn't have to mean
  *literally* all, for accounts that mix personal and broadcast-relevant groups.
- **Export history** to CSV for record-keeping outside the app.
- **Scheduled posts** (e.g. via `node-cron`) for recurring status updates.

---

## 🚀 Running it

### Run locally (your own computer)

```bash
cd mehfooz-status-control
npm install
npm start
```

Then open **http://localhost:3000**, scan the QR (or use a pairing code) as
described above. This is the recommended way to use the tool day-to-day — your
WhatsApp session never leaves your machine.

To let *other devices on your home/office Wi-Fi* reach it (e.g. to open it from
your phone's browser), it already binds to `0.0.0.0` by default — just visit
`http://<your-computer's-LAN-IP>:3000` from the other device, e.g.
`http://192.168.1.20:3000` (find your LAN IP with `ipconfig` on Windows or
`ifconfig`/`ip a` on macOS/Linux).

### Run it "on the internet" (accessible from anywhere)

Because this app holds a live, authenticated WhatsApp session and has **no
login/auth of its own**, only expose it publicly if you understand that
**anyone with the link can post statuses as you**. Two common approaches, from
quickest to most permanent:

**Option A — Quick tunnel (good for testing, temporary links)**
Use a tunneling tool to expose your local `localhost:3000` on a temporary public
HTTPS URL without any server/deployment work:
```bash
# using Cloudflare Tunnel
cloudflared tunnel --url http://localhost:3000

# or using ngrok
ngrok http 3000
```
Both print a public `https://…` URL you can open from anywhere. Close the
tunnel when you're done — the link stops working immediately.

**Option B — A small VPS (good for "always-on")**
1. Rent a small VPS (DigitalOcean, Hetznner, AWS Lightsail, etc. — 1 GB RAM is
   plenty) running Ubuntu.
2. Install Node.js ≥ 20 on it, then `git clone`/upload this project and run
   `npm install`.
3. Run it under a process manager so it survives reboots/crashes:
   ```bash
   npm install -g pm2
   pm2 start src/server.js --name wa-group-status
   pm2 save && pm2 startup
   ```
4. Put it behind a reverse proxy with HTTPS (Nginx + Let's Encrypt via
   `certbot`, or Caddy which does HTTPS automatically), pointing at
   `localhost:3000`.
5. **Add authentication in front of it** (see the suggestion above) or at
   minimum firewall the port to your own IP — do not leave `/api/status/broadcast`
   open to the whole internet unauthenticated.

Either way, the `session/` folder is what holds your WhatsApp login — treat it
like a password and never commit it or share it.

## License

MIT

---

## Credits & manual Anti-Status control

- **Credits tab** (dashboard): add/edit/remove credit entries, pick the displayed one, hide it, set a tagline. Stored in `data/branding.json`; used by the `.menu`, Anti-Status messages (`{poweredBy}` / `{credit}` tokens) and the panel.
- **Manual Anti-Status**: `.delstatus` in a group deletes the newest detected status broadcast (reply to the status card to pick one; `kick` / `nokick` override the dashboard default). The Anti-Status tab has an *Enabled* switch, a *remove sender by default* option and a **Detected statuses** list with Delete / Delete + remove buttons. Works even when automatic mode is off; automatic behavior is unchanged.
- After editing protected files run `npm run integrity:generate` (already done for this release).

---

## Course files, bad words & `.purgestatus`

**Course files** (source: `github.com/bubblevuofficial-ops/data`, branch `main`, one lowercase folder per course code):

| Command (owner/dev, in the group) | What it does |
|---|---|
| `.fileon` / `.fileoff` | Turn course files on/off **for that group only** (any bot mode) |
| `.settrigger <1-50>` | Files sent per request in that group (default 3) |
| `.filestatus` | Show on/off + batch size |

Once on, any member can type a course code (`cs101` or `.cs101`) and **all files stream out immediately, in order** (Handouts → Midterms → Finals → Quizzes) — no menu, no numbers. `cs101 mid` / `cs101 final` / `cs101 handouts` / `cs101 quiz` send only that type. If a course has more files than the group's batch size (`.settrigger`, default 10), reply `more` for the next burst (each member has their own place). A code with no folder gets no reply at all. Members only ever see the store name **Chishti Stock**. Speed: all downloads start in parallel the moment a course is recognised, and downloaded files are cached in memory for 30 minutes, so the next member gets them instantly. Optional `GITHUB_TOKEN` env var lifts the store's 60 requests/hour limit. Folder listings are cached for 5 minutes to save quota.

**Bad words** (per group): `.addbadword a, b` · `.delbadword a` · `.badwordlist` · `.badword on|off` · `.badwordmsg <text with {user} {group}>`. All of it, plus course-file settings, is also editable per group from the dashboard (Groups → 🤖).

**`.purgestatus`** (replaces `.delstatus`): removes a detected status with a single message that is edited through a ~7-second Loading → Detecting → Deleting → Done sequence. Same `kick` / `nokick` options and reply-to-target behaviour as before.

After installing: run `npm install` (axios was added), and `npm run integrity:generate` if you edit any protected file yourself.


---

## v2.1 — what changed

**Course files ("Chishti Stock")**
- `.fileon` now plays a one-time ~12 s "connecting to Chishti Stock…" show (one message edited in place), ending with *CONNECTED · File System ACTIVE*. It runs in the background, so other groups are never frozen while it plays.
- Files arrive with no menu — see above. One status message is edited live (*Collecting files from Chishti Stock… → delivering → delivery complete*).
- **Delivery card** (separate per-group switch): `.filecard on|off` posts the group's DP after delivery with a caption that mentions the member, names the group and thanks them; `.filecardlink on|off` adds the group's invite link (bot must be admin to read it). Also available per group in the Group Bot modal and in Bulk Settings.

**Status removal (`.purgestatus`)** — the animation now runs ≥ 12 s (10 stages: verifying access → detecting → contacting servers → deleting → synchronizing → finalizing) while the real delete runs alongside, then the message is replaced with a professional result card ending with the credit line. It is no longer awaited inside the message loop.

**Dashboard**
- **Anti-Status tab** → *⚡ Enable for ALL my admin groups* / *Disable all* (one click, saved). Per-group checkboxes still work.
- **Bulk Settings** (new tab) → tick groups (search, admin-only filter, select all) → tick settings (or *Select ALL* / *Core protection preset*) → *Turn ON / OFF*. Covers every protection toggle, welcome/goodbye, course files, delivery card, and Anti-Status. API: `POST /api/group-bot/bulk`, `POST /api/anti-status/bulk`.

**Bug fixed** — switching Anti-Status **off** for a single group never actually persisted (the removed group was merged straight back into the saved config). `saveConfig` now replaces the group map when given one.

`integrity.json` was regenerated for the edited protected files (`npm run integrity:generate` after any further edit to them).

## v2.1.1 — Course files menu, ghost-vanish, .del
- `cs101` now shows ONE message with a button per category (Handouts / Mid / Final / Quiz, with counts). Tapping a button acts as if the member typed it; the menu ghost-fades and is deleted, and files start instantly. Typing `cs101 mid` still works.
- Only one "searching" message is sent (never edited), then files, then one completion message with a **More** button when files remain (`.settrigger` sets the batch size).
- Duplicate guard: the same WhatsApp message id / same request within 10s is answered once (fixes double replies after reconnects or simultaneous commands).
- `.del` — reply to any message to delete it for everyone (bot needs admin for others' messages).


### Course files v2.2 — owner commands
- `.stats [cs101]` folders + total files + handouts / mids / finals / quizzes · `.files` (or `.total`) total files · `.folders` number + names of folders · `.handouts` `.mids` `.finals` `.quizzes` `[cs101]` one type.
- `.upload cs101` creates the folder on GitHub; every file you send next is added to it. `.done` (or `.upload stop`) ends it. Needs a GitHub token with write access (`GITHUB_TOKEN` / `GITHUB_WRITE_TOKEN`).
- Delivery messages are compact, show the group's name (auto-detected) and end with the "Powered by" line. The big delivery card was removed (`.filecard` no longer has any effect).


## 🖼️ Picture reader — `.read`

Reply to a picture (e.g. a course-selection screenshot) with **`.read`** in a group where `.fileon` is active.
The bot scans the picture for every subject code, shows which are in stock / not in stock, then sends the files
step by step — one batch at a time (the group's batch size). Type **`more`** for the next batch; the bot tells you
how many files are left per subject.

* Default reader: free offline OCR (`tesseract.js`, installed by `npm install`).
* Better accuracy: set `ANTHROPIC_API_KEY` in `.env` and Claude vision is used instead (falls back to OCR on error).
* `.read` can also be written as the caption of the picture itself.
