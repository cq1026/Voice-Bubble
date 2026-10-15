import { readConfig } from "./config.js";
import { createApplication } from "./app.js";
try {
  const config = readConfig();
  const { app, store } = createApplication(config);
  const server = app.listen(config.port, config.host, (error) => {
    if (error) {
      console.error(
        "Voice Bubble could not bind its listener. Check HOST and PORT; another process may already use this port.",
      );
      store.close();
      process.exitCode = 1;
      return;
    }
    console.info(
      `Voice Bubble listening on port ${config.port}; auth=${config.authMode}; paid_generation=${config.paidEnabled}`,
    );
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      server.close(() => {
        store.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    });
} catch {
  // Never dump environment values, upstream request objects, or signed media URLs.
  console.error(
    "Voice Bubble startup failed. Check configuration, build output, and writable DATA_DIR.",
  );
  process.exitCode = 1;
}
