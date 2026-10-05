// Show Tracker: TVmaze for show/episode data, Supabase for sign-in and per-user progress.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";

const $ = s => document.querySelector(s);
const gateMsg = $("#gateMsg");

/* ---------- Supabase setup ---------- */
let SUPABASE_URL, SUPABASE_KEY;
try {
  ({ SUPABASE_URL, SUPABASE_KEY } = await import("./config.js"));
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("empty config");
} catch (e) {
  $("#gate").hidden = false;
  $("#signInForm").hidden = true;
  gateMsg.textContent = "Missing config.js. Run `node scripts/write-config.mjs` with SUPABASE_URL and SUPABASE_KEY set (see README).";
  throw e;
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const TABLE = "showtracker_shows";

/* ---------- constants & state ---------- */
const API = "https://api.tvmaze.com";
const EP_CACHE_KEY = "showtracker-eps-v1";
const ROWS_CACHE_KEY = "showtracker-rows-v1";
const REFRESH_MS = 12 * 3600e3;

let user = null, channel = null;
let shows = {};                 // showId -> { id, name, image, ..., myLink, watched, addedAt, lastTouch }
let epCache = loadJSON(EP_CACHE_KEY, {});
let view = "next", searchResults = [], openShowId = null, searching = false, editingLink = false;
let loaded = false, pending = 0;
const fetching = new Set();

function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* cache only */ } }
const saveEpCache = () => saveJSON(EP_CACHE_KEY, epCache);

/* ---------- helpers ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const strip = html => { const d = document.createElement("div"); d.innerHTML = html || ""; return d.textContent.trim(); };
const pad = n => String(n).padStart(2, "0");
const code = e => `S${pad(e.s)}E${pad(e.n)}`;
const now = () => Date.now();
const aired = e => e.t && e.t <= now();
const fmtDate = t => t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "TBA";
const rel = t => {
  const d = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  if (d === 0) return "Today"; if (d === 1) return "Tomorrow"; if (d < 7) return new Date(t).toLocaleDateString(undefined, { weekday: "long" });
  return fmtDate(t);
};
const epsOf = id => epCache[id]?.eps || [];
const watchedOf = id => shows[id]?.watched || {};

async function api(path, tries = 2) {
  const r = await fetch(API + path);
  if (r.status === 429 && tries > 0) { await new Promise(res => setTimeout(res, 1200)); return api(path, tries - 1); }
  if (!r.ok) throw new Error(`TVmaze returned ${r.status}`);
  return r.json();
}

function slimShow(s) {
  return {
    name: s.name,
    image: s.image ? (s.image.medium || s.image.original) : null,
    network: s.webChannel?.name || s.network?.name || null,
    status: s.status || null, premiered: s.premiered || null, genres: s.genres || [],
    officialSite: s.officialSite || null, summary: strip(s.summary).slice(0, 1500),
    rating: s.rating?.average || null
  };
}
function slimEps(list) {
  return list.filter(e => e.season != null && e.number != null && e.type !== "insignificant_special")
    .map(e => ({ id: e.id, s: e.season, n: e.number, name: e.name, t: e.airstamp ? Date.parse(e.airstamp) : (e.airdate ? Date.parse(e.airdate) : null) }))
    .sort((a, b) => a.s - b.s || a.n - b.n);
}

/* ---------- data layer (Supabase) ---------- */
const fromRow = r => ({
  ...(r.info || {}), id: r.show_id, myLink: r.my_link, watched: r.watched || {},
  addedAt: Date.parse(r.added_at), lastTouch: Date.parse(r.last_touch)
});
const toRow = s => ({
  show_id: Number(s.id),
  info: { name: s.name, image: s.image ?? null, network: s.network ?? null, status: s.status ?? null, premiered: s.premiered ?? null,
          genres: s.genres || [], officialSite: s.officialSite ?? null, summary: (s.summary || "").slice(0, 1500), rating: s.rating ?? null },
  my_link: s.myLink ?? null, watched: s.watched || {},
  added_at: new Date(s.addedAt || now()).toISOString(), last_touch: new Date(s.lastTouch || now()).toISOString()
});

function setSync() {
  const el = $("#sync"), offline = !navigator.onLine;
  el.textContent = pending ? "Saving…" : offline ? "Offline" : "Synced";
  el.classList.toggle("off", !!pending || offline);
}
async function track(promise) {
  pending++; setSync();
  try { const { data, error } = await promise; if (error) throw error; return data; }
  finally { pending--; setSync(); }
}

async function loadShows() {
  const { data, error } = await sb.from(TABLE).select("*");
  if (error) { toast(`Couldn't load your shows (${error.message}).`); return; }
  shows = Object.fromEntries(data.map(r => [String(r.show_id), fromRow(r)]));
  saveJSON(ROWS_CACHE_KEY + ":" + user.id, data);
  loaded = true;
  render();
  loadMissingEpisodes();
}
let reloadTimer;
const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (!pending) loadShows(); else scheduleReload(); }, 400); };

/* Fetch episodes (and fresh details) from TVmaze. Episodes stay in a local cache; only detail changes are saved. */
async function loadEpisodes(id, { force = false } = {}) {
  id = String(id);
  const c = epCache[id];
  if (!force && c && now() - c.fetchedAt < REFRESH_MS) return;
  if (fetching.has(id)) return;
  fetching.add(id);
  try {
    const [show, eps] = await Promise.all([api(`/shows/${id}`), api(`/shows/${id}/episodes`)]);
    epCache[id] = { fetchedAt: now(), eps: slimEps(eps) };
    saveEpCache();
    const meta = slimShow(show), cur = shows[id];
    if (user && cur && ["name", "image", "network", "status", "officialSite", "rating"].some(k => meta[k] !== cur[k])) {
      Object.assign(cur, meta);
      track(sb.from(TABLE).update({ info: toRow(cur).info }).eq("show_id", Number(id))).catch(() => {});
    }
  } finally { fetching.delete(id); }
}

async function loadMissingEpisodes() {
  let changed = false;
  for (const id of Object.keys(shows)) {
    const c = epCache[id];
    if (c && now() - c.fetchedAt < REFRESH_MS) continue;
    try { await loadEpisodes(id); changed = true; } catch (e) { /* retry next time */ }
  }
  if (changed) render();
}

/* ---------- derived ---------- */
function progress(id) {
  const eps = epsOf(id), w = watchedOf(id);
  const a = eps.filter(aired);
  const watched = a.filter(e => w[e.id]).length;
  return {
    airedCount: a.length, watched, left: a.length - watched,
    next: a.find(e => !w[e.id]) || null,
    upcoming: eps.find(e => e.t && e.t > now()) || null,
    loading: !epCache[id]
  };
}

/* ---------- writes ---------- */
let lastUndo = null;
function applyWatchedLocal(id, epIds, on) {
  const s = shows[id]; if (!s) return;
  s.watched = { ...s.watched };
  epIds.forEach(e => { if (on) s.watched[e] = now(); else delete s.watched[e]; });
  s.lastTouch = now();
}
async function setWatched(id, epIds, on, { undoable = true } = {}) {
  id = String(id);
  if (!epIds.length) return;
  const w = watchedOf(id);
  const wasOn = epIds.filter(e => w[e]), wasOff = epIds.filter(e => !w[e]);
  if (undoable) lastUndo = async () => {
    await setWatched(id, on ? wasOff : wasOn, !on, { undoable: false });
  };
  applyWatchedLocal(id, epIds, on); render();
  try { await track(sb.rpc("showtracker_set_watched", { p_show_id: Number(id), p_eps: epIds.map(Number), p_on: on })); }
  catch (e) { toast("Couldn't save that change. Check your connection."); scheduleReload(); }
}

async function addShow(id, name) {
  if (shows[id]) { openShow(id); return; }
  toast(`Adding ${name}…`, false);
  try {
    const show = await api(`/shows/${id}`);
    await loadEpisodes(id, { force: true });
    const s = { id, ...slimShow(show), myLink: null, watched: {}, addedAt: now(), lastTouch: now() };
    await track(sb.from(TABLE).insert(toRow(s)));
    shows[String(id)] = s; render();
    toast(`Added ${name}`);
  } catch (e) { toast(`Couldn't add ${name}. Check your connection and try again.`); }
}

async function removeShow(id) {
  id = String(id);
  const snapshot = shows[id]; if (!snapshot) return;
  closeShow();
  delete shows[id]; render();
  lastUndo = async () => { shows[id] = snapshot; render(); await track(sb.from(TABLE).upsert(toRow(snapshot))); };
  try { await track(sb.from(TABLE).delete().eq("show_id", Number(id))); toast(`Removed ${snapshot.name}`, true); }
  catch (e) { shows[id] = snapshot; render(); toast("Couldn't remove the show. Try again."); }
}

async function saveLink(id, url) {
  const s = shows[id]; if (!s) return;
  const prev = s.myLink; s.myLink = url; render();
  try { await track(sb.from(TABLE).update({ my_link: url }).eq("show_id", Number(id))); toast(url ? "Link saved" : "Link removed"); }
  catch (e) { s.myLink = prev; render(); toast("Couldn't save the link. Try again."); }
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, undo) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>` + (undo ? `<button type="button" id="undoBtn">Undo</button>` : "");
  t.hidden = false;
  if (undo) $("#undoBtn").onclick = () => { const u = lastUndo; lastUndo = null; t.hidden = true; u && u().catch(() => toast("Couldn't undo. Try again.")); };
  clearTimeout(toastTimer);
  if (undo !== false) toastTimer = setTimeout(() => t.hidden = true, 5000);
}

/* ---------- rendering ---------- */
const posterImg = src => src ? `<img class="poster" src="${esc(src)}" alt="" loading="lazy">` : `<div class="poster" aria-hidden="true"></div>`;

function showRow(s, mode) {
  const p = progress(s.id);
  const pct = p.airedCount ? Math.round(p.watched / p.airedCount * 100) : 0;
  let line, act = "";
  if (p.loading) {
    line = `<div class="meta">Loading episodes…</div>`;
  } else if (mode === "coming" && p.upcoming) {
    line = `<div class="next"><span class="code">${code(p.upcoming)}</span><span class="name">${esc(p.upcoming.name)}</span></div>`;
    act = `<span class="chip ${rel(p.upcoming.t) === "Today" ? "onair" : ""}">${esc(rel(p.upcoming.t))}</span>`;
  } else if (p.next) {
    line = `<div class="next"><span class="code">${code(p.next)}</span><span class="name">${esc(p.next.name)}</span></div>`;
    act = `<button class="btn primary small" data-act="watch" data-show="${s.id}" data-ep="${p.next.id}">Watched ${code(p.next)}</button>`;
  } else {
    line = `<div class="meta">${p.airedCount ? "All caught up" : "Nothing aired yet"}${p.upcoming ? ` · next ${code(p.upcoming)} ${esc(rel(p.upcoming.t))}` : s.status === "Ended" ? " · series ended" : ""}</div>`;
    act = `<span class="chip good">Caught up</span>`;
  }
  const sub = [s.network, p.left > 0 ? `${p.left} episode${p.left === 1 ? "" : "s"} left` : null].filter(Boolean).join(" · ");
  return `<article class="row">
    ${posterImg(s.image)}
    <div class="info">
      <button class="title" data-act="open" data-id="${s.id}">${esc(s.name)}</button>
      ${line}
      <div class="meta">${esc(sub)}</div>
      <div class="prog ${pct === 100 ? "done" : ""}" title="${p.watched} of ${p.airedCount} aired episodes watched"><b style="width:${pct}%"></b></div>
    </div>
    <div class="act">${s.myLink ? `<a class="btn small" href="${esc(s.myLink)}" target="_blank" rel="noopener" title="${esc(s.myLink)}">Open ↗</a>` : ""}${act}</div>
  </article>`;
}

const SUGGEST = ["Severance", "The Bear", "Slow Horses", "Shōgun", "The White Lotus", "Andor"];
const emptyLibrary = () => `<section class="empty">
  <h3>Add your first show</h3>
  <p>Search above for anything you're watching. Each show comes in with every season and episode, and the tracker works out what's next. Have a backup from the single-file Episode Log? Use Import below.</p>
  <div class="suggest">${SUGGEST.map(n => `<button class="btn small" data-act="suggest" data-q="${esc(n)}">${esc(n)}</button>`).join("")}</div>
</section>`;

const footer = () => `<div class="foot">
  <button class="btn small" data-act="export">Export backup</button>
  <button class="btn small" data-act="import">Import backup</button>
  <button class="btn small" data-act="refresh">Refresh episode lists</button>
  <span>Show data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a> (CC BY-SA).</span>
</div>`;

function render() {
  if (!user) return;
  const list = Object.values(shows);
  const withNext = list.filter(s => progress(s.id).next);
  const coming = list.filter(s => { const u = progress(s.id).upcoming; return u && u.t - now() < 30 * 864e5; });
  $("#nNext").textContent = withNext.length || "";
  $("#nComing").textContent = coming.length || "";
  $("#nLib").textContent = list.length || "";
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.view === view));
  $("#searchTab").hidden = view !== "search";

  let html = "";
  if (view === "search") {
    if (searching) html = `<div class="loading">Searching…</div>`;
    else if (!searchResults.length) html = `<div class="empty"><h3>No shows found</h3><p>Try a shorter title or check the spelling.</p></div>`;
    else html = searchResults.map(({ show: s }) => {
      const yr = s.premiered ? s.premiered.slice(0, 4) : "";
      const net = s.webChannel?.name || s.network?.name || "";
      return `<article class="row">${posterImg(s.image?.medium)}
        <div class="info"><span class="title" style="cursor:default">${esc(s.name)}</span>
          <div class="meta">${esc([yr, net, s.status].filter(Boolean).join(" · "))}</div>
          <div class="meta">${esc((s.genres || []).join(", "))}</div></div>
        <div class="act">${shows[s.id] ? `<button class="btn small" data-act="open" data-id="${s.id}">Open</button>` : `<button class="btn primary small" data-act="add" data-id="${s.id}" data-name="${esc(s.name)}">Add show</button>`}</div>
      </article>`;
    }).join("");
  } else if (!loaded) {
    html = `<div class="loading">Loading your shows…</div>`;
  } else if (!list.length) {
    html = emptyLibrary();
  } else if (view === "next") {
    const caught = list.filter(s => !progress(s.id).next);
    const sorted = withNext.sort((a, b) => (b.lastTouch || b.addedAt) - (a.lastTouch || a.addedAt));
    html = sorted.length ? sorted.map(s => showRow(s, "next")).join("") : `<div class="empty"><h3>You're all caught up</h3><p>Nothing aired is left unwatched. Check Coming up for what airs next.</p></div>`;
    if (caught.length && sorted.length) html += `<h2 class="sec">Caught up</h2>` + caught.map(s => showRow(s, "next")).join("");
  } else if (view === "coming") {
    const sorted = coming.sort((a, b) => progress(a.id).upcoming.t - progress(b.id).upcoming.t);
    html = sorted.length ? `<h2 class="sec">Next 30 days</h2>` + sorted.map(s => showRow(s, "coming")).join("")
      : `<div class="empty"><h3>Nothing airing in the next 30 days</h3><p>New episodes for shows in your list will show up here as they get scheduled.</p></div>`;
  } else {
    html = list.sort((a, b) => a.name.localeCompare(b.name)).map(s => showRow(s, "next")).join("");
  }
  $("#main").innerHTML = html + footer();
  if (openShowId) renderPanel();
}

function renderPanel() {
  const s = shows[openShowId]; if (!s) return closeShow();
  const p = progress(s.id), w = watchedOf(s.id), eps = epsOf(s.id);
  const seasons = {};
  eps.forEach(e => (seasons[e.s] ||= []).push(e));
  const openSeason = p.next ? p.next.s : (p.upcoming ? p.upcoming.s : null);
  const jw = `https://www.justwatch.com/za/search?q=${encodeURIComponent(s.name)}`;
  const panel = $("#panel");
  const prevOpen = new Set([...panel.querySelectorAll("details[open]")].map(d => d.dataset.s));
  const keepOpen = prevOpen.size ? prevOpen : new Set([String(openSeason)]);
  const linkDraft = $("#linkInput")?.value;
  const scroll = panel.scrollTop;
  panel.innerHTML = `
    <button class="btn small close" data-act="close">Close</button>
    <div class="ph">${posterImg(s.image)}
      <div style="min-width:0">
        <h2>${esc(s.name)}</h2>
        <div class="chips">
          ${s.status ? `<span class="chip ${s.status === "Running" ? "onair" : ""}">${esc(s.status)}</span>` : ""}
          ${s.premiered ? `<span class="chip">${esc(s.premiered.slice(0, 4))}</span>` : ""}
          ${s.rating ? `<span class="chip">★ ${s.rating}</span>` : ""}
          <span class="chip ${p.left ? "" : "good"}">${p.watched}/${p.airedCount} watched</span>
        </div>
        ${s.summary ? `<p class="summary">${esc(s.summary)}</p>` : ""}
      </div>
    </div>
    <div class="where">
      <span>Where to watch:</span>
      ${s.network ? `<strong>${esc(s.network)}</strong>` : ""}
      ${s.officialSite ? `<a href="${esc(s.officialSite)}" target="_blank" rel="noopener">Official page ↗</a>` : ""}
      <a href="${jw}" target="_blank" rel="noopener">Streaming options in SA ↗</a>
      <div class="mylink">
        ${editingLink || !s.myLink
          ? `<form class="linkform" id="linkForm">
              <input id="linkInput" type="url" placeholder="Paste the link to where you watch this show" value="${esc(linkDraft ?? s.myLink ?? "")}" aria-label="My link for ${esc(s.name)}">
              <button class="btn small primary" type="submit">Save link</button>
              ${s.myLink ? `<button class="btn small" type="button" data-act="linkCancel">Cancel</button>` : ""}
            </form>`
          : `<strong>My link</strong><span class="url">${esc(s.myLink)}</span>
             <a class="btn small primary" href="${esc(s.myLink)}" target="_blank" rel="noopener">Open ↗</a>
             <button class="btn small" data-act="linkEdit">Edit</button>
             <button class="btn small" data-act="linkClear">Remove</button>`}
      </div>
    </div>
    <div class="actions">
      ${p.next ? `<button class="btn primary" data-act="watch" data-show="${s.id}" data-ep="${p.next.id}">Watched ${code(p.next)}</button>` : ""}
      <button class="btn" data-act="refreshOne" data-id="${s.id}">Refresh episodes</button>
      <button class="btn" data-act="remove" data-id="${s.id}">Remove show</button>
    </div>
    ${p.loading ? `<div class="loading">Loading episodes…</div>` : ""}
    ${Object.keys(seasons).sort((a, b) => a - b).map(sn => {
      const list = seasons[sn], a = list.filter(aired), done = a.filter(e => w[e.id]).length;
      const allDone = a.length && done === a.length;
      return `<details class="season" data-s="${sn}" ${keepOpen.has(sn) ? "open" : ""}>
        <summary><span class="chev" aria-hidden="true">›</span><h3>Season ${sn}</h3>
          <span class="chip ${allDone ? "good" : ""}">${done}/${list.length}</span>
          ${a.length ? `<button class="btn small" data-act="season" data-s="${sn}" data-on="${allDone ? 0 : 1}">${allDone ? "Unmark season" : "Mark season"}</button>` : ""}
        </summary>
        <ul class="eps">${list.map(e => {
          const isAired = aired(e), isW = !!w[e.id];
          return `<li class="ep ${isW ? "watched" : ""} ${isAired ? "" : "future"}">
            <input type="checkbox" id="ep-${e.id}" data-act="toggle" data-ep="${e.id}" ${isW ? "checked" : ""} ${isAired ? "" : "disabled"} aria-label="Watched ${code(e)}">
            <label class="code" for="ep-${e.id}">${code(e)}</label>
            <label class="name" for="ep-${e.id}">${esc(e.name)}</label>
            <span style="display:flex;gap:6px;align-items:center">
              ${isAired && !isW ? `<button class="btn upto" data-act="upto" data-ep="${e.id}">Watched up to here</button>` : ""}
              <span class="date">${isAired ? fmtDate(e.t) : (e.t ? rel(e.t) : "TBA")}</span>
            </span>
          </li>`;
        }).join("")}</ul>
      </details>`;
    }).join("")}`;
  panel.scrollTop = scroll;
}

function openShow(id) {
  openShowId = String(id); editingLink = false;
  const panel = $("#panel"); panel.innerHTML = ""; panel.hidden = false; $("#scrim").hidden = false;
  document.body.style.overflow = "hidden";
  renderPanel();
  if (!epCache[openShowId]) loadEpisodes(openShowId).then(render).catch(() => {});
}
function closeShow() { openShowId = null; $("#panel").hidden = true; $("#scrim").hidden = true; document.body.style.overflow = ""; }

/* ---------- search ---------- */
async function doSearch(q) {
  q = q.trim(); if (!q) return;
  view = "search"; searching = true; render();
  try { searchResults = await api(`/search/shows?q=${encodeURIComponent(q)}`); }
  catch (e) { searchResults = []; toast("Search failed. Check your connection and try again."); }
  searching = false; render();
}

/* ---------- backup ---------- */
function exportBackup() {
  const data = { app: "showtracker", version: 2, exportedAt: new Date().toISOString(), shows };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `showtracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Accepts this app's backups (version 2) and the single-file Episode Log backups (shows with eps + a flat watched map).
async function importBackup(data) {
  if (!data?.shows) throw new Error("bad file");
  const rows = [];
  for (const [id, s] of Object.entries(data.shows)) {
    let watched = s.watched || {};
    if (Array.isArray(s.eps)) {
      if (data.watched) watched = Object.fromEntries(s.eps.filter(e => data.watched[e.id]).map(e => [e.id, data.watched[e.id]]));
      epCache[id] = { fetchedAt: s.fetchedAt || 0, eps: s.eps.map(({ id, s: sn, n, name, t }) => ({ id, s: sn, n, name, t })) };
    }
    const existing = shows[id];
    rows.push(toRow({ ...s, id, myLink: s.myLink ?? existing?.myLink ?? null, watched: { ...(existing?.watched || {}), ...watched } }));
  }
  saveEpCache();
  for (let i = 0; i < rows.length; i += 200) await track(sb.from(TABLE).upsert(rows.slice(i, i + 200)));
  await loadShows();
  return rows.length;
}

/* ---------- events ---------- */
$("#signInForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#signInBtn");
  gateMsg.textContent = ""; btn.disabled = true; btn.textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#password").value });
  btn.disabled = false; btn.textContent = "Sign in";
  if (error) gateMsg.textContent = error.message === "Invalid login credentials" ? "That email and password don't match. Try again." : `Sign-in failed: ${error.message}`;
  else $("#password").value = "";
});
$("#signOutBtn").addEventListener("click", () => sb.auth.signOut());
$("#searchForm").addEventListener("submit", e => { e.preventDefault(); $("#q").blur(); doSearch($("#q").value); });
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => { view = t.dataset.view; render(); }));
$("#scrim").addEventListener("click", closeShow);
document.addEventListener("keydown", e => { if (e.key === "Escape" && openShowId) closeShow(); });
window.addEventListener("online", () => { setSync(); if (user) loadShows(); });
window.addEventListener("offline", setSync);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && user) loadShows(); });

const showIdOfEp = epId => Object.keys(shows).find(id => epsOf(id).some(e => e.id === epId));

document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el || el.dataset.act === "toggle") return;
  const a = el.dataset.act;
  if (a === "open") openShow(el.dataset.id);
  else if (a === "close") closeShow();
  else if (a === "add") addShow(Number(el.dataset.id), el.dataset.name);
  else if (a === "suggest") { $("#q").value = el.dataset.q; doSearch(el.dataset.q); }
  else if (a === "watch") {
    const epId = Number(el.dataset.ep), id = el.dataset.show || showIdOfEp(epId);
    const ep = epsOf(id).find(x => x.id === epId);
    setWatched(id, [epId], true);
    toast(`Marked ${shows[id]?.name} ${ep ? code(ep) : ""} as watched`, true);
  }
  else if (a === "upto") {
    const epId = Number(el.dataset.ep), id = openShowId, eps = epsOf(id);
    const ids = eps.slice(0, eps.findIndex(x => x.id === epId) + 1).filter(aired).map(x => x.id);
    setWatched(id, ids, true); toast(`Marked ${ids.length} episodes as watched`, true);
  }
  else if (a === "season") {
    e.preventDefault();
    const id = openShowId, on = el.dataset.on === "1";
    const ids = epsOf(id).filter(x => x.s === Number(el.dataset.s) && aired(x)).map(x => x.id);
    setWatched(id, ids, on); toast(`${on ? "Marked" : "Unmarked"} season ${el.dataset.s}`, true);
  }
  else if (a === "linkEdit") { editingLink = true; renderPanel(); $("#linkInput")?.focus(); }
  else if (a === "linkCancel") { editingLink = false; renderPanel(); }
  else if (a === "linkClear") { editingLink = false; saveLink(openShowId, null); }
  else if (a === "remove") removeShow(el.dataset.id);
  else if (a === "refreshOne") {
    try { await loadEpisodes(el.dataset.id, { force: true }); render(); toast("Episode list updated"); }
    catch (err) { toast("Couldn't refresh. Try again in a moment."); }
  }
  else if (a === "refresh") {
    toast("Refreshing episode lists…", false);
    let fails = 0;
    for (const id of Object.keys(shows)) { try { await loadEpisodes(id, { force: true }); } catch (err) { fails++; } }
    render(); toast(fails ? `Refreshed, but ${fails} show${fails > 1 ? "s" : ""} failed. Try again later.` : "All episode lists are up to date");
  }
  else if (a === "export") exportBackup();
  else if (a === "import") $("#importFile").click();
});

document.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset?.act === "toggle") setWatched(openShowId, [Number(el.dataset.ep)], el.checked);
});

document.addEventListener("submit", e => {
  if (e.target.id !== "linkForm") return;
  e.preventDefault();
  let v = $("#linkInput").value.trim();
  if (!v) return;
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try { new URL(v); } catch (err) { toast("That doesn't look like a web address. Paste the full link."); return; }
  if (v.length > 2000) { toast("That link is too long to save."); return; }
  editingLink = false;
  saveLink(openShowId, v);
});

$("#importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = "";
  try {
    toast("Importing…", false);
    const n = await importBackup(JSON.parse(await f.text()));
    toast(`Imported ${n} show${n === 1 ? "" : "s"}`);
    loadMissingEpisodes();
  } catch (err) { toast("That file isn't a Show Tracker or Episode Log backup."); }
});

/* ---------- auth & live sync ---------- */
let authResolved = false;
function onUser(u) {
  // Skip repeats (e.g. token refreshes), but always run the first time so the sign-in screen appears when signed out.
  if (authResolved && (u?.id || null) === (user?.id || null)) return;
  authResolved = true;
  user = u;
  if (channel) { sb.removeChannel(channel); channel = null; }
  shows = {}; loaded = false; closeShow();
  $("#gate").hidden = !!u;
  $("#app").hidden = !u;
  if (!u) return;

  $("#userName").textContent = u.email || "";
  const cached = loadJSON(ROWS_CACHE_KEY + ":" + u.id, null);
  if (cached) { shows = Object.fromEntries(cached.map(r => [String(r.show_id), fromRow(r)])); loaded = true; }
  render(); setSync();
  loadShows();
  channel = sb.channel("showtracker-" + u.id)
    .on("postgres_changes", { event: "*", schema: "public", table: TABLE, filter: `user_id=eq.${u.id}` }, scheduleReload)
    .subscribe();
}

sb.auth.onAuthStateChange((_event, session) => {
  // Defer: Supabase recommends not awaiting other Supabase calls inside this callback.
  setTimeout(() => onUser(session?.user || null), 0);
});
const { data: { session } } = await sb.auth.getSession();
onUser(session?.user || null);
