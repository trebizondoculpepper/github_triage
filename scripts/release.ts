#!/usr/bin/env node
/** `npm run release`: explicit official release (#79). See scripts/dispatch.ts. */
import { main } from "./dispatch.js";

process.exitCode = main("release");
