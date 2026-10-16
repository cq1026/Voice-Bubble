import { z } from "zod";
import type { Config } from "./config.js";
import { SafeError } from "./store.js";
import { joinPcm, MAX_PCM_BYTES, receiveDialogue } from "./dialogue.js";

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
const modelSchema = z.object({
  model_id: z.string(),
  name: z.string().optional(),
  can_do_text_to_speech: z.boolean(),
  can_use_style: z.boolean().optional(),
  can_use_speaker_boost: z.boolean().optional(),
  maximum_text_length_per_request: z.number().int().positive().optional(),
  languages: z
    .array(z.object({ language_id: z.string(), name: z.string() }))
    .optional(),
});
export type Model = z.infer<typeof modelSchema>;
export type VoiceSettings = Partial<z.infer<typeof settingsSchema>>;
export const OUTPUT_FORMAT = "pcm_24000";

// v4's documented controls are stability and similarity only. Playback speed
// remains a separate UI feature. Canonical settings also define the cache key.
export function settingsForModel(
  model: string,
  input: VoiceSettings = {},
  capabilities?: Model,
): VoiceSettings {
  const settings: VoiceSettings = settingsSchema.parse(input);
  if (model === "eleven_v4" || model === "eleven_v4_turbo") {
    return {
      stability: settings.stability,
      similarity_boost: settings.similarity_boost,
    };
  }
  if (model === "eleven_v3") {
    if (![0, 0.5, 1].includes(settings.stability!))
      throw new SafeError(
        "UNSUPPORTED_VOICE_SETTINGS",
        "Eleven v3 的 stability 必须是 0、0.5 或 1；不会自动修改或换模型。",
      );
    delete settings.use_speaker_boost;
  }
  if (capabilities?.can_use_style === false) delete settings.style;
  if (capabilities?.can_use_speaker_boost === false)
    delete settings.use_speaker_boost;
  return settings;
}
export interface SpeechProvider {
  catalog(): Promise<{ voices: Voice[]; models: Model[] }>;
  validate(voice: string, model: string, text?: string): Promise<Model | void>;
  generate(
    text: string,
    voice: string,
    model: string,
    settings: VoiceSettings,
  ): Promise<Uint8Array>;
}
export class ElevenLabs implements SpeechProvider {
  constructor(
    private config: Config,
    private request: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  private async call(
    endpoint: string,
    init: RequestInit = {},
    paid = false,
    upgrade = false,
  ) {
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
    if (
      !response.ok &&
      !(upgrade && response.status === 101 && response.webSocket)
    ) {
      // Never return provider response bodies: these can contain user input or account details.
      await response.body?.cancel();
      throw new SafeError(
        paid && response.status >= 500
          ? "GENERATION_UNCERTAIN"
          : "PROVIDER_REJECTED",
        `ElevenLabs 返回 HTTP ${response.status}；请检查所选模型、音色、参数、PCM 输出格式及账户额度。模型或格式不兼容时不会自动降级，未自动重试。`,
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
    const m = z.array(modelSchema).parse(models);
    return {
      voices: v.voices,
      models: m.filter((m) => m.can_do_text_to_speech),
    };
  }
  async validate(voice: string, model: string, text = "") {
    const [v, models] = await Promise.all([
      this.call(`/v1/voices/${encodeURIComponent(voice)}`).then((r) =>
        r.json(),
      ),
      this.call("/v1/models").then((r) => r.json()),
    ]);
    const available = z.array(modelSchema).parse(models);
    const selected = available.find(
      (m) => m.model_id === model && m.can_do_text_to_speech,
    );
    if (
      z.object({ voice_id: z.string() }).parse(v).voice_id !== voice ||
      !selected
    )
      throw new SafeError(
        "INVALID_VOICE_OR_MODEL",
        "音色或模型未通过 ElevenLabs 校验。请使用 list_voice_options 返回的 ID；不会自动换模型。",
      );
    if (
      selected.maximum_text_length_per_request &&
      [...text].length > selected.maximum_text_length_per_request
    )
      throw new SafeError(
        "MODEL_TEXT_LIMIT",
        `文本超过模型 ${model} 的 ${selected.maximum_text_length_per_request} 字符限制；未调用付费生成。`,
      );
    return selected;
  }

  async generate(
    text: string,
    voice: string,
    model: string,
    settings: VoiceSettings,
  ) {
    if (model === "eleven_v4_turbo") {
      const response = await this.call(
        `/v1/text-to-dialogue/stream-input?model_id=${encodeURIComponent(model)}&output_format=${OUTPUT_FORMAT}`,
        { headers: { Upgrade: "websocket" } },
        true,
        true,
      );
      if (response.status !== 101 || !response.webSocket) {
        await response.body?.cancel();
        throw new SafeError(
          "PROVIDER_REJECTED",
          "ElevenLabs Turbo 未接受 WebSocket 协议；不会换模型或自动重试。",
        );
      }
      return receiveDialogue(response.webSocket, text, voice, settings);
    }
    const response = await this.call(
      `/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${OUTPUT_FORMAT}`,
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
    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim();
    if (
      contentType &&
      !["application/octet-stream", "audio/pcm", "audio/x-pcm"].includes(
        contentType,
      )
    ) {
      await response.body?.cancel();
      throw new SafeError(
        "GENERATION_UNCERTAIN",
        "ElevenLabs 未返回请求的 PCM 格式；可能已计费，不会换格式或自动重试。",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (!response.body) throw new Error();
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_PCM_BYTES) throw new Error();
        chunks.push(chunk);
      }
      return joinPcm(chunks, size);
    } catch {
      throw new SafeError(
        "GENERATION_UNCERTAIN",
        "音频响应不完整或超出限制；请求可能已计费，不会自动重新生成。",
      );
    }
  }
}
