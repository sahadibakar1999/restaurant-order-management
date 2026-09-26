// Shared state for serverless hosting. On Vercel each request can land on a
// different function instance, so orders, tables, chat sessions and live
// events are kept in a shared database instead of local files:
//   - Turso (libSQL):  TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
//   - Upstash Redis:   KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*)
//
// Every order / table / menu item / chat session is stored as its own row.
// State is loaded at the start of a request; before the response is sent only
// the rows that changed are written. Two requests changing different orders
// at the same time therefore never overwrite each other.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const backendName = TURSO_URL && TURSO_TOKEN ? 'turso' : (REDIS_URL && REDIS_TOKEN ? 'redis' : null);
const enabled = Boolean(backendName);

// How each collection is split into rows
const COLLECTIONS = {
  menu: { type: 'list', key: item => item.id },
  tables: { type: 'list', key: table => String(table.number) },
  orders: { type: 'list', key: order => order.id },
  settings: { type: 'object' },            // one row
  sessions: { type: 'map' }                // one row per chat session
};
const SEEDED = ['menu', 'tables', 'orders', 'settings'];
const MAX_EVENTS = 200;
const EVENT_WINDOW_MS = 15 * 60 * 1000;

// One function instance serves several requests at once, so each request
// gets its own copy of the state (AsyncLocalStorage), never shared globals.
const requestContext = new AsyncLocalStorage();
function ctx() {
  const c = requestContext.getStore();
  if (!c) throw new Error('sharedStore used outside a request');
  return c;
}

// ---------- rows <-> collections ----------

function toRows(name, data) {
  const spec = COLLECTIONS[name];
  const rows = new Map();
  if (spec.type === 'list') data.forEach(item => rows.set(String(spec.key(item)), JSON.stringify(item)));
  else if (spec.type === 'map') Object.entries(data || {}).forEach(([id, v]) => rows.set(id, JSON.stringify(v)));
  else rows.set('_', JSON.stringify(data));
  return rows;
}

function numericSuffix(id) {
  const m = String(id).match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function fromRows(name, rows) {
  const spec = COLLECTIONS[name];
  if (spec.type === 'object') return rows.has('_') ? JSON.parse(rows.get('_')) : {};
  if (spec.type === 'map') {
    const out = {};
    rows.forEach((v, id) => { out[id] = JSON.parse(v); });
    return out;
  }
  const list = [...rows.values()].map(v => JSON.parse(v));
  if (name === 'orders') list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (name === 'tables') list.sort((a, b) => Number(a.number) - Number(b.number));
  if (name === 'menu') list.sort((a, b) => numericSuffix(a.id) - numericSuffix(b.id));
  return list;
}

function seed(name) {
  const file = path.join(__dirname, '..', 'data', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// ---------- backends ----------
// load() -> { rows: {collection: Map(id -> json)}, seeded: Set, legacy: {name: json}, events }
// save(upserts [[collection, id, json]], deletes [[collection, id]], seededNow [names], events)

const redisBackend = {
  async call(commands) {
    const res = await fetch(`${REDIS_URL.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands)
    });
    if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
    const results = await res.json();
    const failed = results.find(r => r.error);
    if (failed) throw new Error(`Redis error: ${failed.error}`);
    return results.map(r => r.result);
  },
  async load() {
    const names = Object.keys(COLLECTIONS);
    const results = await this.call([
      ...names.map(n => ['HGETALL', `rom:c:${n}`]),
      ['SMEMBERS', 'rom:seeded'],
      ['MGET', ...SEEDED.map(n => `rom:${n}`)],   // data saved before row storage, migrated once
      ['LRANGE', 'rom:events', 0, -1]
    ]);
    const rows = {};
    names.forEach((n, i) => {
      const flat = results[i] || [];
      const m = new Map();
      for (let j = 0; j < flat.length; j += 2) m.set(flat[j], flat[j + 1]);
      rows[n] = m;
    });
    const legacy = {};
    SEEDED.forEach((n, i) => { if (results[names.length + 1][i]) legacy[n] = results[names.length + 1][i]; });
    return {
      rows,
      seeded: new Set(results[names.length] || []),
      legacy,
      events: (results[names.length + 2] || []).map(e => JSON.parse(e)).filter(e => e.time > Date.now() - EVENT_WINDOW_MS)
    };
  },
  async save(upserts, deletes, seededList, events) {
    const commands = [];
    upserts.forEach(([c, id, v]) => commands.push(['HSET', `rom:c:${c}`, id, v]));
    deletes.forEach(([c, id]) => commands.push(['HDEL', `rom:c:${c}`, id]));
    if (seededList.length) commands.push(['SADD', 'rom:seeded', ...seededList]);
    events.forEach(e => commands.push(['RPUSH', 'rom:events', JSON.stringify(e)]));
    if (events.length) commands.push(['LTRIM', 'rom:events', -MAX_EVENTS, -1]);
    if (commands.length) await this.call(commands);
  }
};

const tursoBackend = {
  client: null,
  ready: null,
  async init() {
    if (!this.client) {
      // web client (plain fetch) for hosted Turso; the Node client only for local file: databases
      const { createClient } = TURSO_URL.startsWith('file:') ? require('@libsql/client') : require('@libsql/client/web');
      this.client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
    }
    if (!this.ready) {
      this.ready = this.client.batch([
        'CREATE TABLE IF NOT EXISTS rows (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, id))',
        'CREATE TABLE IF NOT EXISTS seeded (collection TEXT PRIMARY KEY)',
        'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, event TEXT NOT NULL, data TEXT, time INTEGER NOT NULL)',
        'CREATE INDEX IF NOT EXISTS events_time ON events(time)'
      ], 'write').catch(err => { this.ready = null; throw err; });
    }
    await this.ready;
  },
  async load() {
    await this.init();
    const [rowsRes, seededRes, legacyRes, eventsRes] = await this.client.batch([
      'SELECT collection, id, value FROM rows',
      'SELECT collection FROM seeded',
      { sql: `SELECT key, value FROM kv WHERE key IN (${SEEDED.map(() => '?').join(',')})`, args: SEEDED },
      { sql: 'SELECT id, event, data, time FROM events WHERE time > ? ORDER BY id LIMIT ?', args: [Date.now() - EVENT_WINDOW_MS, MAX_EVENTS] }
    ], 'read');
    const rows = {};
    Object.keys(COLLECTIONS).forEach(n => { rows[n] = new Map(); });
    rowsRes.rows.forEach(r => { if (rows[r.collection]) rows[r.collection].set(r.id, r.value); });
    const legacy = {};
    legacyRes.rows.forEach(r => { legacy[r.key] = r.value; });
    return {
      rows,
      seeded: new Set(seededRes.rows.map(r => r.collection)),
      legacy,
      events: eventsRes.rows.map(r => ({ id: Number(r.id), event: r.event, data: r.data ? JSON.parse(r.data) : null, time: Number(r.time) }))
    };
  },
  // Compare-and-set: a row is only written if it still has the value this
  // request read. Otherwise someone changed it at the same moment and the
  // whole save is rolled back (ConflictError) instead of overwriting them.
  async save(upserts, deletes, seededList, events) {
    await this.init();
    const tx = await this.client.transaction('write');
    try {
      for (const [c, id, value, before] of upserts) {
        const r = before === undefined
          ? await tx.execute({ sql: 'INSERT INTO rows (collection, id, value) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO NOTHING', args: [c, id, value] })
          : await tx.execute({ sql: 'UPDATE rows SET value = ? WHERE collection = ? AND id = ? AND value = ?', args: [value, c, id, before] });
        if (r.rowsAffected !== 1) throw new ConflictError(`${c}/${id}`);
      }
      for (const [c, id, before] of deletes) {
        const r = await tx.execute({ sql: 'DELETE FROM rows WHERE collection = ? AND id = ? AND value = ?', args: [c, id, before] });
        if (r.rowsAffected !== 1) throw new ConflictError(`${c}/${id}`);
      }
      for (const c of seededList) await tx.execute({ sql: 'INSERT OR IGNORE INTO seeded (collection) VALUES (?)', args: [c] });
      for (const e of events) {
        await tx.execute({ sql: 'INSERT OR IGNORE INTO events (id, event, data, time) VALUES (?, ?, ?, ?)', args: [e.id, e.event, JSON.stringify(e.data ?? null), e.time] });
      }
      if (events.length) await tx.execute({ sql: 'DELETE FROM events WHERE time < ?', args: [Date.now() - 4 * EVENT_WINDOW_MS] });
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  }
};

const backend = backendName === 'turso' ? tursoBackend : redisBackend;

class ConflictError extends Error {
  constructor(what) { super(`Changed by another request: ${what}`); this.conflict = true; }
}

// ---------- request lifecycle ----------

async function withRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= attempts || err.noRetry) throw err;
      await new Promise(r => setTimeout(r, 80 * i + Math.random() * 80));
    }
  }
}

async function load() {
  const { rows, seeded, legacy, events } = await withRetry(() => backend.load());
  const cache = {};
  const snapshot = {};
  const dirty = new Set();
  const seededNow = [];

  for (const name of Object.keys(COLLECTIONS)) {
    const collectionRows = rows[name];
    const needsSeed = SEEDED.includes(name) && !seeded.has(name);
    if (needsSeed && collectionRows.size === 0) {
      // First run: migrate data saved before row storage, else start from the demo data
      cache[name] = legacy[name] ? JSON.parse(legacy[name]) : seed(name);
      snapshot[name] = new Map();
      dirty.add(name);
      seededNow.push(name);
      continue;
    }
    if (needsSeed) seededNow.push(name);
    snapshot[name] = collectionRows;
    cache[name] = fromRows(name, collectionRows);
  }
  return { cache, snapshot, dirty, seededNow, pendingEvents: [], loadedEvents: events };
}

// Writes this request's changed rows; throws if the database refused them
async function flush(c) {
  const { cache, snapshot } = c;
  const upserts = [];
  const deletes = [];
  for (const name of c.dirty) {
    const current = toRows(name, cache[name]);
    const before = snapshot[name] || new Map();
    current.forEach((json, id) => { if (before.get(id) !== json) upserts.push([name, id, json, before.get(id)]); });
    before.forEach((json, id) => { if (!current.has(id)) deletes.push([name, id, json]); });
    snapshot[name] = current;
  }
  const events = c.pendingEvents;
  const seededList = c.seededNow;
  c.dirty = new Set();
  c.pendingEvents = [];
  c.seededNow = [];
  if (!upserts.length && !deletes.length && !events.length && !seededList.length) return;
  // A conflict means our data is stale: retrying the same write can't succeed
  await withRetry(() => backend.save(upserts, deletes, seededList, events).catch(err => {
    if (err.conflict) { err.noRetry = true; }
    throw err;
  }));
}

function read(name) {
  return JSON.parse(JSON.stringify(ctx().cache[name])); // callers mutate + save, like the file store
}

function write(name, data) {
  const c = ctx();
  c.cache[name] = JSON.parse(JSON.stringify(data));
  c.dirty.add(name);
  return true;
}

// Map-like chat session store (bot carts)
const sessions = {
  has(id) { const c = requestContext.getStore(); return Boolean(c && c.cache.sessions[id]); },
  get(id) { const c = ctx(); c.dirty.add('sessions'); return c.cache.sessions[id]; },
  set(id, value) { const c = ctx(); c.cache.sessions[id] = value; c.dirty.add('sessions'); }
};

// Event ids must increase across instances without an extra round trip,
// so they combine the timestamp with a small counter.
let counter = 0;
function recordEvent(event, data) {
  const c = requestContext.getStore();
  if (!c) return; // e.g. background timers: nothing to persist
  const id = Date.now() * 1000 + (counter++ % 1000);
  c.pendingEvents.push({ id, event, data, time: Date.now() });
}

function eventsSince(id) {
  const c = ctx();
  const all = [...c.loadedEvents, ...c.pendingEvents];
  const lastId = all.length ? all[all.length - 1].id : 0;
  return { events: all.filter(e => e.id > id), lastId, reset: false };
}

// Express middleware: load before the route, flush before the response goes out
function middleware(req, res, next) {
  if (!enabled) return next();
  load().then((c) => {
    let flushed = false;
    const originals = {};
    const wrap = (method) => {
      originals[method] = res[method].bind(res);
      res[method] = (...args) => {
        if (flushed) return originals[method](...args);
        flushed = true;
        flush(c).then(
          () => originals[method](...args),
          (err) => {
            // Never tell a guest "order placed" if it wasn't saved
            console.error('[sharedStore] save failed:', err.message);
            res.status(err.conflict ? 409 : 503);
            originals.json({
              success: false,
              code: err.conflict ? 'CONFLICT' : 'SAVE_FAILED',
              message: err.conflict
                ? 'Something changed at the same moment. Please try again.'
                : 'Could not save right now. Please try again.'
            });
          }
        );
        return res;
      };
    };
    wrap('json');
    wrap('send');
    wrap('sendStatus');
    requestContext.run(c, () => next());
  }).catch(err => {
    console.error('[sharedStore] load failed:', err.message);
    res.status(503).json({ success: false, message: 'Storage is temporarily unavailable. Please try again.' });
  });
}

module.exports = { enabled, backendName, middleware, read, write, sessions, recordEvent, eventsSince, load, flush };
