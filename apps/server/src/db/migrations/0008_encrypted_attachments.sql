-- End-to-end encrypted attachments.
--
-- Until now an upload was always a readable media file: the server sniffed its content type, stored
-- it under a name derived from its bytes, and served it back to whoever was allowed to see the
-- message. For a file that belongs to an encrypted conversation that is the wrong shape entirely —
-- the server must hold ciphertext it cannot interpret, and must not learn the file's real name or
-- type, which travel inside the encrypted payload instead.
--
-- `is_encrypted` is what tells the two cases apart downstream: no content sniffing applies, the
-- stored name is neutral, no thumbnail or transcode should ever be attempted, and a reader that
-- cannot decrypt the message cannot make sense of the file either.

alter table attachments add column is_encrypted boolean not null default false;

-- Encryption is decided by the client, so record it where the upload is audited, and make the
-- distinction visible to queries that reason about stored media.
create index attachments_encrypted_idx on attachments (is_encrypted) where is_encrypted;
