// Aggregations / analyses over normalized streams.
// Min play threshold: a play counts as "real" if ms_played >= 30000 (30s, Spotify's
// "stream" definition) OR reason_end indicates the song ended ("trackdone").

export const PLAY_THRESHOLD_MS = 30000;

export function isRealPlay(s) {
  return s.ms >= PLAY_THRESHOLD_MS || s.reasonEnd === 'trackdone';
}

export function isSkip(s) {
  if (s.skipped) return true;
  if (s.ms < 30000 && s.reasonEnd && s.reasonEnd !== 'trackdone') return true;
  return false;
}

export function summary(streams) {
  const out = {
    total: streams.length,
    plays: 0,
    skips: 0,
    msPlayed: 0,
    msSkipped: 0,
    msShuffle: 0,
    msOffline: 0,
    msIncognito: 0,
    uniqueTracks: 0,
    uniqueArtists: 0,
    uniqueAlbums: 0,
    firstTs: null,
    lastTs: null,
    countries: new Map(),
    platforms: new Map(),
  };
  const trackSet = new Set();
  const artistSet = new Set();
  const albumSet = new Set();
  for (const s of streams) {
    out.msPlayed += s.ms;
    if (s.shuffle) out.msShuffle += s.ms;
    if (s.offline) out.msOffline += s.ms;
    if (s.incognito) out.msIncognito += s.ms;
    if (isRealPlay(s)) {
      out.plays++;
      trackSet.add(s.tid || (s.artist+'\u0001'+s.track));
      if (s.artist) artistSet.add(s.artist);
      if (s.album) albumSet.add(s.artist+'\u0001'+s.album);
    } else if (isSkip(s)) {
      out.skips++; out.msSkipped += s.ms;
    }
    if (s.country) out.countries.set(s.country, (out.countries.get(s.country)||0)+1);
    if (s.platform) {
      const p = simplifyPlatform(s.platform);
      out.platforms.set(p, (out.platforms.get(p)||0)+s.ms);
    }
    if (!out.firstTs || s.ts < out.firstTs) out.firstTs = s.ts;
    if (!out.lastTs || s.ts > out.lastTs) out.lastTs = s.ts;
  }
  out.uniqueTracks = trackSet.size;
  out.uniqueArtists = artistSet.size;
  out.uniqueAlbums = albumSet.size;
  return out;
}

export function simplifyPlatform(p) {
  const s = p.toLowerCase();
  if (s.includes('ios')) return 'iOS';
  if (s.includes('android')) return 'Android';
  if (s.includes('os x') || s.includes('osx') || s.includes('macos') || s.includes('mac os')) return 'macOS';
  if (s.includes('windows')) return 'Windows';
  if (s.includes('linux')) return 'Linux';
  if (s.includes('web')) return 'Web';
  if (s.includes('partner')) return 'Partner';
  if (s.includes('cast')) return 'Cast';
  if (s.includes('speaker') || s.includes('sonos') || s.includes('alexa') || s.includes('echo')) return 'Speaker';
  return p.split(';')[0].slice(0,32);
}

// === group by helpers ===
function bucketKey(ts, granularity) {
  const d = new Date(ts);
  if (granularity === 'day') return d.toISOString().slice(0,10);
  if (granularity === 'month') return d.toISOString().slice(0,7);
  if (granularity === 'year') return d.toISOString().slice(0,4);
  if (granularity === 'week') {
    // ISO week start (Mon)
    const utc = new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 1 - day);
    return utc.toISOString().slice(0,10);
  }
  return '';
}

export function timeline(streams, granularity='month', mode='ms') {
  // returns sorted [{x: Date, y: number}]
  const m = new Map();
  for (const s of streams) {
    if (!isRealPlay(s)) continue;
    const k = bucketKey(s.ts, granularity);
    const v = mode === 'ms' ? s.ms : 1;
    m.set(k, (m.get(k)||0)+v);
  }
  // fill gaps
  if (m.size === 0) return [];
  const keys = [...m.keys()].sort();
  const out = [];
  if (granularity === 'month') {
    let [y0,mo0] = keys[0].split('-').map(Number);
    let [y1,mo1] = keys[keys.length-1].split('-').map(Number);
    let y=y0, mo=mo0;
    while (y < y1 || (y === y1 && mo <= mo1)) {
      const k = `${y}-${String(mo).padStart(2,'0')}`;
      out.push({x: new Date(Date.UTC(y, mo-1, 1)), y: m.get(k) || 0, _key: k});
      mo++; if (mo>12){mo=1;y++;}
    }
  } else if (granularity === 'year') {
    const y0 = +keys[0], y1 = +keys[keys.length-1];
    for (let y=y0;y<=y1;y++) out.push({x:new Date(Date.UTC(y,0,1)),y:m.get(String(y))||0,_key:String(y)});
  } else if (granularity === 'day') {
    let d = new Date(keys[0]+'T00:00:00Z');
    const last = new Date(keys[keys.length-1]+'T00:00:00Z');
    while (d <= last) {
      const k = d.toISOString().slice(0,10);
      out.push({x:new Date(d),y:m.get(k)||0,_key:k});
      d = new Date(d.getTime()+86400000);
    }
  } else if (granularity === 'week') {
    let d = new Date(keys[0]+'T00:00:00Z');
    const last = new Date(keys[keys.length-1]+'T00:00:00Z');
    while (d <= last) {
      const k = d.toISOString().slice(0,10);
      out.push({x:new Date(d),y:m.get(k)||0,_key:k});
      d = new Date(d.getTime()+7*86400000);
    }
  }
  return out;
}

export function topN(streams, keyFn, n=20, opts={}) {
  // returns [{key, label, ms, plays, skips, lastTs, firstTs, _ref}]
  const m = new Map();
  for (const s of streams) {
    const key = keyFn(s);
    if (!key) continue;
    let agg = m.get(key);
    if (!agg) { agg = { key, ms:0, plays:0, skips:0, firstTs:null, lastTs:null, _ref:s }; m.set(key, agg); }
    agg.ms += s.ms;
    if (isRealPlay(s)) agg.plays++;
    if (isSkip(s)) agg.skips++;
    if (!agg.firstTs || s.ts < agg.firstTs) agg.firstTs = s.ts;
    if (!agg.lastTs || s.ts > agg.lastTs) agg.lastTs = s.ts;
  }
  const arr = [...m.values()];
  arr.sort((a,b) => (opts.by === 'plays' ? b.plays-a.plays : b.ms-a.ms));
  return arr.slice(0,n);
}

export function hourDayMatrix(streams) {
  // 7 rows (Mon..Sun) × 24 cols. value = ms
  const v = Array.from({length:7},()=>Array(24).fill(0));
  for (const s of streams) {
    if (!isRealPlay(s)) continue;
    const d = new Date(s.ts);
    const dow = (d.getUTCDay()+6)%7; // Mon=0
    const h = d.getUTCHours();
    v[dow][h] += s.ms;
  }
  return v;
}

export function calendarMap(streams) {
  const m = new Map();
  let minY = Infinity, maxY = -Infinity;
  for (const s of streams) {
    if (!isRealPlay(s)) continue;
    const d = new Date(s.ts);
    const k = d.toISOString().slice(0,10);
    m.set(k, (m.get(k)||0) + s.ms);
    const y = d.getUTCFullYear();
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { map:m, minY: minY === Infinity ? null : minY, maxY: maxY === -Infinity ? null : maxY };
}

export function streaks(streams) {
  // returns longest listening streak (consecutive days with >=1 real play)
  const days = new Set();
  for (const s of streams) {
    if (!isRealPlay(s)) continue;
    days.add(new Date(s.ts).toISOString().slice(0,10));
  }
  const arr = [...days].sort();
  let best = 0, cur = 0, prev = null, bestStart = null, bestEnd = null, curStart = null;
  for (const d of arr) {
    const t = new Date(d+'T00:00:00Z').getTime();
    if (prev != null && t - prev === 86400000) { cur++; }
    else { cur = 1; curStart = d; }
    if (cur > best) { best = cur; bestStart = curStart; bestEnd = d; }
    prev = t;
  }
  return { longest: best, start: bestStart, end: bestEnd, totalActiveDays: arr.length };
}

export function hourHistogram(streams) {
  const h = Array(24).fill(0);
  for (const s of streams) {
    if (!isRealPlay(s)) continue;
    const d = new Date(s.ts);
    h[d.getUTCHours()] += s.ms;
  }
  return h;
}

export function dowHistogram(streams) {
  const d = Array(7).fill(0);
  for (const s of streams) {
    if (!isRealPlay(s)) continue;
    const dt = new Date(s.ts);
    d[(dt.getUTCDay()+6)%7] += s.ms;
  }
  return d;
}

export function reasonHistograms(streams) {
  const start = new Map(), end = new Map();
  for (const s of streams) {
    if (s.reasonStart) start.set(s.reasonStart, (start.get(s.reasonStart)||0)+1);
    if (s.reasonEnd) end.set(s.reasonEnd, (end.get(s.reasonEnd)||0)+1);
  }
  return { start, end };
}

// "Discovery" — count *new tracks* per month (first time the track appears).
export function discoveryTimeline(streams) {
  const seen = new Set();
  const by = new Map();
  // ensure chronological order
  const sorted = [...streams].sort((a,b)=>a.ts<b.ts?-1:1);
  for (const s of sorted) {
    if (!isRealPlay(s)) continue;
    const id = s.tid || (s.artist+'\u0001'+s.track);
    if (seen.has(id)) continue;
    seen.add(id);
    const k = s.ts.slice(0,7);
    by.set(k, (by.get(k)||0)+1);
  }
  return by;
}

export function newArtistsTimeline(streams) {
  const seen = new Set();
  const by = new Map();
  const sorted = [...streams].sort((a,b)=>a.ts<b.ts?-1:1);
  for (const s of sorted) {
    if (!isRealPlay(s)) continue;
    if (!s.artist) continue;
    if (seen.has(s.artist)) continue;
    seen.add(s.artist);
    const k = s.ts.slice(0,7);
    by.set(k, (by.get(k)||0)+1);
  }
  return by;
}

// For each month return shares of the top N artists (others bucketed)
export function topArtistShares(streams, topNCount=6) {
  const totals = new Map();
  for (const s of streams) {
    if (!isRealPlay(s) || !s.artist) continue;
    totals.set(s.artist, (totals.get(s.artist)||0)+s.ms);
  }
  const top = [...totals.entries()].sort((a,b)=>b[1]-a[1]).slice(0,topNCount).map(x=>x[0]);
  const topSet = new Set(top);

  const months = new Map();
  for (const s of streams) {
    if (!isRealPlay(s)) continue;
    const k = s.ts.slice(0,7);
    let row = months.get(k);
    if (!row) { row = Object.fromEntries(top.map(a=>[a,0])); row._other = 0; months.set(k,row); }
    if (s.artist && topSet.has(s.artist)) row[s.artist] += s.ms;
    else row._other += s.ms;
  }
  return { topArtists: top, monthMap: months };
}

// Yearly top 10 lists for "year-by-year" section
export function topByYear(streams, keyFn) {
  const years = new Map();
  for (const s of streams) {
    if (!isRealPlay(s)) continue;
    const y = s.ts.slice(0,4);
    let m = years.get(y);
    if (!m) { m = new Map(); years.set(y,m); }
    const k = keyFn(s);
    if (!k) continue;
    let agg = m.get(k);
    if (!agg) { agg = {key:k, ms:0, plays:0, _ref:s}; m.set(k,agg); }
    agg.ms += s.ms;
    agg.plays += 1;
  }
  const out = [];
  for (const [y,m] of [...years.entries()].sort()) {
    const arr = [...m.values()].sort((a,b)=>b.ms-a.ms);
    out.push({ year:y, items: arr.slice(0,10) });
  }
  return out;
}

// "Listening split" — derived percentages
export function splitMs(streams) {
  let shuffle=0, normal=0, skipped=0, real=0;
  for (const s of streams) {
    if (s.shuffle) shuffle += s.ms; else normal += s.ms;
    if (isSkip(s)) skipped += s.ms;
    if (isRealPlay(s)) real += s.ms;
  }
  return { shuffle, normal, skipped, real };
}

// === ENRICHED INSIGHTS ===
// requires tracks (Map id -> meta) and artists (Map id -> meta)
export function genreTotals(streams, tracks, artists) {
  const m = new Map();
  for (const s of streams) {
    if (!isRealPlay(s) || !s.tid) continue;
    const t = tracks.get(s.tid);
    if (!t) continue;
    const aIds = t.artistIds || [];
    const seenG = new Set();
    for (const aid of aIds) {
      const a = artists.get(aid);
      if (!a || !a.genres) continue;
      for (const g of a.genres) {
        if (seenG.has(g)) continue;
        seenG.add(g);
        m.set(g, (m.get(g)||0)+s.ms);
      }
    }
  }
  return m;
}

export function audioFeatureWeighted(streams, tracks) {
  // weighted average of audio features by ms
  const F = ['energy','valence','danceability','acousticness','instrumentalness','liveness','speechiness'];
  const sums = Object.fromEntries(F.map(f=>[f,0]));
  let totalMs = 0;
  for (const s of streams) {
    if (!isRealPlay(s) || !s.tid) continue;
    const t = tracks.get(s.tid);
    if (!t || t.energy == null) continue;
    for (const f of F) sums[f] += (t[f] || 0) * s.ms;
    totalMs += s.ms;
  }
  if (!totalMs) return null;
  const out = {};
  for (const f of F) out[f] = sums[f]/totalMs;
  out._totalMs = totalMs;
  return out;
}

export function audioFeatureByMonth(streams, tracks, feature='valence') {
  const sums = new Map(), weights = new Map();
  for (const s of streams) {
    if (!isRealPlay(s) || !s.tid) continue;
    const t = tracks.get(s.tid);
    if (!t || t[feature] == null) continue;
    const k = s.ts.slice(0,7);
    sums.set(k,(sums.get(k)||0)+t[feature]*s.ms);
    weights.set(k,(weights.get(k)||0)+s.ms);
  }
  const out = [];
  for (const [k,w] of [...weights.entries()].sort()) {
    out.push({ x: new Date(k+'-01T00:00:00Z'), y: (sums.get(k)/w) });
  }
  return out;
}

// release year of music listened to (taste vintage)
export function releaseYearHistogram(streams, tracks) {
  const m = new Map();
  for (const s of streams) {
    if (!isRealPlay(s) || !s.tid) continue;
    const t = tracks.get(s.tid);
    if (!t || !t.releaseDate) continue;
    const y = +t.releaseDate.slice(0,4);
    if (!y) continue;
    m.set(y, (m.get(y)||0)+s.ms);
  }
  return m;
}

export function popularityHistogram(streams, tracks) {
  const buckets = Array(10).fill(0); // 0-9, 10-19, ..., 90-99
  for (const s of streams) {
    if (!isRealPlay(s) || !s.tid) continue;
    const t = tracks.get(s.tid);
    if (!t || t.popularity == null) continue;
    const b = Math.min(9, Math.floor(t.popularity/10));
    buckets[b] += s.ms;
  }
  return buckets;
}
