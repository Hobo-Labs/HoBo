// The release gate's check entry (ADR-0172): run one ai-bdd step, or all three,
// against HOBO_AI_BDD_PROJECT with HOBO_AI_BDD_CMD, print ai-bdd's own output to
// stderr and one JSON evidence line last on stdout (the stage-gate runner keeps
// that line), and exit 0 passed, ai-bdd's failing code, 1 a refused report,
// 2 configuration, or 3 not run.
//
//   node --import tsx packages/stage-gate/scripts/check-acceptance.mts [plans-fresh|replay|evidence-intact|all]
import { checkAcceptance } from "../src/acceptance-check.ts";
import { stopRunningAiBdd } from "../src/ai-bdd-process.ts";

// Stopped (SIGTERM from the runner's timeoutMs, or Ctrl-C): ai-bdd runs in a
// process group of its own, so it does not see the signal unless it is passed
// on. Its group gets the same signal, and SIGKILL after AI_BDD_GRACE_MS; then
// this exits. A second signal ends this at once.
for (const [signal, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
] as const) {
	process.once(signal, () => {
		void stopRunningAiBdd(signal).then(() => process.exit(code));
	});
}

const result = await checkAcceptance(
	process.argv.slice(2),
	process.env,
	process.cwd(),
);
process.stdout.write(`${JSON.stringify(result.evidence)}\n`);
process.exitCode = result.exitCode;
