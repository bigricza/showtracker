// Movie search: combines two free, keyless sources and ranks the results.
//   - iTunes Search (ZA and US stores): rich details and posters, but only movies you can buy or rent.
//   - Wikidata: almost every film, including new and upcoming releases, with prefix matching.
// GET /api/movies?q=practical  ->  { results: [...], sources: { itunes: "ok" | "error", wikidata: "ok" | "error" } }

const UA = "ShowTracker/1.0 (personal episode tracker; https://github.com/bigricza/showtracker)";
const TIMEOUT_MS = 6000;

// Wikidata classes that count as a movie (film, feature, animated, 3D, TV film, documentary, comedy, drama, horror…)
const FILM_CLASSES = new Set(["Q11424", "Q24869", "Q202866", "Q229390", "Q506240", "Q93204", "Q157443", "Q130232", "Q200092", "Q188473", "Q842256", "Q1054574", "Q2484376", "Q17013749"]);
const WD_STATEMENT = ["Q11424", "Q24869", "Q202866", "Q506240", "Q93204"].map(q => `P31=${q}`).join("|");

export const norm = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`);
  return r.json();
}

/* ---------- iTunes ---------- */
function fromItunes(m) {
  return {
    key: `itunes:${m.trackId}`,
    title: m.trackName,
    year: m.releaseDate ? Number(m.releaseDate.slice(0, 4)) : null,
    released: m.releaseDate ? m.releaseDate.slice(0, 10) : null,
    genre: m.primaryGenreName || null,
    runtime: m.trackTimeMillis ? Math.round(m.trackTimeMillis / 60000) : null,
    rating: m.contentAdvisoryRating || null,
    director: m.artistName || null,
    summary: (m.longDescription || m.shortDescription || "").slice(0, 1500),
    poster: m.artworkUrl100 ? m.artworkUrl100.replace(/\/\d+x\d+bb\./, "/400x600bb.") : null,
    storeUrl: m.trackViewUrl || null,
    source: "itunes"
  };
}

async function itunesSearch(term, country) {
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term, media: "movie", entity: "movie", country, limit: "25" })}`;
  const data = await getJSON(url);
  return (data.results || []).filter(m => m.trackId && m.trackName).map(fromItunes);
}

async function searchItunes(q) {
  const words = norm(q).split(" ").filter(Boolean);
  const terms = [q];
  // iTunes needs every word to match, so also try shorter versions of a multi-word query ("practical magic 2" -> "practical magic").
  if (words.length > 1) terms.push(words.slice(0, -1).join(" "));
  if (words.length > 2) terms.push(words.slice(0, 2).join(" "));
  const runs = await Promise.allSettled(terms.flatMap(t => [itunesSearch(t, "za"), itunesSearch(t, "us")]));
  if (runs.every(r => r.status === "rejected")) throw runs[0].reason;
  return runs.flatMap(r => r.status === "fulfilled" ? r.value : []);
}

/* ---------- Wikidata ---------- */
const WD = "https://www.wikidata.org/w/api.php";
const claimIds = (e, p) => (e.claims?.[p] || []).map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
const claimVal = (e, p) => (e.claims?.[p] || []).map(c => c.mainsnak?.datavalue?.value).find(Boolean);

function fromWikidata(e) {
  const title = e.labels?.en?.value;
  const desc = e.descriptions?.en?.value || "";
  const date = (e.claims?.P577 || []).map(c => c.mainsnak?.datavalue?.value?.time).filter(Boolean).sort()[0] || null;
  const year = date ? Number(date.slice(1, 5)) : (Number((desc.match(/\b(18|19|20)\d{2}\b/) || [])[0]) || null);
  const dur = claimVal(e, "P2047");
  const runtime = dur?.amount ? Math.round(Number(dur.amount) * (dur.unit?.endsWith("Q7727") ? 1 : dur.unit?.endsWith("Q25235") ? 60 : 1)) || null : null;
  const director = (desc.match(/(?:directed by|film by)\s+(.+)$/i) || [])[1] || null;
  const imdb = claimVal(e, "P345");
  return {
    key: `wikidata:${e.id}`,
    title,
    year,
    released: date && !date.includes("-00-") ? date.slice(1, 11) : null,
    genre: null,
    runtime,
    rating: null,
    director: director ? director.trim() : null,
    summary: desc ? desc.charAt(0).toUpperCase() + desc.slice(1) + "." : "",
    poster: null,
    storeUrl: typeof imdb === "string" && /^tt\d+$/.test(imdb) ? `https://www.imdb.com/title/${imdb}/` : `https://www.wikidata.org/wiki/${e.id}`,
    source: "wikidata"
  };
}

async function searchWikidata(q) {
  const base = { format: "json", formatversion: "2" };
  const [prefix, fulltext] = await Promise.allSettled([
    // Prefix match on titles and alternative titles, so "practi" finds "Practical Magic".
    getJSON(`${WD}?${new URLSearchParams({ ...base, action: "wbsearchentities", search: q, language: "en", uselang: "en", type: "item", limit: "50" })}`),
    // Word search restricted to films, so "magic" finds "Practical Magic" even when it's not the first word.
    getJSON(`${WD}?${new URLSearchParams({ ...base, action: "query", list: "search", srnamespace: "0", srlimit: "30", srsearch: `${q} haswbstatement:${WD_STATEMENT}` })}`)
  ]);
  if (prefix.status === "rejected" && fulltext.status === "rejected") throw prefix.reason;
  const ids = new Set();
  if (prefix.status === "fulfilled") (prefix.value.search || []).forEach(s => ids.add(s.id));
  if (fulltext.status === "fulfilled") (fulltext.value.query?.search || []).forEach(s => ids.add(s.title));
  const list = [...ids].filter(id => /^Q\d+$/.test(id)).slice(0, 50);
  if (!list.length) return [];
  const data = await getJSON(`${WD}?${new URLSearchParams({ format: "json", action: "wbgetentities", ids: list.join("|"), props: "labels|descriptions|claims", languages: "en" })}`);
  return list.map(id => data.entities?.[id])
    .filter(e => e && e.labels?.en?.value && claimIds(e, "P31").some(c => FILM_CLASSES.has(c)))
    .map(fromWikidata);
}

/* ---------- ranking ---------- */
export function score(m, q) {
  const t = norm(m.title), nq = norm(q);
  if (!t || !nq) return 0;
  const qWords = nq.split(" "), tWords = t.split(" ");
  let s = 0;
  if (t === nq) s = 100;
  else if (t.startsWith(nq)) s = 85;
  else if (qWords.every(w => tWords.some(tw => tw.startsWith(w)))) s = 70;
  else s = 40 * qWords.filter(w => tWords.some(tw => tw.startsWith(w))).length / qWords.length;
  if (m.source === "itunes") s += 4;       // richer details and a poster
  if (m.poster) s += 1;
  if (m.year) s += Math.min(3, Math.max(0, (m.year - 1990) / 12));   // nudge newer films up on ties
  return s;
}

export function mergeAndRank(lists, q, limit = 25) {
  const byKey = new Map();
  for (const m of lists.flat()) {
    if (!m?.title) continue;
    // Same title and year from different sources/stores = same movie; keep the first (iTunes lists come first).
    const k = `${norm(m.title)}|${m.year || ""}`;
    if (!byKey.has(k)) byKey.set(k, m);
  }
  return [...byKey.values()]
    .map(m => ({ m, s: score(m, q) }))
    .filter(x => x.s >= 15)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ m }) => m);
}

export default async function handler(req, res) {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: "Add a search term with ?q=" });

  const [it, wd] = await Promise.allSettled([searchItunes(q), searchWikidata(q)]);
  const sources = { itunes: it.status === "fulfilled" ? "ok" : "error", wikidata: wd.status === "fulfilled" ? "ok" : "error" };
  if (it.status === "rejected" && wd.status === "rejected") {
    return res.status(502).json({ error: "Movie search is unavailable right now.", sources });
  }
  const results = mergeAndRank([it.value || [], wd.value || []], q);
  res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
  return res.status(200).json({ results, sources });
}
