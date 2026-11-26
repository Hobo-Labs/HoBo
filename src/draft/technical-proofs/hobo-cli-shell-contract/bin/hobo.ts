#!/usr/bin/env node
import { runHobo } from "../src/cli-shell.js";

const result = await runHobo(process.argv.slice(2), { cwd: process.cwd(), env: process.env });

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}
process.exitCode = result.exitCode;
