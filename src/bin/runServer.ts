#!/usr/bin/env -S node --enable-source-maps

import { createServer } from "vite";
import express, { Request, Response } from "express";
import "express-async-errors";
import fs from "node:fs/promises";
import { createProxyMiddleware, fixRequestBody, responseInterceptor } from "http-proxy-middleware";
import compression from "compression";
import { resolve } from "node:path";
import { devSetup, loadPackageConfig } from "../lib/utils.js";
import { glob } from "glob";
import react from "@vitejs/plugin-react";

process.env.SERVER_TYPE = process.argv[3] || process.argv[2];

const { port, devUrl: FORWARDURL, awsProfile, service, env } = loadPackageConfig();
const file = resolve("./server/index.ts");
await devSetup();

const PORT = port || 3000;

const viteServerHotReload = await createServer({
  appType: "custom",
  build: {
    rollupOptions: {
      input: {
        main: file,
      },
    },
  },
  resolve: {
    alias: {
      "#node-web-compat": "./node-web-compat-node.js",
    },
  },
  server: {
    strictPort: true,
    middlewareMode: true,
    watch: {
      usePolling: true,
      interval: 100,
    },
    hmr: {
      port: PORT + 10,
    },
  },
});
const appDir = "app/" + process.env.SERVER_TYPE + "/";
const viteModules = await createServer({
  appType: "custom",
  base: "/static/",
  root: "./" + appDir,
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
      },
    },
  },
  resolve: {
    alias: {},
  },
  server: {
    strictPort: true,
    hmr: {
      port: PORT + 20,
    },
    middlewareMode: true,
  },
  plugins: [
    react({
      include: "**/*.tsx",
    }),
  ],
});

const app = express();

app.use(viteModules.middlewares);
app.use(
  compression({
    filter: (req: Request, res: Response) => {
      if (res.get("content-type") == "text/event-stream") {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);
app.get("*", async (req, res, next) => {
  if (
    req.originalUrl.match(/api/) ||
    req.originalUrl.match(/static/) ||
    req.originalUrl.match(/.well-known/) ||
    req.originalUrl.match(/sse/)
  ) {
    return next();
  }

  try {
    res.locals.html = await viteModules.transformIndexHtml(
      "/",
      (
        await fs.readFile("./" + appDir + "index.html")
      )
        .toString()
        .replace(new RegExp(`<script.*src="shared-[^"]*"></script>`, "i"), "")
        .replace(
          new RegExp(`(<script .* src="./index.tsx"></script>)`, "i"),
          `${(
            await glob(["./" + appDir + "*/index.tsx"])
          )
            .map((path) => {
              return `<script type="module" src="${path.replace(appDir, "./")}"></script>`;
            })
            .join("\n")}\n$1`,
        ),
    );
  } catch (e) {
    console.log(e);
    throw new Error(e.message);
  }

  next();
});
app.all("*", async (req, res, next) => {
  req.url = req.originalUrl;
  try {
    const { default: handle } = await viteServerHotReload.ssrLoadModule(file, { fixStacktrace: true });
    await handle(req, res, (e: any) => {
      if (e) {
        console.error(e);
        res.status(500).end(e.stack);
      } else {
        console.log("Forwarding to the cloud handler - " + req.url);
        next("route");
      }
    });
  } catch (e) {
    viteServerHotReload.ssrFixStacktrace(e);
    console.log(e);
    res.status(500).end();
  }
});

if (FORWARDURL) {
  app.use(
    "/api",
    createProxyMiddleware({
      changeOrigin: true,
      cookieDomainRewrite: "localhost",
      followRedirects: false,
      target: FORWARDURL + "/api",
      on: {
        proxyReq: fixRequestBody,
      },
    }),
  );
  app.use(
    "/static",
    createProxyMiddleware({
      changeOrigin: true,
      cookieDomainRewrite: "localhost",
      followRedirects: false,
      target: FORWARDURL + "/static",
      on: {
        proxyReq: fixRequestBody,
      },
    }),
  );
  app.use(
    "/sse",
    createProxyMiddleware({
      changeOrigin: true,
      cookieDomainRewrite: "localhost",
      followRedirects: false,
      target: FORWARDURL + "/sse",
      on: {
        proxyReq: fixRequestBody,
      },
    }),
  );

  const microwsRegExp = new RegExp(`(<script src="/static/microws-web-.*\.js"></script>)`);
  app.use(
    createProxyMiddleware({
      changeOrigin: true,
      cookieDomainRewrite: "localhost",
      followRedirects: false,
      target: FORWARDURL,
      selfHandleResponse: true,
      on: {
        proxyReq: fixRequestBody,
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
          console.log(`rewriting HTML URL: ${req.url}`);
          let modules = (await fs.readdir("app", { withFileTypes: true }))
            .filter((f) => f.isDirectory())
            .map(({ name }) => name);
          const entrypoints = modules
            .map((module) => {
              return `<script type="module" src="./${process.env.SERVER_TYPE}/${module}/index.tsx"></script>`;
            })
            .join("\n");
          return await viteModules.transformIndexHtml(
            req.url,
            responseBuffer
              .toString("utf8")
              .replace(/\sasync\s/g, " defer ") //Async runs to fast and causes a race condition we need the scripts to wait until the page loads (dev only)
              .replace(microwsRegExp, `${entrypoints}`),
          );
        }),
      },
    }),
  );
}
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.log(err);
  next(err);
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on port ${PORT}!`);
});
process.on("uncaughtException", (e) => {
  viteServerHotReload.ssrFixStacktrace(e);
  console.log("Uncaught Error");
  console.log(e);
});
