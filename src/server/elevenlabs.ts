import { z } from "zod";
import type { Config } from "./config.js";
import { SafeError } from "./store.js";

export const settingsSchema = z.object({
  stability: z.number().min(0).max(1).default(0.5),
  similarity_boost: z.number().min(0).max(1).default(0.75),
  style: z.number().min(0).max(1).default(0),
  use_speaker_boost: z.boolean().default(true),
  speed: z.number().min(0.7).max(1.2).default(1),
});
export const generationSchema = z.object({
  text: z.string().trim().min(1).max(3000),
  voice_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
  model_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
  voice_settings: settingsSchema.optional(),
  request_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .optional(),
  confirm_paid_generation: z
    .literal(true)
    .describe(
      "Only set true after the user explicitly requests paid ElevenLabs generation.",
    ),
  retry_failed: z
    .boolean()
    .default(false)
    .describe(
      "Only with explicit permission to retry a failed/uncertain paid request; it may incur another charge.",
    ),
});
export type GenerateInput = z.infer<typeof generationSchema>;
export interface Voice {
  voice_id: string;
  name: string;
}
export interface Model {
  model_id: string;
  name: string;
  can_do_text_to_speech: boolean;
}
export interface SpeechProvider {
  catalog(): Promise<{ voices: Voice[]; models: Model[] }>;
  validate(voice: string, model: string): Promise<void>;
  generate(
    text: string,
    voice: string,
    model: string,
    settings: z.infer<typeof settingsSchema>,
  ): Promise<Uint8Array>;
}
export class ElevenLabs implements SpeechProvider {
  constructor(
    private config: Config,
    private request: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  private async call(endpoint: string, init: RequestInit = {}, paid = false) {
    if (!this.config.apiKey)
      throw new SafeError(
        "ELEVENLABS_NOT_CONFIGURED",
        "请在服务端配置 ELEVENLABS_API_KEY；不要在聊天中发送密钥。",
      );
    let response: Response;
    try {
      response = await this.request(`https://api.elevenlabs.io${endpoint}`, {
        ...init,
        headers: { "xi-api-key": this.config.apiKey, ...init.headers },
        signal: AbortSignal.timeout(paid ? 90_000 : 15_000),
        // Workers supports manual/follow; reject 3xx below so API keys never follow redirects.
        redirect: "manual",
      });
    } catch {
      throw new SafeError(
        paid ? "GENERATION_UNCERTAIN" : "PROVIDER_UNAVAILABLE",
        paid
          ? "生成连接中断或超时，计费状态不确定。不会自动重试，请检查 ElevenLabs 用量。"
          : "ElevenLabs 暂时无法连接。",
      );
    }
    if (!response.ok) {
      // Never return provider response bodies: these can contain user input or account details.
      await response.body?.cancel();
      throw new SafeError(
        paid && response.status >= 500
          ? "GENERATION_UNCERTAIN"
          : "PROVIDER_REJECTED",
        `ElevenLabs 返回 HTTP ${response.status}；请检查服务端配置、账户权限或额度。未自动重试。`,
      );
    }
    return response;
  }
  async catalog() {
    const [voices, models] = await Promise.all([
      this.call("/v1/voices").then((r) => r.json()),
      this.call("/v1/models").then((r) => r.json()),
    ]);
    const v = z
      .object({
        voices: z.array(z.object({ voice_id: z.string(), name: z.string() })),
      })
      .parse(voices);
    const m = z
      .array(
        z.object({
          model_id: z.string(),
          name: z.string(),
          can_do_text_to_speech: z.boolean(),
        }),
      )
      .parse(models);
    return {
      voices: v.voices,
      models: m.filter((m) => m.can_do_text_to_speech),
    };
  }
  async validate(voice: string, model: string) {
    const [v, models] = await Promise.all([
      this.call(`/v1/voices/${encodeURIComponent(voice)}`).then((r) =>
        r.json(),
      ),
      this.call("/v1/models").then((r) => r.json()),
    ]);
    if (
      z.object({ voice_id: z.string() }).parse(v).voice_id !== voice ||
      !Array.isArray(models) ||
      !models.some(
        (m) => m.model_id === model && m.can_do_text_to_speech === true,
      )
    )
      throw new SafeError(
        "INVALID_VOICE_OR_MODEL",
        "音色或模型未通过 ElevenLabs 校验。请使用 list_voice_options 返回的 ID。",
      );
  }
  async generate(
    text: string,
    voice: string,
    model: string,
    settings: z.infer<typeof settingsSchema>,
  ) {
    const response = await this.call(
      `/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/octet-stream",
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: settings,
        }),
      },
      true,
    );
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (!response.body) throw new Error();
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw new Error();
        chunks.push(chunk);
      }
      if (!size || size % 2) throw new Error();
      const pcm = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      return pcm;
    } catch {
      throw new SafeError(
        "GENERATION_UNCERTAIN",
        "音频响应不完整或超出限制；请求可能已计费，不会自动重新生成。",
      );
    }
  }
}
