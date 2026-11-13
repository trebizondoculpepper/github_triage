#!/usr/bin/env node
/** `npm run make-prerelease`: explicit prerelease on npm "next" (#79). See scripts/dispatch.mjs. */
import { main } from "./dispatch.mjs";

process.exitCode = main("prerelease");
