// Turns a free-text order ("2 butter naan and a mango lassi, less spicy")
// into cart lines. Uses Claude when ANTHROPIC_API_KEY is set, otherwise a
// built-in keyword matcher so the demo works without any API key.

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, single: 1, double: 2, couple: 2
};

const STOPWORDS = new Set([
  'i', 'want', 'would', 'like', 'to', 'order', 'please', 'pls', 'plz', 'get', 'me', 'give',
  'the', 'of', 'some', 'for', 'us', 'we', 'can', 'have', 'need', 'add', 'also', 'more',
  'plate', 'plates', 'portion', 'portions', 'piece', 'pieces', 'pcs', 'glass', 'glasses',
  'bowl', 'bowls', 'x', 'with', 'and', 'table'
]);

// Modifiers kept as a kitchen note instead of being matched against dish names
const NOTE_PATTERNS = [
  /\b(less|extra|more|no|without|mild|medium)\s+(spicy|spice|oil|butter|onion|garlic|sugar|ice|salt|cream|cheese|masala)\b/g,
  /\b(jain|sugar[- ]free|well done|not spicy)\b/g
];

function normalizeWord(w) {
  if (w.length > 3 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeWord);
}

function itemTokens(item) {
  return new Set(tokenize(item.name).filter(t => !STOPWORDS.has(t)));
}

function matchItem(phrase, menu) {
  const words = tokenize(phrase).filter(t => !STOPWORDS.has(t) && !NUMBER_WORDS[t] && !/^\d+$/.test(t));
  if (words.length === 0) return { item: null, candidates: [] };

  const scored = menu.map(item => {
    const tokens = itemTokens(item);
    const hits = words.filter(w => tokens.has(w)).length;
    // Prefer items that cover more of what was typed, then shorter names
    return { item, hits, coverage: hits / words.length, size: tokens.size };
  }).filter(s => s.hits > 0);

  if (scored.length === 0) return { item: null, candidates: [] };
  scored.sort((a, b) => b.hits - a.hits || b.coverage - a.coverage || a.size - b.size);

  const best = scored[0];
  const tied = scored.filter(s => s.hits === best.hits && s.coverage === best.coverage);
  if (tied.length > 1 && best.hits === 1 && words.length === 1) {
    // "paneer" alone is ambiguous: ask instead of guessing
    return { item: null, candidates: tied.map(t => t.item) };
  }
  return { item: best.item, candidates: [] };
}

function extractNotes(segment) {
  const notes = [];
  let rest = ` ${segment} `;
  for (const pattern of NOTE_PATTERNS) {
    rest = rest.replace(pattern, (m) => { notes.push(m.trim()); return ' '; });
  }
  return { rest: rest.trim(), notes };
}

function parseWithRules(text, menu) {
  const segments = text.toLowerCase()
    .split(/,|;|\n|\+|\band\b|\balso\b|\bplus\b/)
    .map(s => s.trim())
    .filter(Boolean);

  const items = [];
  const unmatched = [];
  const ambiguous = [];
  const orderNotes = [];

  for (const segment of segments) {
    const { rest, notes } = extractNotes(segment);
    const hasWords = tokenize(rest).some(t => !STOPWORDS.has(t) && !NUMBER_WORDS[t] && !/^\d+$/.test(t));
    if (!hasWords) {
      // A note on its own ("less spicy") applies to the whole order
      orderNotes.push(...notes);
      continue;
    }

    let quantity = 1;
    const digit = rest.match(/(?:^|\s)(\d{1,2})\s*x?\b|\bx\s*(\d{1,2})\b/);
    if (digit) {
      quantity = parseInt(digit[1] || digit[2], 10);
    } else {
      const word = tokenize(rest).find(t => NUMBER_WORDS[t]);
      if (word) quantity = NUMBER_WORDS[word];
    }

    const { item, candidates } = matchItem(rest, menu);
    if (item) {
      items.push({ itemId: item.id, quantity: Math.min(Math.max(quantity, 1), 20), note: notes.join(', ') });
    } else if (candidates.length) {
      ambiguous.push({ text: rest, options: candidates.map(c => c.name) });
    } else {
      unmatched.push(rest);
    }
  }

  return { items, unmatched, ambiguous, note: orderNotes.join(', '), source: 'rules' };
}

// --- Claude (optional) ---

let anthropicClient = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    const AnthropicClass = Anthropic.default || Anthropic;
    anthropicClient = new AnthropicClass();
  }
  return anthropicClient;
}

async function parseWithClaude(client, text, menu) {
  const { z } = require('zod');
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

  const OrderSchema = z.object({
    items: z.array(z.object({
      menu_item_id: z.string(),
      quantity: z.number().int(),
      note: z.string()
    })),
    unmatched: z.array(z.string())
  });

  const menuList = menu
    .map(m => `${m.id} | ${m.name} | ${m.category}${m.inStock ? '' : ' | SOLD OUT'}`)
    .join('\n');

  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(OrderSchema) },
    system:
      'You turn a restaurant customer\'s chat message into order lines for this menu.\n' +
      'Only use menu_item_id values from the menu. Map casual names, typos, Hindi/Hinglish ' +
      'words and plurals to the closest dish (e.g. "naan" -> Butter Garlic Naan). ' +
      'Put preferences like "less spicy" or "no onion" in note. If a request clearly ' +
      'matches nothing on the menu, or is ambiguous between dishes, add the customer\'s ' +
      'words to unmatched instead of guessing. Default quantity is 1.\n\nMENU (id | name | category):\n' +
      menuList,
    messages: [{ role: 'user', content: text }]
  });

  const parsed = response.parsed_output;
  if (!parsed) return null;

  const byId = new Map(menu.map(m => [m.id, m]));
  const items = parsed.items
    .filter(i => byId.has(i.menu_item_id))
    .map(i => ({
      itemId: i.menu_item_id,
      quantity: Math.min(Math.max(i.quantity || 1, 1), 20),
      note: i.note || ''
    }));
  return { items, unmatched: parsed.unmatched || [], ambiguous: [], note: '', source: 'ai' };
}

async function parseOrder(text, menu) {
  const client = getClient();
  if (client) {
    try {
      const result = await parseWithClaude(client, text, menu);
      if (result) return result;
    } catch (err) {
      console.error('[orderParser] Claude parse failed, using rules:', err.message);
    }
  }
  return parseWithRules(text, menu);
}

// Cheap check so greetings/commands don't get sent to the parser
function looksLikeOrder(text) {
  const t = text.toLowerCase();
  return /\d/.test(t) || /\b(and|,|plus|with|want|order|give|get|please|also)\b/.test(t) ||
    tokenize(t).some(w => NUMBER_WORDS[w] && w !== 'a');
}

module.exports = { parseOrder, parseWithRules, looksLikeOrder, aiEnabled: () => Boolean(process.env.ANTHROPIC_API_KEY) };
