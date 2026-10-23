-- Add size_bytes column to media_blobs so consumers can read file size
-- without loading the full bytea content. Backfill existing rows from
-- octet_length(content) so historical data is consistent.
ALTER TABLE whatsapp_connector.media_blobs
  ADD COLUMN IF NOT EXISTS size_bytes integer;

UPDATE whatsapp_connector.media_blobs
  SET size_bytes = octet_length(content)
  WHERE size_bytes IS NULL;

ALTER TABLE whatsapp_connector.media_blobs
  ALTER COLUMN size_bytes SET NOT NULL;
