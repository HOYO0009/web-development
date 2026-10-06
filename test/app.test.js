import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const ORIGIN = 'http://localhost:3000';
const TOMORROW = '2035-06-02';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'library-test-'));
  let currentTime = new Date(2035, 5, 1, 12);
  let application;
  let server;
  let url;

  async function start() {
    application = createApp({
      dbPath: join(directory, 'library.sqlite'),
      origin: ORIGIN,
      now: () => new Date(currentTime),
    });
    server = await new Promise((resolve) => {
      const instance = application.app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    url = `http://127.0.0.1:${server.address().port}`;
  }

  async function stop() {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    application.close();
  }

  await start();
  t.after(async () => {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  });

  async function request(path, { method = 'GET', body, cookie, origin = ORIGIN, headers = {} } = {}) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(method === 'GET' ? {} : { Origin: origin }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { status: response.status, body: data, headers: response.headers,
      cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  async function login(username = 'student1') {
    const response = await request('/api/auth/login', {
      method: 'POST', body: { username, password: 'Library123!' },
    });
    assert.equal(response.status, 200);
    assert.ok(response.cookie);
    return response.cookie;
  }

  return { request, login,
    advanceTime: (milliseconds) => { currentTime = new Date(currentTime.getTime() + milliseconds); },
    restart: async () => { await stop(); await start(); },
  };
}

test('login, cookie settings, current user, logout, and session expiry', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/bookings')).status, 401);
  assert.equal((await f.request('/api/auth/me', { cookie: 'library_session=%E0%A4%A' })).status, 401);
  const failed = await f.request('/api/auth/login', {
    method: 'POST', body: { username: 'student1', password: 'wrong' },
  });
  assert.equal(failed.status, 401);
  const login = await f.request('/api/auth/login', {
    method: 'POST', body: { username: 'student1', password: 'Library123!' },
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(login.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.equal(login.body.user.role, 'student');
  assert.equal(login.body.user.passwordHash, undefined);
  assert.equal((await f.request('/api/auth/me', { cookie: login.cookie })).body.user.username, 'student1');
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie: login.cookie })).status, 200);
  assert.equal((await f.request('/api/auth/me', { cookie: login.cookie })).status, 401);
  const cookie = await f.login();
  f.advanceTime(8 * 60 * 60 * 1000 + 1);
  assert.equal((await f.request('/api/auth/me', { cookie })).status, 401);
});

test('a successful login replaces the previous session cookie', async (t) => {
  const f = await fixture(t);
  const oldCookie = await f.login();
  const replacement = await f.request('/api/auth/login', {
    method: 'POST', cookie: oldCookie, body: { username: 'student2', password: 'Library123!' },
  });
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.cookie, oldCookie);
  assert.equal((await f.request('/api/auth/me', { cookie: oldCookie })).status, 401);
  assert.equal((await f.request('/api/auth/me', { cookie: replacement.cookie })).body.user.username, 'student2');
});

test('mutation endpoints enforce origin and JSON content type, including login', async (t) => {
  const f = await fixture(t);
  const payload = { username: 'admin', password: 'Library123!' };
  assert.equal((await f.request('/api/auth/login', {
    method: 'POST', body: payload, origin: 'https://other.example',
  })).status, 403);
  assert.equal((await f.request('/api/auth/login', {
    method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' },
  })).status, 415);
  const cookie = await f.login('admin');
  assert.equal((await f.request('/api/seats', {
    method: 'POST', cookie, body: { seatNumber: 9 }, origin: 'https://other.example',
  })).status, 403);
});

test('students create, read, edit, and cancel their own bookings', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const me = (await f.request('/api/auth/me', { cookie })).body.user;
  const created = await f.request('/api/bookings', {
    method: 'POST', cookie, body: { seatNumber: 8, date: TOMORROW, timeSlotId: 4 },
  });
  assert.equal(created.status, 201);
  const id = created.body.booking.bookingId;
  assert.equal(created.body.booking.userId, me.userId);
  const list = (await f.request('/api/bookings', { cookie })).body.bookings;
  assert.ok(list.some((booking) => booking.bookingId === id));
  assert.ok(list.every((booking) => booking.userId === me.userId));
  const edited = await f.request(`/api/bookings/${id}`, {
    method: 'PUT', cookie, body: { seatNumber: 7, date: '2035-06-03', timeSlotId: 3 },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.booking.seatNumber, 7);
  assert.equal(edited.body.booking.date, '2035-06-03');
  assert.equal(edited.body.booking.timeSlotId, 3);
  assert.equal((await f.request(`/api/bookings/${id}`, { method: 'DELETE', cookie })).status, 200);
  assert.ok(!(await f.request('/api/bookings', { cookie })).body.bookings.some((booking) => booking.bookingId === id));
});

test('availability follows booking changes and includes the current seat during editing', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const path = `/api/availability?date=${TOMORROW}&timeSlotId=4`;
  const seat8 = async (query = path) => (await f.request(query, { cookie })).body.seats.find((seat) => seat.seatNumber === 8);
  assert.equal((await seat8()).available, true);
  const created = await f.request('/api/bookings', {
    method: 'POST', cookie, body: { seatNumber: 8, date: TOMORROW, timeSlotId: 4 },
  });
  const id = created.body.booking.bookingId;
  assert.equal((await seat8()).available, false);
  assert.equal((await seat8(`${path}&excludeBookingId=${id}`)).available, true);
  await f.request(`/api/bookings/${id}`, { method: 'DELETE', cookie });
  assert.equal((await seat8()).available, true);
});

test('students cannot edit, cancel, or exclude another student booking', async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const second = await f.login('student2');
  const created = await f.request('/api/bookings', {
    method: 'POST', cookie: first, body: { seatNumber: 8, date: TOMORROW, timeSlotId: 4 },
  });
  const id = created.body.booking.bookingId;
  assert.equal((await f.request(`/api/bookings/${id}`, {
    method: 'PUT', cookie: second, body: { seatNumber: 7, date: TOMORROW, timeSlotId: 4 },
  })).status, 404);
  assert.equal((await f.request(`/api/bookings/${id}`, { method: 'DELETE', cookie: second })).status, 404);
  assert.equal((await f.request(`/api/availability?date=${TOMORROW}&timeSlotId=4&excludeBookingId=${id}`, { cookie: second })).status, 404);
  assert.ok(!(await f.request('/api/bookings', { cookie: second })).body.bookings.some((booking) => booking.bookingId === id));
  const forged = await f.request('/api/bookings', {
    method: 'POST', cookie: second, body: { seatNumber: 7, date: TOMORROW, timeSlotId: 4, userId: created.body.booking.userId },
  });
  assert.ok(forged.status === 400 || forged.body.booking.userId !== created.body.booking.userId);
});

test('duplicate and concurrent bookings conflict, and an unsuccessful edit preserves the booking', async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const second = await f.login('student2');
  const payload = { seatNumber: 8, date: TOMORROW, timeSlotId: 4 };
  const responses = await Promise.all([
    f.request('/api/bookings', { method: 'POST', cookie: first, body: payload }),
    f.request('/api/bookings', { method: 'POST', cookie: second, body: payload }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const other = await f.request('/api/bookings', {
    method: 'POST', cookie: first, body: { ...payload, seatNumber: 7 },
  });
  assert.equal(other.status, 201);
  assert.equal((await f.request(`/api/bookings/${other.body.booking.bookingId}`, {
    method: 'PUT', cookie: first, body: payload,
  })).status, 409);
  const preserved = (await f.request('/api/bookings', { cookie: first })).body.bookings.find((booking) => booking.bookingId === other.body.booking.bookingId);
  assert.equal(preserved.seatNumber, 7);
});

test('administrators moderate all bookings, and students cannot manage library resources', async (t) => {
  const f = await fixture(t);
  const student = await f.login();
  const admin = await f.login('admin');
  for (const path of ['/api/seats', '/api/time-slots']) {
    assert.equal((await f.request(path, { method: 'POST', cookie: student, body: {} })).status, 403);
  }
  assert.equal((await f.request('/api/seats/8', { method: 'DELETE', cookie: student })).status, 403);
  assert.equal((await f.request('/api/time-slots/4', { method: 'DELETE', cookie: student })).status, 403);
  const list = (await f.request('/api/bookings', { cookie: admin })).body.bookings;
  assert.ok(new Set(list.map((booking) => booking.userId)).size >= 2);
  assert.equal((await f.request(`/api/bookings/${list[0].bookingId}`, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await f.request('/api/bookings', {
    method: 'POST', cookie: admin, body: { seatNumber: 8, date: TOMORROW, timeSlotId: 4 },
  })).status, 403);
});

test('administrator resource additions, overlap validation, and protected deletion', async (t) => {
  const f = await fixture(t);
  const admin = await f.login('admin');
  const student = await f.login();
  assert.equal((await f.request('/api/seats', { method: 'POST', cookie: admin, body: { seatNumber: 9 } })).status, 201);
  assert.equal((await f.request('/api/seats', { method: 'POST', cookie: admin, body: { seatNumber: 9 } })).status, 409);
  const added = await f.request('/api/time-slots', {
    method: 'POST', cookie: admin, body: { startTime: '16:00', endTime: '18:00' },
  });
  assert.equal(added.status, 201);
  const slot = added.body.timeSlot.timeSlotId;
  assert.equal((await f.request('/api/time-slots', {
    method: 'POST', cookie: admin, body: { startTime: '17:00', endTime: '19:00' },
  })).status, 409);
  const booking = await f.request('/api/bookings', {
    method: 'POST', cookie: student, body: { seatNumber: 9, date: TOMORROW, timeSlotId: slot },
  });
  assert.equal((await f.request('/api/seats/9', { method: 'DELETE', cookie: admin })).status, 409);
  assert.equal((await f.request(`/api/time-slots/${slot}`, { method: 'DELETE', cookie: admin })).status, 409);
  await f.request(`/api/bookings/${booking.body.booking.bookingId}`, { method: 'DELETE', cookie: student });
  assert.equal((await f.request('/api/seats/9', { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await f.request(`/api/time-slots/${slot}`, { method: 'DELETE', cookie: admin })).status, 200);
});

test('invalid dates, relationships, identifiers, and time intervals are rejected', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const payload = { seatNumber: 8, date: TOMORROW, timeSlotId: 4 };
  for (const patch of [
    { date: '2035-02-30' }, { date: '2035-05-31' }, { date: '06/02/2035' },
    { seatNumber: -1 }, { seatNumber: '8' }, { seatNumber: 1.5 },
    { timeSlotId: 999 }, { seatNumber: 999 },
  ]) {
    const result = await f.request('/api/bookings', { method: 'POST', cookie, body: { ...payload, ...patch } });
    assert.ok([400, 404].includes(result.status), JSON.stringify({ patch, result }));
    assert.equal(typeof result.body.error, 'string');
  }
  const admin = await f.login('admin');
  for (const body of [{ startTime: '18:00', endTime: '17:00' }, { startTime: '25:00', endTime: '26:00' }]) {
    assert.equal((await f.request('/api/time-slots', { method: 'POST', cookie: admin, body })).status, 400);
  }
});

test('application data survives restart, sessions do not, and seed data is not repeated', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const created = await f.request('/api/bookings', {
    method: 'POST', cookie, body: { seatNumber: 8, date: TOMORROW, timeSlotId: 4 },
  });
  const before = (await f.request('/api/bookings', { cookie })).body.bookings;
  await f.restart();
  assert.equal((await f.request('/api/auth/me', { cookie })).status, 401);
  const freshCookie = await f.login();
  const after = (await f.request('/api/bookings', { cookie: freshCookie })).body.bookings;
  assert.equal(after.length, before.length);
  assert.ok(after.some((booking) => booking.bookingId === created.body.booking.bookingId));
});
