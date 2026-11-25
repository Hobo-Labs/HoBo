import { checkAcceptance } from "../src/acceptance-check.ts";
import { stopRunningAiBdd } from "../src/ai-bdd-process.ts";

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
