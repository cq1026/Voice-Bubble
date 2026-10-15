export type Palette = "lavender" | "pink";
export interface BubbleData {
  audioId: string;
  durationSeconds: number;
  waveform: number[];
  source: "test" | "elevenlabs";
  palette: Palette;
  playback: { mimeType: "audio/wav"; refreshTool: "get_voice_bubble" };
}
export interface Playback {
  url: string;
  expiresAt: string;
}
export interface BubbleResult {
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}
export function parseBubble(
  result: BubbleResult,
): { data: BubbleData; playback: Playback } | null {
  const data = result.structuredContent as BubbleData | undefined;
  const playback = result._meta?.playback as Playback | undefined;
  if (
    result.isError ||
    !data ||
    !/^vb_[a-f0-9]{64}$/.test(data.audioId ?? "") ||
    !Number.isFinite(data.durationSeconds) ||
    data.durationSeconds <= 0 ||
    !Array.isArray(data.waveform) ||
    data.waveform.length !== 64 ||
    !data.waveform.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
    !["test", "elevenlabs"].includes(data.source) ||
    !["lavender", "pink"].includes(data.palette) ||
    !playback ||
    !Number.isFinite(Date.parse(playback.expiresAt))
  )
    return null;
  try {
    const url = new URL(playback.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
  } catch {
    return null;
  }
  return { data, playback };
}
