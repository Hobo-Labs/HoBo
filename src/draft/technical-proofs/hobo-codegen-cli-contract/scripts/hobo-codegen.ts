#!/usr/bin/env node
import { createCodegenCli } from "../src/codegen-cli-contract.js";

const cli = createCodegenCli();
const result = await cli.run(["codegen", ...process.argv.slice(2)], {
  cwd: process.cwd(),
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
