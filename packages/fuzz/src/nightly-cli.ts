import { randomBytes } from "node:crypto";
import { type NightlyCampaignOptions, runNightlyCampaign } from "./campaign.js";

function parseArguments(args: readonly string[]): NightlyCampaignOptions {
	let seed = randomBytes(4).readInt32BE(0);
	let runs = 1000;
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (
			(option !== "--seed" && option !== "--runs") ||
			!value ||
			!/^-?(0|[1-9][0-9]*)$/u.test(value)
		) {
			throw new Error("usage: nightly-cli [--seed INTEGER] [--runs INTEGER]");
		}
		const number = Number(value);
		if (!Number.isSafeInteger(number))
			throw new Error("option value must be a safe integer");
		if (option === "--seed") seed = number;
		else runs = number;
	}
	return { seed, runs };
}

try {
	const report = runNightlyCampaign(parseArguments(process.argv.slice(2)));
	process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
	process.stderr.write(
		`nightly fuzz failed: ${error instanceof Error ? error.message : "unexpected error"}\n`,
	);
	process.exitCode = 1;
}
