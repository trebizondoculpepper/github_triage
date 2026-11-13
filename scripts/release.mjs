#!/usr/bin/env node
/** `npm run release`: explicit official release (#79). See scripts/dispatch.mjs. */
import { main } from "./dispatch.mjs";

process.exitCode = main("release");
