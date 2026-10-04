CREATE TABLE IF NOT EXISTS whatsapp_connector.media_blobs (
  connection_id uuid NOT NULL,
  media_reference text NOT NULL,
  mime_type text,
  file_name text,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, media_reference)
);

CREATE INDEX IF NOT EXISTS ix_media_blobs_created_at
  ON whatsapp_connector.media_blobs(created_at);
