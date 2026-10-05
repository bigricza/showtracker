// Writes public/config.js from environment variables at build time (Vercel runs this).
// SUPABASE_URL and SUPABASE_KEY are the project URL and its publishable (anon) key.
// Both are safe in a browser; access is controlled by row-level security in the database.
import { writeFileSync } from "node:fs";

const { SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_KEY before building.");
  process.exit(1);
}
writeFileSync(
  new URL("../public/config.js", import.meta.url),
  `export const SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};\nexport const SUPABASE_KEY = ${JSON.stringify(SUPABASE_KEY)};\n`
);
console.log("Wrote public/config.js");
