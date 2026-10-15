import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/client";

// Internal test fixture only. Uses the real MCP Apps host bridge, not a fake player clock.
const iframe = document.querySelector<HTMLIFrameElement>("#widget")!;
iframe.removeAttribute("src");
let sequence = 1;
async function rpc(method: string, params: unknown) {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: sequence++, method, params }),
  });
  const body = (await response.json()) as {
    error?: unknown;
    result: CallToolResult;
  };
  if (!response.ok || body.error) throw new Error("Test MCP request failed");
  return body.result;
}
const query = new URLSearchParams(location.search);
const bridge = new AppBridge(
  null,
  { name: "Voice Bubble internal test host", version: "0.1.0" },
  { serverTools: {} },
  {
    hostContext: {
      theme: query.get("theme") === "dark" ? "dark" : "light",
      displayMode: "inline",
      platform: "web",
      containerDimensions: { width: window.innerWidth },
    },
  },
);
const calls: string[] = [];
bridge.oncalltool = async (params) => {
  if (params.name !== "get_voice_bubble")
    throw new Error("Only audio reads are allowed in the test widget");
  calls.push(params.name);
  return rpc("tools/call", params);
};
bridge.onsizechange = () => {};
bridge.oninitialized = async () => {
  const result: CallToolResult = await rpc("tools/call", {
    name: "get_voice_bubble",
    arguments: { audio_id: "demo" },
  });
  if (query.get("expired") === "true") {
    const playback = result._meta!.playback as {
      url: string;
      expiresAt: string;
    };
    playback.url = playback.url.replace(/expires=\d+/, "expires=1");
    playback.expiresAt = new Date(0).toISOString();
  }
  if (query.get("broken") === "true")
    (result._meta!.playback as { url: string }).url = "/audio/invalid.wav";
  if (query.get("palette") === "pink")
    (result.structuredContent as { palette: string }).palette = "pink";
  await bridge.sendToolInput({ arguments: { audio_id: "demo" } });
  await bridge.sendToolResult(result);
  (window as any).__bubbleTest = { bridge, result, calls };
};
void bridge
  .connect(
    new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!),
  )
  .then(() => {
    iframe.src = "/__test/widget";
  });
