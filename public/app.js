// Show Tracker: TVmaze for show/episode data, Firebase Auth + Firestore for per-user progress.
const FB = "https://www.gstatic.com/firebasejs/12.19.0";
const { initializeApp } = await import(`${FB}/firebase-app.js`);
const {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut
} = await import(`${FB}/firebase-auth.js`);
const {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, deleteField, writeBatch
} = await import(`${FB}/firebase-firestore.js`);

const $ = s => document.querySelector(s);
const gateMsg = $("#gateMsg");

/* ---------- Firebase setup ---------- */
let firebaseConfig;
try {
  ({ firebaseConfig } = await import("./firebase-config.js"));
} catch (e) {
  $("#gate").hidden = false;
  $("#signInBtn").disabled = true;
  gateMsg.textContent = "Missing firebase-config.js. Copy firebase-config.example.js to firebase-config.js and paste in your project's web config.";
  throw e;
}

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* ---------- constants & state ---------- */
const API = "https://api.tvmaze.com";
const EP_CACHE_KEY = "showtracker-eps-v1";
const REFRESH_MS = 12 * 3600e3;

let user = null, unsubShows = null;
let shows = {};                 // showId -> Firestore doc data (metadata, myLink, watched map)
let epCache = loadEpCache();    // showId -> { fetchedAt, eps: [...] }
let view = "next", searchResults = [], openShowId = null, searching = false, editingLink = false;
let loaded = false;
const fetching = new Set();

function loadEpCache() { try { return JSON.parse(localStorage.getItem(EP_CACHE_KEY)) || {}; } catch (e) { return {}; } }
function saveEpCache() { try { localStorage.setItem(EP_CACHE_KEY, JSON.stringify(epCache)); } catch (e) { /* cache only; safe to lose */ } }

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
const showRef = id => doc(db, "users", user.uid, "shows", String(id));

async function api(path, tries = 2) {
  const r = await fetch(API + path);
  if (r.status === 429 && tries > 0) { await new Promise(res => setTimeout(res, 1200)); return api(path, tries - 1); }
  if (!r.ok) throw new Error(`TVmaze returned ${r.status}`);
  return r.json();
}

function slimShow(s) {
  return {
    id: s.id, name: s.name,
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

/* Fetch episodes (and fresh metadata) from TVmaze. Episodes stay in a local cache; only metadata changes go to Firestore. */
async function loadEpisodes(id, { force = false } = {}) {
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
      updateDoc(showRef(id), meta).catch(() => {});
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
async function setWatched(id, epIds, on) {
  const w = watchedOf(id);
  const before = Object.fromEntries(epIds.map(e => [e, w[e] ?? null]));
  const patch = { lastTouch: now() };
  epIds.forEach(e => patch[`watched.${e}`] = on ? now() : deleteField());
  lastUndo = () => {
    const undo = {};
    Object.entries(before).forEach(([e, v]) => undo[`watched.${e}`] = v ?? deleteField());
    return updateDoc(showRef(id), undo);
  };
  try { await updateDoc(showRef(id), patch); } catch (e) { toast("Couldn't save that change. Check your connection."); }
}

async function addShow(id, name) {
  if (shows[id]) { openShow(id); return; }
  toast(`Adding ${name}…`, false);
  try {
    await loadEpisodes(id, { force: true });
    const show = await api(`/shows/${id}`);
    await setDoc(showRef(id), { ...slimShow(show), myLink: null, watched: {}, addedAt: now(), lastTouch: now() });
    toast(`Added ${name}`);
  } catch (e) { toast(`Couldn't add ${name}. Check your connection and try again.`); }
}

async function removeShow(id) {
  const snapshot = shows[id]; if (!snapshot) return;
  closeShow();
  lastUndo = () => setDoc(showRef(id), snapshot);
  try { await deleteDoc(showRef(id)); toast(`Removed ${snapshot.name}`, true); }
  catch (e) { toast("Couldn't remove the show. Try again."); }
}

async function saveLink(id, url) {
  try { await updateDoc(showRef(id), { myLink: url }); toast(url ? "Link saved" : "Link removed"); }
  catch (e) { toast("Couldn't save the link. Try again."); }
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, undo) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>` + (undo ? `<button type="button" id="undoBtn">Undo</button>` : "");
  t.hidden = false;
  if (undo) $("#undoBtn").onclick = () => { lastUndo && lastUndo().catch(() => toast("Couldn't undo. Try again.")); lastUndo = null; t.hidden = true; };
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
  <p>Search above for anything you're watching. Each show comes in with every season and episode, and the tracker works out what's next. Have a backup from the single-file version? Use Import below.</p>
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
  const docs = [];
  for (const [id, s] of Object.entries(data.shows)) {
    let watched = s.watched || {};
    if (Array.isArray(s.eps)) {
      if (data.watched) watched = Object.fromEntries(s.eps.filter(e => data.watched[e.id]).map(e => [e.id, data.watched[e.id]]));
      epCache[id] = { fetchedAt: s.fetchedAt || 0, eps: s.eps.map(({ id, s: sn, n, name, t }) => ({ id, s: sn, n, name, t })) };
    }
    const existing = shows[id]?.watched || {};
    docs.push([id, {
      id: Number(id), name: s.name, image: s.image ?? null, network: s.network ?? null, status: s.status ?? null,
      premiered: s.premiered ?? null, genres: s.genres || [], officialSite: s.officialSite ?? null,
      summary: (s.summary || "").slice(0, 1500), rating: s.rating ?? null,
      myLink: s.myLink ?? shows[id]?.myLink ?? null,
      watched: { ...existing, ...watched }, addedAt: s.addedAt || now(), lastTouch: s.lastTouch || s.addedAt || now()
    }]);
  }
  saveEpCache();
  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    docs.slice(i, i + 400).forEach(([id, d]) => batch.set(showRef(id), d));
    await batch.commit();
  }
  return docs.length;
}

/* ---------- events ---------- */
$("#signInBtn").addEventListener("click", async () => {
  const provider = new GoogleAuthProvider();
  gateMsg.textContent = "";
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") return signInWithRedirect(auth, provider);
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") gateMsg.textContent = `Sign-in failed (${e.code || e.message}).`;
  }
});
$("#signOutBtn").addEventListener("click", () => signOut(auth));
$("#searchForm").addEventListener("submit", e => { e.preventDefault(); $("#q").blur(); doSearch($("#q").value); });
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => { view = t.dataset.view; render(); }));
$("#scrim").addEventListener("click", closeShow);
document.addEventListener("keydown", e => { if (e.key === "Escape" && openShowId) closeShow(); });

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
onAuthStateChanged(auth, u => {
  user = u;
  if (unsubShows) { unsubShows(); unsubShows = null; }
  shows = {}; loaded = false; closeShow();
  $("#gate").hidden = !!u;
  $("#app").hidden = !u;
  if (!u) return;

  $("#userName").textContent = u.displayName || u.email || "";
  const av = $("#avatar");
  if (u.photoURL) { av.src = u.photoURL; av.hidden = false; } else av.hidden = true;

  const sync = $("#sync");
  unsubShows = onSnapshot(collection(db, "users", u.uid, "shows"), { includeMetadataChanges: true }, snap => {
    const next = {};
    snap.forEach(d => next[d.id] = d.data());
    shows = next; loaded = true;
    const pending = snap.metadata.hasPendingWrites, offline = snap.metadata.fromCache;
    sync.textContent = pending ? "Saving…" : offline ? "Offline" : "Synced";
    sync.classList.toggle("off", pending || offline);
    render();
    loadMissingEpisodes();
  }, err => {
    toast(`Couldn't load your shows (${err.code}).`);
  });
});
