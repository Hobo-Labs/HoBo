import { runS4StageGateDrill } from "../src/s4-stage-gate.js";

const args = process.argv.slice(2);
const phase = readArg("--phase") ?? "deploy-and-assert";
const runId = readArg("--run-id") ?? "local-run";

const result = runS4StageGateDrill({ phase, runId });
console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}
