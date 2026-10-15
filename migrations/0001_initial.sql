-- D1 is the source of truth. No text, access tokens or provider secrets are stored.
CREATE TABLE audio (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('test', 'elevenlabs')),
  duration REAL NOT NULL CHECK(duration > 0),
  waveform TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  created_at INTEGER NOT NULL
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed', 'uncertain')),
  attempt_token TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL
);
CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  audio_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
