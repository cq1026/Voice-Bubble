import { SafeError } from "./store.js";
import type { VoiceSettings } from "./elevenlabs.js";

export const MAX_PCM_BYTES = 16 * 1024 * 1024;
export function joinPcm(chunks: Uint8Array[], size: number) {
  if (!size || size % 2 || size > MAX_PCM_BYTES) throw new Error("Invalid PCM");
  const pcm = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  const prefix = String.fromCharCode(...pcm.subarray(0, 4));
  if (prefix === "RIFF" || prefix === "OggS" || prefix.startsWith("ID3"))
    throw new Error("Unexpected encoded audio");
  return pcm;
}

// One official Text-to-Dialogue session, one voice, one input, one closing
// flush. A partial stream is never published and never retried automatically.
export function receiveDialogue(
  socket: WebSocket,
  text: string,
  voice: string,
  settings: VoiceSettings,
  timeoutMs = 90_000,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0,
      settled = false;
    const finish = (pcm?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", fail);
      socket.removeEventListener("error", fail);
      try {
        socket.close(1000, "complete");
      } catch {
        /* already closed */
      }
      if (pcm) resolve(pcm);
      else
        reject(
          new SafeError(
            "GENERATION_UNCERTAIN",
            "Turbo 音频流未完整结束或请求被拒绝；可能已计费。不会换模型、端点或自动重试。",
          ),
        );
    };
    const fail = () => finish();
    const timer = setTimeout(fail, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      try {
        if (
          typeof event.data !== "string" ||
          event.data.length > MAX_PCM_BYTES * 1.5
        )
          throw new Error();
        const message = JSON.parse(event.data);
        if (!message || typeof message !== "object" || message.error)
          throw new Error();
        if (message.audio) {
          if (typeof message.audio !== "string") throw new Error();
          const decoded = atob(message.audio);
          size += decoded.length;
          if (size > MAX_PCM_BYTES) throw new Error();
          chunks.push(Uint8Array.from(decoded, (c) => c.charCodeAt(0)));
        }
        // is_final_audio_for_turn is NOT completion of the socket's flush.
        if (message.is_final === true) finish(joinPcm(chunks, size));
      } catch {
        fail();
      }
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", fail);
    socket.addEventListener("error", fail);
    try {
      socket.accept();
      socket.send(
        JSON.stringify({ voices: [voice], voice_settings: settings }),
      );
      socket.send(
        JSON.stringify({
          inputs: [{ text, voice_id: voice, new_turn: false }],
        }),
      );
      socket.send(JSON.stringify({ close_socket: true }));
    } catch {
      fail();
    }
  });
}
