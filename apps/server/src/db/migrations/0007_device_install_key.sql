-- ============================================================================
-- 0007 — a device row is an install, not a login
-- ============================================================================
--
-- Until now every successful login inserted a brand-new device row. For a browser
-- that reuses one profile that is simply wrong, and it failed in three ways:
--
--  * the E2EE identity is keyed by device id, so every sign-in orphaned the Olm
--    account stored in the browser and published yet another device bundle —
--    the account slowly filled with devices that can never decrypt anything;
--  * every orphaned device keeps its own one-time key pool, so first messages
--    started failing for "a device that stopped answering" instead of for the
--    users who genuinely have no keys;
--  * sessions accumulated until `MAX_ACTIVE_SESSIONS` locked the user out of
--    their own account with no way back in short of revoking devices.
--
-- Clients now send a stable, client-generated install key with register/login.
-- It is an identifier, not a credential: it is only ever resolved *within* the
-- authenticated user's own devices, so leaking it grants nothing.
-- ============================================================================

alter table devices add column if not exists install_key text;

comment on column devices.install_key is
  'Stable per-installation identifier supplied by the client; re-login reuses the device row.';

create unique index if not exists devices_user_install_key_idx
  on devices (user_id, install_key)
  where install_key is not null;
