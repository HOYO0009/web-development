const $ = (id) => document.getElementById(id);
const state = { user: null, date: '', slotId: '', seat: null, editId: null, seats: [], slots: [], availabilitySeq: 0, mutationBusy: false };
const loginView = $('login-view');
const appView = $('app-view');
const status = $('status');
const loginStatus = $('login-status');

function todayLocal() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function announce(message = '', error = false, login = false) {
  const target = login ? loginStatus : status;
  target.textContent = message;
  target.classList.toggle('error', error);
}
function clear(node) { node.replaceChildren(); }
function empty(node, message) { const text = document.createElement('p'); text.className = 'empty'; text.textContent = message; node.append(text); }
function confirmAction(message) {
  const dialog = $('confirm-dialog');
  $('confirm-message').textContent = message;
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}
function setBusy(form, busy) {
  form.querySelectorAll('button,input,select').forEach((element) => {
    if (busy) {
      element.dataset.wasDisabled = String(element.disabled);
      element.disabled = true;
    } else if (element.dataset.wasDisabled !== undefined) {
      element.disabled = element.dataset.wasDisabled === 'true';
      delete element.dataset.wasDisabled;
    }
  });
}

async function request(path, options = {}) {
  const mutation = options.method && options.method !== 'GET';
  let response;
  try {
    response = await fetch(path, { credentials: 'same-origin', headers: mutation ? { 'Content-Type': 'application/json' } : undefined, ...options });
  } catch {
    throw new Error('Cannot reach the server. Please try again.');
  }
  let data = {};
  try { data = await response.json(); } catch { /* no JSON body */ }
  if (response.status === 401) { const error = new Error(data.error || 'Authentication required.'); error.sessionExpired = true; throw error; }
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function showLogin(message = '') {
  state.user = null; state.editId = null; state.seat = null; state.slots = []; state.seats = [];
  clear($('student-bookings')); clear($('admin-bookings'));
  loginView.hidden = false; appView.hidden = true; $('password').value = '';
  announce('', false); announce(message, Boolean(message), true);
  if (message) $('username').focus();
}
function showApp(user) {
  state.user = user; announce('', false, true); loginView.hidden = true; appView.hidden = false;
  $('welcome').textContent = `${user.name} · ${user.role}`;
  $('student-view').hidden = user.role !== 'student';
  $('admin-view').hidden = user.role !== 'admin';
}
function renderSlots() {
  const select = $('time-slot'); const selected = String(state.slotId); clear(select);
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = state.slots.length ? 'Choose a time slot' : 'No time slots available'; select.append(placeholder);
  state.slots.forEach((slot) => { const option = document.createElement('option'); option.value = slot.timeSlotId; option.textContent = `${slot.startTime}–${slot.endTime}`; select.append(option); });
  if (state.slots.some((slot) => String(slot.timeSlotId) === selected)) select.value = selected;
  else { state.slotId = ''; state.seat = null; }
}
function renderAvailability(seats = [], loading = false) {
  const grid = $('seat-grid'); clear(grid);
  if (loading) return empty(grid, 'Loading seats…');
  if (!state.slotId) return empty(grid, state.slots.length ? 'Choose a time slot to see seats.' : 'An administrator must add a time slot first.');
  const visible = $('available-only').checked ? seats.filter((seat) => seat.available || seat.seatNumber === state.seat) : seats;
  if (!visible.length) return empty(grid, 'No seats match this view.');
  visible.forEach((seat) => {
    const selected = state.seat === seat.seatNumber;
    const button = document.createElement('button');
    button.type = 'button'; button.className = `seat${seat.available ? '' : ' taken'}`; button.textContent = seat.seatNumber;
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `Seat ${seat.seatNumber}, ${seat.available ? 'available' : 'unavailable'}${selected ? ', selected' : ''}`);
    button.disabled = !seat.available && !selected;
    button.addEventListener('click', () => {
      state.seat = seat.seatNumber;
      renderAvailability(seats);
      grid.querySelector('[aria-pressed="true"]')?.focus();
    });
    grid.append(button);
  });
}
async function loadAvailability() {
  const sequence = ++state.availabilitySeq;
  if (!state.date || !state.slotId) return renderAvailability();
  renderAvailability([], true);
  try {
    const query = new URLSearchParams({ date: state.date, timeSlotId: state.slotId });
    if (state.editId) query.set('excludeBookingId', state.editId);
    const data = await request(`/api/availability?${query}`);
    if (sequence === state.availabilitySeq) renderAvailability(data.seats);
  } catch (error) {
    if (sequence !== state.availabilitySeq) return;
    renderAvailability();
    if (error.sessionExpired) showLogin('Your session has expired. Please sign in again.'); else announce(error.message, true);
  }
}
function renderBookings(bookings, destinationId, admin = false) {
  const node = $(destinationId); clear(node);
  if (!bookings.length) return empty(node, 'No bookings yet.');
  bookings.forEach((booking) => {
    const card = document.createElement('article'); card.className = 'booking-card';
    const details = document.createElement('div'); const label = document.createElement('p'); label.textContent = `${booking.date} · ${booking.startTime}–${booking.endTime} · Seat ${booking.seatNumber}`; details.append(label);
    if (admin) { const owner = document.createElement('small'); owner.textContent = booking.name; details.append(owner); }
    const actions = document.createElement('div'); actions.className = 'booking-actions';
    if (!admin) { const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit'; edit.addEventListener('click', () => beginEdit(booking)); actions.append(edit); }
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'delete'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => cancelBooking(booking.bookingId, cancel)); actions.append(cancel);
    card.append(details, actions); node.append(card);
  });
}
function renderResources() {
  const seats = $('seat-list'); const slots = $('slot-list'); clear(seats); clear(slots);
  if (!state.seats.length) empty(seats, 'No seats configured.');
  state.seats.forEach(({ seatNumber }) => addResourceRow(seats, `Seat ${seatNumber}`, `/api/seats/${seatNumber}`, `seat ${seatNumber}`));
  if (!state.slots.length) empty(slots, 'No time slots configured.');
  state.slots.forEach((slot) => addResourceRow(slots, `${slot.startTime}–${slot.endTime}`, `/api/time-slots/${slot.timeSlotId}`, 'this time slot'));
}
function addResourceRow(list, labelText, path, confirmationLabel) {
  const item = document.createElement('li'); const label = document.createElement('span'); label.textContent = labelText;
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete'; remove.textContent = 'Delete'; remove.addEventListener('click', () => deleteResource(path, confirmationLabel, remove));
  item.append(label, remove); list.append(item);
}
async function refreshStudent() {
  const [seats, slots, bookings] = await Promise.all([request('/api/seats'), request('/api/time-slots'), request('/api/bookings')]);
  state.seats = seats.seats; state.slots = slots.timeSlots; renderSlots(); renderBookings(bookings.bookings, 'student-bookings'); await loadAvailability();
}
async function refreshAdmin() {
  const [seats, slots, bookings] = await Promise.all([request('/api/seats'), request('/api/time-slots'), request('/api/bookings')]);
  state.seats = seats.seats; state.slots = slots.timeSlots; renderResources(); renderBookings(bookings.bookings, 'admin-bookings', true);
}
async function refresh() { if (state.user.role === 'student') await refreshStudent(); else await refreshAdmin(); }
function resetEdit() {
  state.editId = null; state.seat = null; state.slotId = ''; state.date = todayLocal();
  $('booking-form').reset(); $('booking-date').value = state.date; $('save-booking').textContent = 'Create booking'; $('cancel-edit').hidden = true;
  renderSlots(); renderAvailability();
}
function beginEdit(booking) {
  state.editId = booking.bookingId; state.date = booking.date; state.slotId = String(booking.timeSlotId); state.seat = booking.seatNumber;
  $('booking-date').value = booking.date; renderSlots(); $('time-slot').value = state.slotId; $('save-booking').textContent = 'Save changes'; $('cancel-edit').hidden = false;
  announce('Editing your booking.'); loadAvailability();
}
async function cancelBooking(id, button) {
  if (state.mutationBusy || !(await confirmAction('Cancel this booking?'))) return;
  state.mutationBusy = true; button.disabled = true;
  try { await request(`/api/bookings/${id}`, { method: 'DELETE' }); if (state.editId === id) resetEdit(); try { await refresh(); announce('Booking cancelled.'); } catch (error) { announce(`Booking cancelled, but the list could not refresh: ${error.message}`, true); } }
  catch (error) { if (error.sessionExpired) showLogin('Your session has expired. Please sign in again.'); else announce(error.message, true); }
  finally { state.mutationBusy = false; button.disabled = false; }
}
async function deleteResource(path, label, button) {
  if (state.mutationBusy || !(await confirmAction(`Delete ${label}?`))) return;
  state.mutationBusy = true; button.disabled = true;
  try { await request(path, { method: 'DELETE' }); try { await refreshAdmin(); announce('Deleted.'); } catch (error) { announce(`Deleted, but the lists could not refresh: ${error.message}`, true); } }
  catch (error) { if (error.sessionExpired) showLogin('Your session has expired. Please sign in again.'); else announce(error.message, true); }
  finally { state.mutationBusy = false; button.disabled = false; }
}
async function addResource(form, path, makeBody, success) {
  if (!form.reportValidity() || state.mutationBusy) return;
  state.mutationBusy = true; setBusy(form, true);
  try { await request(path, { method: 'POST', body: JSON.stringify(makeBody()) }); form.reset(); try { await refreshAdmin(); announce(success); } catch (error) { announce(`${success.replace('.', '')}, but the lists could not refresh: ${error.message}`, true); } }
  catch (error) { if (error.sessionExpired) showLogin('Your session has expired. Please sign in again.'); else announce(error.message, true); }
  finally { state.mutationBusy = false; setBusy(form, false); }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (!form.reportValidity() || state.mutationBusy) return;
  state.mutationBusy = true; setBusy(form, true); announce('', false, true);
  try {
    const data = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }) });
    showApp(data.user); state.date = todayLocal(); $('booking-date').min = state.date; $('booking-date').value = state.date;
    try { await refresh(); announce('Signed in.'); } catch (error) { announce(`Signed in, but data could not refresh: ${error.message}`, true); }
  } catch (error) { announce(error.sessionExpired ? 'Sign-in failed. Check your username and password.' : error.message, true, true); }
  finally { state.mutationBusy = false; setBusy(form, false); }
});
$('logout-button').addEventListener('click', async () => {
  if (state.mutationBusy) return;
  state.mutationBusy = true;
  try {
    await request('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    showLogin();
  } catch (error) {
    if (error.sessionExpired) showLogin();
    else announce(error.message, true);
  } finally { state.mutationBusy = false; }
});
$('booking-date').addEventListener('change', () => { state.date = $('booking-date').value; state.seat = null; loadAvailability(); });
$('time-slot').addEventListener('change', () => { state.slotId = $('time-slot').value; state.seat = null; loadAvailability(); });
$('available-only').addEventListener('change', loadAvailability);
$('cancel-edit').addEventListener('click', () => { resetEdit(); announce('Edit cancelled.'); });
$('booking-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (!form.reportValidity() || state.mutationBusy) return;
  if (!state.slotId || !state.seat) return announce('Choose a time slot and an available seat.', true);
  state.mutationBusy = true; setBusy(form, true); const editing = state.editId;
  try { const body = { seatNumber: state.seat, date: state.date, timeSlotId: Number(state.slotId) }; await request(editing ? `/api/bookings/${editing}` : '/api/bookings', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) }); resetEdit(); try { await refreshStudent(); announce(editing ? 'Booking updated.' : 'Booking created.'); } catch (error) { announce(`${editing ? 'Booking updated' : 'Booking created'}, but the list could not refresh: ${error.message}`, true); } }
  catch (error) { if (error.sessionExpired) showLogin('Your session has expired. Please sign in again.'); else announce(error.message, true); }
  finally { state.mutationBusy = false; setBusy(form, false); }
});
$('seat-form').addEventListener('submit', (event) => { event.preventDefault(); addResource(event.currentTarget, '/api/seats', () => ({ seatNumber: Number($('new-seat').value) }), 'Seat added.'); });
$('slot-form').addEventListener('submit', (event) => { event.preventDefault(); addResource(event.currentTarget, '/api/time-slots', () => ({ startTime: $('start-time').value, endTime: $('end-time').value }), 'Time slot added.'); });
async function initialize() {
  state.date = todayLocal(); $('booking-date').min = state.date; $('booking-date').value = state.date;
  try {
    const data = await request('/api/auth/me');
    showApp(data.user);
    await refresh();
  } catch (error) {
    if (error.sessionExpired) showLogin();
    else if (state.user) announce(error.message, true);
    else showLogin(error.message);
  }
}
initialize();
