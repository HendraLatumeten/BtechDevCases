# TrailWallet — JWT Auth & Offline-Resilient Wallet

A full-stack TypeScript application implementing user registration, JWT authentication, an authenticated welcome view with **15-minute inactivity auto-logout**, and a **wallet manager** designed to stay reliable under **very poor network conditions (jungle or caves)**.

## Tech Stack

- **Backend**: Node.js, TypeScript, Express, Zod, `bcryptjs`, `jsonwebtoken`, `compression`, `helmet`
- **Frontend**: React 19, TypeScript, Vite, Service Worker app-shell cache
- **Database**: PostgreSQL 16 (Docker Compose) and embedded PostgreSQL (`@electric-sql/pglite`) for zero-setup local dev & isolated integration tests
- **Testing**: Vitest, Supertest, React Testing Library
- **Containerization**: Docker & Docker Compose (with Nginx reverse-proxy & gzip compression)

---

## Core Features & Design Decisions

### 1. Registration & Login (JWT)
- **Register** (`POST /api/auth/register`): Validates `email`, `password` (min 8 chars, letter + number), and `confirmPassword` (must match). Creates the user and initializes their wallet atomically inside one database transaction with a configurable starting balance (`INITIAL_WALLET_BALANCE`, default `1000.00`).
- **Login** (`POST /api/auth/login`): Verifies bcrypt password hash and issues a signed JWT containing `sub`, `userId`, `email`, and session `jti`.

### 2. Authenticated View & True 15-Minute Inactivity Timeout
- **Protected Route** (`GET /api/protected` / `GET /api/me`): Returns `"Hello [email], welcome back"`.
- **Sliding Inactivity Timeout (`INACTIVITY_TIMEOUT_MINUTES=15`)**:
  - **Backend**: Every login creates a row in `sessions` (`id = jti`, `last_active_at`). Each authenticated request verifies `now - last_active_at < 15 minutes` and updates `last_active_at`. If idle >= 15 minutes, the session is revoked and returns `401`.
  - **Frontend**: Tracks pointer/keyboard/scroll/touch interactions across browser tabs via `localStorage`, displays a live idle countdown, sends lightweight keep-alive pings only when active and online, and logs out automatically after 15 minutes of inactivity.

### 3. Wallet Manager & Concurrency Safety
- **View Balance & Ledger** (`GET /api/wallet`): Shows current balance and incoming/outgoing transaction history.
- **Transfer Money** (`POST /api/wallet/transfer`): Accepts `recipient` (email), `amount`, and `notes`.
  - Prevents self-transfers, non-existent recipients, negative/zero amounts, and floating-point drift (all amounts stored as integer `BIGINT` cents).
  - Runs inside a PostgreSQL ACID transaction locking both sender and recipient wallets in deterministic UUID order (`ORDER BY id ASC FOR UPDATE`) to prevent deadlocks and concurrent overdraft race conditions.

### 4. Designed for Jungle & Cave Connectivity
- **Idempotent Transfers (`Idempotency-Key`)**: Every transfer submission generates a persistent UUID key. If the signal drops mid-request and the client retries, the server recognizes `(sender_wallet_id, idempotency_key)` and returns the original transaction (`200`) without debiting twice.
- **Offline Outbox & Auto-Sync**: Transfers submitted while offline or interrupted by network timeouts are stored safely in `localStorage` and automatically flushed in order when connectivity returns.
- **Cached Protected View & App Shell**: Service Worker (`/sw.js`) caches the static app shell while the dashboard caches the latest synced balance/transactions locally so users can still inspect their wallet offline.
- **Low-Bandwidth Payloads**: Gzip compression enabled at both Express and Nginx layers, short request timeouts (`8s`), and exponential-backoff retries on safe/idempotent requests.

---

## How to Build and Run

### Option 1: Docker Compose (Recommended)

1. Copy the example environment file and customize secrets if needed:
   ```bash
   cp .env.example .env
   ```
2. Build and start PostgreSQL, Backend API, and Frontend:
   ```bash
   docker compose up --build
   ```
3. Open the application:
   - **Frontend UI**: http://localhost:8080
   - **Backend API**: http://localhost:3000/api/health

To stop and remove containers (add `-v` to wipe database volume):
```bash
docker compose down
```

### Option 2: Run Locally (Without Docker)

Requires **Node.js 20+**. Uses embedded PostgreSQL (`pglite://./data/pgdata`) by default if `DATABASE_URL` is not set to an external Postgres instance.

1. Install dependencies:
   ```bash
   npm --prefix backend install
   npm --prefix frontend install
   ```
2. Start backend (port `3000`) and frontend (port `5173`) in separate terminals:
   ```bash
   npm run dev:backend
   npm run dev:frontend
   ```
3. Open http://localhost:5173.

---

## Environment Variables

See `.env.example` for a ready-to-use template.

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | No | `3000` | Backend HTTP server port (`BACKEND_PORT` in Docker Compose) |
| `DATABASE_URL` | Prod: Yes | `pglite://./data/pgdata` | PostgreSQL connection URI (`postgres://...`) or `pglite://...` |
| `JWT_SECRET` | Prod: Yes | Dev fallback in non-prod | Secret key used to sign/verify JWTs |
| `JWT_EXPIRES_IN` | No | `24h` | Upper-bound JWT lifetime |
| `INACTIVITY_TIMEOUT_MINUTES` | No | `15` | Sliding session inactivity timeout in minutes |
| `INITIAL_WALLET_BALANCE` | No | `1000.00` | Starting balance credited to each newly registered user |
| `CORS_ORIGIN` | No | `http://localhost:5173,http://localhost:8080` | Comma-separated allowed origins |
| `BCRYPT_ROUNDS` | No | `10` | Bcrypt hashing cost (`4`–`14`) |
| `POSTGRES_DB` | Compose | `trailwallet` | Postgres database name in Docker Compose |
| `POSTGRES_USER` | Compose | `trailwallet` | Postgres user in Docker Compose |
| `POSTGRES_PASSWORD` | Compose | `trailwallet_pass` | Postgres password in Docker Compose |
| `FRONTEND_PORT` | Compose | `8080` | Exposed host port for Nginx frontend container |

---

## Running Tests & Typechecks

Run all unit & integration tests (backend + frontend):
```bash
npm test
```

Run typechecks and production builds:
```bash
npm run typecheck
npm run build
```

---

## API Quick Reference

| Method & Path | Auth | Description |
| :--- | :--- | :--- |
| `GET /api/health` | Public | Health check & DB connectivity |
| `POST /api/auth/register` | Public | Register user (`email`, `password`, `confirmPassword`) |
| `POST /api/auth/login` | Public | Authenticate (`email`, `password`) and return JWT |
| `POST /api/auth/ping` | Bearer JWT | Lightweight keep-alive to extend inactivity window |
| `POST /api/auth/logout` | Bearer JWT | Revoke current JWT session immediately |
| `GET /api/protected` | Bearer JWT | Returns `"Hello [email], welcome back"` |
| `GET /api/wallet` | Bearer JWT | Returns current wallet balance and recent transactions |
| `POST /api/wallet/transfer` | Bearer JWT | Transfer funds (`recipient`, `amount`, `notes`, optional `Idempotency-Key` header) |

