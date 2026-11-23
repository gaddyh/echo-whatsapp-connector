-- Add ON DELETE CASCADE foreign key from media_blobs to connections.
-- Migration 004 created media_blobs without a foreign key, so deleting a
-- connection left orphaned media content. Clean any existing orphans first,
-- then add the constraint so future connection deletes cascade media.
--
-- The constraint add is guarded by a pg_constraint check: migrate.ts has no
-- applied-migrations ledger and re-runs every file on each invocation, so
-- every file must be idempotent. A bare ADD CONSTRAINT fails once the
-- constraint already exists (Postgres has no ADD CONSTRAINT IF NOT EXISTS).

DELETE FROM whatsapp_connector.media_blobs m
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_connector.connections c WHERE c.id = m.connection_id
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'media_blobs_connection_id_fkey'
       AND conrelid = 'whatsapp_connector.media_blobs'::regclass
  ) THEN
    ALTER TABLE whatsapp_connector.media_blobs
      ADD CONSTRAINT media_blobs_connection_id_fkey
      FOREIGN KEY (connection_id)
      REFERENCES whatsapp_connector.connections(id)
      ON DELETE CASCADE;
  END IF;
END
$$;
