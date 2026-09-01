/**
 * Cloudflare Worker: watch prijavim.se start lists and push a notification to
 * ntfy when a new rider registers in the category we care about.
 *
 * Runs on a cron trigger. State lives in Workers KV, one entry per race.
 *
 * races.txt is read from GitHub at run time rather than baked in here, so
 * adding a race stays a one-line edit on github.com with no redeploy.
 */

const FAIL_ALERT_AFTER = 3;
const FAIL_REALERT_EVERY = 36;

// A start list that suddenly loses more than this fraction of its riders is
// treated as a bad fetch, not as mass withdrawals.
const SHRINK_GUARD = 0.5;

// prijavim.se returns 403 to requests without a browser User-Agent.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "sl-SI,sl;q=0.9,en;q=0.8",
};

class ParseError extends Error {}

const clean = (s) => s.replace(/\s+/g, " ").trim();

function raceId(url) {
  const m = url.match(/\/checkings\/(\d+)/);
  return m ? m[1] : url.replace(/\W+/g, "_").slice(-40);
}

async function readRaces(env) {
  const res = await fetch(env.RACES_URL, {
    headers: { "User-Agent": "prijavimse-notifier" },
    cf: { cacheTtl: 60 },
  });
  if (!res.ok) throw new ParseError(`races.txt fetch failed: HTTP ${res.status}`);
  return (await res.text())
    .split("\n")
    .map((l) => l.split("#")[0].trim())
    .filter(Boolean);
}

/**
 * Parse a start list page. Returns { name, riders }.
 *
 * Uses HTMLRewriter, so the page streams through once and is never held in
 * memory as a DOM.
 */
async function parseStartList(response, expectedId) {
  const headers = [];
  const rows = [];
  let ogUrl = "";
  let ogTitle = "";
  let counter = "";

  const lastRow = () => rows[rows.length - 1];

  const rewriter = new HTMLRewriter()
    .on('meta[property="og:url"]', {
      element(e) {
        ogUrl = e.getAttribute("content") || "";
      },
    })
    .on('meta[property="og:title"]', {
      element(e) {
        ogTitle = e.getAttribute("content") || "";
      },
    })
    // The registration count sits in a different container depending on
    // whether entries are still open ("go-racebottomCheckin") or closed
    // ("checking-btn-footer"). Exactly one of the two is present per page.
    .on("div.go-racebottomCheckin", {
      text(t) {
        counter += t.text;
      },
    })
    .on("div.checking-btn-footer", {
      text(t) {
        counter += t.text;
      },
    })
    .on("table.table-checkings-content th", {
      element() {
        headers.push("");
      },
      text(t) {
        if (headers.length) headers[headers.length - 1] += t.text;
      },
    })
    .on("table.table-checkings-content tbody tr", {
      element() {
        rows.push({ cells: [], pid: null, title: "" });
      },
    })
    .on("table.table-checkings-content tbody td", {
      element() {
        const r = lastRow();
        if (r) r.cells.push("");
      },
      text(t) {
        const r = lastRow();
        if (r && r.cells.length) r.cells[r.cells.length - 1] += t.text;
      },
    })
    .on('table.table-checkings-content tbody a[href*="/profile/view/"]', {
      element(e) {
        const r = lastRow();
        if (!r || r.pid) return;
        const m = (e.getAttribute("href") || "").match(/\/profile\/view\/(\d+)/);
        if (m) r.pid = m[1];
        r.title = e.getAttribute("title") || r.title;
      },
    });

  // Drive the stream to completion so every handler has run.
  await rewriter.transform(response).arrayBuffer();

  // An unknown race id serves the home page under the requested URL: same 200,
  // same start-list-shaped table, same "0 registered" counter. The tell is
  // og:url, where the server echoes the slug it resolved the id to - real races
  // get ".../6399/vzpon-na-jost-2026/", an unknown id gets ".../999999//".
  const resolved = ogUrl.match(/\/checkings\/(\d+)\/([^/?#]*)/);
  if (!resolved || !resolved[2]) {
    throw new ParseError("page is not a race - check the race id in the URL");
  }
  if (expectedId && resolved[1] !== expectedId) {
    throw new ParseError(`page is race ${resolved[1]}, expected ${expectedId}`);
  }

  const cols = {};
  headers.forEach((h, i) => {
    cols[clean(h)] = i;
  });
  if (!("Kategorija" in cols) || !("Priimek" in cols)) {
    throw new ParseError("start list table not found");
  }
  const col = (row, header) => {
    const i = cols[header];
    return i === undefined || i >= row.cells.length ? "" : clean(row.cells[i]);
  };

  const riders = [];
  for (const row of rows) {
    if (row.cells.length < headers.length) continue;
    const category = col(row, "Kategorija");
    if (!category) continue;

    // The profile link is the only stable identity on the page: the visible
    // surname is CSS-uppercased and the row number shifts as people register.
    let id;
    let name = clean(row.title);
    if (!name) name = clean(`${col(row, "Priimek")} ${col(row, "Ime")}`);
    if (row.pid) id = `p${row.pid}`;
    else id = `n${name.toLowerCase().replace(/\s+/g, "_")}`;

    riders.push({
      id,
      name,
      club: col(row, "Klub"),
      category,
      trasa: col(row, "Trasa"),
    });
  }

  // A race with nobody registered yet is a normal, expected state - and it is
  // exactly when we most want to be watching. Only treat zero riders as
  // breakage when the page itself claims somebody is registered.
  const claimed = counter.match(/Že prijavljenih[^0-9]*(\d+)/);
  if (claimed) {
    if (Number(claimed[1]) !== riders.length) {
      throw new ParseError(
        `page says ${claimed[1]} registered, parsed ${riders.length}`
      );
    }
  } else if (!riders.length) {
    throw new ParseError("no registration count on page and zero riders parsed");
  }

  return { name: ogTitle || resolved[2], riders };
}

async function fetchRace(url, expectedId) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (!res.ok) throw new ParseError(`HTTP ${res.status}`);
      return await parseStartList(res, expectedId);
    } catch (err) {
      last = err;
      if (i < 2) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last instanceof ParseError ? last : new ParseError(String(last));
}

/**
 * Find the chat to message, so the only secret needed is the bot token.
 *
 * Telegram reports who has written to the bot via getUpdates, so the first
 * time round we take the most recent chat and remember it in KV.
 */
async function telegramChatId(env, token) {
  if (env.TELEGRAM_CHAT_ID) return String(env.TELEGRAM_CHAT_ID).trim();
  const cached = await env.STATE.get("telegram_chat");
  if (cached) return cached;

  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  if (!res.ok) {
    console.log(`telegram getUpdates failed: HTTP ${res.status}`);
    return null;
  }
  const data = await res.json();
  const withChat = (data.result || [])
    .map((u) => u.message || u.channel_post)
    .filter((m) => m && m.chat && m.chat.id);
  if (!withChat.length) {
    console.log("telegram: no chat found - send your bot a message once");
    return null;
  }
  const id = String(withChat[withChat.length - 1].chat.id);
  await env.STATE.put("telegram_chat", id);
  console.log(`telegram: learned chat id ${id}`);
  return id;
}

async function sendTelegram(env, token, { title, message, url }) {
  const chat = await telegramChatId(env, token);
  if (!chat) return "FAILED telegram - no chat id";
  let text = `${title}\n\n${message}`;
  if (url) text += `\n\n${url}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      return `FAILED telegram HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    }
    return "ok via telegram";
  } catch (err) {
    return `FAILED telegram ${err}`;
  }
}

async function sendNtfy(env, topic, { title, message, url, priority, tags }) {
  const body = { topic, title, message, priority, tags: tags || ["bicyclist"] };
  if (url) body.click = url;

  // Anonymous publishing to ntfy.sh is rate limited per source IP, and a
  // Worker shares Cloudflare's egress pool with everyone else - so the daily
  // quota gets exhausted by strangers and every push comes back 429. A free
  // account token does NOT lift this; only a paid plan does.
  const headers = { "Content-Type": "application/json" };
  const token = (env.NTFY_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(env.NTFY_SERVER || "https://ntfy.sh/", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    // fetch does not throw on 4xx/5xx, so a rejected push would otherwise be
    // swallowed and look exactly like a delivered one.
    if (!res.ok) {
      return `FAILED ntfy HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    }
    return "ok via ntfy";
  } catch (err) {
    return `FAILED ntfy ${err}`;
  }
}

/**
 * Hand the push to GitHub Actions instead of sending it from here.
 *
 * ntfy.sh rate limits anonymous publishing per source IP and a Worker shares
 * Cloudflare's egress pool, so pushing directly from here always returns 429.
 * GitHub's runners have their own address that delivers fine. Only the cron
 * *schedule* is throttled on GitHub - repository_dispatch fires immediately,
 * so this keeps 5-minute detection while borrowing a working sender.
 */
async function sendViaGitHub(env, token, { title, message, url, priority }) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${env.GH_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "prijavimse-notifier",
        },
        body: JSON.stringify({
          event_type: "notify",
          client_payload: { title, message, url, priority },
        }),
      }
    );
    if (res.status === 204) return "ok via github";
    return `FAILED github HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
  } catch (err) {
    return `FAILED github ${err}`;
  }
}

async function notify(env, opts) {
  const opts2 = { priority: 3, ...opts };
  const gh = (env.GH_TOKEN || "").trim();
  const tg = (env.TELEGRAM_TOKEN || "").trim();
  const topic = (env.NTFY_TOPIC || "").trim();

  let result;
  if (gh && env.GH_REPO) result = await sendViaGitHub(env, gh, opts2);
  else if (tg) result = await sendTelegram(env, tg, opts2);
  else if (topic) result = await sendNtfy(env, topic, opts2);
  else {
    console.log(`[would notify] ${opts2.title} / ${opts2.message}`);
    return;
  }

  console.log(`push: ${result} - ${opts2.title}`);

  // Delivery failures are invisible by nature: we cannot notify you that
  // notifying is broken. Record the outcome so the status page can show it,
  // and so an expired token surfaces somewhere.
  await env.STATE.put(
    "lastpush",
    JSON.stringify({ at: new Date().toISOString(), result, title: opts2.title })
  );
}

function describe(r) {
  let line = r.name;
  if (r.club) line += ` (${r.club})`;
  if (r.trasa) line += ` - ${r.trasa}`;
  return line;
}

/** Check one race. Returns true on success, false if the check failed. */
async function checkRace(env, url, log) {
  const id = raceId(url);
  const key = `race:${id}`;
  const category = env.CATEGORY || "Master A";
  const prev = await env.STATE.get(key, "json");

  let parsed;
  try {
    parsed = await fetchRace(url, id);
  } catch (err) {
    log(`FAIL ${id}: ${err.message}`);
    return false;
  }

  const mine = parsed.riders.filter(
    (r) => r.category.toLowerCase() === category.toLowerCase()
  );
  const total = parsed.riders.length;
  log(`OK   ${parsed.name}: ${mine.length} ${category} of ${total} registered`);

  // A start list that collapsed is far more likely to be a bad render than a
  // real mass withdrawal. Keep the old state and report a failure.
  if (prev && (prev.total || 0) * SHRINK_GUARD > total) {
    log(`FAIL ${parsed.name}: list shrank ${prev.total} -> ${total}, ignoring`);
    return false;
  }

  const riders = {};
  for (const r of mine) riders[r.id] = r;
  const snapshot = { url, race: parsed.name, total, riders };

  if (!prev) {
    await env.STATE.put(key, JSON.stringify(snapshot));
    await notify(env, {
      title: parsed.name,
      message: `Now watching. ${mine.length} ${category} already registered.`,
      url,
      priority: 2,
      tags: ["eyes"],
    });
    return true;
  }

  const known = prev.riders || {};
  const fresh = mine.filter((r) => !(r.id in known));

  if (fresh.length) {
    const lines = fresh.map((r) => `+ ${describe(r)}`);
    lines.push("", `${category}: ${mine.length} - skupaj ${total}`);
    await notify(env, {
      title: parsed.name,
      message: lines.join("\n"),
      url,
      priority: 4,
    });
    log(`     -> notified about ${fresh.length} new`);
  }

  // KV writes are the scarce resource on the free plan, so only write when the
  // snapshot actually changed.
  if (JSON.stringify(snapshot) !== JSON.stringify(prev)) {
    await env.STATE.put(key, JSON.stringify(snapshot));
  }
  return true;
}

export async function run(env) {
  const lines = [];
  const log = (m) => {
    lines.push(m);
    console.log(m);
  };

  let races;
  try {
    races = await readRaces(env);
  } catch (err) {
    log(`FAIL ${err.message}`);
    return lines.join("\n");
  }
  if (!races.length) {
    log("No races in races.txt - nothing to do.");
    return lines.join("\n");
  }

  const health = (await env.STATE.get("health", "json")) || {};
  const next = {};

  // Track failures per race. One race that quietly stops parsing has to raise
  // an alert on its own, or it would hide behind the races that still work.
  for (const url of races) {
    const id = raceId(url);
    if (await checkRace(env, url, log)) {
      next[id] = 0;
      continue;
    }
    const streak = (health[id] || 0) + 1;
    next[id] = streak;
    if (
      streak === FAIL_ALERT_AFTER ||
      (streak > FAIL_ALERT_AFTER && streak % FAIL_REALERT_EVERY === 0)
    ) {
      const prev = await env.STATE.get(`race:${id}`, "json");
      await notify(env, {
        title: `Check failing: ${prev?.race || id}`,
        message:
          `${streak} checks in a row failed. The site may be down, the race ` +
          `may have been removed, or the start list layout changed.`,
        url,
        priority: 4,
        tags: ["warning"],
      });
    }
  }

  if (JSON.stringify(next) !== JSON.stringify(health)) {
    await env.STATE.put("health", JSON.stringify(next));
  }

  // Proof of life. A worker that stops running raises no alert of its own, so
  // record when it last ran and let the status page show how stale that is.
  const meta = (await env.STATE.get("meta", "json")) || { runs: 0 };
  await env.STATE.put(
    "meta",
    JSON.stringify({ lastRun: new Date().toISOString(), runs: (meta.runs || 0) + 1 })
  );
  return lines.join("\n");
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  // Read-only endpoints. Neither notifies nor writes state, so the worker's
  // public URL is safe to hit.
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/parse") {
      const target = url.searchParams.get("url");
      if (!target) return new Response("pass ?url=<race url>\n", { status: 400 });
      // The workers.dev URL is public, so keep this from being usable as a
      // general-purpose fetch relay for arbitrary hosts.
      let host;
      try {
        host = new URL(target).hostname;
      } catch {
        return new Response("bad url\n", { status: 400 });
      }
      if (host !== "prijavim.se" && !host.endsWith(".prijavim.se")) {
        return new Response("only prijavim.se urls\n", { status: 403 });
      }
      try {
        const parsed = await fetchRace(target, raceId(target));
        return Response.json({
          race: parsed.name,
          total: parsed.riders.length,
          riders: parsed.riders,
        });
      } catch (err) {
        return new Response(`${err.message}\n`, { status: 502 });
      }
    }

    const health = (await env.STATE.get("health", "json")) || {};
    const meta = (await env.STATE.get("meta", "json")) || {};
    const out = [`category: ${env.CATEGORY || "Master A"}`];
    if (meta.lastRun) {
      const age = Math.round((Date.now() - Date.parse(meta.lastRun)) / 1000);
      out.push(`last run: ${meta.lastRun} (${age}s ago, ${meta.runs} total)`);
    }
    const push = await env.STATE.get("lastpush", "json");
    if (push) {
      out.push(`last push: ${push.at} ${push.result} (${push.title})`);
    }
    out.push("");
    for (const [id, fails] of Object.entries(health)) {
      const st = await env.STATE.get(`race:${id}`, "json");
      out.push(
        `${id}  ${st ? Object.keys(st.riders || {}).length : "?"} watched  ` +
          `of ${st?.total ?? "?"}  fails=${fails}  ${st?.race || ""}`
      );
    }
    return new Response(out.join("\n") + "\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
