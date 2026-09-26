// Shared state for serverless hosting. On Vercel each request can land on a
// different function instance, so orders, chat sessions and live events are
// kept in Upstash Redis (Vercel Marketplace, free tier) instead of local files.
//
// Enabled automatically when the Redis REST env vars exist
// (KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/_TOKEN).
// The rest of the app keeps its synchronous storage API: state is loaded once
// at the start of a request and changed keys are written back before the
// response is sent.
const fs = require('fs');
const path = require('path');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const enabled = Boolean(URL_ && TOKEN);

const PREFIX = 'rom:';
const DATA_FILES = ['menu', 'tables', 'orders', 'settings'];
const MAX_EVENTS = 200;

let cache = null;          // { menu, tables, orders, settings, sessions }
let dirty = new Set();
let pendingEvents = [];     // events recorded during this request
let loadedEvents = [];      // recent events from Redis

async function redis(commands) {
  const res = await fetch(`${URL_.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
  const results = await res.json();
  const failed = results.find(r => r.error);
  if (failed) throw new Error(`Redis error: ${failed.error}`);
  return results.map(r => r.result);
}

function seed(name) {
  const file = path.join(__dirname, '..', 'data', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Loads the latest shared state (one round trip)
async function load() {
  const keys = [...DATA_FILES, 'sessions'].map(k => PREFIX + k);
  const [values, events] = await redis([
    ['MGET', ...keys],
    ['LRANGE', `${PREFIX}events`, 0, -1]
  ]);

  cache = {};
  dirty = new Set();
  pendingEvents = [];
  DATA_FILES.forEach((name, i) => {
    if (values[i]) {
      cache[name] = JSON.parse(values[i]);
    } else {
      cache[name] = seed(name); // first run: start from the demo data
      dirty.add(name);
    }
  });
  cache.sessions = values[DATA_FILES.length] ? JSON.parse(values[DATA_FILES.length]) : {};
  loadedEvents = (events || []).map(e => JSON.parse(e));
}

// Writes changed keys + new events (one round trip)
async function flush() {
  if (!cache) return;
  const commands = [];
  for (const name of dirty) {
    commands.push(['SET', PREFIX + name, JSON.stringify(cache[name])]);
  }
  for (const evt of pendingEvents) {
    commands.push(['RPUSH', `${PREFIX}events`, JSON.stringify(evt)]);
  }
  if (pendingEvents.length) {
    commands.push(['LTRIM', `${PREFIX}events`, -MAX_EVENTS, -1]);
  }
  dirty = new Set();
  const toPush = pendingEvents;
  pendingEvents = [];
  if (commands.length === 0) return;
  try {
    await redis(commands);
  } catch (err) {
    console.error('[sharedStore] flush failed:', err.message);
    toPush.forEach(e => pendingEvents.push(e));
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

module.exports = { enabled, middleware, read, write, sessions, recordEvent, eventsSince, load, flush };
