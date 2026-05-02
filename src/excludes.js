// Track-exclusion list: which streams are removed from analytics.
// Stored in the `meta` store as an array of stream "track keys"
// (tid if available, otherwise `${artist}\u0001${track}`) — same
// convention used by the topN/insights aggregations.

import { getMeta, setMeta } from './store.js';

const KEY = 'excluded_tracks';

let cached = null;

export function trackKey(s) {
  return s.tid || (s.artist + '\u0001' + s.track);
}

export async function loadExcluded() {
  if (cached) return cached;
  const arr = (await getMeta(KEY)) || [];
  cached = new Set(arr);
  return cached;
}

export async function saveExcluded(set) {
  cached = set;
  await setMeta(KEY, [...set]);
}

export async function setExcluded(key, on) {
  const set = await loadExcluded();
  if (on) set.add(key); else set.delete(key);
  await saveExcluded(set);
  return set;
}

export async function clearExcluded() {
  cached = new Set();
  await setMeta(KEY, []);
  return cached;
}

export function isExcluded(set, s) {
  return set.has(trackKey(s));
}

// Filter an array of streams using the cached exclusion set.
export function applyExclusions(streams, set) {
  if (!set || set.size === 0) return streams;
  const out = [];
  for (const s of streams) {
    if (!set.has(trackKey(s))) out.push(s);
  }
  return out;
}

// Get current cached set synchronously (assumes loadExcluded() was awaited).
export function currentSet() {
  return cached || new Set();
}
