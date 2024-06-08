#!/usr/bin/env -S node --enable-source-maps

import { resolve } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { devSetup } from "../lib/utils.js";
register("ts-node/esm", pathToFileURL("./"));
import { setUncaughtExceptionCaptureCallback } from "node:process";

setUncaughtExceptionCaptureCallback((error) => {
  console.error(error);
  process.exit(1);
});
await devSetup();

await import(resolve(process.cwd(), process.argv[2]));
