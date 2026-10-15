import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { McpServer } from "@modelcontextprotocol/server";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { SafeError } from "./store.js";
import { generationSchema } from "./elevenlabs.js";
import type { VoiceService } from "./service.js";

export const RESOURCE_URI = "ui://voice-bubble/player-v1.html";
export function resourceMetadata(baseUrl: string) {
  return {
    ui: {
      prefersBorder: false,
      csp: {
        connectDomains: [baseUrl],
        resourceDomains: [baseUrl],
        frameDomains: [],
      },
    },
    "openai/widgetPrefersBorder": false,
    "openai/widgetDescription":
      "一条透明背景上的语音气泡。只含播放、真实波形、剩余时长和倍速；不会自动播放。",
    "openai/widgetCSP": {
      connect_domains: [baseUrl],
      resource_domains: [baseUrl],
      frame_domains: [],
    },
  };
}
async function safe(action: () => Promise<any> | any) {
  try {
    return await action();
  } catch (e) {
    const error =
      e instanceof SafeError
        ? e
        : new SafeError(
            "INTERNAL_ERROR",
            "请求未完成，请检查服务端配置或稍后读取已有音频。不会自动重新生成。",
          );
    return {
      isError: true,
      content: [
        { type: "text" as const, text: `${error.code}: ${error.message}` },
      ],
    };
  }
}
export function createMcpServer(service: VoiceService, html: string) {
  const server = new McpServer(
    { name: "Voice Bubble", version: "0.2.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  const securitySchemes =
    service.config.authMode === "oauth"
      ? [{ type: "oauth2", scopes: [service.config.scope] }]
      : [{ type: "noauth" }];
  const uiMeta = {
    ui: {
      resourceUri: RESOURCE_URI,
      visibility: ["model", "app"] as ("model" | "app")[],
    },
    "openai/outputTemplate": RESOURCE_URI,
    "openai/widgetAccessible": true,
    securitySchemes,
  };
  registerAppResource(
    server,
    "voice-bubble",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: resourceMetadata(service.config.baseUrl),
        },
      ],
    }),
  );
  registerAppTool(
    server,
    "get_voice_bubble",
    {
      title: "读取语音气泡",
      description:
        '播放或重新打开已保存的 Voice Bubble 音频。仅读取，不调用 ElevenLabs，不计费。audio_id="demo" 播放明确标注的本地测试音频。也用于刷新过期播放链接。',
      inputSchema: z.object({
        audio_id: z.string().regex(/^(demo|vb_[a-f0-9]{64})$/),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: uiMeta,
    },
    async ({ audio_id }) => safe(() => service.result(audio_id)),
  );
  registerAppTool(
    server,
    "generate_voice_bubble",
    {
      title: "生成语音气泡（付费）",
      description:
        "仅当用户明确要求调用 ElevenLabs 付费生成语音时使用。默认音色由服务端配置，其他音色必须来自 list_voice_options，不能编造。相同文本、音色、模型和设置复用已保存音频；重播应调用 get_voice_bubble。失败不自动重试。",
      inputSchema: generationSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: {
        ...uiMeta,
        ui: { resourceUri: RESOURCE_URI, visibility: ["model"] },
        "openai/widgetAccessible": false,
      },
    },
    async (input) => safe(() => service.generate(input)),
  );
  server.registerTool(
    "list_voice_options",
    {
      title: "读取 ElevenLabs 音色和模型",
      description:
        "从当前 ElevenLabs 账户读取真实音色 ID 和可用 TTS 模型，不生成音频。选择结果中的 ID，不要编造。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { securitySchemes },
    },
    async () =>
      safe(async () => ({
        content: [
          { type: "text" as const, text: "可用音色和语音模型（未生成音频）。" },
        ],
        structuredContent: await service.provider.catalog(),
      })),
  );
  return server;
}
