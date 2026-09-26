// Shared state for serverless hosting. On Vercel each request can land on a
// different function instance, so orders, chat sessions and live events are
// kept in a shared database instead of local files:
//   - Turso (libSQL):  TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
//   - Upstash Redis:   KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*)
// The rest of the app keeps its synchronous storage API: state is loaded once
// at the start of a request and changed keys are written back before the
// response is sent.
const fs = require('fs');
const path = require('path');

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const backendName = TURSO_URL && TURSO_TOKEN ? 'turso' : (REDIS_URL && REDIS_TOKEN ? 'redis' : null);
const enabled = Boolean(backendName);

const PREFIX = 'rom:';
const DATA_FILES = ['menu', 'tables', 'orders', 'settings'];
const KEYS = [...DATA_FILES, 'sessions'];
const MAX_EVENTS = 200;
const EVENT_WINDOW_MS = 15 * 60 * 1000; // pollers only need recent events

let cache = null;          // { menu, tables, orders, settings, sessions }
let dirty = new Set();
let pendingEvents = [];     // events recorded during this request
let loadedEvents = [];      // recent events from the database

// ---------- Backends: load() -> { values: {key: string|null}, events: [] }, save(entries, events) ----------

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
    const [values, events] = await this.call([
      ['MGET', ...KEYS.map(k => PREFIX + k)],
      ['LRANGE', `${PREFIX}events`, 0, -1]
    ]);
    const out = {};
    KEYS.forEach((k, i) => { out[k] = values[i]; });
    return { values: out, events: (events || []).map(e => JSON.parse(e)) };
  },
  async save(entries, events) {
    const commands = entries.map(([k, v]) => ['SET', PREFIX + k, v]);
    events.forEach(e => commands.push(['RPUSH', `${PREFIX}events`, JSON.stringify(e)]));
    if (events.length) commands.push(['LTRIM', `${PREFIX}events`, -MAX_EVENTS, -1]);
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
        'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, event TEXT NOT NULL, data TEXT, time INTEGER NOT NULL)',
        'CREATE INDEX IF NOT EXISTS events_time ON events(time)'
      ], 'write').catch(err => { this.ready = null; throw err; });
    }
    await this.ready;
  },
  async load() {
    await this.init();
    const [kv, events] = await this.client.batch([
      { sql: `SELECT key, value FROM kv WHERE key IN (${KEYS.map(() => '?').join(',')})`, args: KEYS },
      { sql: 'SELECT id, event, data, time FROM events WHERE time > ? ORDER BY id LIMIT ?', args: [Date.now() - EVENT_WINDOW_MS, MAX_EVENTS] }
    ], 'read');
    const out = {};
    KEYS.forEach(k => { out[k] = null; });
    kv.rows.forEach(r => { out[r.key] = r.value; });
    return {
      values: out,
      events: events.rows.map(r => ({ id: Number(r.id), event: r.event, data: r.data ? JSON.parse(r.data) : null, time: Number(r.time) }))
    };
  },
  async save(entries, events) {
    await this.init();
    const statements = entries.map(([k, v]) => ({
      sql: 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [k, v]
    }));
    events.forEach(e => statements.push({
      sql: 'INSERT OR IGNORE INTO events (id, event, data, time) VALUES (?, ?, ?, ?)',
      args: [e.id, e.event, JSON.stringify(e.data ?? null), e.time]
    }));
    if (events.length) statements.push({ sql: 'DELETE FROM events WHERE time < ?', args: [Date.now() - 4 * EVENT_WINDOW_MS] });
    if (statements.length) await this.client.batch(statements, 'write');
  }
};

const backend = backendName === 'turso' ? tursoBackend : redisBackend;

function seed(name) {
  const file = path.join(__dirname, '..', 'data', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Loads the latest shared state (one round trip)
async function load() {
  const { values, events } = await backend.load();
  cache = {};
  dirty = new Set();
  pendingEvents = [];
  DATA_FILES.forEach(name => {
    if (values[name]) {
      cache[name] = JSON.parse(values[name]);
    } else {
      cache[name] = seed(name); // first run: start from the demo data
      dirty.add(name);
    }
  });
  cache.sessions = values.sessions ? JSON.parse(values.sessions) : {};
  loadedEvents = events;
}

// Writes changed keys + new events (one round trip)
async function flush() {
  if (!cache) return;
  const entries = [...dirty].map(name => [name, JSON.stringify(cache[name])]);
  const events = pendingEvents;
  dirty = new Set();
  pendingEvents = [];
  if (entries.length === 0 && events.length === 0) return;
  try {
    await backend.save(entries, events);
  } catch (err) {
    console.error('[sharedStore] flush failed:', err.message);
  }
}

function read(name) {
  return JSON.parse(JSON.stringify(cache[name])); // callers mutate + save, like the file store
}

function write(name, data) {
  cache[name] = JSON.parse(JSON.stringify(data));
  dirty.add(name);
  return true;
}

// Map-like session store (bot carts) that persists when enabled
const sessions = {
  has(id) { return Boolean(cache && cache.sessions[id]); },
  get(id) { dirty.add('sessions'); return cache.sessions[id]; },
  set(id, value) { cache.sessions[id] = value; dirty.add('sessions'); }
};

// Event ids must increase across instances without an extra round trip,
// so they combine the timestamp with a small counter.
let counter = 0;
function recordEvent(event, data) {
  const id = Date.now() * 1000 + (counter++ % 1000);
  pendingEvents.push({ id, event, data, time: Date.now() });
}

function eventsSince(id) {
  const all = [...loadedEvents, ...pendingEvents];
  const lastId = all.length ? all[all.length - 1].id : 0;
  return { events: all.filter(e => e.id > id), lastId, reset: false };
}

// Express middleware: load before the route, flush before the response goes out
function middleware(req, res, next) {
  if (!enabled) return next();
  load().then(() => {
    let flushed = false;
    const wrap = (method) => {
      const original = res[method].bind(res);
      res[method] = (...args) => {
        if (flushed) return original(...args);
        flushed = true;
        flush().finally(() => original(...args));
        return res;
      };
    };
    wrap('json');
    wrap('send');
    wrap('sendStatus');
    next();
  }).catch(err => {
    console.error('[sharedStore] load failed:', err.message);
    res.status(503).json({ success: false, message: 'Storage is temporarily unavailable. Please try again.' });
  });
}

module.exports = { enabled, backendName, middleware, read, write, sessions, recordEvent, eventsSince, load, flush };
