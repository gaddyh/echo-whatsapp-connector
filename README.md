# echo-whatsapp-connector

A narrow, production-oriented WhatsApp linked-device connector for **Echo Guard**, built on [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys).

The service owns WhatsApp connectivity. Echo Guard owns the product/domain.

## Why this exists

Echo already has provider-neutral WhatsApp ports (`WhatsAppProvisioner`, `WhatsAppMessaging`, canonical provider events). This repo implements the same semantics using Baileys instead of Green API.

Goals:

- no third-party WhatsApp gateway between WhatsApp and Echo infrastructure;
- much lower per-user infrastructure cost than browser/Chromium-based automation;
- encrypted PostgreSQL-backed Baileys auth state (no production auth files);
- stable opaque `connection_id` boundary;
- group/LID-aware message normalization for Guard;
- restart/reconnect without requiring a new QR unless WhatsApp actually logs the linked device out;
- small, replaceable transport service with no Guard/AI logic.

## Non-goals

This is **not** a generic WhatsApp bot platform. It intentionally does not include:

- Guard analysis or alert policy;
- marketing/bulk messaging;
- proxy rotation or anti-ban behavior;
- Kubernetes/autoscaling machinery;
- one container per user;
- a full chat-history product database.

## Architecture

```text
                           shared PostgreSQL
                    ┌──────────────┴──────────────┐
                    │                             │
          echo-whatsapp-connector             Echo Guard
                    │                             │
        ┌───────────┴───────────┐                 │
        │                       │                 │
   Baileys session A       Baileys session B      │
        │                       │                 │
        └──────── WhatsApp WebSockets ────────────┘

connector-owned schema: whatsapp_connector
```

Recommended first production topology:

```text
EC2 worker A + stable public IP     EC2 worker B + stable public IP
└─ Docker connector                └─ Docker connector
   └─ ~10–20 sessions                 └─ ~10–20 sessions

                 │
            shared Postgres
```

Start small and measure real RSS/CPU/reconnect behavior before increasing sessions per worker.

## Echo protocol mapping

The HTTP API is intentionally shaped around Echo's existing provider-neutral semantics.

| Echo capability | Connector endpoint |
|---|---|
| `WhatsAppProvisioner.create_connection` | `POST /connections` |
| `configure_connection` | `PUT /connections/:id/config` (webhook settings retained as metadata; Baileys owns the socket) |
| `get_status` | `GET /connections/:id/status` |
| `get_pairing_qr` | `GET /connections/:id/qr` |
| phone pairing code | `POST /connections/:id/pairing-code` |
| `unpair` | `POST /connections/:id/unpair` |
| `delete_connection` | `DELETE /connections/:id` |
| `WhatsAppMessaging.send_message` | `POST /connections/:id/messages` |
| provider events | normalized rows in `whatsapp_connector.event_inbox` (default) |

Echo should expose this connector through a Python `BaileysProvisioner` / `BaileysMessaging` / `BaileysEventAdapter`, preserving its existing ports.

## Connection states

The connector emits provider-neutral states:

- `provisioning`
- `connecting`
- `pairing_required`
- `connected`
- `degraded`
- `blocked`
- `suspended`
- `unknown`

Transient socket failures must **not** erase auth state. A true WhatsApp logout/device removal maps to `pairing_required`.

## PostgreSQL auth state

Baileys auth has two independently changing parts:

```text
AuthenticationState
├─ creds
└─ keys (Signal sessions, prekeys, sender keys, LID mappings, etc.)
```

This repo persists both to PostgreSQL and encrypts each payload with AES-256-GCM using `AUTH_ENCRYPTION_KEY`.

Tables are under the dedicated `whatsapp_connector` schema:

- `connections`
- `auth_credentials`
- `auth_keys`
- `identities`
- `groups`
- `group_participants`
- `event_inbox`

The connector owns those tables even when using the same PostgreSQL database as Echo Guard.

Managed PostgreSQL providers such as Render require SSL: set `DATABASE_SSL=true` there. Local docker PostgreSQL does not — set `DATABASE_SSL=false`. Booleans are parsed with `z.stringbool()`, so the words `true`/`false` are honored exactly as written.

### Why not `useMultiFileAuthState`?

Baileys' own production guidance recommends implementing a proper SQL/NoSQL auth store instead of its multi-file example helper. Keeping auth in Postgres makes workers disposable and enables moving a connection between EC2 instances without copying local directories.

## LID identity strategy

WhatsApp increasingly uses LID (`...@lid`) rather than phone-number JIDs as the primary identity.

Guard therefore treats:

```text
LID          = preferred canonical participant identity
phone JID    = optional metadata
phone number = optional metadata
```

A group message may contain both `participant` and `participantAlt`; the normalizer preserves both and uses LID when present.

## Normalized message event

Typical event written to `event_inbox.payload`:

```json
{
  "event_type": "message",
  "event_id": "message:<connection-id>:<message-id>:in",
  "provider": "baileys",
  "connection_id": "...",
  "chat_id": "120363...@g.us",
  "is_group": true,
  "provider_message_id": "ABC123",
  "direction": "inbound",
  "source": null,
  "timestamp": "2026-10-02T12:00:00.000Z",
  "kind": "text",
  "text": "...",
  "sender": {
    "canonical_id": "123456789@lid",
    "lid": "123456789@lid",
    "phone_jid": "972501234567@s.whatsapp.net",
    "phone_number": "972501234567",
    "display_name": "Maya"
  },
  "quoted_message_id": "OPTIONAL"
}
```

Provider/Baileys protobuf objects never cross this boundary.

## Event delivery

Default (`EVENT_SINK=db`): connector inserts normalized events into:

```text
whatsapp_connector.event_inbox
```

Rows are unique on `(connection_id, event_id)` for idempotency. Echo Guard can consume unprocessed rows and set `processed_at`.

A retention sweep runs hourly (`RETENTION_SWEEP_INTERVAL_MS`, 0 disables) and deletes processed events older than `EVENT_RETENTION_DAYS` (7), never-consumed events older than `UNPROCESSED_EVENT_RETENTION_DAYS` (30), and `media_blobs` older than `MEDIA_RETENTION_DAYS` (30). Each rule can be disabled by setting its days to 0.

Optional (`EVENT_SINK=http`): connector posts the same normalized JSON to `EVENT_WEBHOOK_URL` with optional bearer auth. HTTP delivery is guarded by the local session generation, but cannot provide the same atomic fencing guarantee as the database sink.

## Lease recovery and runtime health

The connector renews each 30-second connection lease every 10 seconds. A renewal timeout or database transport error makes ownership unverified: the Baileys socket is stopped immediately, credentials are retained, and the `SessionManager` schedules recovery with bounded exponential backoff and jitter. Recovery must acquire a valid fencing token before opening a new socket; it never maps a database failure to `pairing_required`.

Connection status responses include persisted provider status separately from runtime health. A connection is only runtime-healthy when its session and socket are active, the lease is valid, and recovery is not pending. During a database outage, runtime state is `claim_unverified` rather than an inferred expired lease.

## API

All endpoints except `/health` require:

```http
Authorization: Bearer <INTERNAL_API_TOKEN>
```

### Create connection

```http
POST /connections
Content-Type: application/json

{
  "phone_number": "972501234567"
}
```

Response:

```json
{
  "connection_id": "uuid",
  "status": "provisioning"
}
```

### Status

```http
GET /connections/:id/status
```

### QR

```http
GET /connections/:id/qr
```

Possible response:

```json
{
  "outcome": "qr_ready",
  "image_base64": "..."
}
```

or `already_authorized` / `timeout`.

A connection that was never paired and exhausts its pairing QR refs goes dormant as `pairing_required` (`qr_expired`) instead of cycling re-registration forever. It is revived on demand by the pairing endpoints above; auth state is preserved.

### Pair with phone-number code

```http
POST /connections/:id/pairing-code
Content-Type: application/json

{
  "phone_number": "972501234567"
}
```

### Send text

```http
POST /connections/:id/messages
Content-Type: application/json

{
  "chat_id": "972501234567@s.whatsapp.net",
  "message": "hello"
}
```

Response:

```json
{
  "provider_message_id": "..."
}
```

### Unpair vs delete

`POST /connections/:id/unpair`
- logs the linked device out;
- clears Baileys auth;
- keeps the connector connection row;
- moves state to `pairing_required`.

`DELETE /connections/:id`
- stops the session;
- removes connector-owned connection/auth/cache rows via FK cascade.

## Local development

Requirements:

- Node.js 20+
- Docker (optional, for local Postgres)

```bash
cp .env-example .env
# set AUTH_ENCRYPTION_KEY:
openssl rand -base64 32

docker compose up -d postgres
npm install
npm run migrate
npm run dev
```

Health:

```bash
curl http://localhost:8080/health
```

## Docker

```bash
docker build -t echo-whatsapp-connector .
docker run --env-file .env -p 8080:8080 echo-whatsapp-connector
```

Run migrations before starting a new release:

```bash
npm run migrate
```

## Deployment guidance

For the first 20–100 Guard users:

1. one connector container per small EC2 worker;
2. up to 100 sessions per worker (L3 herd-verified: a full 100-session restart ramp, claim-renewal wave and mass reconnect all pass against real PostgreSQL);
3. use a stable public/Elastic IP per worker if IP stability matters operationally;
4. shared PostgreSQL for encrypted auth and event inbox;
5. stagger restored sessions using `SESSION_START_STAGGER_MS`;
6. pin the Baileys package version;
7. test a new Baileys version on staging before rolling it to all workers;
8. never clear auth on ordinary reconnect/version failures.

This scaffold does **not** implement distributed worker claiming yet. `worker_id` is persisted and sessions assigned to the current `WORKER_ID` are restored. Before running multiple workers that can dynamically take ownership of the same connection, add a DB advisory lock or Redis lease so exactly one live process can own a WhatsApp session.

## Ops log monitor

With `LOG_MONITOR_ENABLED=true`, the connector tees its structured logs into a bounded in-memory ring and, every `LOG_MONITOR_DIGEST_MS` (default 1h), sends aggregated counters plus redacted warn/error samples to an LLM (`OPENAI_MODEL`, default `gpt-5.6-luna`) that writes an hourly digest: what happened, what resolved from the previous hour, and what is still open. The digest is logged (`component: 'log-monitor'`) and, when `OPS_ALERT_ENDPOINT` is set, POSTed there (`{severity, title, body, source, worker_id, timestamp}` with Bearer `OPS_ALERT_TOKEN`) — e.g. to an echo-v2 ops-alert bridge that relays it to WhatsApp. The LLM only ever sees redacted aggregates: phone numbers masked, connection ids truncated, JIDs stripped; a model or delivery failure falls back to a locally rendered digest so the heartbeat never goes silent.

## Browser fingerprint

Each connection presents a realistic browser identity (weighted palette: Chrome/Edge/Firefox/Safari across Windows/macOS/Linux), chosen once at pairing and persisted in `connections.settings` — it never changes for the life of the connection, so a fleet naturally becomes a mixture of pairing-time vintages like a real device population. In the child's WhatsApp "Linked devices" screen the connector therefore appears as e.g. "Chrome on Windows" rather than a fixed product name. Set `BAILEYS_BROWSER_NAME` to force the legacy single fixed identity for all connections (rollback/testing). Note that a name which is not a real browser (like a product name) registers with WhatsApp as `OTHER_WEB_CLIENT`, which real WhatsApp Web populations do not use — which is why the palette uses genuine browser names.

## WhatsApp Web version override

Normal behavior uses Baileys' current `fetchLatestWaWebVersion()`.

For an incident or controlled rollback, set:

```text
WA_WEB_VERSION_OVERRIDE=2.3000.xxxxxxxxxx
```

This is intentionally operational configuration rather than Guard business logic.

## Security

- auth credentials and Signal keys are encrypted before PostgreSQL storage;
- auth/QR values are redacted from logs;
- no per-user provider API token is exposed to Echo;
- connector API is internal and bearer-authenticated;
- never log message bodies in infrastructure logs;
- rotate `AUTH_ENCRYPTION_KEY` only through a planned re-encryption migration;
- treat the DB auth tables as equivalent to linked-device credentials.

## Current limitations / next POC work

This is a strong **repo scaffold**, not yet a claim that production behavior has been validated against a live WhatsApp account. Before pilot use, validate:

- Postgres auth survives container + EC2 restart without QR;
- pairing code behavior with the currently supported WhatsApp protocol;
- LID/PN identity consistency in real groups;
- contact/display-name resolution rate;
- group metadata/participant cache population;
- 10 min / 2 h / 8 h disconnect recovery;
- Baileys package upgrade while preserving auth;
- actual `401/device_removed` behavior;
- memory per session under Guard traffic;
- message loss/duplication under restart/reconnect;
- outbound `source=api` correlation under races/restarts.

## Recommended POC exit criteria

```text
pair 2–3 accounts
→ persist auth in Postgres
→ restart container / machine
→ no QR
→ receive private + group messages
→ stable LID identity resolution
→ normalized event appears once in event_inbox
→ Echo Guard consumes it
→ deliberate 10m / 2h / 8h outage reconnects cleanly
```
