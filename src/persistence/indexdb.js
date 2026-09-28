const DB_NAME = 'smart-trader-v1';
const DB_VERSION = 2;

let _db = null;
let _opening = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;
  _opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('events')) {
        const st = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        st.createIndex('ts', 'ts', { unique: false });
        st.createIndex('type', 'type', { unique: false });
      }
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('candles')) {
        const st = db.createObjectStore('candles', { keyPath: 'id' });
        st.createIndex('symInt', ['exchange', 'symbol', 'interval', 'openTime'], { unique: true });
      }
      if (!db.objectStoreNames.contains('trades')) {
        const st = db.createObjectStore('trades', { keyPath: 'id' });
        st.createIndex('ts', 'ts', { unique: false });
        st.createIndex('sym', 'sym', { unique: false });
      }
      if (!db.objectStoreNames.contains('reconcile')) {
        const st = db.createObjectStore('reconcile', { keyPath: 'id' });
        st.createIndex('ts', 'ts', { unique: false });
        st.createIndex('kind', 'kind', { unique: false });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => _db.close();
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
  return _opening;
}

function tx(store, mode) {
  return openDB().then((db) => {
    const t = db.transaction(store, mode);
    return { t, s: t.objectStore(store) };
  });
}

function reqToPromise(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function put(store, value) {
  const { t, s } = await tx(store, 'readwrite');
  const p = reqToPromise(s.put(value));
  return Promise.all([p, txDone(t)]).then(() => value);
}

export async function add(store, value) {
  const { t, s } = await tx(store, 'readwrite');
  const p = reqToPromise(s.add(value));
  return Promise.all([p, txDone(t)]).then(() => value);
}

export async function get(store, key) {
  const { t, s } = await tx(store, 'readonly');
  return Promise.all([reqToPromise(s.get(key)), txDone(t)]).then(([r]) => r);
}

export async function getAll(store, limit = 1000) {
  const { t, s } = await tx(store, 'readonly');
  const r = reqToPromise(s.getAll(null, limit));
  return Promise.all([r, txDone(t)]).then(([res]) => res);
}

export async function count(store) {
  const { t, s } = await tx(store, 'readonly');
  return Promise.all([reqToPromise(s.count()), txDone(t)]).then(([r]) => r);
}

export async function clearStore(store) {
  const { t, s } = await tx(store, 'readwrite');
  return Promise.all([reqToPromise(s.clear()), txDone(t)]).then(() => true);
}

export async function del(store, key) {
  const { t, s } = await tx(store, 'readwrite');
  return Promise.all([reqToPromise(s.delete(key)), txDone(t)]).then(() => true);
}

export function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function db() {
  return openDB();
}

export { openDB };
