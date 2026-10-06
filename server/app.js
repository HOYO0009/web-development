import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

const SESSION_COOKIE = 'library_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pad = (number) => String(number).padStart(2, '0');
const localDate = (value) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;

function realDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function timeOfDay(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  return true;
}

function positiveId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function readCookie(request, name) {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > -1 && part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function passwordMatches(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function userShape(row) {
  return { userId: Number(row.userId), name: row.name, username: row.username, role: row.role };
}

function bookingShape(row) {
  return {
    bookingId: Number(row.bookingId),
    userId: Number(row.userId),
    name: row.name,
    seatNumber: Number(row.seatNumber),
    date: row.date,
    timeSlotId: Number(row.timeSlotId),
    startTime: row.startTime,
    endTime: row.endTime,
  };
}

function initializeDatabase(db, now) {
  const initialized = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS users (
      userId INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student', 'admin'))
    );
    CREATE TABLE IF NOT EXISTS seats (
      seatNumber INTEGER PRIMARY KEY CHECK (seatNumber > 0)
    );
    CREATE TABLE IF NOT EXISTS time_slots (
      timeSlotId INTEGER PRIMARY KEY,
      startTime TEXT NOT NULL,
      endTime TEXT NOT NULL,
      UNIQUE (startTime, endTime)
    );
    CREATE TABLE IF NOT EXISTS bookings (
      bookingId INTEGER PRIMARY KEY,
      userId INTEGER NOT NULL REFERENCES users(userId) ON DELETE RESTRICT,
      seatNumber INTEGER NOT NULL REFERENCES seats(seatNumber) ON DELETE RESTRICT,
      date TEXT NOT NULL,
      timeSlotId INTEGER NOT NULL REFERENCES time_slots(timeSlotId) ON DELETE RESTRICT,
      UNIQUE (seatNumber, date, timeSlotId)
    );
    CREATE INDEX IF NOT EXISTS bookings_lookup ON bookings(date, timeSlotId, seatNumber);
    CREATE INDEX IF NOT EXISTS bookings_user ON bookings(userId);
  `);

  if (initialized) return;
  const tomorrow = new Date(now());
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = localDate(tomorrow);
  const insertUser = db.prepare('INSERT INTO users (name, username, passwordHash, role) VALUES (?, ?, ?, ?)');
  const insertSeat = db.prepare('INSERT INTO seats (seatNumber) VALUES (?)');
  const insertSlot = db.prepare('INSERT INTO time_slots (startTime, endTime) VALUES (?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    insertUser.run('Alex Morgan', 'student1', passwordHash('Library123!'), 'student');
    insertUser.run('Sam Lee', 'student2', passwordHash('Library123!'), 'student');
    insertUser.run('Library Admin', 'admin', passwordHash('Library123!'), 'admin');
    for (let seat = 1; seat <= 8; seat += 1) insertSeat.run(seat);
    for (const [startTime, endTime] of [['08:00', '10:00'], ['10:00', '12:00'], ['12:00', '14:00'], ['14:00', '16:00']]) {
      insertSlot.run(startTime, endTime);
    }
    db.prepare('INSERT INTO bookings (userId, seatNumber, date, timeSlotId) VALUES (?, ?, ?, ?)').run(1, 1, tomorrowDate, 1);
    db.prepare('INSERT INTO bookings (userId, seatNumber, date, timeSlotId) VALUES (?, ?, ?, ?)').run(2, 2, tomorrowDate, 2);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function isBusy(error) {
  return error?.code === 'ERR_SQLITE_BUSY' || /SQLITE_BUSY/.test(String(error?.message));
}

export function createApp({ dbPath = 'data/library.sqlite', now = () => new Date(), origin = 'http://localhost:3000' } = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  initializeDatabase(db, now);
  const app = express();
  const sessions = new Map();
  const secureCookie = origin.startsWith('https://');

  const close = () => {
    sessions.clear();
    db.close();
  };
  const transaction = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction was not opened */ }
      throw error;
    }
  };
  const respondUser = (response, user) => response.json({ user: userShape(user) });
  const requireMutation = (request, response, next) => {
    const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') return next(new HttpError(415, 'Content-Type must be application/json'));
    if (request.headers.origin !== origin) return next(new HttpError(403, 'Request origin is not allowed'));
    return next();
  };
  const requireSession = (request, response, next) => {
    const token = readCookie(request, SESSION_COOKIE);
    const session = token && sessions.get(token);
    if (!session || session.expiresAt <= now().getTime()) {
      if (token) sessions.delete(token);
      return next(new HttpError(401, 'Authentication is required'));
    }
    const user = db.prepare('SELECT userId, name, username, role FROM users WHERE userId = ?').get(session.userId);
    if (!user) {
      sessions.delete(token);
      return next(new HttpError(401, 'Authentication is required'));
    }
    request.user = user;
    request.sessionToken = token;
    return next();
  };
  const requireAdmin = (request, response, next) => request.user.role === 'admin'
    ? next()
    : next(new HttpError(403, 'Administrator access is required'));
  const requireStudent = (request, response, next) => request.user.role === 'student'
    ? next()
    : next(new HttpError(403, 'Student access is required'));
  const bookingById = db.prepare(`
    SELECT b.bookingId, b.userId, u.name, b.seatNumber, b.date, b.timeSlotId, t.startTime, t.endTime
    FROM bookings b JOIN users u ON u.userId = b.userId JOIN time_slots t ON t.timeSlotId = b.timeSlotId
    WHERE b.bookingId = ?
  `);
  const bookingForUser = db.prepare(`
    SELECT b.bookingId, b.userId, u.name, b.seatNumber, b.date, b.timeSlotId, t.startTime, t.endTime
    FROM bookings b JOIN users u ON u.userId = b.userId JOIN time_slots t ON t.timeSlotId = b.timeSlotId
    WHERE b.bookingId = ? AND b.userId = ?
  `);

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use((request, response, next) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ? requireMutation(request, response, next) : next());
  app.use(express.json({ type: 'application/json', limit: '16kb' }));

  app.post('/api/auth/login', (request, response, next) => {
    try {
      const { username, password } = request.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) throw new HttpError(400, 'Username and password are required');
      const user = db.prepare('SELECT userId, name, username, passwordHash, role FROM users WHERE username = ?').get(username);
      if (!user || !passwordMatches(password, user.passwordHash)) throw new HttpError(401, 'Invalid username or password');
      const previousToken = readCookie(request, SESSION_COOKIE);
      if (previousToken) sessions.delete(previousToken);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { userId: Number(user.userId), expiresAt: now().getTime() + SESSION_TTL_MS });
      response.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: SESSION_TTL_MS, path: '/' });
      return respondUser(response, user);
    } catch (error) { return next(error); }
  });

  app.post('/api/auth/logout', (request, response) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) sessions.delete(token);
    response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secureCookie, path: '/' });
    response.json({ message: 'Logged out' });
  });

  app.get('/api/auth/me', requireSession, (request, response) => respondUser(response, request.user));

  app.get('/api/seats', requireSession, (request, response) => {
    response.json({ seats: db.prepare('SELECT seatNumber FROM seats ORDER BY seatNumber').all().map((row) => ({ seatNumber: Number(row.seatNumber) })) });
  });
  app.post('/api/seats', requireSession, requireAdmin, (request, response, next) => {
    try {
      const { seatNumber } = request.body ?? {};
      if (!positiveId(seatNumber)) throw new HttpError(400, 'seatNumber must be a positive integer');
      db.prepare('INSERT INTO seats (seatNumber) VALUES (?)').run(seatNumber);
      response.status(201).json({ seat: { seatNumber } });
    } catch (error) { next(error); }
  });
  app.delete('/api/seats/:seatNumber', requireSession, requireAdmin, (request, response, next) => {
    try {
      const seatNumber = Number(request.params.seatNumber);
      if (!Number.isSafeInteger(seatNumber) || seatNumber <= 0 || String(seatNumber) !== request.params.seatNumber) throw new HttpError(400, 'seatNumber must be a positive integer');
      const result = db.prepare('DELETE FROM seats WHERE seatNumber = ?').run(seatNumber);
      if (!result.changes) throw new HttpError(404, 'Seat not found');
      response.json({ message: 'Seat deleted' });
    } catch (error) { next(error); }
  });

  app.get('/api/time-slots', requireSession, (request, response) => {
    response.json({ timeSlots: db.prepare('SELECT timeSlotId, startTime, endTime FROM time_slots ORDER BY startTime').all().map((row) => ({ ...row, timeSlotId: Number(row.timeSlotId) })) });
  });
  app.post('/api/time-slots', requireSession, requireAdmin, (request, response, next) => {
    try {
      const { startTime, endTime } = request.body ?? {};
      if (!timeOfDay(startTime) || !timeOfDay(endTime) || startTime >= endTime) throw new HttpError(400, 'Times must be HH:mm with startTime before endTime');
      const timeSlot = transaction(() => {
        const overlap = db.prepare('SELECT 1 FROM time_slots WHERE ? < endTime AND ? > startTime').get(startTime, endTime);
        if (overlap) throw new HttpError(409, 'Time slot overlaps an existing slot');
        const result = db.prepare('INSERT INTO time_slots (startTime, endTime) VALUES (?, ?)').run(startTime, endTime);
        return { timeSlotId: Number(result.lastInsertRowid), startTime, endTime };
      });
      response.status(201).json({ timeSlot });
    } catch (error) { next(error); }
  });
  app.delete('/api/time-slots/:id', requireSession, requireAdmin, (request, response, next) => {
    try {
      const timeSlotId = Number(request.params.id);
      if (!Number.isSafeInteger(timeSlotId) || timeSlotId <= 0 || String(timeSlotId) !== request.params.id) throw new HttpError(400, 'timeSlotId must be a positive integer');
      const result = db.prepare('DELETE FROM time_slots WHERE timeSlotId = ?').run(timeSlotId);
      if (!result.changes) throw new HttpError(404, 'Time slot not found');
      response.json({ message: 'Time slot deleted' });
    } catch (error) { next(error); }
  });

  app.get('/api/bookings', requireSession, (request, response) => {
    const where = request.user.role === 'student' ? 'WHERE b.userId = ?' : '';
    const statement = db.prepare(`
      SELECT b.bookingId, b.userId, u.name, b.seatNumber, b.date, b.timeSlotId, t.startTime, t.endTime
      FROM bookings b JOIN users u ON u.userId = b.userId JOIN time_slots t ON t.timeSlotId = b.timeSlotId
      ${where} ORDER BY b.date, t.startTime, b.seatNumber
    `);
    const rows = request.user.role === 'student' ? statement.all(request.user.userId) : statement.all();
    response.json({ bookings: rows.map(bookingShape) });
  });
  app.post('/api/bookings', requireSession, requireStudent, (request, response, next) => {
    try {
      const { seatNumber, date, timeSlotId } = request.body ?? {};
      if (!positiveId(seatNumber) || !positiveId(timeSlotId) || !realDate(date)) throw new HttpError(400, 'seatNumber, date, and timeSlotId are required');
      if (date < localDate(now())) throw new HttpError(400, 'Bookings cannot be in the past');
      const booking = transaction(() => {
        if (!db.prepare('SELECT 1 FROM seats WHERE seatNumber = ?').get(seatNumber)) throw new HttpError(404, 'Seat not found');
        if (!db.prepare('SELECT 1 FROM time_slots WHERE timeSlotId = ?').get(timeSlotId)) throw new HttpError(404, 'Time slot not found');
        if (db.prepare('SELECT 1 FROM bookings WHERE seatNumber = ? AND date = ? AND timeSlotId = ?').get(seatNumber, date, timeSlotId)) throw new HttpError(409, 'Seat is already booked for this time slot');
        const result = db.prepare('INSERT INTO bookings (userId, seatNumber, date, timeSlotId) VALUES (?, ?, ?, ?)').run(request.user.userId, seatNumber, date, timeSlotId);
        return bookingById.get(Number(result.lastInsertRowid));
      });
      response.status(201).json({ booking: bookingShape(booking) });
    } catch (error) { next(error); }
  });
  app.put('/api/bookings/:id', requireSession, requireStudent, (request, response, next) => {
    try {
      const bookingId = Number(request.params.id);
      const { seatNumber, date, timeSlotId } = request.body ?? {};
      if (!Number.isSafeInteger(bookingId) || bookingId <= 0 || String(bookingId) !== request.params.id || !positiveId(seatNumber) || !positiveId(timeSlotId) || !realDate(date)) throw new HttpError(400, 'bookingId, seatNumber, date, and timeSlotId must be valid');
      if (date < localDate(now())) throw new HttpError(400, 'Bookings cannot be in the past');
      const booking = transaction(() => {
        if (!bookingForUser.get(bookingId, request.user.userId)) throw new HttpError(404, 'Booking not found');
        if (!db.prepare('SELECT 1 FROM seats WHERE seatNumber = ?').get(seatNumber)) throw new HttpError(404, 'Seat not found');
        if (!db.prepare('SELECT 1 FROM time_slots WHERE timeSlotId = ?').get(timeSlotId)) throw new HttpError(404, 'Time slot not found');
        if (db.prepare('SELECT 1 FROM bookings WHERE seatNumber = ? AND date = ? AND timeSlotId = ? AND bookingId <> ?').get(seatNumber, date, timeSlotId, bookingId)) throw new HttpError(409, 'Seat is already booked for this time slot');
        db.prepare('UPDATE bookings SET seatNumber = ?, date = ?, timeSlotId = ? WHERE bookingId = ?').run(seatNumber, date, timeSlotId, bookingId);
        return bookingById.get(bookingId);
      });
      response.json({ booking: bookingShape(booking) });
    } catch (error) { next(error); }
  });
  app.delete('/api/bookings/:id', requireSession, (request, response, next) => {
    try {
      const bookingId = Number(request.params.id);
      if (!Number.isSafeInteger(bookingId) || bookingId <= 0 || String(bookingId) !== request.params.id) throw new HttpError(400, 'bookingId must be a positive integer');
      const booking = request.user.role === 'student' ? bookingForUser.get(bookingId, request.user.userId) : bookingById.get(bookingId);
      if (!booking) throw new HttpError(404, 'Booking not found');
      db.prepare('DELETE FROM bookings WHERE bookingId = ?').run(bookingId);
      response.json({ message: 'Booking deleted' });
    } catch (error) { next(error); }
  });

  app.get('/api/availability', requireSession, (request, response, next) => {
    try {
      const { date, timeSlotId: slotValue, excludeBookingId: excludeValue } = request.query;
      const timeSlotId = Number(slotValue);
      if (!realDate(date) || typeof slotValue !== 'string' || !Number.isSafeInteger(timeSlotId) || timeSlotId <= 0 || String(timeSlotId) !== slotValue) throw new HttpError(400, 'date and timeSlotId must be valid');
      let excludeBookingId;
      if (excludeValue !== undefined) {
        excludeBookingId = Number(excludeValue);
        if (request.user.role !== 'student' || typeof excludeValue !== 'string' || !Number.isSafeInteger(excludeBookingId) || excludeBookingId <= 0 || String(excludeBookingId) !== excludeValue || !bookingForUser.get(excludeBookingId, request.user.userId)) throw new HttpError(404, 'Booking not found');
      }
      if (!db.prepare('SELECT 1 FROM time_slots WHERE timeSlotId = ?').get(timeSlotId)) throw new HttpError(404, 'Time slot not found');
      const occupied = new Set(db.prepare(`SELECT seatNumber FROM bookings WHERE date = ? AND timeSlotId = ? ${excludeBookingId ? 'AND bookingId <> ?' : ''}`).all(...(excludeBookingId ? [date, timeSlotId, excludeBookingId] : [date, timeSlotId])).map((row) => Number(row.seatNumber)));
      const seats = db.prepare('SELECT seatNumber FROM seats ORDER BY seatNumber').all().map((row) => ({ seatNumber: Number(row.seatNumber), available: !occupied.has(Number(row.seatNumber)) }));
      response.json({ date, timeSlotId, seats });
    } catch (error) { next(error); }
  });

  app.use(express.static(path.join(moduleDir, '..', 'public'), { index: 'index.html', fallthrough: true }));
  app.use((request, response) => response.status(404).json({ error: 'Not found' }));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof SyntaxError && 'body' in error) return response.status(400).json({ error: 'Invalid JSON body' });
    if (error instanceof HttpError) return response.status(error.status).json({ error: error.message });
    if (isBusy(error)) return response.status(503).json({ error: 'Database is temporarily busy' });
    if (/FOREIGN KEY constraint failed/.test(String(error?.message))) {
      return response.status(409).json({ error: 'This seat or time slot has bookings and cannot be deleted.' });
    }
    if (error?.code?.startsWith('ERR_SQLITE_CONSTRAINT') || /(?:UNIQUE|FOREIGN KEY) constraint failed/.test(String(error?.message))) {
      return response.status(409).json({ error: 'Resource conflicts with existing data' });
    }
    return response.status(500).json({ error: 'Internal server error' });
  });

  return { app, db, close };
}
