# Plan: Two-Pipeline Ingestion + SQLite Write-Ahead Outbox (rev 5 — FINAL)

Rev 4 + review corrections: no I/O before append (group names via in-memory
cache), single bounded publish attempt (no in-loop retries), bounded
background work, media-availability metric, and the PG-outage soak test as
the acceptance gate. No further planning rounds — this is the build spec.

## Ingestion flow (final)

```
messages.upsert, per message:
  normalize                                    (CPU)
  → source='api' check                         (memory Set)
  → media_download_url                         (local HMAC)
  → chat_name via in-memory group name cache   (memory Map; miss → nameless)
  → outbox.append(FINAL event)                 (SQLite, WAL, ~0.1ms)
  → publish: ONE attempt, race-bounded 5s       (normal ~10ms; outage: fast-fail)
      success → outbox.delete
      failure/timeout → LEAVE in outbox; drainer replays
  → enqueue background work (bounded, see below)

background queue (per worker, POST_PUBLISH_CONCURRENCY=8, queue cap 500):
  identity upserts · groupMetadata cache warming · DOWNLOAD_MEDIA blob warming
  (drop+warn on overflow; identity/group data self-heals on reconnect)

drainer (30s tick + boot): replays READY outbox rows → insertEventUnfenced
  (ON CONFLICT DO NOTHING) → delete on success; FK 23503 → auditable drop;
  transient error → stop batch, retry next tick
```

**Zero I/O before append.** The critical path is: normalize + three memory
lookups + one local SQLite write. Ingestion continues at append speed
during a full Postgres outage, bounded only by outbox capacity.

## Event shape (echo-v2 contract unchanged)

`media_download_url` (local, expires as today), `media_size` = declared
fileLength, `source` as today. `chat_name`: present for groups whose name is
in the in-memory cache (populated by groups.upsert/update handlers and
post-publish warming); first event per group per session lifetime may be
nameless — cosmetic, self-heals.

## Review corrections → implementation

1. **Group cache after append** → in-memory name cache (zero-I/O pre-append
   read; DB/WA lookups only in the background queue). One line removes it if
   even the memory read is unwanted.
2. **Bounded background work** → minimal semaphore queue, no new deps.
3. **Media availability metric** → `media_fetch_unavailable_after_restart`
   counter on the blob-miss + map-miss path in `downloadMedia`.
4. **Publish must not delay ingestion** → single bounded attempt, retries
   removed; the drainer is the retry mechanism.

## Schema (no state machine — immutable payloads)

```sql
CREATE TABLE IF NOT EXISTS outbox (
  connection_id TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (connection_id, event_id)
);
```

Capacity: soft (10k) pressure warning; hard (20k) refuse + critical signal;
no eviction. Write failure: critical log + `outbox_write_failures`; direct
publish still attempted. FK on replay: auditable terminal drop. Metrics:
`outbox_pending_count`, `outbox_oldest_age_seconds`, `outbox_disk_bytes`,
`outbox_write_failures`, `media_fetch_unavailable_after_restart`.

## Race-condition map (final)

RC-1 (append→crash→PG) unit · RC-2 (PG-commit→crash→delete) **L3 real PG,
exactly-once** · RC-4 (FK terminal) L3 · RC-5 (drainer+session, identical
payloads) unit/L3 · RC-7/12 (capacity refusal) unit · RC-8 (partial drain)
unit · RC-9 (SQLite fail → critical + direct PG) unit · RC-10/14 (restart
drain) unit+L3 · RC-13 (both down → explicit signal) unit · RC-11 (crash
during post-publish work → event already durable) handler-order test.
RC-16/17/18: structurally impossible (no post-append mutation).

## Acceptance test (the gate)

**L3 PG-outage soak**: with the herd harness running simulated messages:
1. `docker stop` the Postgres container mid-flow
2. ingestion continues: every event lands in SQLite (assert count, zero
   loss, no eviction below capacity)
3. `docker start` + wait healthy
4. drain → **every event in `event_inbox` exactly once** (count match +
   no duplicates)

Plus: handler-order test (append precedes all background work),
publish-hang test (second message ingests while first publish hangs),
bounded-attempt timeout test, background-queue overflow test.

## Files

- `src/events/outbox.ts` — EventOutbox (append/delete/pending/count/
  oldestAge/diskBytes, capacity, WAL NORMAL), getOutbox(), drainer,
  startOutboxDrainer/stopOutboxDrainer
- `src/events/sink.ts` — insertEventUnfenced
- `src/events/background-queue.ts` — bounded semaphore queue
- `src/sessions/session.ts` — handler restructure per flow; in-memory
  group name cache; publishEventWithRetry → single bounded attempt
- `src/app.ts` — drainer wiring (after SELECT 1 gate)
- `src/config/env.ts` — EVENT_OUTBOX_DIR/MAX_EVENTS/HARD_MAX/DRAIN_MS,
  POST_PUBLISH_CONCURRENCY, PUBLISH_ATTEMPT_TIMEOUT_MS
- `src/monitor/counters.ts` + prompt — new metrics
- `vitest.config.ts` gate, `.gitignore` data/, `package.json`
  better-sqlite3
- Tests: `tests/event-outbox.test.ts` (all unit rows), session-lifecycle
  updates, L3 RC-2/RC-4/RC-14 + PG-outage soak, log-counters

## Guarantee

> Once a message event has been successfully committed to the outbox, it
> will remain recoverable until PostgreSQL acknowledges it or an explicitly
> defined terminal policy applies.

Pre-append window (normalize + memory + local write, milliseconds) stated;
`synchronous=NORMAL` power-loss caveat documented; deploy-during-outage
needs the persistent disk (gate item before paying users).
