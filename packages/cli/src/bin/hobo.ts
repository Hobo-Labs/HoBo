#!/usr/bin/env node
import { createHoboCli } from "../shell/dispatch.js";

const cli = createHoboCli();
const result = await cli.run(process.argv.slice(2));

if (result.stdout) {
	process.stdout.write(result.stdout);
}
if (result.stderr) {
	process.stderr.write(result.stderr);
}
process.exitCode = result.exitCode;
