import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const ui = await build({
  entryPoints: ["src/ui/main.tsx"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  write: false,
  outdir: "dist/ui",
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = ui.outputFiles
  .find((f) => f.path.endsWith(".js"))
  .text.replaceAll("</script", "<\\/script");
const css = ui.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
await writeFile(
  "dist/widget.html",
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`,
);
if (process.env.BUILD_TEST_HOST === "true") {
  const host = await build({
    entryPoints: ["tests/host/harness.ts"],
    bundle: true,
    format: "iife",
    write: false,
    minify: true,
    target: "es2022",
  });
  await writeFile(
    "dist/test-host.html",
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent}iframe{width:100%;height:72px;display:block;border:0}</style></head><body><iframe id="widget" title="Voice Bubble test host" sandbox="allow-scripts" src="/__test/widget"></iframe><script>${host.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`,
  );
}
console.info(
  "Built self-contained MCP Apps UI resource. Wrangler bundles the Worker.",
);
