import { z } from "zod";
import { SafeError } from "./store.js";
export const audioIdSchema = z.string().regex(/^vb_[a-f0-9]{64}$/);
const cursorSchema = z.object({
  created_at: z.number().int().nonnegative().max(8640000000000000),
  audio_id: audioIdSchema,
});
export const listSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(300).optional(),
  source: z.enum(["demo", "elevenlabs"]).optional(),
});
export const deleteSchema = z.object({
  audio_id: audioIdSchema,
  confirm_delete: z
    .literal(true)
    .describe(
      "Only true after displaying this full audio_id and receiving the user's explicit confirmation. Never infer consent or batch-delete.",
    ),
});
export function parseCursor(raw?: string) {
  if (!raw) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    return cursorSchema.parse(
      JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/"))),
    );
  } catch {
    throw new SafeError("INVALID_CURSOR", "分页游标无效；请重新查询第一页。");
  }
}
