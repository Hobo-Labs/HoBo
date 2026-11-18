import { randomBytes } from "node:crypto";
import { type NightlyCampaignOptions, runNightlyCampaign } from "./campaign.js";
import { runDockerCampaign } from "./docker-campaign.js";
import { runSchemathesis } from "./schemathesis.js";

interface NightlyArguments extends NightlyCampaignOptions {
	readonly api: boolean;
	readonly docker: boolean;
}

function parseArguments(args: readonly string[]): NightlyArguments {
	let seed = randomBytes(4).readInt32BE(0);
	let runs = 1000;
	let api = false;
	let docker = process.env.HOBO_FUZZ_DOCKER !== "0";
	let index = args[0] === "--" ? 1 : 0;
	while (index < args.length) {
		const option = args[index];
		if (option === "--api") {
			api = true;
			index++;
			continue;
		}
		if (option === "--docker" || option === "--no-docker") {
			docker = option === "--docker";
			index++;
			continue;
		}
		const value = args[index + 1];
		if (
			(option !== "--seed" && option !== "--runs") ||
			!value ||
			!/^-?(0|[1-9][0-9]*)$/u.test(value)
		)
			throw new Error(
				"usage: nightly-cli [--seed INTEGER] [--runs INTEGER] [--api] [--docker|--no-docker]",
			);
		const number = Number(value);
		if (!Number.isSafeInteger(number))
			throw new Error("option value must be a safe integer");
		if (option === "--seed") seed = number;
		else runs = number;
		index += 2;
	}
	return { seed, runs, api, docker };
}

try {
	const options = parseArguments(process.argv.slice(2));
	const report = runNightlyCampaign(options);
	const api = options.api
		? await runSchemathesis({ seed: options.seed >>> 0 })
		: undefined;
	if (api && (!api.ran || !api.passed))
		throw new Error("API fuzz failed: " + api.reason);
	const docker = options.docker ? await runDockerCampaign() : undefined;
	process.stdout.write(
		JSON.stringify({
			...report,
			...(api ? { api } : undefined),
			...(docker ? { docker } : undefined),
		}) + "\n",
	);
} catch (error) {
	process.stderr.write(
		"nightly fuzz failed: " +
			(error instanceof Error ? error.message : "unexpected error") +
			"\n",
	);
	process.exitCode = 1;
}
