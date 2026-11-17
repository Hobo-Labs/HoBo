import { randomBytes } from "node:crypto";
import { type NightlyCampaignOptions, runNightlyCampaign } from "./campaign.js";
import { runSchemathesis } from "./schemathesis.js";

interface NightlyArguments extends NightlyCampaignOptions {
	readonly api: boolean;
}

function parseArguments(args: readonly string[]): NightlyArguments {
	let seed = randomBytes(4).readInt32BE(0);
	let runs = 1000;
	let api = false;
	let index = args[0] === "--" ? 1 : 0;
	while (index < args.length) {
		const option = args[index];
		if (option === "--api") {
			api = true;
			index++;
			continue;
		}
		const value = args[index + 1];
		if (
			(option !== "--seed" && option !== "--runs") ||
			!value ||
			!/^-?(0|[1-9][0-9]*)$/u.test(value)
		) {
			throw new Error(
				"usage: nightly-cli [--seed INTEGER] [--runs INTEGER] [--api]",
			);
		}
		const number = Number(value);
		if (!Number.isSafeInteger(number))
			throw new Error("option value must be a safe integer");
		if (option === "--seed") seed = number;
		else runs = number;
		index += 2;
	}
	return { seed, runs, api };
}

try {
	const options = parseArguments(process.argv.slice(2));
	const report = runNightlyCampaign(options);
	if (options.api) {
		const api = await runSchemathesis({ seed: options.seed >>> 0 });
		if (!api.ran || !api.passed)
			throw new Error("API fuzz failed: " + api.reason);
		process.stdout.write(JSON.stringify({ ...report, api }) + "\n");
	} else {
		process.stdout.write(JSON.stringify(report) + "\n");
	}
} catch (error) {
	process.stderr.write(
		"nightly fuzz failed: " +
			(error instanceof Error ? error.message : "unexpected error") +
			"\n",
	);
	process.exitCode = 1;
}
