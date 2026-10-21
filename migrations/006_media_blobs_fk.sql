-- Add ON DELETE CASCADE foreign key from media_blobs to connections.
-- Migration 004 created media_blobs without a foreign key, so deleting a
-- connection left orphaned media content. Clean any existing orphans first,
-- then add the constraint so future connection deletes cascade media.

DELETE FROM whatsapp_connector.media_blobs m
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_connector.connections c WHERE c.id = m.connection_id
);

ALTER TABLE whatsapp_connector.media_blobs
  ADD CONSTRAINT media_blobs_connection_id_fkey
  FOREIGN KEY (connection_id)
  REFERENCES whatsapp_connector.connections(id)
  ON DELETE CASCADE;
