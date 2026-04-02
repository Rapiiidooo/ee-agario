// Fetch identity images and bake them into a seed SQLite DB
import Database from 'better-sqlite3';

const db = new Database('/app/identities-seed.db');
db.exec(`CREATE TABLE IF NOT EXISTS identity_images (
  hash TEXT PRIMARY KEY, name TEXT NOT NULL,
  content_type TEXT NOT NULL, data BLOB NOT NULL,
  fetched_at TEXT DEFAULT (datetime('now'))
)`);
const upsert = db.prepare('INSERT OR REPLACE INTO identity_images (hash, name, content_type, data) VALUES (?, ?, ?, ?)');

const seen = new Set();
let count = 0;

for (const url of ['https://api.taoswap.org/identities/', 'https://api.taoswap.org/subnets/']) {
  try {
    const res = await fetch(url);
    const data = await res.json();
    const entries = url.includes('subnets')
      ? Object.values(data.results || data)
          .filter(s => s.identity?.image && s.identity.image !== '-' && s.identity.image.startsWith('http'))
          .map(s => ({ name: s.identity.name || s.name, image: s.identity.image }))
      : Object.values(data.results || data)
          .filter(e => e.name && e.name !== '-' && e.name !== 'N/A' && e.image && e.image !== '-' && e.image !== '' && !e.image.includes('N/A') && e.image.startsWith('http'))
          .map(e => ({ name: e.name, image: e.image }));

    for (const e of entries) {
      if (seen.has(e.image)) continue;
      seen.add(e.image);
      try {
        const r = await fetch(e.image, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const ct = r.headers.get('content-type') || 'image/png';
        const buf = Buffer.from(await r.arrayBuffer());
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
          .map(b => b.toString(16).padStart(2, '0')).join('');
        upsert.run(hash, e.name, ct, buf);
        count++;
      } catch (_) {}
    }
  } catch (_) {}
}

db.close();
console.log(`Baked ${count} identity images into seed DB`);
