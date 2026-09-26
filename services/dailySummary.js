// End-of-day sales summary for the owner: revenue, top dishes, busiest hour,
// cancellations and prep speed. Sent on WhatsApp at a set time each night.
const storage = require('./storage');
const whatsappApi = require('./whatsappApi');

function tz() {
  return storage.getSettings().timezone || process.env.TZ_NAME || 'Asia/Kolkata';
}

// YYYY-MM-DD for a date in the restaurant's timezone
function dayKey(date, timeZone = tz()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function hourIn(date, timeZone = tz()) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(date), 10) % 24;
}

function buildSummary(day = dayKey(new Date())) {
  const settings = storage.getSettings();
  const orders = storage.getOrders().filter(o => dayKey(new Date(o.createdAt)) === day);
  const valid = orders.filter(o => o.status !== 'cancelled');
  const cancelled = orders.filter(o => o.status === 'cancelled');

  const revenue = valid.reduce((sum, o) => sum + (o.total || 0), 0);
  const avgOrder = valid.length ? Math.round(revenue / valid.length) : 0;

  const dishCounts = {};
  valid.forEach(o => (o.items || []).forEach(i => {
    dishCounts[i.name] = dishCounts[i.name] || { quantity: 0, revenue: 0 };
    dishCounts[i.name].quantity += i.quantity;
    dishCounts[i.name].revenue += i.price * i.quantity;
  }));
  const topDishes = Object.entries(dishCounts)
    .map(([name, d]) => ({ name, ...d }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5);

  const byHour = {};
  valid.forEach(o => { const h = hourIn(new Date(o.createdAt)); byHour[h] = (byHour[h] || 0) + 1; });
  const busiest = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
  const busiestHour = busiest ? { hour: Number(busiest[0]), orders: busiest[1] } : null;

  // Prep time = order placed -> marked ready
  const prepTimes = valid.map(o => {
    const ready = (o.history || []).find(h => h.status === 'ready');
    return ready ? (new Date(ready.time) - new Date(o.createdAt)) / 60000 : null;
  }).filter(v => v !== null && v >= 0);
  const avgPrepMinutes = prepTimes.length ? Math.round(prepTimes.reduce((a, b) => a + b, 0) / prepTimes.length) : null;

  const channels = { web: 0, whatsapp: 0 };
  valid.forEach(o => { channels[o.channel === 'web' ? 'web' : 'whatsapp'] += 1; });

  return {
    day,
    restaurantName: settings.restaurantName,
    currency: settings.currency || '₹',
    orderCount: valid.length,
    cancelledCount: cancelled.length,
    revenue,
    avgOrder,
    topDishes,
    busiestHour,
    avgPrepMinutes,
    channels
  };
}

function formatHour(h) {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${suffix}`;
}

function formatMessage(s) {
  const c = s.currency;
  const dateLabel = new Date(`${s.day}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  if (s.orderCount === 0 && s.cancelledCount === 0) {
    return `📊 *${s.restaurantName} — Daily Summary (${dateLabel})*\n\nNo orders today.`;
  }
  const lines = [
    `📊 *${s.restaurantName} — Daily Summary (${dateLabel})*`,
    ``,
    `💰 *Sales:* ${c}${s.revenue.toLocaleString('en-IN')} from ${s.orderCount} orders`,
    `🧾 *Average order:* ${c}${s.avgOrder.toLocaleString('en-IN')}`,
    `📱 *Channels:* ${s.channels.web} QR web · ${s.channels.whatsapp} WhatsApp`
  ];
  if (s.busiestHour) lines.push(`⏰ *Busiest hour:* ${formatHour(s.busiestHour.hour)}–${formatHour((s.busiestHour.hour + 1) % 24)} (${s.busiestHour.orders} orders)`);
  if (s.avgPrepMinutes !== null) lines.push(`⏱️ *Avg prep time:* ${s.avgPrepMinutes} min`);
  lines.push(`❌ *Cancelled:* ${s.cancelledCount}`);
  if (s.topDishes.length) {
    lines.push(``, `🏆 *Top dishes:*`);
    s.topDishes.forEach((d, i) => lines.push(`${i + 1}. ${d.name} — ${d.quantity} sold (${c}${d.revenue.toLocaleString('en-IN')})`));
  }
  return lines.join('\n');
}

async function sendSummary(day) {
  const settings = storage.getSettings();
  const summary = buildSummary(day);
  const text = formatMessage(summary);
  const to = (settings.ownerWhatsapp || process.env.OWNER_WHATSAPP || '').replace(/\D/g, '') || 'owner_simulator';
  await whatsappApi.sendMessage(to, text);
  return { summary, text, to };
}

// Checks once a minute and sends the summary at settings.dailySummaryTime (HH:MM, restaurant time)
function startScheduler() {
  let lastSentDay = null;
  setInterval(async () => {
    const settings = storage.getSettings();
    if (settings.dailySummaryEnabled === false) return;
    const target = settings.dailySummaryTime || '23:00';
    const now = new Date();
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const today = dayKey(now);
    if (hhmm === target && lastSentDay !== today) {
      lastSentDay = today;
      try {
        await sendSummary(today);
        console.log(`[dailySummary] Sent summary for ${today}`);
      } catch (err) {
        console.error('[dailySummary] Failed to send:', err.message);
      }
    }
  }, 60_000).unref();
}

module.exports = { buildSummary, formatMessage, sendSummary, startScheduler, dayKey };
