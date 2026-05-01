// Parses Spotify Extended Streaming History JSON files.
// Discards podcast/video entries and produces a normalized stream record.

export function trackIdFromUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const m = uri.match(/^spotify:track:([A-Za-z0-9]+)$/);
  return m ? m[1] : null;
}

export function normalizeStream(r) {
  // Skip non-music: podcasts, audiobooks, video — we only want music tracks.
  // Music entries have master_metadata_track_name set.
  const trackName = r.master_metadata_track_name;
  if (!trackName) return null;
  const artist = r.master_metadata_album_artist_name || '';
  const album = r.master_metadata_album_album_name || '';
  const uri = r.spotify_track_uri || null;
  const tid = trackIdFromUri(uri);
  const ts = r.ts;
  const ms = +r.ms_played || 0;
  if (!ts) return null;
  // composite key for de-dupe — exact same ts + track is the same play
  const k = `${ts}|${tid || (artist + '\u0001' + trackName)}`;
  return {
    k,
    ts,
    ms,
    tid,
    track: trackName,
    artist,
    album,
    platform: r.platform || '',
    country: r.conn_country || '',
    reasonStart: r.reason_start || '',
    reasonEnd: r.reason_end || '',
    shuffle: !!r.shuffle,
    skipped: !!r.skipped,
    offline: !!r.offline,
    incognito: !!r.incognito_mode,
  };
}

export async function parseFile(file) {
  const text = await file.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error(`${file.name}: invalid JSON`); }
  if (!Array.isArray(json)) throw new Error(`${file.name}: expected an array`);
  const out = [];
  for (const r of json) {
    const n = normalizeStream(r);
    if (n) out.push(n);
  }
  return out;
}

// Parse the year range from a typical filename:
//   Streaming_History_Audio_2018-2019_3.json
//   Streaming_History_Audio_2020_1.json
export function parseFilename(name) {
  const m = name.match(/Streaming_History_(Audio|Video)_(\d{4})(?:-(\d{4}))?_(\d+)\.json$/i);
  if (!m) return null;
  return {
    kind: m[1].toLowerCase(),
    yearFrom: +m[2],
    yearTo: m[3] ? +m[3] : +m[2],
    index: +m[4],
  };
}
