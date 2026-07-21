import { createServer, type Server } from "node:http";
import type { Logger } from "./logger.js";

export function startHealthServer(port: number, logger: Logger): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", utc: new Date().toISOString() }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("seam-acp is running. See /health");
  });

  // The health port doubles as a single-instance guard: if it's already bound,
  // another seam-acp is running, so exit cleanly instead of crashing (an
  // unhandled 'error' would otherwise take the process down non-deterministically,
  // and under a restart supervisor cause a tight crash loop). The OS releases the
  // port when the owning process dies, so there's no stale-lock problem.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        { port },
        "health port already in use — another seam-acp instance is running; exiting (single-instance guard)"
      );
      process.exit(0);
    }
    logger.error({ err }, "health server error");
  });

  server.listen(port, () => {
    logger.info({ port }, "health server listening");
  });

  return server;
}
