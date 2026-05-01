// Tiny IndexedDB wrapper. Stores raw streams + per-track enrichment.
const DB_NAME = 'shx';
const DB_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
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
        // key = spotify track id
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('artists')) {
        db.createObjectStore('artists', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    Promise.resolve(fn(t)).then(r => { result = r; }).catch(reject);
  });
}

export async function putStreams(streams) {
  if (!streams.length) return 0;
  let added = 0;
  await tx(['streams'], 'readwrite', t => {
    const s = t.objectStore('streams');
    return new Promise((resolve, reject) => {
      let i = 0;
      function next() {
        if (i >= streams.length) return resolve();
        const item = streams[i++];
        const r = s.add(item);
        r.onsuccess = () => { added++; next(); };
        r.onerror = (e) => {
          // ConstraintError = duplicate key, that's fine
          if (r.error && r.error.name === 'ConstraintError') {
            e.preventDefault(); next();
          } else reject(r.error);
        };
      }
      next();
    });
  });
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
