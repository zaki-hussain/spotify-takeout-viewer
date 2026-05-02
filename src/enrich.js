// Spotify Web API enrichment via PKCE OAuth.
// Privacy: PKCE is implicit-grant's modern replacement; no client secret needed.
// All requests are made directly from the browser; tokens never leave it.
//
// Scopes required: none for /tracks, /artists, /audio-features (public catalog endpoints)
// require an access token but no scopes.

import { getMeta, setMeta, putTracks, putArtists, getTracks, getArtists } from './store.js';

const TOKEN_KEY = 'spotify_token';
const PKCE_KEY = 'spotify_pkce';
const CLIENT_KEY = 'spotify_client_id';

export function redirectUri() {
  // Use exact current page URL (no hash, no search) as redirect URI.
  const u = new URL(location.href);
  u.hash = ''; u.search = '';
  return u.toString();
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return new Uint8Array(buf);
}

function randomString(len=64) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return b64url(arr);
}

export async function startAuth(clientId) {
  await setMeta(CLIENT_KEY, clientId);
  const verifier = randomString(64);
  const challenge = b64url(await sha256(verifier));
  const state = randomString(16);
  await setMeta(PKCE_KEY, { verifier, state, redirect: redirectUri() });
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', '');
  location.assign(url.toString());
}

export async function handleAuthRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return null;
  const pkce = await getMeta(PKCE_KEY);
  const clientId = await getMeta(CLIENT_KEY);
  // Strip query so a refresh doesn't reuse the code
  history.replaceState({}, '', location.pathname);
  if (params.get('error')) return { error: params.get('error') };
  if (!pkce || !clientId) return { error: 'missing_pkce_state' };
  if (params.get('state') !== pkce.state) return { error: 'state_mismatch' };
  const code = params.get('code');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pkce.redirect,
    client_id: clientId,
    code_verifier: pkce.verifier,
  });
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {'Content-Type':'application/x-www-form-urlencoded'},
    body
  });
  if (!r.ok) return { error: 'token_exchange_failed:' + r.status };
  const data = await r.json();
  data._fetched = Date.now();
  await setMeta(TOKEN_KEY, data);
  return { ok: true };
}

async function getValidToken() {
  const tok = await getMeta(TOKEN_KEY);
  if (!tok) return null;
  const exp = (tok._fetched || 0) + (tok.expires_in || 3600)*1000 - 60_000;
  if (Date.now() < exp && tok.access_token) return tok.access_token;
  // refresh
  if (!tok.refresh_token) return null;
  const clientId = await getMeta(CLIENT_KEY);
  const body = new URLSearchParams({
    grant_type:'refresh_token',
    refresh_token: tok.refresh_token,
    client_id: clientId,
  });
  const r = await fetch('https://accounts.spotify.com/api/token',{
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body
  });
  if (!r.ok) return null;
  const data = await r.json();
  data.refresh_token = data.refresh_token || tok.refresh_token;
  data._fetched = Date.now();
  await setMeta(TOKEN_KEY, data);
  return data.access_token;
}

export async function isConnected() {
  const tok = await getMeta(TOKEN_KEY);
  return !!(tok && tok.access_token);
}

async function api(path, token) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch('https://api.spotify.com/v1' + path, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (r.status === 429) {
      const wait = (+r.headers.get('Retry-After') || 1) * 1000;
      await sleep(wait);
      continue;
    }
    if (r.status === 401) throw new Error('unauthorized');
    if (!r.ok) {
      if (r.status >= 500) { await sleep(1000 * (attempt+1)); continue; }
      throw new Error('api ' + r.status + ' ' + path);
    }
    return r.json();
  }
  throw new Error('rate_limited');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function chunk(arr, n) {
  const out = [];
  for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n));
  return out;
}

// Enrich a list of track ids. Calls onProgress(done, total, label).
export async function enrichTracks(trackIds, onProgress=()=>{}) {
  const token = await getValidToken();
  if (!token) throw new Error('not connected');

  // Skip already-known
  const existing = new Map((await getTracks()).map(t => [t.id, t]));
  const need = trackIds.filter(id => !existing.has(id) || existing.get(id).energy == null);
  const total = need.length;
  if (!total) {
    onProgress(0, 0, 'nothing to do');
    return { tracks: existing.size, fetched: 0 };
  }

  // 1) /tracks (50/req) → get name, album, release_date, popularity, artist ids
  const trackBatches = chunk(need, 50);
  let done = 0;
  const tracksOut = [];
  const artistIdSet = new Set();
  for (const b of trackBatches) {
    const data = await api('/tracks?ids=' + b.join(','), token);
    for (const t of data.tracks || []) {
      if (!t) continue;
      const rec = {
        id: t.id,
        name: t.name,
        album: t.album?.name || '',
        albumId: t.album?.id || '',
        releaseDate: t.album?.release_date || '',
        durationMs: t.duration_ms,
        popularity: t.popularity ?? null,
        explicit: !!t.explicit,
        artistIds: (t.artists||[]).map(a=>a.id).filter(Boolean),
        artistNames: (t.artists||[]).map(a=>a.name),
        isrc: t.external_ids?.isrc || '',
      };
      tracksOut.push(rec);
      for (const aid of rec.artistIds) artistIdSet.add(aid);
    }
    done += b.length;
    onProgress(done, total, 'tracks');
  }

  // 2) /audio-features (100/req)
  const afBatches = chunk(need, 100);
  let afDone = 0;
  const afMap = new Map();
  for (const b of afBatches) {
    let data;
    try { data = await api('/audio-features?ids=' + b.join(','), token); }
    catch(e){ data = { audio_features: [] }; }
    for (const f of data.audio_features || []) {
      if (!f || !f.id) continue;
      afMap.set(f.id, {
        energy: f.energy, valence: f.valence, danceability: f.danceability,
        tempo: f.tempo, key: f.key, mode: f.mode, loudness: f.loudness,
        acousticness: f.acousticness, instrumentalness: f.instrumentalness,
        liveness: f.liveness, speechiness: f.speechiness,
        timeSignature: f.time_signature,
      });
    }
    afDone += b.length;
    onProgress(afDone, total, 'audio features');
  }
  for (const t of tracksOut) {
    const f = afMap.get(t.id);
    if (f) Object.assign(t, f);
  }
  await putTracks(tracksOut);

  // 3) /artists (50/req) for genres
  const haveArtists = new Set((await getArtists()).map(a => a.id));
  const needArtists = [...artistIdSet].filter(id => !haveArtists.has(id));
  const artistBatches = chunk(needArtists, 50);
  let aDone = 0;
  const artistsOut = [];
  for (const b of artistBatches) {
    const data = await api('/artists?ids=' + b.join(','), token);
    for (const a of data.artists || []) {
      if (!a) continue;
      artistsOut.push({
        id: a.id,
        name: a.name,
        genres: a.genres || [],
        popularity: a.popularity ?? null,
        followers: a.followers?.total ?? null,
      });
    }
    aDone += b.length;
    onProgress(aDone, needArtists.length, 'artists');
  }
  await putArtists(artistsOut);

  return { tracks: tracksOut.length, artists: artistsOut.length };
}

export async function disconnect() {
  await setMeta(TOKEN_KEY, null);
}

// === CSV (Exportify) fallback ===
// minimal CSV parser tolerant of quoted commas
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inq = false;
  for (let i=0;i<text.length;i++) {
    const c = text[i];
    if (inq) {
      if (c === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inq = false;
      else cur += c;
    } else {
      if (c === '"') inq = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); cur=''; rows.push(row); row=[]; }
      else if (c === '\r') {/*skip*/}
      else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows.shift().map(h => h.trim());
  return { headers, rows };
}

// Take a CSV (Exportify-style) and merge into local tracks store.
export async function importCsv(text) {
  const { headers, rows } = parseCsv(text);
  const idx = name => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const fcol = name => { const i = idx(name); return i >= 0 ? r => r[i] : () => ''; };
  const get = {
    spotifyId: fcol('Spotify ID'),
    track: fcol('Track Name'),
    album: fcol('Album Name'),
    artistNames: fcol('Artist Name(s)'),
    artistIds: fcol('Artist IDs'),
    releaseDate: fcol('Release Date'),
    durationMs: fcol('Duration (ms)'),
    popularity: fcol('Popularity'),
    genres: fcol('Genres'),
    danceability: fcol('Danceability'),
    energy: fcol('Energy'),
    key: fcol('Key'),
    loudness: fcol('Loudness'),
    mode: fcol('Mode'),
    speechiness: fcol('Speechiness'),
    acousticness: fcol('Acousticness'),
    instrumentalness: fcol('Instrumentalness'),
    liveness: fcol('Liveness'),
    valence: fcol('Valence'),
    tempo: fcol('Tempo'),
    timeSignature: fcol('Time Signature'),
  };

  const tracks = [];
  const artistGenreMap = new Map(); // artistId -> Set of genres
  for (const r of rows) {
    const id = get.spotifyId(r);
    if (!id) continue;
    const artistIds = (get.artistIds(r) || '').split(',').map(s=>s.trim()).filter(Boolean);
    const genres = (get.genres(r) || '').split(',').map(s=>s.trim()).filter(Boolean);
    const t = {
      id,
      name: get.track(r),
      album: get.album(r),
      artistNames: (get.artistNames(r) || '').split(',').map(s=>s.trim()),
      artistIds,
      releaseDate: get.releaseDate(r),
      durationMs: +get.durationMs(r) || null,
      popularity: +get.popularity(r) || null,
      danceability: +get.danceability(r) || null,
      energy: +get.energy(r) || null,
      key: +get.key(r),
      loudness: +get.loudness(r),
      mode: +get.mode(r),
      speechiness: +get.speechiness(r),
      acousticness: +get.acousticness(r),
      instrumentalness: +get.instrumentalness(r),
      liveness: +get.liveness(r),
      valence: +get.valence(r),
      tempo: +get.tempo(r),
      timeSignature: +get.timeSignature(r),
      _csvGenres: genres,
    };
    // Genres in Exportify CSV are aggregated from the artists; attribute to first artist if available.
    if (artistIds[0]) {
      const set = artistGenreMap.get(artistIds[0]) || new Set();
      for (const g of genres) set.add(g);
      artistGenreMap.set(artistIds[0], set);
    }
    tracks.push(t);
  }
  await putTracks(tracks);
  // synthesize minimal artist records for genre lookups
  const existingArtists = new Map((await getArtists()).map(a=>[a.id,a]));
  const artistRecs = [];
  for (const [aid, gset] of artistGenreMap) {
    const ex = existingArtists.get(aid);
    artistRecs.push({
      id: aid,
      name: ex?.name || '',
      genres: ex?.genres?.length ? ex.genres : [...gset],
      popularity: ex?.popularity ?? null,
      followers: ex?.followers ?? null,
    });
  }
  await putArtists(artistRecs);
  return { tracks: tracks.length, artists: artistRecs.length };
}
