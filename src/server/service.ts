import { audioId, pcmToWav } from "./audio.js";
import { AudioStore, SafeError } from "./store.js";
import {
  ElevenLabs,
  generationSchema,
  settingsSchema,
  type GenerateInput,
  type SpeechProvider,
} from "./elevenlabs.js";
import type { Config } from "./config.js";

export class VoiceService {
  private inflight = new Map<string, Promise<string>>();
  readonly provider: SpeechProvider;
  constructor(
    readonly config: Config,
    readonly store: AudioStore,
    readonly demoId: string,
    provider?: SpeechProvider,
  ) {
    this.provider = provider ?? new ElevenLabs(config);
  }
  result(id: string) {
    const data = this.store.get(
      id === "demo" ? this.demoId : id,
      this.config.palette,
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            data.source === "test"
              ? `测试音频（本地预录，非 ElevenLabs）。audio_id: ${data.audioId}`
              : `语音已保存。audio_id: ${data.audioId}。重播请使用 get_voice_bubble，不要重新生成。`,
        },
      ],
      structuredContent: { ...data },
      _meta: {
        playback: this.store.playback(
          data.audioId,
          this.config.baseUrl,
          this.config.mediaTtl,
        ),
      },
    };
  }
  async generate(raw: GenerateInput) {
    const input = generationSchema.parse(raw);
    const voice = input.voice_id ?? this.config.defaultVoice,
      model = input.model_id ?? this.config.defaultModel;
    if (!voice)
      throw new SafeError(
        "VOICE_REQUIRED",
        "请设置 ELEVENLABS_VOICE_ID，或从 list_voice_options 选择真实音色 ID。",
      );
    // Validate config-provided IDs as well as tool arguments before using them in requests.
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(voice) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(model)
    )
      throw new SafeError("INVALID_CONFIG", "服务端音色或模型 ID 格式不正确。");
    const settings = settingsSchema.parse(input.voice_settings ?? {});
    const text = input.text.replace(/\r\n?/g, "\n");
    const id = audioId(
      JSON.stringify({
        version: 1,
        text,
        voice,
        model,
        settings,
        format: "pcm_24000",
      }),
    );
    this.store.bindRequest(input.request_id, id);
    if (this.store.has(id)) return this.result(id);
    if (!this.config.paidEnabled)
      throw new SafeError(
        "PAID_GENERATION_DISABLED",
        "付费生成默认关闭。明确同意付费后，需由部署者开启 ENABLE_PAID_GENERATION；已有音频仍可播放。",
      );
    if (!this.inflight.has(id)) {
      const task = this.generateOnce(
        id,
        text,
        voice,
        model,
        settings,
        input.retry_failed,
      );
      this.inflight.set(id, task);
      void task.finally(() => this.inflight.delete(id)).catch(() => {});
    }
    return this.result(await this.inflight.get(id)!);
  }
  private async generateOnce(
    id: string,
    text: string,
    voice: string,
    model: string,
    settings: ReturnType<typeof settingsSchema.parse>,
    retry: boolean,
  ) {
    // Listing and validating voices does not synthesize or incur TTS generation charges.
    await this.provider.validate(voice, model);
    this.store.claim(id, retry);
    try {
      const pcm = await this.provider.generate(text, voice, model, settings);
      this.store.put(id, pcmToWav(pcm), "elevenlabs");
      this.store.finish(id, "ready");
      return id;
    } catch (error) {
      this.store.finish(
        id,
        error instanceof SafeError && error.code === "PROVIDER_REJECTED"
          ? "failed"
          : "uncertain",
      );
      if (error instanceof SafeError) throw error;
      throw new SafeError(
        "GENERATION_UNCERTAIN",
        "生成或持久保存失败；可能已计费。不会自动再次调用 ElevenLabs。",
      );
    }
  }
}
