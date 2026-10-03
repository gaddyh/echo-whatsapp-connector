ALTER TABLE whatsapp_connector.connections
  ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 0;
