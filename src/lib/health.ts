import { createServer, get as httpGet, type Server } from "node:http";
import type { Logger } from "./logger.js";

export function startHealthServer(port: number, logger: Logger): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", app: "seam-acp", utc: new Date().toISOString() }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("seam-acp is running. See /health");
  });

  // The health port doubles as a single-instance guard: if it's already bound we
  // MUST exit (we can't serve), else a second instance would go on to log into
  // Discord. We exit UNCONDITIONALLY on EADDRINUSE, guarded by a hard wall-clock
  // timer so a misbehaving occupant (slow/endless/aborted response) can't keep us
  // alive; the /health probe only enriches the log (sibling seam-acp vs a foreign
  // process squatting the port — the latter means HEALTH_PORT needs changing).
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      let exited = false;
      const bail = (msg: string, extra: Record<string, unknown> = { port }): void => {
        if (exited) return;
        exited = true;
        logger.error(extra, msg);
        process.exit(0);
      };
      // Ultimate backstop: exit even if no probe event ever fires.
      setTimeout(
        () => bail(`health port ${port} in use; exiting (single-instance guard)`),
        1500
      ).unref();

      const req = httpGet(
        { host: "127.0.0.1", port, path: "/health", timeout: 1000 },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
            if (body.length > 4096) req.destroy(); // cap; triggers close/error → bail
          });
          res.on("end", () => {
            const isSeamAcp =
              res.statusCode === 200 && /"app"\s*:\s*"seam-acp"/.test(body);
            bail(
              isSeamAcp
                ? "health port already bound by another seam-acp instance; exiting (single-instance guard)"
                : `health port ${port} is held by another process (not seam-acp); set HEALTH_PORT to a free port; exiting`,
              isSeamAcp ? { port } : { port, statusCode: res.statusCode }
            );
          });
          res.on("error", () =>
            bail(`health port ${port} is in use (probe response error); exiting`)
          );
          res.on("close", () =>
            bail(`health port ${port} is in use (probe closed early); exiting`)
          );
        }
      );
      req.on("timeout", () => {
        req.destroy();
        bail(
          `health port ${port} is in use but /health did not respond (held by another process); set HEALTH_PORT to a free port; exiting`
        );
      });
      req.on("error", () =>
        bail(
          `health port ${port} is in use but not reachable on /health (held by another process); set HEALTH_PORT to a free port; exiting`
        )
      );
      return;
    }
    logger.error({ err }, "health server error");
  });

  server.listen(port, () => {
    logger.info({ port }, "health server listening");
  });

  return server;
}
