// Mini-Shelter — шахматка бронирований: HTTP-сервер + SQLite, без внешних зависимостей.
// Требуется Node.js >= 22.13 (встроенный модуль node:sqlite).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'guests.db');
const PASSWORD = process.env.PASSWORD || '';
const SESSION_DAYS = 30;

if (!PASSWORD) {
  console.error('Не задан пароль. Укажите PASSWORD в файле .env или в переменных окружения.');
  process.exit(1);
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS rooms (
    id   INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id         INTEGER PRIMARY KEY,
    room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    guest      TEXT NOT NULL,
    phone      TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL,  -- YYYY-MM-DD, день заезда
    end_date   TEXT NOT NULL,  -- YYYY-MM-DD, день выезда (утром номер освобождается)
    status     TEXT NOT NULL CHECK (status IN ('paid', 'partial', 'unpaid')),
    total      TEXT NOT NULL DEFAULT '',
    paid       TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bookings_room_dates ON bookings (room_id, start_date, end_date);
`);

// Базы, созданные до появления категорий, получают новый столбец.
if (!db.prepare('PRAGMA table_info(rooms)').all().some((c) => c.name === 'category')) {
  db.exec("ALTER TABLE rooms ADD COLUMN category TEXT NOT NULL DEFAULT ''");
}

const CATEGORIES = ['Премиум', 'Премиум плюс', 'Люкс', 'Делюкс', 'VIP эконом', 'Эконом'];

// Номерной фонд по умолчанию — заносится только в пустую базу.
function defaultRooms() {
  const rooms = [];
  const range = (from, to, category, special = {}) => {
    for (let n = from; n <= to; n++) rooms.push([String(n), special[n] || category]);
  };
  range(1001, 1014, 'Премиум', { 1002: 'Люкс', 1013: 'Люкс' });
  range(2001, 2010, 'Премиум', { 2001: 'Делюкс', 2010: 'Делюкс' });
  range(2011, 2017, 'Премиум плюс');
  range(3001, 3010, 'Премиум', { 3001: 'Делюкс', 3010: 'Делюкс' });
  range(4001, 4008, 'Премиум', { 4001: 'Делюкс', 4008: 'Делюкс' });
  range(5002, 5002, 'Премиум');
  range(101, 104, 'VIP эконом');
  range(201, 210, 'Эконом');
  range(301, 305, 'Эконом');
  return rooms.filter(([name]) => name !== '202');
}

// Однократно дополняем базу номерным фондом: недостающие номера добавляются,
// у уже существующих без категории проставляется категория. Удалённые позже номера не возвращаются.
if (db.prepare('PRAGMA user_version').get().user_version < 1) {
  const add = db.prepare('INSERT OR IGNORE INTO rooms (name, category) VALUES (?, ?)');
  const setCategory = db.prepare("UPDATE rooms SET category = ? WHERE name = ? AND category = ''");
  db.exec('BEGIN');
  for (const [name, category] of defaultRooms()) {
    add.run(name, category);
    setCategory.run(category, name);
  }
  db.exec('PRAGMA user_version = 1');
  db.exec('COMMIT');
}

// Раньше end_date означал последний занятый день, теперь — день выезда.
if (db.prepare('PRAGMA user_version').get().user_version < 2) {
  db.exec('BEGIN');
  db.exec("UPDATE bookings SET end_date = date(end_date, '+1 day')");
  db.exec('PRAGMA user_version = 2');
  db.exec('COMMIT');
}

const q = {
  rooms: db.prepare('SELECT id, name, category FROM rooms'),
  roomAdd: db.prepare('INSERT INTO rooms (name, category) VALUES (?, ?)'),
  roomUpdate: db.prepare('UPDATE rooms SET name = ?, category = ? WHERE id = ?'),
  roomDelete: db.prepare('DELETE FROM rooms WHERE id = ?'),
  bookingsInRange: db.prepare(
    'SELECT * FROM bookings WHERE end_date >= ? AND start_date <= ?'
  ),
  // День выезда одного гостя может быть днём заезда другого.
  overlap: db.prepare(
    `SELECT guest, start_date, end_date FROM bookings
     WHERE room_id = ? AND id != ? AND end_date > ? AND start_date < ? LIMIT 1`
  ),
  bookingAdd: db.prepare(
    `INSERT INTO bookings (room_id, guest, phone, start_date, end_date, status, total, paid, note)
     VALUES (:room_id, :guest, :phone, :start_date, :end_date, :status, :total, :paid, :note)`
  ),
  bookingUpdate: db.prepare(
    `UPDATE bookings SET room_id = :room_id, guest = :guest, phone = :phone,
       start_date = :start_date, end_date = :end_date, status = :status,
       total = :total, paid = :paid, note = :note
     WHERE id = :id`
  ),
  bookingDelete: db.prepare('DELETE FROM bookings WHERE id = ?'),
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s));
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const ru = (iso) => iso.split('-').reverse().join('.');

function cleanRoom(body) {
  const name = str(body.name, 40);
  const category = str(body.category, 40);
  if (!name) throw new HttpError(400, 'Укажите номер комнаты');
  if (category && !CATEGORIES.includes(category)) throw new HttpError(400, 'Неизвестная категория');
  return { name, category };
}

function cleanBooking(body, id = 0) {
  const b = {
    room_id: Number(body.room_id),
    guest: str(body.guest, 200),
    phone: str(body.phone, 100),
    start_date: body.start_date,
    end_date: body.end_date,
    status: body.status,
    total: str(body.total, 50),
    paid: str(body.paid, 50),
    note: str(body.note, 2000),
  };
  if (!b.guest) throw new HttpError(400, 'Укажите имя гостя');
  if (!Number.isInteger(b.room_id)) throw new HttpError(400, 'Выберите номер');
  if (!isDate(b.start_date) || !isDate(b.end_date)) throw new HttpError(400, 'Неверные даты');
  if (b.end_date <= b.start_date) throw new HttpError(400, 'Дата выезда должна быть позже даты заезда');
  if (!['paid', 'partial', 'unpaid'].includes(b.status)) throw new HttpError(400, 'Неверный статус оплаты');

  const clash = q.overlap.get(b.room_id, id, b.start_date, b.end_date);
  if (clash) {
    throw new HttpError(409,
      `Номер уже занят: ${clash.guest}, ${ru(clash.start_date)} – ${ru(clash.end_date)}`);
  }
  return b;
}

function sqliteError(err) {
  if (String(err.message).includes('UNIQUE')) return new HttpError(409, 'Такой номер уже есть');
  if (String(err.message).includes('FOREIGN KEY')) return new HttpError(400, 'Номер не найден');
  return err;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new HttpError(413, 'Слишком большой запрос');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

async function api(req, url) {
  const [, , resource, rawId] = url.pathname.split('/');
  const id = Number(rawId);
  const method = req.method;

  if (resource === 'data' && method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isDate(from) || !isDate(to)) throw new HttpError(400, 'Неверный диапазон дат');
    return { categories: CATEGORIES, rooms: q.rooms.all(), bookings: q.bookingsInRange.all(from, to) };
  }

  if (resource === 'rooms') {
    if (method === 'POST' && !rawId) {
      const { name, category } = cleanRoom(await readJson(req));
      try {
        const { lastInsertRowid } = q.roomAdd.run(name, category);
        return { id: Number(lastInsertRowid), name, category };
      } catch (e) { throw sqliteError(e); }
    }
    if (method === 'PUT' && id) {
      const { name, category } = cleanRoom(await readJson(req));
      try { q.roomUpdate.run(name, category, id); } catch (e) { throw sqliteError(e); }
      return { id, name, category };
    }
    if (method === 'DELETE' && id) {
      q.roomDelete.run(id);
      return { ok: true };
    }
  }

  if (resource === 'bookings') {
    if (method === 'POST' && !rawId) {
      const b = cleanBooking(await readJson(req));
      try {
        const { lastInsertRowid } = q.bookingAdd.run(b);
        return { ...b, id: Number(lastInsertRowid) };
      } catch (e) { throw sqliteError(e); }
    }
    if (method === 'PUT' && id) {
      const b = cleanBooking(await readJson(req), id);
      try { q.bookingUpdate.run({ ...b, id }); } catch (e) { throw sqliteError(e); }
      return { ...b, id };
    }
    if (method === 'DELETE' && id) {
      q.bookingDelete.run(id);
      return { ok: true };
    }
  }

  throw new HttpError(404, 'Не найдено');
}

// ---------- Вход по паролю ----------
// Сессия — подписанная cookie «срок.подпись». Ключ подписи хранится в базе и
// смешивается с паролем, поэтому смена пароля завершает все старые сессии.
db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
  .run('session_secret', randomBytes(32).toString('hex'));
const SESSION_KEY = createHash('sha256')
  .update(db.prepare("SELECT value FROM meta WHERE key = 'session_secret'").get().value)
  .update(PASSWORD)
  .digest();

const sign = (value) => createHmac('sha256', SESSION_KEY).update(value).digest('base64url');
const sha = (value) => createHash('sha256').update(value).digest();

function passwordMatches(given) {
  return timingSafeEqual(sha(String(given)), sha(PASSWORD));
}

function newSession() {
  const expires = String(Date.now() + SESSION_DAYS * 86400_000);
  return `${expires}.${sign(expires)}`;
}

function hasSession(req) {
  const match = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '');
  if (!match) return false;
  const [expires, signature = ''] = match[1].split('.');
  const expected = sign(expires);
  return signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    && Number(expires) > Date.now();
}

function sessionCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return `session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// Не больше 10 неверных попыток за 15 минут с одного адреса.
const failedLogins = new Map();
const LOGIN_WINDOW = 15 * 60_000;

function clientIp(req) {
  const ip = req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for'];
  // за обратным прокси (Caddy/nginx на этом же сервере) реальный адрес в заголовке
  if (forwarded && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('::ffff:172.'))) {
    return forwarded.split(',')[0].trim();
  }
  return ip;
}

function loginBlocked(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || entry.until < Date.now()) return false;
  return entry.count >= 10;
}

function loginFailed(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || entry.until < Date.now()) failedLogins.set(ip, { count: 1, until: Date.now() + LOGIN_WINDOW });
  else entry.count++;
}

async function readForm(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  return new URLSearchParams(raw);
}

const [indexHtml, loginHtml] = await Promise.all([
  readFile(join(ROOT, 'public', 'index.html')),
  readFile(join(ROOT, 'public', 'login.html'), 'utf8'),
]);

function sendLogin(res, status, error = '') {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(loginHtml.replace('<!--error-->', error));
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return sendLogin(res, 429, 'Слишком много попыток. Попробуйте через 15 минут.');
    const form = await readForm(req);
    if (!passwordMatches(form.get('password') || '')) {
      loginFailed(ip);
      return sendLogin(res, 401, 'Неверный пароль');
    }
    failedLogins.delete(ip);
    return redirect(res, '/', { 'Set-Cookie': sessionCookie(req, newSession(), SESSION_DAYS * 86400) });
  }

  if (url.pathname === '/logout' && req.method === 'POST') {
    return redirect(res, '/', { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (!hasSession(req)) {
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Требуется вход' }));
    }
    return sendLogin(res, 200);
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      const result = await api(req, url);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Ошибка сервера' : err.message }));
    }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(indexHtml);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не найдено');
});

server.listen(PORT, () => {
  console.log(`Mini-Shelter запущен: http://localhost:${PORT}  (база: ${DB_PATH})`);
});
