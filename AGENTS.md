# AGENTS.md

## Purpose
`echo-whatsapp-connector` is a narrow Baileys transport service for Echo Guard.
It owns WhatsApp linked-device connectivity, Baileys auth state, reconnect lifecycle,
LID/PN identity mappings, and normalization of WhatsApp events.

It does **not** own Guard analysis, alert policy, user/family domain logic, or product UX.

## Architectural contract
The public behavior of this repo must remain semantically compatible with Echo's existing provider-neutral ports:
- `WhatsAppProvisioner`
- `WhatsAppMessaging`
- `WhatsAppEventAdapter` / canonical provider events

Do not leak Baileys types (`WAMessage`, `WASocket`, LID internals, protobuf types) across the HTTP/event boundary.

## Provider neutrality
Echo Guard should be able to replace this service with Green API, Meta Cloud API, or another provider without changing Guard domain logic.

## Connection identity
Use connector `connection_id` as the opaque provider connection id exposed to Echo.
Inside the connector, prefer WhatsApp LID as canonical participant identity when available;
phone JID/number are optional metadata.

## Persistence
Production auth state must use PostgreSQL. Do not use `useMultiFileAuthState` in production.
Persist both credentials and all Signal key categories. Encrypt auth payloads before DB storage.

## Session safety
Exactly one live Baileys socket may own a connection at a time.
Never clear auth state on transient disconnects, version incompatibility, 408/428/515, or process restart.
Only mark `PAIRING_REQUIRED` / clear auth after an explicit logged-out/device-removed condition or an operator-requested unpair/delete.

## Restart behavior
Stagger session startups after worker restart to avoid reconnect storms.

## Scope discipline
Do not add generic bot-platform features, marketing automation, Kubernetes, proxy rotation, or Guard analyzer logic to this repo.
