# E-commerce REST API

A CommonJS Node.js REST API using Express and an embedded SQLite database. It provides JWT authentication, administrator-managed products, persistent customer carts, customer/admin order workflows, and optional Stripe checkout.

## Requirements

- Node.js 22 or newer
- npm
- Nothing else to install: SQLite is an embedded database stored in a local file.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`. In PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   Set a strong JWT secret. For example:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   SQLite is created automatically at `data/ecommerce.sqlite`; there is no database account, cluster, URI, or service to start. Never commit `.env`. Leave SMTP, Redis, and Stripe settings empty for local development. Set `NODE_ENV=development` to receive verification/reset tokens in the local API response.

3. Start the API:

   ```sh
   npm run dev
   ```

   Use `npm start` for a normal Node.js process. The default port is `5000`. In local development, registration and password-recovery responses include the one-time token needed to complete the flow. To deliver links by email, configure SMTP. To accept payments, configure both Stripe keys and register a webhook for `/api/payments/stripe/webhook` subscribing to `payment_intent.succeeded`, `payment_intent.canceled`, and `charge.refunded`.

4. Configure an administrator:

   ```sh
   npm run promote-admin -- customer@example.com
   ```

   This promotes an existing verified account in the local SQLite database. Restrict access to the command and database file; do not expose admin provisioning as a public endpoint.

5. Run `npm test` to exercise the API and database workflows. Tests use temporary SQLite files and need no external database.

## Environment variables

| Variable | Required | Description |
|---|---:|---|
| `PORT` | No | HTTP port; defaults to `5000` |
| `DB_PATH` | No | SQLite file path; defaults to `data/ecommerce.sqlite` |
| `JWT_SECRET` | Yes | Secret of at least 32 characters used to sign tokens |
| `JWT_EXPIRES_IN` | No | JWT lifetime accepted by jsonwebtoken; defaults to `1d` |
| `CLIENT_ORIGIN` | Yes in production | Comma-separated frontend origins allowed by CORS |
| `APP_URL` | No | Frontend base URL used in email links; defaults to `http://localhost:3000` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Optional locally; all required together to send email | SMTP delivery configuration |
| `SMTP_SECURE` | No | Set `true` for implicit TLS (often port 465); otherwise use STARTTLS SMTP (often port 587) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Together for production/payments | Stripe API credential and webhook signing secret; both must be configured together. Leave both blank to disable payments in local development |
| `STRIPE_CURRENCY` | No | Only `usd` is currently supported |
| `API_RATE_LIMIT` | No | General API requests per IP per 15-minute window; defaults to `300` |
| `ORDER_HOLD_MINUTES` | No | Inventory hold time for an unpaid order; defaults to `30`, maximum `1440` |
| `REDIS_URL` | No | Optional shared rate-limit storage; in-memory limits work without Redis |
| `TRUST_PROXY` | No | Express proxy-hop/IP trust setting; configure to match deployment topology |
| `NODE_ENV` | No | Set to `production` for sanitized errors and stricter production configuration |

## Authentication and authorization

Registration requires email verification before login. With SMTP configured, verification and reset links are emailed. Without SMTP in development, registration and recovery return a one-time development token; submit it to the matching API endpoint. Production never exposes tokens in API responses and requires SMTP. Tokens are single-use, hashed at rest, and expire. Password reset invalidates previous JWTs. Recovery messages do not reveal whether an email address exists. Send the login token on protected routes:

```http
Authorization: Bearer <token>
```

Public registration always creates an unprivileged customer; it ignores any `isAdmin` field in the request. Promote a verified account with the restricted `npm run promote-admin -- email` command. Do not expose public admin self-registration.

Product writes, order listing across all customers, and order status changes require an administrator token. Customers can create orders and read or delete their own pending orders only.

Each verified customer has a persistent, account-scoped cart. Cart operations require authentication. Product prices shown in the cart are current catalog prices; checkout recalculates prices and reserves stock atomically, creates an order snapshot, and empties the cart only when the order is successfully created.

## API routes

All responses use JSON. IDs are UUID strings. Product and order collection endpoints accept `page` (default `1`) and `limit` (default `20`, maximum `100`) where applicable.

| Method | Route | Access | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | Public | Register a customer (`name`, `email`, `password`) |
| `POST` | `/api/auth/login` | Public | Log in (`email`, `password`); returns JWT |
| `POST` | `/api/auth/verify-email` | Public, throttled | Verify email (`token`) |
| `POST` | `/api/auth/resend-verification` | Public, throttled | Request a verification email (`email`) |
| `POST` | `/api/auth/forgot-password` | Public, throttled | Request a password reset email (`email`) |
| `POST` | `/api/auth/reset-password` | Public, throttled | Reset password (`token`, `password`) |
| `GET` | `/api/products` | Public | List products; optional `search`, `category`, `page`, `limit` |
| `GET` | `/api/products/:id` | Public | Get a product |
| `POST` | `/api/products` | Admin | Create a product (`name`, `description`, `price`, `category`, `stock`) |
| `PUT` | `/api/products/:id` | Admin | Replace supplied editable product fields |
| `PATCH` | `/api/products/:id` | Admin | Update supplied editable product fields |
| `DELETE` | `/api/products/:id` | Admin | Delete a product |
| `GET` | `/api/cart` | Customer | View the signed-in customer's cart and current catalog prices |
| `POST` | `/api/cart/items` | Customer | Add quantity to a cart item (`productId`, `quantity`) |
| `PATCH` | `/api/cart/items/:productId` | Customer | Set an item's quantity (`quantity`) |
| `DELETE` | `/api/cart/items/:productId` | Customer | Remove an item from the cart |
| `DELETE` | `/api/cart` | Customer | Empty the signed-in customer's cart |
| `POST` | `/api/orders/from-cart` | Customer | Checkout the cart; creates an order and clears the cart atomically |
| `POST` | `/api/orders` | Customer | Create an order (`orderItems: [{ product, quantity }]`); response includes `expiresAt` |
| `GET` | `/api/orders/mine` | Customer | List the signed-in customer's orders |
| `GET` | `/api/orders/:id` | Owner or admin | Get an order |
| `DELETE` | `/api/orders/:id` | Owner or admin | Delete an unpaid pending order without a Stripe payment attempt |
| `POST` | `/api/orders/:id/cancel` | Owner or admin | Cancel an unpaid pending order; cancel its Stripe intent if one exists |
| `GET` | `/api/orders` | Admin | List all customer orders |
| `PATCH` | `/api/orders/:id/status` | Admin | Change status (`pending`, `processing`, `shipped`, `delivered`, `cancelled`); `refunded` is set by Stripe webhook |
| `POST` | `/api/orders/:id/payment-intent` | Owner or admin | Create or resume a Stripe PaymentIntent; returns a client secret |
| `POST` | `/api/orders/:id/refund` | Admin | Request a full Stripe refund; final state comes from the signed webhook |
| `POST` | `/api/payments/stripe/webhook` | Stripe signature | Process signed Stripe payment/refund events; not a browser endpoint |
| `GET` | `/api/health/live` | Public | Liveness probe; confirms the process is running |
| `GET` | `/api/health/ready` | Public | Readiness probe; returns `503` if SQLite or configured Redis is unavailable |
| `GET` | `/api/health` | Public | Readiness alias for `/api/health/ready` |

Order item prices are read from the database, never trusted from the client, and stored as a snapshot. Stock reservation and order creation use SQLite transactions. Unpaid orders reserve inventory for `ORDER_HOLD_MINUTES`; a worker checks every minute and cancels expired Stripe intents or releases stock for expired orders without a payment attempt. Stripe PaymentIntents use server-calculated amounts, USD minor units, deterministic idempotency keys, and order metadata. Payment/refund state changes only after signature-verified webhooks, which are deduplicated transactionally. Canceling a Stripe PaymentIntent releases stock when cancellation is confirmed. A full refund of an unshipped order marks it refunded; refunded stock is not automatically restocked. Paid orders cannot use the unpaid-order stock restoration path.

The frontend must confirm payments using the returned PaymentIntent client secret and must never treat a browser success redirect as proof of payment. Use Stripe test mode before live credentials.

## Project structure

```text
config/       SQLite initialization and schema
controllers/  Request handlers and business logic
middleware/   JWT authorization and centralized errors
models/       SQLite-backed data access
routes/       Express route definitions
scripts/      Restricted admin provisioning command
services/     Scheduled unpaid-order expiration
utils/        Email, Redis, Stripe, logging, and shared error helpers
test/         HTTP, schema, and SQLite integration tests
server.js     Express setup and process lifecycle
```

## Production checklist

Implemented here: embedded SQLite with automatic file/schema setup, Helmet headers, CORS allowlisting, general and auth/recovery rate limits, optional Redis-backed shared rate limits, JSON structured logs, liveness/readiness probes, graceful shutdown, admin provisioning, email verification/password recovery, optional Stripe PaymentIntents and signed idempotent webhooks, unpaid-order expiration, automated tests, and CI on Node.js 22/24.

Still environment- and business-specific before launch:

- Configure production SMTP, optional Stripe live credentials/webhook, frontend origins, HTTPS, and proxy trust. Store secrets in the hosting platform's secret manager.
- Back up the SQLite database file, including its WAL state (use SQLite's backup API or stop the service before copying); periodically test restoring it.
- SQLite is best suited to a single API instance with persistent disk. For multi-instance or high-write deployments, use a managed relational database such as PostgreSQL.
- Connect JSON stdout and readiness probes to hosting log aggregation, alerting, and uptime monitoring.
- Configure hosting/deployment, TLS termination, secret rotation, and incident-response procedures.
- Integrate shipping/tax/fulfillment and define refund/return policies. These business rules are intentionally not guessed here.
- Verify legal requirements for privacy, retention, tax, and payments where you operate.
