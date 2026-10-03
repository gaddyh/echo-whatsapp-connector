CREATE SCHEMA IF NOT EXISTS whatsapp_connector;

CREATE TABLE IF NOT EXISTS whatsapp_connector.connections (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'provisioning',
  raw_status text,
  phone_number text,
  worker_id text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_connected_at timestamptz,
  last_event_at timestamptz,
  last_disconnect_reason text,
  reconnect_count integer NOT NULL DEFAULT 0,
  state_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_connections_worker_status
  ON whatsapp_connector.connections(worker_id, status);

CREATE TABLE IF NOT EXISTS whatsapp_connector.auth_credentials (
  connection_id uuid PRIMARY KEY REFERENCES whatsapp_connector.connections(id) ON DELETE CASCADE,
  encrypted_payload bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_connector.auth_keys (
  connection_id uuid NOT NULL REFERENCES whatsapp_connector.connections(id) ON DELETE CASCADE,
  category text NOT NULL,
  key_id text NOT NULL,
  encrypted_payload bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id, category, key_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_connector.identities (
  connection_id uuid NOT NULL REFERENCES whatsapp_connector.connections(id) ON DELETE CASCADE,
  canonical_id text NOT NULL,
  lid text,
  phone_jid text,
  phone_number text,
  push_name text,
  saved_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id, canonical_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_identities_lid
  ON whatsapp_connector.identities(connection_id, lid) WHERE lid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_identities_phone_jid
  ON whatsapp_connector.identities(connection_id, phone_jid) WHERE phone_jid IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_connector.groups (
  connection_id uuid NOT NULL REFERENCES whatsapp_connector.connections(id) ON DELETE CASCADE,
  group_jid text NOT NULL,
  subject text,
  owner_jid text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id, group_jid)
);

CREATE TABLE IF NOT EXISTS whatsapp_connector.group_participants (
  connection_id uuid NOT NULL REFERENCES whatsapp_connector.connections(id) ON DELETE CASCADE,
  group_jid text NOT NULL,
  canonical_id text NOT NULL,
  lid text,
  phone_jid text,
  display_name text,
  role text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id, group_jid, canonical_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_connector.event_inbox (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL,
  connection_id uuid NOT NULL REFERENCES whatsapp_connector.connections(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  provider_message_id text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE(connection_id, event_id)
);

CREATE INDEX IF NOT EXISTS ix_event_inbox_unprocessed
  ON whatsapp_connector.event_inbox(received_at)
  WHERE processed_at IS NULL;
