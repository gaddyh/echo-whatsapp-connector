-- Typed partial index for Echo's claim polls. The legacy
-- ix_event_inbox_unprocessed (received_at WHERE processed_at IS NULL)
-- made every claim SELECT scan all unprocessed rows regardless of
-- event_type; with (event_type, received_at, id) each consumer only walks
-- its own event type.
--
-- Exactly one statement in this file, on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block, and both src/db/migrate.ts and
-- tests/herd-postgres.test.ts send each migration file as a single
-- simple-protocol query string. A multi-statement string would run inside
-- an implicit transaction and fail; a single statement autocommits.
--
-- If this build is interrupted it can leave an INVALID index behind that
-- IF NOT EXISTS will then skip. Verify with:
--   SELECT indisvalid FROM pg_index
--    WHERE indexrelid::regclass::text =
--      'whatsapp_connector.ix_event_inbox_unprocessed_typed';
-- (must be true; if not, DROP INDEX CONCURRENTLY it and re-run migrations)
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_event_inbox_unprocessed_typed
  ON whatsapp_connector.event_inbox(event_type, received_at, id)
  WHERE processed_at IS NULL;
