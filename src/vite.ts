import fs, { access, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { InlineConfig, PluginOption, build, defineConfig } from "vite";
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import react from "@vitejs/plugin-react";
import { dynamoOrderedWrite, dynamodb, evidently } from "@microws/aws";
import {
  CreateFeatureCommand,
  UpdateFeatureCommand,
  GetFeatureCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-evidently";
import { glob } from "glob";

import { argv } from "node:process";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getEnvironment } from "./environment.js";
const TenDaysSeconds = 60 * 60 * 24 * 10;
let matchExpression = null;
if (argv[4]) {
  matchExpression = new RegExp(`\/${argv[4]}`, "i");
}

export type MicrowsConfig = {
  table?: string;
  evidentlyArn?: string;
  bucket?: string;
  globals?: Record<string, string>;
};
export function MicrowsConfig({ table, evidentlyArn, bucket, globals }: MicrowsConfig) {
  if (!globals) {
    globals = {};
  }
  let externals = [];

  //@ts-ignore
  return defineConfig(async ({ command, mode, isSsrBuild, isPreview }) => {
    if (command == "build") {
      for await (const file of await glob(["./app/Shared*.ts"])) {
        if (!matchExpression || matchExpression.test(file)) {
          let [junk, sharedname] = file.match(/app\/([^\/]+)\.ts$/);
          const config: InlineConfig = {
            appType: "custom",
            root: "app",
            mode: "production",
            define: {
              globalThis: "window",
              "process.env.NODE_ENV": JSON.stringify("production"),
            },
            resolve: {
              alias: {
                "./runtimeConfig": "./runtimeConfig.browser",
              },
            },
            build: {
              assetsInlineLimit: 0,
              outDir: resolve("./dist/app/"),
              emptyOutDir: true,
              target: "es2022",
              lib: {
                entry: resolve("./app/" + sharedname + ".ts"),
                name: sharedname,
                fileName: (format, entryName) => {
                  return `static/${sharedname.toLowerCase()}-[hash].js`;
                },
                formats: ["umd"],
              },
              rollupOptions: {
                external: [],
                output: {},
              },
            },
            plugins: [
              react(),
              S3UploadPlugin(bucket),
              MicrowsModuleLog(new RegExp(`(${sharedname.toLowerCase()})-(.*).js`), evidentlyArn, table),
            ],
          };
          await build(config);
        } else {
          console.log("Skipping file", file);
        }
      }

      for await (const file of await glob(["./app/*/*/index.tsx"])) {
        if (!matchExpression || matchExpression.test(file)) {
          externals.push(file);
          let [junk, site, module] = file.match(/app\/([^\/]+)\/([^\/]+)\/index.tsx/);
          let moduleName = `${site.toLowerCase()}-${module.toLowerCase()}`;

          const config: InlineConfig = {
            appType: "custom",
            root: "app",
            mode: "production",
            define: {
              globalThis: "window",
              "process.env.NODE_ENV": JSON.stringify("production"),
            },
            resolve: {
              alias: {
                "./runtimeConfig": "./runtimeConfig.browser",
              },
            },
            build: {
              assetsInlineLimit: 0,
              target: "es2022",
              sourcemap: "inline",
              rollupOptions: {
                external: Object.keys(globals),
                output: {
                  format: "iife",
                  entryFileNames: `static/${moduleName}-[hash]_sourcemap.js`,
                  assetFileNames: `static/${moduleName}/[name]_[hash].[ext]`,
                  globals: globals,
                },
                input: file,
              },
              emptyOutDir: true,
              outDir: resolve("./dist/app/"),
            },
            plugins: [react(), bucket ? S3UploadPlugin(bucket) : null].filter(Boolean),
          };
          await build(config);
          delete config.build.sourcemap;
          let output: any = config.build.rollupOptions.output;
          output.entryFileNames = output.entryFileNames?.replace(/_sourcemap\.js/, ".js");
          config.plugins.push(MicrowsModuleLog(new RegExp(`(${moduleName})-(.*).js`), evidentlyArn, table));
          await build(config);
        } else {
          console.log("Skipping file", file);
        }
      }
      for await (const file of await glob(["./app/*/index.html"])) {
        if (!matchExpression || matchExpression.test(file)) {
          let [junk, site] = file.match(/app\/([^\/]+)\/index.html/);
          console.log(file);
          const config: InlineConfig = {
            appType: "custom",
            root: "app",
            mode: "production",
            define: {
              globalThis: "window",
              "process.env.NODE_ENV": JSON.stringify("production"),
            },
            resolve: {
              alias: {
                "./runtimeConfig": "./runtimeConfig.browser",
              },
            },
            build: {
              assetsInlineLimit: 0,
              target: "es2022",
              rollupOptions: {
                external: Object.keys(globals),
                output: {
                  format: "iife",
                  entryFileNames: `static/${site.toLowerCase()}-core.tsx`,
                  assetFileNames: `static/${site.toLowerCase()}/[name]_[hash].[ext]`,
                  globals: globals,
                  inlineDynamicImports: true,
                },
                input: file,
              },
              emptyOutDir: true,
              outDir: resolve("./dist/app/"),
            },
            plugins: [
              react(),
              singleFile(site + "/index.html", `static/${site.toLowerCase()}-core.tsx`),
              S3UploadPlugin(bucket),
              MicrowsModuleLog(new RegExp(`(${site.toLowerCase()}-html)-(.*).html`), evidentlyArn, table),
            ],
          };
          await build(config);
        } else {
          console.log("Skipping file", file);
        }
      }

      process.exit(0);
    }
    return {
      appType: "custom",
      root: "app",
      resolve: {
        alias: {
          "./runtimeConfig": "./runtimeConfig.browser",
        },
      },
      test: {
        root: ".",
        globals: true,
        env: Object.fromEntries((await getEnvironment(`/${process.env.SERVICE}/dev/`)).entries()),
      },
    };
  });
}

function singleFile(htmlFileName: string, javascriptFileName: string): PluginOption {
  return {
    name: "SingleFile",
    enforce: "post",
    generateBundle: async (_, bundle) => {
      let htmlFile = bundle[htmlFileName] as any;
      let jsFile = bundle[javascriptFileName] as any;

      let sharedFiles = (await glob(["./app/shared*.ts"]))
        .map((path) => {
          return `<script src="${path.replace("app/", "/static/").replace(".ts", "-[HASH].js")}"></script>`;
        })
        .join("\n");
      htmlFile.source = htmlFile.source.replace(
        new RegExp(`<script .* src="/${javascriptFileName}"></script>`, "i"),
        `${sharedFiles}\n<script type="text/javascript">\n${jsFile.code}</script>`,
      );
      delete bundle[javascriptFileName];

      const hash = createHash("sha256").update(htmlFile.source).digest("base64url");
      htmlFile.fileName = javascriptFileName.replace(/core.*$/, `html-${hash.slice(-10)}.html`);
    },
  };
}
export function S3UploadPlugin(bucket: string) {
  return {
    name: "UploadToS3",
    writeBundle: async (result, data) => {
      if (!bucket) return;
      let distDir = resolve(result.dir);
      try {
        await new Promise<void>((res, rej) => {
          let p = exec(`
        aws s3 sync  --cache-control "max-age=31536000" --size-only  ${resolve(distDir, "static")} ${bucket}/static `);
          p.stdout.pipe(process.stdout);
          p.stderr.pipe(process.stderr);
          p.on("exit", (code) => {
            if (code) {
              rej(new Error("Failed to execute: " + code));
            } else {
              res();
            }
          });
        });
      } catch (e) {
        console.log(e);
        console.log("Can't upload from here");
      }
    },
  };
}
export function MicrowsModuleLog(reg: RegExp, evidentlyArn: string, table: string) {
  return {
    name: "MicowsModule",
    writeBundle: async (result, data) => {
      let distDir = resolve(result.dir, "static");
      let files = await fs.readdir(distDir);
      let mainFile = files.map((file) => reg.exec(file)).filter(Boolean)[0];
      if (mainFile?.index == 0) {
        const name = mainFile[1];
        const version = mainFile[2];

        if (table) {
          await dynamoOrderedWrite(
            new GetCommand({
              TableName: table,
              Key: {
                PK: "MicrowsModule",
                SK: name.toLowerCase(),
              },
            }),
            async (current: { TypeSK: string }) => {
              return [
                {
                  Put: {
                    TableName: table,
                    Item: {
                      PK: name.toLowerCase(),
                      SK: "MicrowsModuleLog-" + new Date().toISOString(),
                      id: name.toLowerCase(),
                      target: "developer",
                      TypePK: "MicrowsModuleLog",
                      TypeSK: new Date().toISOString(),
                      version: version,
                      ttl: Date.now() / 1000 + TenDaysSeconds,
                    },
                  },
                },
                {
                  Update: {
                    TableName: table,
                    Key: {
                      PK: "MicrowsModule",
                      SK: name.toLowerCase(),
                    },
                    UpdateExpression: `SET
                      #developer=:developer, 
                      #qa=:developer, 
                      #deploy=if_not_exists(#deploy, :none),
                      #general=if_not_exists(#general, :none),
                      #id=:name,TypePK=:microwsModule, TypeSK=:date`,
                    ExpressionAttributeNames: {
                      "#developer": "developer",
                      "#qa": "qa",
                      "#deploy": "deploy",
                      "#general": "general",
                      "#id": "id",
                    },
                    ConditionExpression: "attribute_not_exists(PK) or TypeSK=:lastdate",
                    ExpressionAttributeValues: {
                      ":name": name.toLowerCase(),
                      ":lastdate": current?.TypeSK || 0,
                      ":none": {
                        version: "None",
                        date: new Date().toISOString(),
                      },
                      ":developer": {
                        version: version,
                        date: new Date().toISOString(),
                      },
                      ":date": new Date().toISOString(),
                      ":microwsModule": "MicrowsModule",
                    },
                  },
                },
              ];
            },
          );
        }
        if (evidentlyArn) {
          const featureName = "Module_" + name;
          let variations: null | Map<string, { hash: string; time: string; value: { stringValue: string } }> = null;
          try {
            let { feature } = await evidently.send(
              new GetFeatureCommand({
                project: evidentlyArn,
                feature: featureName,
              }),
            );
            variations = new Map(
              feature.variations.map((r) => {
                let [hash, time] = r.value.stringValue.split(/[\s*\u00A0]*\|[\s*\u00A0]*/);
                return [
                  r.name,
                  {
                    hash,
                    time,
                    value: r.value as { stringValue: string },
                  },
                ];
              }),
            );
          } catch (e) {
            if (!(e instanceof ResourceNotFoundException)) {
              throw e;
            }
          }
          let versionValue = {
            stringValue: [version, new Date().toISOString().replace(/\.\d+Z$/, "Z")].join(" \u00A0 | \u00A0 "),
          };
          if (variations == null) {
            await evidently.send(
              new CreateFeatureCommand({
                project: evidentlyArn,
                name: featureName,
                variations: [
                  { name: "trunk", value: versionValue },
                  { name: "release", value: { stringValue: "None" } },
                  { name: "beta", value: { stringValue: "None" } },
                  { name: "history_1", value: { stringValue: "None" } },
                  { name: "history_2", value: { stringValue: "None" } },
                ],
                defaultVariation: "release",
              }),
            );
          } else {
            if (
              variations.get("trunk").hash !== version ||
              (process.env.FORCE_PROD == "true" && variations.get("release").hash !== version) ||
              (process.env.FORCE_BETA == "true" && variations.get("beta").hash !== version)
            ) {
              await evidently.send(
                new UpdateFeatureCommand({
                  project: evidentlyArn,
                  feature: featureName,
                  description: "Microws Module",
                  addOrUpdateVariations: [
                    variations.get("trunk").hash !== version ? { name: "trunk", value: versionValue } : null,
                    variations.get("beta").hash !== version && process.env.FORCE_BETA == "true"
                      ? { name: "beta", value: versionValue }
                      : null,
                    variations.get("release").hash !== version && process.env.FORCE_PROD == "true"
                      ? { name: "release", value: versionValue }
                      : null,
                    process.env.FORCE_PROD == "true"
                      ? { name: "history_1", value: variations.get("release").value }
                      : null,
                    process.env.FORCE_PROD == "true"
                      ? { name: "history_2", value: variations.get("history_1").value }
                      : null,
                  ].filter(Boolean),
                }),
              );
            }
          }
        }
      }
    },
  };
}
