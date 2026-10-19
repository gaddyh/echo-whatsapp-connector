ALTER TABLE whatsapp_connector.connections
  ADD COLUMN IF NOT EXISTS account_phone_number text;
