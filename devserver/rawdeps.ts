// Dev only: binaryen's 13 MB build is served as it is on disk, not through Vite's transform.
//
// It is excluded from dependency optimization (it uses top-level await), so Vite transforms it
// like source: the one rewrite (a node:module import that only runs under Node) gives it an
// inline source map, which makes the response about 120 MB, and Vite rebuilds that map on every
// request. That held the dev server's only thread for 3 to 5 s each time a pipeline worker started,
// and a pipeline worker starts as each check ends, right as its Load begins, so the Load's first
// save request waited behind it. A response that size is also too big for the browser to cache,
// so it happened again every time.
import { createReadStream, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/** The URL Vite gives binaryen in dev (with a ?v= version query). */
const URL_PATH = "/node_modules/binaryen/index.js";

export function rawBinaryenPlugin(): Plugin {
  return {
    name: "atw-raw-binaryen",
    apply: "serve",
    configureServer(server) {
      const file = createRequire(import.meta.url).resolve("binaryen");
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== "GET" || req.url?.split("?")[0] !== URL_PATH) return next();
        res.statusCode = 200;
        res.setHeader("content-type", "text/javascript");
        res.setHeader("content-length", statSync(file).size);
        // Versioned by the ?v= query like Vite's own dependency responses, so the browser keeps it.
        res.setHeader("cache-control", "max-age=31536000,immutable");
        createReadStream(file).pipe(res);
      });
    },
  };
}
