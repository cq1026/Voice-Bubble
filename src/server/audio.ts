import { createHash } from "node:crypto";

export function audioId(content: string | Buffer) {
  return `vb_${createHash("sha256").update(content).digest("hex")}`;
}
export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  if (!pcm.length || pcm.length % 2) throw new Error("Invalid PCM audio");
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function analyzeWav(wav: Buffer) {
  if (
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Expected a PCM WAV file");
  let sampleRate = 0,
    channels = 0,
    pcm: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length;) {
    const type = wav.toString("ascii", at, at + 4),
      size = wav.readUInt32LE(at + 4),
      start = at + 8;
    if (start + size > wav.length) throw new Error("Truncated WAV");
    if (type === "fmt ") {
      if (
        size < 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 14) !== 16
      )
        throw new Error("Expected 16-bit PCM");
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
    }
    if (type === "data") pcm = wav.subarray(start, start + size);
    at = start + size + (size % 2);
  }
  if (!pcm?.length || !sampleRate || channels !== 1 || pcm.length % 2)
    throw new Error("Expected mono PCM samples");
  const samples = pcm.length / 2;
  const rms = Array.from({ length: 64 }, (_, bar) => {
    const start = Math.floor((bar * samples) / 64),
      end = Math.floor(((bar + 1) * samples) / 64);
    let sum = 0;
    for (let i = start; i < end; i++)
      sum += (pcm!.readInt16LE(i * 2) / 32768) ** 2;
    return Math.sqrt(sum / Math.max(1, end - start));
  });
  const peak = Math.max(...rms, 0.000001);
  return {
    durationSeconds: samples / sampleRate,
    waveform: rms.map((v) => Number((v / peak).toFixed(5))),
  };
}
