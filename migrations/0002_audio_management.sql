-- Additive migration: old audio stays intact; no transcript or credentials.
ALTER TABLE audio ADD COLUMN voice_id TEXT;
ALTER TABLE audio ADD COLUMN model_id TEXT;
CREATE INDEX audio_created_id ON audio(created_at DESC, id DESC);
CREATE INDEX requests_audio_id ON requests(audio_id);
-- Retain deleted markers to permanently revoke pre-upgrade links, even if the
-- deterministic audio ID is generated again. Object keys are never exposed.
CREATE TABLE audio_deletions (
  audio_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('deleting', 'deleted')),
  object_key TEXT NOT NULL,
  operation_token TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
