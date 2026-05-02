// Tiny IndexedDB wrapper. Stores raw streams + per-track enrichment.
const DB_NAME = 'shx';
const DB_VERSION = 1;
const STREAM_CHUNK = 5000;

let _dbPromise = null;

function open() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('streams')) {
        // key = ts + '|' + (uri||name) -- composite unique key for de-dupe
        db.createObjectStore('streams', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('artists')) {
        db.createObjectStore('artists', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
    req.onerror = () => { _dbPromise = null; reject(req.error); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); _dbPromise = null; };
      resolve(db);
    };
  });
  return _dbPromise;
}

// Run a transaction. `fn(t)` should return a Promise that resolves with the
// result; the result is returned from `tx` only after the transaction itself
// commits (oncomplete). On error/abort, tx rejects with the underlying error.
async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(stores, mode); }
    catch (e) { return reject(e); }
    let result;
    let settled = false;
    const settle = (kind, val) => {
      if (settled) return;
      settled = true;
      if (kind === 'ok') resolve(val); else reject(val);
    };
    t.oncomplete = () => settle('ok', result);
    t.onerror = () => settle('err', t.error || new Error('transaction error'));
    t.onabort = () => settle('err', t.error || new Error('transaction aborted'));
    Promise.resolve()
      .then(() => fn(t))
      .then(r => { result = r; })
      .catch(err => {
        try { t.abort(); } catch {}
        settle('err', err);
      });
  });
}

// Batch-add an array of items. Returns the number actually inserted (i.e.,
// excluding duplicates rejected by the unique keyPath constraint).
function addBatch(store, items) {
  return new Promise((resolve, reject) => {
    let added = 0;
    let pending = items.length;
    if (!pending) return resolve(0);
    for (const item of items) {
      let req;
      try { req = store.add(item); }
      catch (e) { return reject(e); }
      req.onsuccess = () => { added++; if (--pending === 0) resolve(added); };
      req.onerror = (e) => {
        // duplicate key -> fine, swallow so the transaction does not abort
        if (req.error && req.error.name === 'ConstraintError') {
          e.preventDefault();
          e.stopPropagation();
          if (--pending === 0) resolve(added);
        } else {
          reject(req.error || new Error('add failed'));
        }
      };
    }
  });
}

export async function putStreams(streams) {
  if (!streams || !streams.length) return 0;
  let added = 0;
  for (let i = 0; i < streams.length; i += STREAM_CHUNK) {
    const slice = streams.slice(i, i + STREAM_CHUNK);
    added += await tx(['streams'], 'readwrite', async t => {
      return addBatch(t.objectStore('streams'), slice);
    });
  }
  return added;
}

export async function getAllStreams() {
  return tx(['streams'], 'readonly', t => new Promise((resolve, reject) => {
    const r = t.objectStore('streams').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export async function streamCount() {
  return tx(['streams'], 'readonly', t => new Promise((resolve, reject) => {
    const r = t.objectStore('streams').count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export async function rememberFile(name) {
  return tx(['files'], 'readwrite', t => new Promise((resolve, reject) => {
    const r = t.objectStore('files').put({ name, ts: Date.now() });
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}

export async function listFiles() {
  return tx(['files'], 'readonly', t => new Promise((resolve, reject) => {
    const r = t.objectStore('files').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export async function putTracks(tracks) {
  if (!tracks.length) return;
  await tx(['tracks'], 'readwrite', t => {
    const s = t.objectStore('tracks');
    for (const tr of tracks) s.put(tr);
  });
}
export async function getTracks() {
  return tx(['tracks'], 'readonly', t => new Promise((resolve, reject) => {
    const r = t.objectStore('tracks').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export async function putArtists(artists) {
  if (!artists.length) return;
  await tx(['artists'], 'readwrite', t => {
    const s = t.objectStore('artists');
    for (const a of artists) s.put(a);
  });
}
export async function getArtists() {
  return tx(['artists'], 'readonly', t => new Promise((resolve, reject) => {
    const r = t.objectStore('artists').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export async function setMeta(k, v) {
  return tx(['meta'], 'readwrite', t => new Promise((resolve, reject) => {
    const r = t.objectStore('meta').put({ k, v });
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}
export async function getMeta(k) {
  return tx(['meta'], 'readonly', t => new Promise((resolve, reject) => {
    const r = t.objectStore('meta').get(k);
    r.onsuccess = () => resolve(r.result ? r.result.v : undefined);
    r.onerror = () => reject(r.error);
  }));
}

export async function clearAll() {
  return tx(['streams','files','tracks','artists','meta'], 'readwrite', t => {
    for (const s of ['streams','files','tracks','artists','meta']) t.objectStore(s).clear();
  });
}
