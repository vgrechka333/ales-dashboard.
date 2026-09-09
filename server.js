// Sales Bot Dashboard — сервер
// Каждые N минут опрашивает API Salebot (get_clients), сохраняет клиентов
// в SQLite и отдаёт дашборду посчитанную статистику.

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SALEBOT_API_KEY;
// SALEBOT_GROUP_ID — это значение поля "group" в ответе Salebot (например "soulful_trader_bot"),
// а НЕ числовой ID. Посмотреть его можно, открыв в браузере:
// https://chatter.salebot.pro/api/ТВОЙ_КЛЮЧ/get_clients?offset=0&limit=1
const GROUP_ID = process.env.SALEBOT_GROUP_ID || '';
const POLL_INTERVAL_MINUTES = parseFloat(process.env.POLL_INTERVAL_MINUTES || '5');
const BASE_URL = process.env.SALEBOT_BASE_URL || 'https://chatter.salebot.pro';

if (!API_KEY) {
  console.error('ОШИБКА: не задан SALEBOT_API_KEY в переменных окружения. Без него опрос Salebot невозможен.');
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

// Salebot отдаёт created_at уже готовой строкой вида "2026-09-09 10:25:47.198713".
// SQLite понимает формат "YYYY-MM-DD HH:MM:SS", поэтому просто обрезаем до секунд.
function toSqlDate(rawCreatedAt) {
  if (rawCreatedAt && typeof rawCreatedAt === 'string' && rawCreatedAt.length >= 19) {
    return rawCreatedAt.slice(0, 19);
  }
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Забирает всех клиентов постранично через get_clients (offset/limit).
async function fetchAllClients() {
  const results = [];
  let offset = 0;
  const limit = 100;
  const MAX_ITER = 500; // защита от бесконечного цикла

  for (let i = 0; i < MAX_ITER; i++) {
    const url = new URL(`${BASE_URL}/api/${API_KEY}/get_clients`);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Salebot API ответил ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.clients || data.result || []);

    if (!items.length) break;
    results.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return results;
}

async function pollAndStore() {
  if (!API_KEY) return;
  try {
    const clients = await fetchAllClients();
    const filtered = GROUP_ID ? clients.filter((c) => String(c.group) === String(GROUP_ID)) : clients;

    const insertMany = db.transaction((items) => {
      for (const c of items) {
        const id = c.id ?? c.client_id;
        if (id == null) continue;
        upsertStmt.run({
          client_id: String(id),
          name: c.name || null,
          created_at: toSqlDate(c.created_at),
        });
      }
    });
    insertMany(filtered);
    console.log(
      `[${new Date().toLocaleTimeString('ru-RU')}] опрос Salebot: получено ${clients.length} клиентов` +
      (GROUP_ID ? `, после фильтра по group="${GROUP_ID}": ${filtered.length}` : '')
    );
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
