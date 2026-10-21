// Movie search: proxies the iTunes Search API (no key needed) and returns a trimmed list.
// GET /api/movies?q=dune  ->  { results: [{ key, title, year, released, genre, runtime, rating, director, summary, poster, storeUrl }] }
const STORE = "za";

export default async function handler(req, res) {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: "Add a search term with ?q=" });

  const url = `https://itunes.apple.com/search?${new URLSearchParams({
    term: q, media: "movie", entity: "movie", country: STORE, limit: "20"
  })}`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": "ShowTracker/1.0" } });
    if (!r.ok) return res.status(502).json({ error: `Movie search returned ${r.status}` });
    const data = await r.json();
    const seen = new Set();
    const results = (data.results || [])
      .filter(m => m.trackId && m.trackName && !seen.has(m.trackId) && seen.add(m.trackId))
      .map(m => ({
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
        storeUrl: m.trackViewUrl || null
      }));
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({ results });
  } catch (e) {
    return res.status(502).json({ error: "Movie search is unavailable right now." });
  }
}
