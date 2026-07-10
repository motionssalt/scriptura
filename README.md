# Scriptura 🕊️📖

A Telegram bot that runs adaptive daily Bible reading plans across all 66 books / 1,189 chapters of the KJV, with streak tracking, four reading modes, and self-adjusting catch-up math so a missed day doesn't blow up your end date.

By **MOTIONSALT**.

## Features

- **Four reading modes:** Direct (Genesis → Revelation), Alternating (OT ↔ NT), Random, Random Alternating.
- **Any plan length from 1 to 3,650 days** — six presets (30/60/90/120/180/365) plus a custom-days input.
- **Adaptive catch-up:** if you fall behind, the next day's quota grows (capped at 2× the base rate) so the plan still finishes on time — without inflating "days remaining" once you've caught up.
- **Streak tracking** that only counts consecutive completed days ending at today or yesterday.
- **Separate OT/NT progress bars** (929 OT chapters, 260 NT chapters) — correctly counted even in random / alternating modes.
- **7-day paginated schedule** view centered on today, so you can see what's coming.
- **Milestones** at 10 / 25 / 50 / 75 / 100 %.
- **Embedded KJV quote library** — 500+ curated scriptures, one is rotated in on every screen, zero external API calls or rate limits.
- **Mandatory `@motionsalt` channel-follow gate** — bot won't respond until the user has joined the channel. Gated at the entrypoint, KV-cached with a 1-hour TTL so repeat users aren't rechecked on every message.
- **Runs entirely on Cloudflare's edge** — one Worker, one D1 database, one KV namespace (for the membership cache).

## Commands

| Command | What it does |
|---|---|
| `/start` | Create your reading plan (defaults: 365 days, Direct mode) or show the welcome screen if you already have one |
| `/menu` | Main menu with everything |
| `/today` | Today's chapters, streak, and mark-complete button |
| `/progress` | Overall %, OT %, NT %, streak, days remaining, milestones |
| `/schedule` | 7-day paginated schedule view centered on today |
| `/settings` | Change reading mode / plan length, or reset progress (locked once a plan is in progress) |

Callbacks are handled through the inline keyboards on each screen — you rarely need to type a command after `/start`.

## ⚠️ Repo reconstructed after the fact

This repository was reconstructed from a single saved `worker.js`. Scriptura was previously deployed straight to Cloudflare without ever being committed to Git, so **the `schema.sql` in this repo describes what the code expects, not necessarily what's in your live D1 database.**

Before running `schema.sql` against a database that already has Scriptura data in it:

1. Open **Workers & Pages → D1 → `scriptura` → Console** in the Cloudflare dashboard.
2. Run `SELECT sql FROM sqlite_master WHERE name = 'scriptura_progress';` — this dumps the live `CREATE TABLE` statement.
3. Diff that against `schema.sql` in this repo.
4. If they differ, edit `schema.sql` (or migrate the live table) so they match before touching production data.

The schema in this repo uses `CREATE TABLE IF NOT EXISTS` so it's safe to re-run on a database that already has the table, but it will silently leave column mismatches in place — the diff step above is what actually catches drift.

## File layout

```
scriptura/
├── worker.js         # Worker entry: channel-follow gate + full router + D1 access
├── wrangler.toml     # Worker config (Git-integrated deploy reads this)
├── schema.sql        # D1 schema for scriptura_progress
├── package.json      # No runtime deps — worker.js uses only Workers built-ins
├── .gitignore
└── README.md         # This file
```

Everything the bot does lives in one file (`worker.js`) — quote library, book/chapter metadata, plan math, streak logic, D1 access, Telegram API calls, the channel-follow gate, and the update router.

## Why D1 (not KV like LazyFonts)?

LazyFonts stores tiny ephemeral per-chat session state and doesn't care about relations, so KV is perfect for it. Scriptura's data is the opposite: durable per-user records with structured columns (start_date, plan_days, reading_mode, JSON arrays for completed_days / book_order, streak, last_read_date, waiting_for input state) that get partial updates on every mark-complete and settings change. That's a row-in-a-table workload, so D1 fits and KV would be awkward.

The KV namespace this Worker uses is *only* for the 1-hour membership-check cache — a separate concern from the reading-plan data.

## Deploying

See **[Setup](#setup)** below for the full step-by-step guide (Termux-friendly, no Wrangler CLI required — everything goes through the Cloudflare dashboard).

The one-line version:

1. Create the bot with [@BotFather](https://t.me/BotFather), copy the token.
2. Push this repo to GitHub.
3. Create a D1 database in the Cloudflare dashboard, run `schema.sql` against it in the D1 console.
4. Create a KV namespace for the membership cache.
5. Cloudflare dashboard → Workers & Pages → Create → Connect to Git → pick this repo.
6. In the Worker's settings, bind D1 (variable name `DB`), bind KV (variable name `SCRIPTURA_KV`), add secret `TELEGRAM_TOKEN`, and enable the `workers.dev` domain.
7. Register the webhook with a single `curl` call.

---

# Setup

This guide walks you through deploying Scriptura end-to-end, assuming:

- You're on a **rooted Android phone using Termux** (or any other environment where you *can't* run the Wrangler CLI locally).
- You have a **Cloudflare account** (free tier is fine).
- You have a **GitHub account** — there is already an empty repo at `github.com/YOUR_USERNAME/scriptura` waiting for this code.
- You have **`curl`** available (Termux has it by default; `pkg install curl` if not).

No Wrangler CLI is required at any point. Everything happens through the Cloudflare dashboard, GitHub, and one `curl` call at the end.

---

## Step 1 — Create the Telegram bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Give it a display name (e.g. `Scriptura`) and a username ending in `bot` (e.g. `ScripturaBot`, or `MotionsaltScripturaBot` if that's taken).
4. BotFather replies with an **HTTP API token** that looks like `1234567890:AAH...`. **Copy it and keep it secret** — anyone with this token controls your bot.

Optional polish (all via BotFather):

- `/setdescription` — set the "What can this bot do?" text.
- `/setuserpic` — give it an avatar.
- `/setcommands` — paste this so Telegram shows a nice command menu:

  ```
  start - Create your plan or show the welcome screen
  menu - Main menu
  today - Today's reading and mark-complete
  progress - Overall %, OT/NT %, streak, milestones
  schedule - 7-day paginated schedule
  settings - Change plan length / reading mode / reset
  ```

### 1a. Make the bot an admin of `@motionsalt`

The channel-follow gate calls `getChatMember` against `@motionsalt`, which **requires the bot to be an admin of that channel**. If the bot is ever removed as admin, the gate will start failing closed and lock every user out.

1. Open the `@motionsalt` Telegram channel.
2. **Channel Info → Administrators → Add Admin** → search for your bot's username → confirm.
3. Only the "invite users via link" permission is strictly needed for the `getChatMember` call to succeed, but the safest default is to leave admin permissions at defaults (all checked except "Anonymous").

---

## Step 2 — Push this project to GitHub

The empty `scriptura` repo already exists. From Termux (or wherever you have this project):

```bash
cd scriptura
git init
git add .
git commit -m "Initial Scriptura commit — reconstructed repo around existing worker.js"

git remote add origin https://github.com/YOUR_USERNAME/scriptura.git
git branch -M main
git push -u origin main
```

If you'd rather use GitLab or Bitbucket, that's fine — Cloudflare supports all of them.

---

## Step 3 — Create the D1 database

1. Cloudflare dashboard → **Workers & Pages** → **D1** (left sidebar) → **Create database**.
2. Name it `scriptura`.
3. Region: pick the closest to you (this is where the primary lives).
4. Click **Create**.
5. On the database's page, **copy the Database ID** shown at the top — you'll paste it into `wrangler.toml` (or into the dashboard binding, either works).

### 3a. Run the schema

1. Still on the `scriptura` database page, click the **Console** tab (the D1 dashboard has a built-in SQL console — no Wrangler CLI needed).
2. Open `schema.sql` from this repo, copy its contents.
3. Paste into the console and click **Execute**.
4. Verify with `SELECT name FROM sqlite_master WHERE type='table';` → you should see `scriptura_progress`.

> **If this database already has live Scriptura data**, read the "Repo reconstructed after the fact" section above *before* running `schema.sql`.

---

## Step 4 — Create the KV namespace (membership cache)

Scriptura caches `@motionsalt` channel-membership checks in Workers KV for 1 hour, so verified users don't get re-checked on every message.

1. Cloudflare dashboard → **Workers & Pages** → **KV** (left sidebar).
2. Click **Create a namespace**.
3. Name it `scriptura-membership` (any name works, but this one matches the docs).
4. Click **Add**.

You don't need to copy the ID right now — you'll bind it to the Worker in Step 6 through the dashboard UI.

---

## Step 5 — Create the Worker from your Git repo

1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages / Workers** tab → **Create Worker** via **"Connect to Git"** (the exact button label shifts occasionally; look for "Import a repository" or "Connect to Git").
2. Authorize Cloudflare to access your GitHub account if it hasn't been done already.
3. Pick the `scriptura` repo.
4. On the build config screen:
   - **Project name:** `scriptura` (this becomes part of your Worker's URL: `scriptura.<your-subdomain>.workers.dev`).
   - **Production branch:** `main`.
   - **Build command:** *(leave blank — no build step needed, no npm dependencies at runtime)*.
   - **Deploy command:** *leave the default* (`npx wrangler deploy` — Cloudflare runs this **in its own build environment**, not on your phone. This is why you don't need Wrangler CLI locally).
   - **Root directory:** *leave blank* (project is at repo root).
5. Click **Save and Deploy**.

The first deploy will probably fail because the D1 and KV bindings and the `TELEGRAM_TOKEN` secret haven't been wired up yet — that's fine, we'll fix it in the next step and redeploy.

---

## Step 6 — Bind D1, KV, and set the bot-token secret

1. Once the Worker exists, open it: **Workers & Pages** → click `scriptura`.
2. Go to **Settings** → **Variables and Bindings** (formerly "Settings → Variables").

### 6a. D1 binding

- Scroll to **D1 Database Bindings** → **Add binding**.
- **Variable name:** `DB` (case-sensitive — the code looks for exactly `env.DB`).
- **D1 database:** pick `scriptura` from the dropdown.
- Save.

### 6b. KV binding (membership cache)

- Scroll to **KV Namespace Bindings** → **Add binding**.
- **Variable name:** `SCRIPTURA_KV` (case-sensitive — the code looks for exactly `env.SCRIPTURA_KV`).
- **KV namespace:** pick `scriptura-membership` from the dropdown.
- Save.

### 6c. Bot token secret

- Scroll to **Secrets** (or **Environment Variables** and toggle "Encrypt") → **Add**.
- **Variable name:** `TELEGRAM_TOKEN` — **note this is `TELEGRAM_TOKEN`, not `TELEGRAM_BOT_TOKEN` like LazyFonts uses**. The Scriptura code reads `env.TELEGRAM_TOKEN` exactly; wrong name → silent failures.
- **Value:** paste the token from BotFather (Step 1).
- Save.

### 6d. ⚠️ Enable the `workers.dev` subdomain

**Easy to miss — caused a real deployment confusion during LazyFonts setup.**

- Still on the Worker's page → **Settings** → **Domains & Routes**.
- If **`workers.dev`** is toggled off, enable it. Without this, your Worker has no public URL that Telegram can hit — the deploy "succeeds" but the bot silently doesn't work.

Trigger a redeploy (**Deployments** tab → **Retry deployment** on the latest one, or push any commit to `main`). After it finishes, your Worker's URL is visible on the Worker's overview page — it'll look like:

```
https://scriptura.<your-subdomain>.workers.dev
```

Copy that URL. Confirm the Worker is alive with:

```bash
curl https://scriptura.<your-subdomain>.workers.dev
# → Scriptura webhook OK
```

---

## Step 7 — Register the webhook with Telegram

This is the only step that requires a terminal, and it's a single `curl` call. From Termux:

```bash
BOT_TOKEN="paste-your-bot-token-here"
WORKER_URL="https://scriptura.<your-subdomain>.workers.dev"

curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WORKER_URL}\",
    \"allowed_updates\": [\"message\", \"edited_message\", \"callback_query\"]
  }"
```

Expected response:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

Sanity-check it stuck:

```bash
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

You want to see your Worker's URL in the `url` field and `"pending_update_count": 0`.

---

## Step 8 — Test it

1. Open your bot in Telegram (search its username, or use the direct link BotFather gave you).
2. **Before joining `@motionsalt`:** send `/start` — you should get the 🔒 "Join @motionsalt first" gate message with the two inline buttons.
3. Tap **📢 Join @motionsalt**, join the channel, come back, tap **✅ I've Joined — Check Again** → you should land on the normal welcome screen.
4. Tap **📖 Today's Reading** → chapters for day 1 appear.
5. Tap **✅ Mark Today as Complete** → 🎉 burst + streak = 1.
6. Try **📊 Progress**, **📅 Schedule**, **⚙️ Settings** — all should render.

If nothing happens:

- Check **Workers & Pages → scriptura → Logs** (the "Real-time logs" tab). Any errors will show up there in plain text.
- Confirm the D1 binding variable name is exactly `DB`.
- Confirm the KV binding variable name is exactly `SCRIPTURA_KV`.
- Confirm the secret name is exactly `TELEGRAM_TOKEN` (not `TELEGRAM_BOT_TOKEN`).
- Confirm the bot is still an admin of `@motionsalt` — if it's been demoted, the gate will lock everyone out.
- Re-run `getWebhookInfo` — if `last_error_message` is populated, the message text tells you what Telegram sees.

---

## Updating the bot later

Because the Worker is Git-integrated, any push to `main` triggers a redeploy automatically. Edit `worker.js` locally, commit, push, done — Cloudflare rebuilds in about 30 seconds.

To roll back: **Workers & Pages → scriptura → Deployments** → pick an older deploy → **Rollback**.

---

## Removing the bot

1. `curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"` — unhook Telegram.
2. Cloudflare dashboard → delete the Worker, the D1 database, and the KV namespace.
3. BotFather → `/deletebot` → pick your bot.

---

## Troubleshooting

**Every user is stuck on the "Join @motionsalt first" screen even after joining** — 99 % of the time this is the bot no longer being an admin of `@motionsalt`. `getChatMember` returns an error when the caller isn't an admin, the gate treats errors as "not a member" (fail closed), so nobody gets through. Re-add the bot as admin in the channel and taps of "I've Joined — Check Again" should start working immediately.

**"Handler error: ... env.DB is undefined"** — the D1 binding is missing or named wrong. Confirm variable name is exactly `DB` in **Settings → Variables and Bindings → D1 Database Bindings**.

**The bot silently doesn't respond** — usually one of: `workers.dev` disabled (Step 6d), webhook not registered (Step 7), or wrong secret name (`TELEGRAM_TOKEN`, not `TELEGRAM_BOT_TOKEN`). Run `getWebhookInfo` and check the Worker's real-time logs.

**Reset Progress doesn't unlock settings** — Settings lock as soon as there are completed days OR the plan has been running >0 days. Reset clears the completed days AND re-anchors `start_date` to today, so both conditions clear at once. If it doesn't, the UPDATE failed — check the logs.

## License

MIT.
