ALTER TABLE whatsapp_connector.connections
  ADD COLUMN IF NOT EXISTS claim_owner text,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS ix_connections_claim_expiry
  ON whatsapp_connector.connections(claim_expires_at);
