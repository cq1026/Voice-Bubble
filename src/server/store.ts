import { analyzeWav, audioId, hex } from "./audio.js";
import type { BubbleData, Palette, Playback } from "../shared/types.js";
export class SafeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface AudioRow {
  id: string;
  source: "test" | "elevenlabs";
  duration: number;
  waveform: string;
  object_key: string;
  byte_length: number;
  created_at: number;
}
export interface Job {
  id: string;
  status: "pending" | "ready" | "failed" | "uncertain";
  attempt_token: string;
  updated_at: number;
  lease_expires_at: number;
}
export class AudioStore {
  private db: D1DatabaseSession;
  private key: Promise<CryptoKey>;
  constructor(
    database: D1Database,
    readonly bucket: R2Bucket,
    signingKey: string,
  ) {
    // First read from primary, then sequential consistency. Never claim using a stale replica snapshot.
    this.db = database.withSession("first-primary");
    this.key = crypto.subtle.importKey(
      "raw",
      Uint8Array.from(signingKey.match(/../g)!, (h) => parseInt(h, 16)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  row(id: string) {
    return this.db
      .prepare("SELECT * FROM audio WHERE id=?")
      .bind(id)
      .first<AudioRow>();
  }
  job(id: string) {
    return this.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .bind(id)
      .first<Job>();
  }
  async seedDemo(wav: Uint8Array) {
    const id = await audioId(wav),
      key = `demo/${id}.wav`;
    if (await this.row(id)) return id;
    const analysis = analyzeWav(wav);
    await this.bucket.put(key, new Uint8Array(wav), {
      httpMetadata: { contentType: "audio/wav" },
    });
    await this.db
      .prepare("INSERT OR IGNORE INTO audio VALUES (?, 'test', ?, ?, ?, ?, ?)")
      .bind(
        id,
        analysis.durationSeconds,
        JSON.stringify(analysis.waveform),
        key,
        wav.length,
        Date.now(),
      )
      .run();
    return id;
  }
  async get(id: string, palette: Palette): Promise<BubbleData> {
    const row = await this.row(id);
    if (!row || !(await this.bucket.head(row.object_key))) {
      const job = row ? null : await this.job(id);
      if (job)
        throw new SafeError(
          "GENERATION_NOT_RETRIED",
          `任务状态：${job.status}。audio_id: ${id}。不会自动重新生成；稍后读取，或检查用量后明确授权重试。`,
        );
      throw new SafeError(
        "AUDIO_NOT_FOUND",
        "音频不存在或 R2 对象已丢失；不会自动重新生成。",
      );
    }
    return {
      audioId: id,
      durationSeconds: row.duration,
      waveform: JSON.parse(row.waveform),
      source: row.source,
      palette,
      playback: { mimeType: "audio/wav", refreshTool: "get_voice_bubble" },
    };
  }
  async bindRequest(requestId: string | undefined, id: string) {
    if (!requestId) return;
    const results = await this.db.batch([
      this.db
        .prepare("INSERT OR IGNORE INTO requests VALUES (?,?,?)")
        .bind(requestId, id, Date.now()),
      this.db
        .prepare("SELECT audio_id FROM requests WHERE request_id=?")
        .bind(requestId),
    ]);
    if ((results[1].results[0] as { audio_id: string }).audio_id !== id)
      throw new SafeError(
        "IDEMPOTENCY_CONFLICT",
        "此 request_id 已用于不同内容；请勿复用。",
      );
  }
  async claim(
    id: string,
    retry: boolean,
    now = Date.now(),
  ): Promise<string | null> {
    const token = crypto.randomUUID();
    // One SQL statement serializes across Worker isolates; explicit retries use the same CAS.
    const claimed = await this.db
      .prepare(
        `INSERT INTO jobs VALUES (?, 'pending', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status='pending', attempt_token=excluded.attempt_token,
        updated_at=excluded.updated_at, lease_expires_at=excluded.lease_expires_at
      WHERE ?=1 AND (jobs.status IN ('failed','uncertain') OR (jobs.status='pending' AND jobs.lease_expires_at<=?))
        AND NOT EXISTS (SELECT 1 FROM audio WHERE id=jobs.id)
      RETURNING attempt_token`,
      )
      .bind(id, token, now, now + 180_000, retry ? 1 : 0, now)
      .first<{ attempt_token: string }>();
    return claimed?.attempt_token ?? null;
  }
  async complete(id: string, token: string, wav: Uint8Array) {
    const analysis = analyzeWav(wav),
      key = `audio/${id}/${token}.wav`;
    // Each attempt has an immutable key: a late, fenced-out writer cannot replace a newer result.
    await this.bucket.put(key, new Uint8Array(wav), {
      httpMetadata: { contentType: "audio/wav" },
    });
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO audio (id,source,duration,waveform,object_key,byte_length,created_at)
        SELECT ?, 'elevenlabs', ?, ?, ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM jobs WHERE id=? AND attempt_token=? AND status='pending')
        ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          id,
          analysis.durationSeconds,
          JSON.stringify(analysis.waveform),
          key,
          wav.length,
          Date.now(),
          id,
          token,
        ),
      this.db
        .prepare(
          `UPDATE jobs SET status='ready', updated_at=? WHERE id=? AND attempt_token=? AND status='pending'
        AND EXISTS (SELECT 1 FROM audio WHERE id=? AND object_key=?)`,
        )
        .bind(Date.now(), id, token, id, key),
    ]);
    if (!results[1].meta.changes)
      throw new SafeError(
        "GENERATION_UNCERTAIN",
        "任务已被更新，旧生成结果未发布；不会自动重新生成。",
      );
    // On ambiguous D1 failure, retain the R2 object for recovery. Never assume a paid request is safe to repeat.
  }
  async finish(id: string, token: string, status: "failed" | "uncertain") {
    await this.db
      .prepare(
        "UPDATE jobs SET status=?, updated_at=? WHERE id=? AND attempt_token=? AND status='pending'",
      )
      .bind(status, Date.now(), id, token)
      .run();
  }
  async playback(
    id: string,
    base: string,
    ttl: number,
    now = Date.now(),
  ): Promise<Playback> {
    const expires = Math.floor(now / 1000) + ttl;
    const sig = hex(
      await crypto.subtle.sign(
        "HMAC",
        await this.key,
        new TextEncoder().encode(`audio:${id}:${expires}`),
      ),
    );
    return {
      url: `${base}/audio/${id}.wav?expires=${expires}&sig=${sig}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }
  async verify(
    id: string,
    expires: unknown,
    signature: unknown,
    now = Date.now(),
  ) {
    if (
      typeof expires !== "string" ||
      !/^\d{1,12}$/.test(expires) ||
      typeof signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      Number(expires) <= Math.floor(now / 1000) ||
      !/^vb_[a-f0-9]{64}$/.test(id)
    )
      return false;
    return crypto.subtle.verify(
      "HMAC",
      await this.key,
      Uint8Array.from(signature.match(/../g)!, (h) => parseInt(h, 16)),
      new TextEncoder().encode(`audio:${id}:${Number(expires)}`),
    );
  }
}
