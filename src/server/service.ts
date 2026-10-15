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
  readonly provider: SpeechProvider;
  constructor(
    readonly config: Config,
    readonly store: AudioStore,
    private demo: Uint8Array,
    provider?: SpeechProvider,
  ) {
    this.provider = provider ?? new ElevenLabs(config);
  }
  async result(id: string) {
    const data = await this.store.get(
      id === "demo" ? await this.store.seedDemo(this.demo) : id,
      this.config.palette,
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            data.source === "test"
              ? `测试音频（预录，非 ElevenLabs）。audio_id: ${data.audioId}`
              : `语音已保存。audio_id: ${data.audioId}。重播请使用 get_voice_bubble，不要重新生成。`,
        },
      ],
      structuredContent: { ...data },
      _meta: {
        playback: await this.store.playback(
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
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(voice) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(model)
    )
      throw new SafeError("INVALID_CONFIG", "服务端音色或模型 ID 格式不正确。");
    const settings = settingsSchema.parse(input.voice_settings ?? {}),
      text = input.text.replace(/\r\n?/g, "\n");
    const id = await audioId(
      JSON.stringify({
        version: 1,
        text,
        voice,
        model,
        settings,
        format: "pcm_24000",
      }),
    );
    await this.store.bindRequest(input.request_id, id);
    // Existing records are never regenerated, including when their R2 object has been lost.
    if (await this.store.row(id)) return this.result(id);
    if (!this.config.paidEnabled)
      throw new SafeError(
        "PAID_GENERATION_DISABLED",
        "付费生成默认关闭。明确同意付费后，需由部署者开启 ENABLE_PAID_GENERATION；已有音频仍可播放。",
      );
    const token = await this.store.claim(id, input.retry_failed);
    if (!token) {
      // Briefly join an in-progress request across isolates, without ever re-entering generation.
      for (let i = 0; i < 20; i++) {
        if (await this.store.row(id)) return this.result(id);
        if ((await this.store.job(id))?.status !== "pending") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new SafeError(
        "GENERATION_NOT_RETRIED",
        `任务正在处理、曾失败或结果不确定。audio_id: ${id}。稍后用 get_voice_bubble 读取；检查 ElevenLabs 用量后才能明确授权 retry_failed。`,
      );
    }
    let synthesisStarted = false;
    try {
      await this.provider.validate(voice, model);
      synthesisStarted = true;
      const pcm = await this.provider.generate(text, voice, model, settings);
      await this.store.complete(id, token, pcmToWav(pcm));
    } catch (error) {
      const failed =
        !synthesisStarted ||
        (error instanceof SafeError && error.code === "PROVIDER_REJECTED");
      // Even if recording failure itself fails, the committed pending claim prevents automatic re-entry.
      await this.store
        .finish(id, token, failed ? "failed" : "uncertain")
        .catch(() => {});
      if (error instanceof SafeError) throw error;
      throw new SafeError(
        "GENERATION_UNCERTAIN",
        "生成或持久保存失败；可能已计费。不会自动再次调用 ElevenLabs。",
      );
    }
    return this.result(id);
  }
}
