import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { analyzeWav, audioId } from "./audio.js";
import type { BubbleData, Palette, Playback } from "../shared/types.js";

export class SafeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
interface Row {
  id: string;
  source: "test" | "elevenlabs";
  duration: number;
  waveform: string;
  created_at: number;
}
export class AudioStore {
  readonly db: DatabaseSync;
  private key: Buffer;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(directory, "audio"), { recursive: true, mode: 0o700 });
    const keyPath = path.join(directory, "media-signing.key");
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32)
      throw new Error("Invalid persisted media signing key");
    this.db = new DatabaseSync(path.join(directory, "voice-bubble.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS audio (id TEXT PRIMARY KEY, source TEXT NOT NULL, duration REAL NOT NULL, waveform TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, audio_id TEXT NOT NULL);`);
  }
  path(id: string) {
    if (!/^vb_[a-f0-9]{64}$/.test(id))
      throw new SafeError("AUDIO_NOT_FOUND", "找不到此音频。");
    return path.join(this.directory, "audio", `${id}.wav`);
  }
  put(id: string, wav: Buffer, source: Row["source"]) {
    const analysis = analyzeWav(wav),
      filename = this.path(id),
      temporary = `${filename}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, wav, { mode: 0o600 });
      renameSync(temporary, filename);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    this.db
      .prepare("INSERT OR IGNORE INTO audio VALUES (?,?,?,?,?)")
      .run(
        id,
        source,
        analysis.durationSeconds,
        JSON.stringify(analysis.waveform),
        Date.now(),
      );
    return id;
  }
  seedDemo(fixture: string) {
    const wav = readFileSync(fixture),
      id = audioId(wav);
    if (!this.has(id)) this.put(id, wav, "test");
    return id;
  }
  has(id: string): boolean {
    return Boolean(this.db.prepare("SELECT id FROM audio WHERE id=?").get(id));
  }
  get(id: string, palette: Palette): BubbleData {
    const row = this.db
      .prepare("SELECT * FROM audio WHERE id=?")
      .get(id) as unknown as Row | undefined;
    if (!row || !existsSync(this.path(id)))
      throw new SafeError(
        "AUDIO_NOT_FOUND",
        "音频不存在或持久存储已丢失；不会自动重新生成。",
      );
    return {
      audioId: id,
      durationSeconds: row.duration,
      waveform: JSON.parse(row.waveform),
      source: row.source,
      palette,
      playback: { mimeType: "audio/wav", refreshTool: "get_voice_bubble" },
    };
  }
  sign(id: string, expires: number) {
    return createHmac("sha256", this.key)
      .update(`audio:${id}:${expires}`)
      .digest("hex");
  }
  playback(id: string, base: string, ttl: number, now = Date.now()): Playback {
    const expires = Math.floor(now / 1000) + ttl;
    return {
      url: `${base}/audio/${id}.wav?expires=${expires}&sig=${this.sign(id, expires)}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }
  verify(id: string, expires: unknown, signature: unknown, now = Date.now()) {
    if (
      typeof expires !== "string" ||
      !/^\d{1,12}$/.test(expires) ||
      typeof signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return false;
    if (
      Number(expires) <= Math.floor(now / 1000) ||
      !/^vb_[a-f0-9]{64}$/.test(id)
    )
      return false;
    return timingSafeEqual(
      Buffer.from(this.sign(id, Number(expires)), "hex"),
      Buffer.from(signature, "hex"),
    );
  }
  bindRequest(requestId: string | undefined, id: string) {
    if (!requestId) return;
    this.db
      .prepare("INSERT OR IGNORE INTO requests VALUES (?,?)")
      .run(requestId, id);
    const row = this.db
      .prepare("SELECT audio_id FROM requests WHERE request_id=?")
      .get(requestId);
    if (row?.audio_id !== id)
      throw new SafeError(
        "IDEMPOTENCY_CONFLICT",
        "此 request_id 已用于不同内容；请勿复用。",
      );
  }
  claim(id: string, retry: boolean) {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO jobs VALUES (?, 'pending', ?)")
      .run(id, Date.now());
    if (inserted.changes) return;
    const job = this.db
      .prepare("SELECT status, updated_at FROM jobs WHERE id=?")
      .get(id)!;
    const stale = Number(job.updated_at) < Date.now() - 180_000;
    if (retry && (job.status !== "pending" || stale)) {
      const changed = this.db
        .prepare(
          "UPDATE jobs SET status='pending', updated_at=? WHERE id=? AND status=? AND updated_at=?",
        )
        .run(Date.now(), id, job.status, job.updated_at);
      if (changed.changes) return;
    }
    throw new SafeError(
      "GENERATION_NOT_RETRIED",
      "此生成请求正在处理、曾失败或结果不确定。为避免重复计费，不会自动重试；检查 ElevenLabs 用量后，可明确授权 retry_failed。",
    );
  }
  finish(id: string, status: "ready" | "failed" | "uncertain") {
    this.db
      .prepare("UPDATE jobs SET status=?, updated_at=? WHERE id=?")
      .run(status, Date.now(), id);
  }
  close() {
    this.db.close();
  }
}
