// Sales Bot Dashboard — сервер
// Каждые N минут опрашивает API Salebot (get subscribers), сохраняет новых
// клиентов в SQLite и отдаёт дашборду посчитанную статистику.

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SALEBOT_API_KEY;
const GROUP_ID = process.env.SALEBOT_GROUP_ID || ''; // id бота внутри проекта Salebot (необязательно)
const POLL_INTERVAL_MINUTES = parseFloat(process.env.POLL_INTERVAL_MINUTES || '5');
const BASE_URL = process.env.SALEBOT_BASE_URL || 'https://chatter.salebot.pro';

if (!API_KEY) {
  console.error('ОШИБКА: не задан SALEBOT_API_KEY в переменных окружения (.env). Без него опрос Salebot невозможен.');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- БАЗА ДАННЫХ ----------
const db = new Database(path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    client_id TEXT PRIMARY KEY,
    name TEXT,
    created_at TEXT
  );
`);
const upsertStmt = db.prepare(`
  INSERT OR IGNORE INTO registrations (client_id, name, created_at)
  VALUES (@client_id, @name, @created_at)
`);

// ---------- ОПРОС SALEBOT ----------

function formatSqlDate(unixSeconds) {
  const d = unixSeconds ? new Date(unixSeconds * 1000) : new Date();
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Забирает всех подписчиков бота постранично.
// Salebot отдаёт список без явного признака "это последняя страница" — эвристика:
// если пришло меньше 100 записей, считаем страницу последней.
async function fetchAllSubscribers() {
  const results = [];
  let page = 1;
  const MAX_PAGES = 300; // защита от бесконечного цикла

  while (page <= MAX_PAGES) {
    const url = new URL(`${BASE_URL}/api/${API_KEY}/subscribers`);
    if (GROUP_ID) url.searchParams.set('group', GROUP_ID);
    url.searchParams.set('page', String(page));

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Salebot API ответил ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.result || data.clients || []);

    if (!items.length) break;
    results.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return results;
}

async function pollAndStore() {
  if (!API_KEY) return;
  try {
    const subs = await fetchAllSubscribers();
    const insertMany = db.transaction((items) => {
      for (const c of items) {
        const id = c.id ?? c.client_id;
        if (id == null) continue;
        upsertStmt.run({
          client_id: String(id),
          name: c.name || null,
          created_at: formatSqlDate(c.created_at),
        });
      }
    });
    insertMany(subs);
    console.log(`[${new Date().toLocaleTimeString('ru-RU')}] опрос Salebot: получено ${subs.length} записей`);
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString('ru-RU')}] ошибка опроса Salebot:`, e.message);
  }
}

// первый опрос сразу при старте, дальше — по расписанию
pollAndStore();
setInterval(pollAndStore, POLL_INTERVAL_MINUTES * 60 * 1000);

// ---------- API ДЛЯ ДАШБОРДА ----------
app.get('/api/stats', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM registrations`).get().n;

  const todayCount = db
    .prepare(`SELECT COUNT(*) AS n FROM registrations WHERE date(created_at) = date('now')`)
    .get().n;

  const last7 = db
    .prepare(`SELECT COUNT(*) AS n FROM registrations WHERE created_at >= datetime('now', '-7 days')`)
    .get().n;

  const byDay = db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS n
       FROM registrations
       WHERE created_at >= datetime('now', ?)
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(`-${days} days`);

  const recent = db
    .prepare(`SELECT client_id, name, created_at FROM registrations ORDER BY created_at DESC LIMIT 20`)
    .all();

  res.json({ total, todayCount, last7, byDay, recent });
});

app.get('/api/health', (req, res) => res.json({ ok: true, apiKeySet: Boolean(API_KEY) }));

app.listen(PORT, () => {
  console.log(`Sales Bot Dashboard запущен на порту ${PORT}, опрос Salebot каждые ${POLL_INTERVAL_MINUTES} мин.`);
});
