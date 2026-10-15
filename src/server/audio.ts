const encoder = new TextEncoder();
export function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export async function audioId(content: string | Uint8Array) {
  const bytes =
    typeof content === "string"
      ? encoder.encode(content)
      : new Uint8Array(content);
  return `vb_${hex(await crypto.subtle.digest("SHA-256", bytes))}`;
}
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate = 24000,
): Uint8Array<ArrayBuffer> {
  if (!pcm.length || pcm.length % 2) throw new Error("Invalid PCM audio");
  const wav = new Uint8Array(44 + pcm.length),
    view = new DataView(wav.buffer);
  wav.set(encoder.encode("RIFF"));
  view.setUint32(4, 36 + pcm.length, true);
  wav.set(encoder.encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wav.set(encoder.encode("data"), 36);
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}
export function analyzeWav(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (at: number, n: number) =>
    String.fromCharCode(...wav.subarray(at, at + n));
  if (wav.length < 44 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE")
    throw new Error("Expected a PCM WAV file");
  let sampleRate = 0,
    channels = 0,
    pcm: DataView | undefined;
  for (let at = 12; at + 8 <= wav.length;) {
    const type = ascii(at, 4),
      size = view.getUint32(at + 4, true),
      start = at + 8;
    if (start + size > wav.length) throw new Error("Truncated WAV");
    if (type === "fmt ") {
      if (
        size < 16 ||
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 14, true) !== 16
      )
        throw new Error("Expected 16-bit PCM");
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
    }
    if (type === "data")
      pcm = new DataView(wav.buffer, wav.byteOffset + start, size);
    at = start + size + (size % 2);
  }
  if (!pcm?.byteLength || !sampleRate || channels !== 1 || pcm.byteLength % 2)
    throw new Error("Expected mono PCM samples");
  const samples = pcm.byteLength / 2;
  const rms = Array.from({ length: 64 }, (_, bar) => {
    const start = Math.floor((bar * samples) / 64),
      end = Math.floor(((bar + 1) * samples) / 64);
    let sum = 0;
    for (let i = start; i < end; i++)
      sum += (pcm!.getInt16(i * 2, true) / 32768) ** 2;
    return Math.sqrt(sum / Math.max(1, end - start));
  });
  const peak = Math.max(...rms, 0.000001);
  return {
    durationSeconds: samples / sampleRate,
    waveform: rms.map((v) => Number((v / peak).toFixed(5))),
  };
}
