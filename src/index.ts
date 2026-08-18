import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

try {
  const config = await loadConfig();
  const app = buildApp(config);
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to start AutoRouter");
  process.exit(1);
}
