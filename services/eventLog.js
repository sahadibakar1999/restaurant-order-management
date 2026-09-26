// Remembers recent real-time events so browsers can poll for them when
// WebSockets aren't available (e.g. serverless hosting like Vercel).
const sharedStore = require('./sharedStore');
const MAX_EVENTS = 300;
let nextId = 1;
const events = [];

function record(event, data) {
  if (sharedStore.enabled) return sharedStore.recordEvent(event, data);
  events.push({ id: nextId++, event, data, time: Date.now() });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function since(id) {
  if (sharedStore.enabled) return sharedStore.eventsSince(id);
  const lastId = nextId - 1;
  // A browser that is ahead of us (fresh serverless instance) just resyncs
  if (id > lastId) return { events: [], lastId, reset: true };
  return { events: events.filter(e => e.id > id), lastId, reset: false };
}

module.exports = { record, since };
