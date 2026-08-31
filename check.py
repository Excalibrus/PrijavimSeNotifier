#!/usr/bin/env python3
"""Watch prijavim.se start lists and push a notification when a new rider
registers in the category we care about.

Run it on a schedule. State lives in state/<race-id>.json, so the script is
stateless between runs and safe to kill at any point.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from bs4 import BeautifulSoup

CATEGORY = os.environ.get("CATEGORY", "Master A")
NTFY_SERVER = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")

# Alert once the watcher has failed this many checks in a row, then remind
# every FAIL_REALERT_EVERY failures after that (~3h at a 5 minute cadence).
FAIL_ALERT_AFTER = 3
FAIL_REALERT_EVERY = 36

# A start list that suddenly loses more than this fraction of its riders is
# treated as a bad fetch, not as mass withdrawals.
SHRINK_GUARD = 0.5

ROOT = Path(__file__).resolve().parent
RACES_FILE = ROOT / "races.txt"
STATE_DIR = ROOT / "state"
HEALTH_FILE = STATE_DIR / "_health.json"

# prijavim.se returns 403 to requests without a browser User-Agent.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "sl-SI,sl;q=0.9,en;q=0.8",
}


class ParseError(Exception):
    """The page loaded but did not look like a start list."""


def log(msg):
    print(msg, flush=True)


def read_races():
    if not RACES_FILE.exists():
        return []
    races = []
    for line in RACES_FILE.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            races.append(line)
    return races


def race_id(url):
    m = re.search(r"/checkings/(\d+)", url)
    return m.group(1) if m else re.sub(r"\W+", "_", url)[-40:]


def fetch(url, attempts=3):
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
            return raw.decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            last = exc
            if i < attempts - 1:
                time.sleep(2 * (i + 1))
    raise ParseError("fetch failed: %s" % last)


def parse_start_list(html):
    """Return (race_name, [rider, ...]) for every rider on the page."""
    soup = BeautifulSoup(html, "html.parser")

    og = soup.find("meta", property="og:title")
    name = og.get("content", "").strip() if og else ""
    if not name and soup.title:
        name = re.sub(r"\s*-\s*prijavim\.se\s*$", "", soup.title.get_text(strip=True))

    table = None
    cols = {}
    for candidate in soup.find_all("table"):
        heads = [th.get_text(" ", strip=True) for th in candidate.find_all("th")]
        if "Kategorija" in heads and "Priimek" in heads:
            table = candidate
            cols = {h: i for i, h in enumerate(heads)}
            break
    if table is None:
        raise ParseError("start list table not found")

    riders = []
    for tr in table.find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) < len(cols):
            continue
        text = [td.get_text(" ", strip=True) for td in cells]

        def col(header):
            i = cols.get(header)
            return text[i] if i is not None and i < len(text) else ""

        category = col("Kategorija")
        if not category:
            continue

        # The profile link is the only stable identity on the page: the
        # visible surname is CSS-uppercased and the row number shifts as
        # people register. Fall back to the name when a rider has no profile.
        link = tr.find("a", href=re.compile(r"/profile/view/(\d+)"))
        if link:
            rid = "p" + re.search(r"/profile/view/(\d+)", link["href"]).group(1)
            display = (link.get("title") or "").strip()
        else:
            rid = None
            display = ""
        if not display:
            display = ("%s %s" % (col("Priimek"), col("Ime"))).strip()
        if rid is None:
            rid = "n" + re.sub(r"\s+", "_", display.lower())

        riders.append(
            {
                "id": rid,
                "name": display,
                "club": col("Klub"),
                "category": category,
                "trasa": col("Trasa"),
            }
        )

    if not riders:
        raise ParseError("start list table parsed to zero riders")
    return name or "prijavim.se", riders


def notify(title, message, url=None, priority=3, tags=None):
    if not NTFY_TOPIC:
        log("!! NTFY_TOPIC not set - would have sent: %s / %s" % (title, message))
        return
    payload = {
        "topic": NTFY_TOPIC,
        "title": title,
        "message": message,
        "priority": priority,
        "tags": tags or ["bicyclist"],
    }
    if url:
        payload["click"] = url
    req = urllib.request.Request(
        NTFY_SERVER + "/",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
    except Exception as exc:  # a failed push must not kill the whole run
        log("!! ntfy push failed: %s" % exc)


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def describe(rider):
    line = rider["name"]
    if rider["club"]:
        line += " (%s)" % rider["club"]
    if rider["trasa"]:
        line += " - %s" % rider["trasa"]
    return line


def check_race(url):
    """Check one race. Returns True on success, False if the check failed."""
    path = STATE_DIR / ("%s.json" % race_id(url))
    state = load_json(path, None)

    try:
        html = fetch(url)
        race_name, everyone = parse_start_list(html)
    except ParseError as exc:
        log("FAIL %s: %s" % (url, exc))
        return False

    mine = [r for r in everyone if r["category"].casefold() == CATEGORY.casefold()]
    total = len(everyone)
    log("OK   %s: %d %s of %d registered" % (race_name, len(mine), CATEGORY, total))

    # A start list that collapsed is far more likely to be a bad render than
    # a real mass withdrawal. Keep the old state and report a failure.
    if state and state.get("total", 0) * SHRINK_GUARD > total:
        log("FAIL %s: list shrank %d -> %d, ignoring" % (race_name, state["total"], total))
        return False

    current = {r["id"]: r for r in mine}
    snapshot = {"url": url, "race": race_name, "total": total, "riders": current}

    if state is None:
        save_json(path, snapshot)
        notify(
            race_name,
            "Now watching. %d %s already registered." % (len(mine), CATEGORY),
            url=url,
            priority=2,
            tags=["eyes"],
        )
        return True

    known = state.get("riders", {})
    new = [r for rid, r in current.items() if rid not in known]

    if new:
        lines = ["+ %s" % describe(r) for r in new]
        lines.append("")
        lines.append("%s: %d - skupaj %d" % (CATEGORY, len(mine), total))
        notify(race_name, "\n".join(lines), url=url, priority=4)
        log("     -> notified about %d new" % len(new))

    save_json(path, snapshot)
    return True


def main():
    races = read_races()
    if not races:
        log("No races in races.txt - nothing to do.")
        return 0

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    ok = sum(1 for url in races if check_race(url))
    failed = len(races) - ok

    health = load_json(HEALTH_FILE, {"consecutive_failures": 0})
    streak = health.get("consecutive_failures", 0)

    # Only count a streak when nothing at all got through: one dead race URL
    # among several should not look like a broken watcher.
    if failed and ok == 0:
        streak += 1
        if streak == FAIL_ALERT_AFTER or (
            streak > FAIL_ALERT_AFTER and streak % FAIL_REALERT_EVERY == 0
        ):
            notify(
                "Notifier is broken",
                "%d checks in a row failed. The site may be down or the start "
                "list layout changed." % streak,
                priority=4,
                tags=["warning"],
            )
    else:
        streak = 0

    save_json(HEALTH_FILE, {"consecutive_failures": streak})
    return 0


if __name__ == "__main__":
    sys.exit(main())
