#!/usr/bin/env node
/** `npm run make-prerelease`: explicit prerelease on npm "next" (#79). See scripts/dispatch.ts. */
import { main } from "./dispatch.js";

process.exitCode = main("prerelease");
