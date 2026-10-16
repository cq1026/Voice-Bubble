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
  voice_id: string | null;
  model_id: string | null;
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
      .prepare(
        "SELECT a.* FROM audio a WHERE id=? AND NOT EXISTS (SELECT 1 FROM audio_deletions d WHERE d.audio_id=a.id AND d.state='deleting')",
      )
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
      .prepare(
        "INSERT OR IGNORE INTO audio (id,source,duration,waveform,object_key,byte_length,created_at) VALUES (?, 'test', ?, ?, ?, ?, ?)",
      )
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
    await this.assertNotDeleting(id);
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
        .prepare(
          "INSERT OR IGNORE INTO requests SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM audio_deletions WHERE audio_id=? AND state='deleting')",
        )
        .bind(requestId, id, Date.now(), id),
      this.db
        .prepare("SELECT audio_id FROM requests WHERE request_id=?")
        .bind(requestId),
    ]);
    await this.assertNotDeleting(id);
    if (
      (results[1].results[0] as { audio_id: string } | undefined)?.audio_id !==
      id
    )
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
        `INSERT INTO jobs SELECT ?, 'pending', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM audio_deletions WHERE audio_id=? AND state='deleting') AND NOT EXISTS (SELECT 1 FROM audio WHERE id=?)
      ON CONFLICT(id) DO UPDATE SET status='pending', attempt_token=excluded.attempt_token,
        updated_at=excluded.updated_at, lease_expires_at=excluded.lease_expires_at
      WHERE ?=1 AND (jobs.status IN ('failed','uncertain') OR (jobs.status='pending' AND jobs.lease_expires_at<=?))
        AND NOT EXISTS (SELECT 1 FROM audio WHERE id=jobs.id)
      RETURNING attempt_token`,
      )
      .bind(id, token, now, now + 180_000, id, id, retry ? 1 : 0, now)
      .first<{ attempt_token: string }>();
    if (!claimed) await this.assertNotDeleting(id);
    return claimed?.attempt_token ?? null;
  }
  async complete(
    id: string,
    token: string,
    wav: Uint8Array,
    metadata?: { voice: string; model: string },
  ) {
    const current = await this.job(id);
    if (
      !current ||
      current.status !== "pending" ||
      current.attempt_token !== token
    )
      throw new SafeError(
        "GENERATION_UNCERTAIN",
        "旧任务已完成、被替代或删除；不会写入或发布旧音频。",
      );
    await this.assertNotDeleting(id);
    const analysis = analyzeWav(wav),
      key = `audio/${id}/${token}.wav`;
    // Each attempt has an immutable key: a late, fenced-out writer cannot replace a newer result.
    await this.bucket.put(key, new Uint8Array(wav), {
      httpMetadata: { contentType: "audio/wav" },
    });
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO audio (id,source,duration,waveform,object_key,byte_length,created_at,voice_id,model_id)
        SELECT ?, 'elevenlabs', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM jobs WHERE id=? AND attempt_token=? AND status='pending')
          AND NOT EXISTS (SELECT 1 FROM audio_deletions WHERE audio_id=? AND state='deleting')
        ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          id,
          analysis.durationSeconds,
          JSON.stringify(analysis.waveform),
          key,
          wav.length,
          Date.now(),
          metadata?.voice ?? null,
          metadata?.model ?? null,
          id,
          token,
          id,
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
  async list(
    limit = 20,
    cursor?: { created_at: number; audio_id: string },
    source?: "demo" | "elevenlabs",
  ) {
    const filter = `NOT EXISTS (SELECT 1 FROM audio_deletions d WHERE d.audio_id=a.id AND d.state='deleting') AND (? IS NULL OR a.source=?)`;
    const selectedSource = source === "demo" ? "test" : (source ?? null);
    const results = await this.db.batch([
      this.db
        .prepare(
          `SELECT a.id,a.source,a.duration,a.byte_length,a.created_at,a.voice_id,a.model_id FROM audio a
        WHERE ${filter} AND (? IS NULL OR a.created_at<? OR (a.created_at=? AND a.id<?))
        ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
        )
        .bind(
          selectedSource,
          selectedSource,
          cursor?.created_at ?? null,
          cursor?.created_at ?? null,
          cursor?.created_at ?? null,
          cursor?.audio_id ?? null,
          limit + 1,
        ),
      this.db
        .prepare(
          `SELECT count(*) AS total_count,coalesce(sum(byte_length),0) AS total_byte_length FROM audio a WHERE ${filter}`,
        )
        .bind(selectedSource, selectedSource),
    ]);
    const rows = results[0].results as unknown as AudioRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        audio_id: row.id,
        source: row.source === "test" ? "demo" : "elevenlabs",
        duration_seconds: row.duration,
        byte_length: row.byte_length,
        created_at: new Date(row.created_at).toISOString(),
        voice_id: row.voice_id ?? null,
        model_id: row.model_id ?? null,
      })),
      ...(results[1].results[0] as {
        total_count: number;
        total_byte_length: number;
      }),
      next_cursor:
        rows.length > limit && last
          ? btoa(
              JSON.stringify({
                created_at: last.created_at,
                audio_id: last.id,
              }),
            )
              .replaceAll("+", "-")
              .replaceAll("/", "_")
              .replace(/=+$/, "")
          : null,
    };
  }
  async deleteAudio(id: string, confirm: boolean) {
    if (confirm !== true)
      throw new SafeError(
        "DELETE_CONFIRMATION_REQUIRED",
        "请先展示完整 audio_id，获得本人明确确认后再删除。",
      );
    if (!/^vb_[a-f0-9]{64}$/.test(id))
      throw new SafeError(
        "INVALID_AUDIO_ID",
        "删除必须使用完整 audio_id，不支持批量或模糊匹配。",
      );
    type Deletion = {
      audio_id: string;
      object_key: string;
      operation_token: string;
      state: "deleting" | "deleted";
    };
    try {
      // This atomic statement arbitrates against claim()/complete(). Never clear
      // pending, failed or uncertain jobs, even if their lease has expired.
      let deletion = await this.db
        .prepare(
          `INSERT INTO audio_deletions (audio_id,state,object_key,operation_token,started_at)
        SELECT id,'deleting',object_key,?,? FROM audio
        WHERE id=? AND source='elevenlabs'
          AND NOT EXISTS (SELECT 1 FROM jobs WHERE id=audio.id AND status!='ready')
        ON CONFLICT(audio_id) DO UPDATE SET state='deleting',object_key=excluded.object_key,
          operation_token=excluded.operation_token,started_at=excluded.started_at,finished_at=NULL
        WHERE audio_deletions.state='deleted'
        RETURNING audio_id,object_key,operation_token,state`,
        )
        .bind(crypto.randomUUID(), Date.now(), id)
        .first<Deletion>();
      if (!deletion) {
        deletion = await this.db
          .prepare(
            "SELECT audio_id,object_key,operation_token,state FROM audio_deletions WHERE audio_id=?",
          )
          .bind(id)
          .first<Deletion>();
        if (deletion?.state !== "deleting") {
          const existing = await this.db
            .prepare("SELECT source FROM audio WHERE id=?")
            .bind(id)
            .first<{ source: string }>();
          if (existing?.source === "test")
            throw new SafeError(
              "DEMO_PROTECTED",
              "demo 测试音频受保护，不能删除。",
            );
          if (await this.job(id))
            throw new SafeError(
              "DELETE_UNSAFE_JOB",
              "音频任务未处于可安全删除状态。pending、failed、uncertain 任务不会被清理；请先核对任务及供应商用量。",
            );
          if (existing)
            throw new SafeError(
              "DELETE_INCOMPLETE",
              "删除状态发生变化，请重新确认目标后重试。",
            );
          return {
            audio_id: id,
            status: deletion ? "already_deleted" : "not_found",
          };
        }
      }
      const { object_key: key, operation_token: token } = deletion;
      // Only this exact immutable object; no bucket listing or prefix deletion.
      await this.bucket.delete(key);
      const fence =
        "EXISTS (SELECT 1 FROM audio_deletions WHERE audio_id=? AND operation_token=? AND state='deleting')";
      await this.db.batch([
        this.db
          .prepare(`DELETE FROM requests WHERE audio_id=? AND ${fence}`)
          .bind(id, id, token),
        this.db
          .prepare(
            `DELETE FROM jobs WHERE id=? AND status='ready' AND ${fence}`,
          )
          .bind(id, id, token),
        this.db
          .prepare(`DELETE FROM audio WHERE id=? AND object_key=? AND ${fence}`)
          .bind(id, key, id, token),
        this.db
          .prepare(
            "UPDATE audio_deletions SET state='deleted',finished_at=? WHERE audio_id=? AND operation_token=? AND state='deleting'",
          )
          .bind(Date.now(), id, token),
      ]);
      return { audio_id: id, status: "deleted" };
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError(
        "DELETE_INCOMPLETE",
        `删除未确认完成。audio_id: ${id}。若已标记删除中，访问和生成将保持阻止；明确确认后可用相同 ID 安全重试删除，不会调用付费 TTS。`,
      );
    }
  }
  async assertNotDeleting(id: string) {
    if (
      await this.db
        .prepare(
          "SELECT 1 FROM audio_deletions WHERE audio_id=? AND state='deleting'",
        )
        .bind(id)
        .first()
    )
      throw new SafeError(
        "AUDIO_DELETING",
        "音频正在删除或删除尚未完成；请明确确认后重试删除，不会生成新音频。",
      );
  }
  async incarnation(row: AudioRow) {
    return (await audioId(row.object_key)).slice(3);
  }
  async playback(
    id: string,
    base: string,
    ttl: number,
    now = Date.now(),
  ): Promise<Playback> {
    return this.signedLink(id, base, ttl, "audio", now);
  }
  async signedLink(
    id: string,
    base: string,
    ttl: number,
    purpose: "audio" | "download",
    now = Date.now(),
  ): Promise<Playback> {
    await this.assertNotDeleting(id);
    const row = await this.row(id);
    if (!row || !(await this.bucket.head(row.object_key)))
      throw new SafeError(
        "AUDIO_NOT_FOUND",
        "音频不存在或文件已丢失；不会重新生成。",
      );
    const expires = Math.floor(now / 1000) + ttl;
    const version = await this.incarnation(row);
    const sig = hex(
      await crypto.subtle.sign(
        "HMAC",
        await this.key,
        new TextEncoder().encode(`${purpose}:${id}:${version}:${expires}`),
      ),
    );
    return {
      url: `${base}/${purpose}/${id}.wav?version=${version}&expires=${expires}&sig=${sig}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }
  async verify(
    id: string,
    expires: unknown,
    signature: unknown,
    now = Date.now(),
    version?: string | null,
    purpose: "audio" | "download" = "audio",
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
    const row = await this.row(id);
    if (!row) return false;
    let message: string;
    if (version != null) {
      if (
        !/^[a-f0-9]{64}$/.test(version) ||
        version !== (await this.incarnation(row))
      )
        return false;
      message = `${purpose}:${id}:${version}:${Number(expires)}`;
    } else {
      // Legacy playback only, and never again after a deletion of this ID.
      if (
        purpose !== "audio" ||
        (await this.db
          .prepare("SELECT 1 FROM audio_deletions WHERE audio_id=?")
          .bind(id)
          .first())
      )
        return false;
      message = `audio:${id}:${Number(expires)}`;
    }
    return crypto.subtle.verify(
      "HMAC",
      await this.key,
      Uint8Array.from(signature.match(/../g)!, (h) => parseInt(h, 16)),
      new TextEncoder().encode(message),
    );
  }
}
