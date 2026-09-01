# PrijavimSeNotifier

Pushes a notification to your Android phone when a new rider registers in your
category on a [prijavim.se](https://prijavim.se) start list.

Checks every 5 minutes on GitHub Actions. Notifications arrive through
[ntfy](https://ntfy.sh) — no account, no API key, no app to build.

## Setup

### 1. ntfy on your phone

Install **ntfy** ([Play Store](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
or [F-Droid](https://f-droid.org/packages/io.heckel.ntfy/)), tap **+**, and
subscribe to a topic.

Pick a long random topic name. ntfy topics are unauthenticated, so anyone who
guesses the name can read your notifications — and publish to them.

```bash
python -c "import secrets; print('prijavimse-' + secrets.token_hex(8))"
```

### 2. Push this repo to GitHub

**Use a public repo.** Actions minutes are unlimited on public repos but capped
at 2,000/month on private ones, and every job bills as a full minute. A
5-minute schedule is ~8,640 runs/month, so on a private repo the quota runs out
in about a week and the schedule stops. On a private repo, `*/30` is the
fastest cadence that fits the free tier.

Nothing here is sensitive: the code, the race URLs and the start lists are all
public information on prijavim.se already. `NTFY_TOPIC` is a GitHub Actions
secret and stays hidden even in a public repo.

### 3. Add the topic as a secret

Repo **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
| --- | --- |
| `NTFY_TOPIC` | the topic name from step 1 |

Watching a category other than Master A? Add a repository *variable* (same page,
Variables tab) named `CATEGORY`. The category string has to match the site
exactly, e.g. `Master B`, `Amaterji`, `Ženske A`.

### 4. Turn it on

Open the **Actions** tab and enable workflows. Then run **check start lists →
Run workflow** once by hand — you should get a `Now watching` notification
within a minute. If that arrives, the schedule will work.

If the run pushes a notification but the **Commit state** step fails with a
`403`, the repo is set to read-only workflow tokens. Fix it under **Settings →
Actions → General → Workflow permissions → Read and write permissions**.
Without it state can't be saved, and you'd get the same `Now watching` message
on every single run.

## Adding a race

Add the event URL to [`races.txt`](races.txt), one per line:

```
https://prijavim.se/calendar/checkings/6395/5--cankarjev-pokal---kronometer-in-vzpon-na-ulovko-2026
```

GitHub's web editor works fine from your phone, so you can add a race right
after you enter it. The first check records who is already registered and sends
one `Now watching — N Master A already registered` message; after that you only
hear about genuinely new entries.

Delete the line once the race is over. Nothing breaks if you forget — a finished
race just stops producing new registrations.

## Cloudflare Worker (the 5-minute path)

GitHub throttles `*/5` schedules to roughly one run every 2–4 hours, so the
Worker in [`worker/`](worker/) is what actually delivers 5-minute checks. Same
logic, same notifications, cron that is honoured.

It reads this repo's `races.txt` over HTTPS at run time, so **adding a race
stays a one-line edit here with no redeploy**.

```bash
cd worker && npm install
```

Create the KV namespace and put the printed id into `wrangler.toml`:

```bash
npx wrangler kv namespace create STATE
```

Set the same ntfy topic the Actions version uses:

```bash
npx wrangler secret put NTFY_TOPIC
```

```bash
npx wrangler deploy
```

The first run seeds every race and sends one `Now watching` message each.

### Once the Worker is live

Delete the `schedule:` block from
[`.github/workflows/check.yml`](.github/workflows/check.yml). Otherwise both
systems watch the same races with separate state and you get **two pushes for
every new rider**. Leaving `workflow_dispatch` in place keeps the Actions run
available as a manual backup.

### Poking at it

The Worker's URL exposes two read-only endpoints — neither notifies nor writes
state, so they are safe to hit:

- `/` — every watched race, how many are in your category, and failure counts
- `/parse?url=<race url>` — the parsed start list as JSON, for debugging

Local development needs no Cloudflare account:

```bash
npx wrangler dev --local --test-scheduled
```

Then `curl "http://127.0.0.1:8787/__scheduled"` to fire a check. With no
`NTFY_TOPIC` set it logs what it would have sent instead of pushing.

## Running the Python version locally

```bash
pip install -r requirements.txt
```

```bash
python check.py
```

With no `NTFY_TOPIC` set it prints what it *would* have sent instead of pushing,
which is the easiest way to try changes. To push for real from PowerShell:

```bash
$env:NTFY_TOPIC = "your-topic"; python check.py
```

## How it works

- Fetches each start list with a browser `User-Agent` — the site returns `403`
  without one.
- Finds the table with `Priimek` / `Kategorija` headers and reads columns by
  header name, not by position, so an added column doesn't break it.
- Identifies riders by their **profile ID** (`/profile/view/48707/...`) rather
  than by name, so CSS-uppercased surnames and shifting row numbers don't
  produce phantom registrations.
- Diffs against `state/<race-id>.json`, which the workflow commits back to the
  repo. That doubles as a dated history of who signed up when.

## Failure handling

- Transient errors are retried 3 times per check.
- Failures are counted **per race**. Three in a row (~30 min) send a
  `Check failing: <race>` alert, then it goes quiet and reminds you every ~3
  hours until that race recovers. One broken race can't hide behind the others
  that still work.
- The page prints its own registration count, which is used as a checksum. If
  the site says 32 are registered and we only parsed 27, that's a layout change
  and it alerts rather than silently under-reporting.
- A race nobody has entered yet is a normal state, not an error — those are
  precisely the ones worth watching from day one.
- A wrong race id serves the home page under your URL: same `200`, same
  start-list-shaped table, same `0 registered`. That's caught via `og:url`,
  where the server echoes the slug it resolved — an unknown id gets an empty
  one. So a typo in `races.txt` alerts instead of looking like an empty race.
- If a start list shrinks by more than half between checks, that's treated as a
  bad render rather than mass withdrawals: the old state is kept and the check
  counts as a failure.

## Things worth knowing

- **Timing.** GitHub runs scheduled workflows on a best-effort basis. `*/5` is
  the floor, not a guarantee; at busy hours the real gap can be 15–20 minutes.
  If you ever need tight 5-minute timing, the same `check.py` runs unchanged
  under any cron.
- **Inactivity.** GitHub disables scheduled workflows after 60 days without
  repo activity. State commits normally keep it alive, but if nothing changes
  for two months you'll need to re-enable it in the Actions tab.
- **Re-registrations.** A rider who withdraws and signs up again notifies you a
  second time. That's deliberate — it is a new registration.
