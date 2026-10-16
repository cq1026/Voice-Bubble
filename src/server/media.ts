import type { AudioStore } from "./store.js";
export const mediaHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Range, Content-Length, ETag, Content-Disposition",
  "Cache-Control": "private, no-store",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
export async function media(request: Request, store: AudioStore) {
  const url = new URL(request.url),
    id = url.pathname.match(
      /^\/(?:audio|download)\/(vb_[a-f0-9]{64})\.wav$/,
    )?.[1],
    purpose = url.pathname.startsWith("/download/") ? "download" : "audio";
  const headers = new Headers(mediaHeaders);
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers });
  if (
    !id ||
    !(await store.verify(
      id,
      url.searchParams.get("expires"),
      url.searchParams.get("sig"),
      Date.now(),
      url.searchParams.get("version"),
      purpose,
    ))
  )
    return new Response(
      request.method === "HEAD"
        ? null
        : "Playback link invalid or expired. Refresh using get_voice_bubble.",
      { status: 403, headers },
    );
  const row = await store.row(id);
  if (!row) return new Response(null, { status: 404, headers });
  const head = await store.bucket.head(row.object_key);
  if (!head) return new Response(null, { status: 404, headers });
  if (
    url.searchParams.get("version") != null &&
    url.searchParams.get("version") !== (await store.incarnation(row))
  )
    return new Response(null, { status: 403, headers });
  const size = head.size;
  headers.set("Content-Type", "audio/wav");
  headers.set(
    "Content-Disposition",
    purpose === "download" ? `attachment; filename="${id}.wav"` : "inline",
  );
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", head.httpEtag);
  let range = request.method === "GET" ? request.headers.get("Range") : null;
  // Weak validators/dates are not accepted by If-Range; fall back to the full representation.
  if (
    request.headers.has("If-Range") &&
    request.headers.get("If-Range") !== head.httpEtag
  )
    range = null;
  let offset = 0,
    length = size,
    status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = NaN,
      end = NaN;
    if (match && (match[1] || match[2])) {
      if (!match[1]) {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      }
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    offset = start;
    length = end - start + 1;
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("Content-Length", String(length));
  if (request.method === "HEAD") {
    const current = await store.row(id);
    if (
      !current ||
      current.object_key !== row.object_key ||
      !(await store.verify(
        id,
        url.searchParams.get("expires"),
        url.searchParams.get("sig"),
        Date.now(),
        url.searchParams.get("version"),
        purpose,
      ))
    ) {
      headers.delete("Content-Length");
      return new Response(null, { status: 403, headers });
    }
    return new Response(null, { status, headers });
  }
  const object = await store.bucket.get(
    row.object_key,
    status === 206 ? { range: { offset, length } } : undefined,
  );
  // Recheck the incarnation after R2 I/O; a deletion marker revokes new reads.
  const current = await store.row(id);
  if (
    !object ||
    !current ||
    current.object_key !== row.object_key ||
    !(await store.verify(
      id,
      url.searchParams.get("expires"),
      url.searchParams.get("sig"),
      Date.now(),
      url.searchParams.get("version"),
      purpose,
    ))
  ) {
    headers.delete("Content-Length");
    headers.delete("Content-Range");
    return new Response(null, { status: 404, headers });
  }
  return new Response(object.body, { status, headers });
}
