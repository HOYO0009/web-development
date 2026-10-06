# Library Study Seat Booking

A small course project built with vanilla HTML/CSS/JavaScript, Express, and SQLite. Students reserve library seats; administrators moderate bookings and manage seats and fixed daily time slots. All sample users and bookings are fictional.

## Run locally

Install **Node.js 24 or newer**, then run:

```sh
npm ci
npm start
```

Open [http://localhost:3000](http://localhost:3000). The first launch creates and seeds `data/library.sqlite`; subsequent launches preserve changes. No separate database server or frontend build is needed.

| Username | Password | Role |
| --- | --- | --- |
| student1 | Library123! | Student (Alex Morgan) |
| student2 | Library123! | Student (Sam Lee) |
| admin | Library123! | Administrator |

These shared passwords are for the fictional local demonstration only. There is no registration screen. Restarting the server requires logging in again.

Optional environment variables: `PORT` (default `3000`), `DB_PATH` (default `data/library.sqlite`), and `APP_ORIGIN` (default `http://localhost:<PORT>`). Use the configured origin to open the app, since mutations check it. `APP_ORIGIN` starting with `https://` enables Secure cookies. The app listens on the local machine.

## Workflows

- **Students:** Choose a date and time slot, select an available seat, and book it. View, edit, or cancel personal bookings. Edits can change the seat, date, and time slot.
- **Administrators:** View and cancel any booking. Add or delete seats and time slots. A seat or time slot cannot be deleted while any booking, including an old booking, refers to it.
- New or edited bookings cannot have past dates, using the server's local calendar day. Slots recur every day and cannot overlap; adjacent slots are allowed. Cancelling removes the booking and releases its seat.

## Technical overview

The SQLite database has four related tables: users, seats, time slots, and bookings. Each booking belongs to one user and references one seat and one slot for a date. Foreign keys prevent broken references, and a unique constraint prevents reserving the same seat/date/slot twice. Failed edits leave the original booking intact.

The browser retrieves and modifies JSON using `fetch`. It creates, updates, and removes seat buttons, booking cards, management entries, and feedback messages using DOM methods. Filtering selects available seats for a date and slot. Changes refresh affected data without a page reload; obsolete availability responses are ignored.

The server hashes passwords with salted `crypto.scrypt` and authenticates requests through an HttpOnly, SameSite cookie. Random sessions expire after eight hours and are stored only in server memory. Ownership and administrator permissions are checked on the server. SQL queries use bound parameters; user-facing text is inserted safely into the DOM.

Source layout: `server/` contains database and HTTP handling, `public/` contains the interface, and `test/` contains isolated API tests. Express is the sole direct npm dependency; SQLite, crypto, and the test runner come with Node.

## Check the project

```sh
npm test
```

Tests use temporary databases and native HTTP requests. They cover authentication, session expiry, student ownership, administrator permissions, booking CRUD and conflicts, availability, invalid input, protected deletion, and persistence.

For a short manual check, log in as each student to book, edit, and cancel a seat; then log in as the administrator to cancel another user's booking and add/remove an unused seat and slot. Try an occupied seat and a referenced-resource deletion, navigate with the keyboard, and check the page at a narrow browser width.
