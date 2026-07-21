import { createServer, get as httpGet, type Server } from "node:http";
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
  // exit cleanly instead of crashing (an unhandled 'error' would otherwise take
  // the process down non-deterministically, and under a restart supervisor cause
  // a tight crash loop). We probe /health first so the log distinguishes a
  // sibling seam-acp from an unrelated process squatting the port (the latter
  // means HEALTH_PORT needs changing — otherwise the supervisor will retry
  // forever). Either way we exit(0); the supervisor's backoff handles it.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      const req = httpGet(
        { host: "127.0.0.1", port, path: "/health", timeout: 1000 },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            const isSeamAcp =
              res.statusCode === 200 && /"status"\s*:\s*"ok"/.test(body);
            if (isSeamAcp) {
              logger.error(
                { port },
                "health port already bound by another seam-acp instance; exiting (single-instance guard)"
              );
            } else {
              logger.error(
                { port, statusCode: res.statusCode },
                `health port ${port} is held by another process (not seam-acp); set HEALTH_PORT to a free port; exiting`
              );
            }
            process.exit(0);
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        logger.error(
          { port },
          `health port ${port} is in use but /health did not respond (held by another process); set HEALTH_PORT to a free port; exiting`
        );
        process.exit(0);
      });
      req.on("error", () => {
        logger.error(
          { port },
          `health port ${port} is in use but not reachable on /health (held by another process); set HEALTH_PORT to a free port; exiting`
        );
        process.exit(0);
      });
      return;
    }
    logger.error({ err }, "health server error");
  });

  server.listen(port, () => {
    logger.info({ port }, "health server listening");
  });

  return server;
}
