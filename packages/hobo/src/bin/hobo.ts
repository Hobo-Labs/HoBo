#!/usr/bin/env node
import { join } from "node:path";
// Register TypeScript bindle sources before composing the CLI so `hobo dev`
// runs the flagship src/bindle.ts authoring path without a separate build.
import { register } from "tsx/esm/api";
import { defaultHoboHome } from "../bare-metal-yard.js";

register();

import { createHoboCli, type HoboCli, parseArgv } from "@hobo/cli";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import { createCiCommand } from "../ci-command.js";
import { createComposedHoboCli } from "../cli.js";
import {
	bootstrapDefaultProviders,
	createDefaultYardRuntime,
	type DefaultYardRuntimeOptions,
	toRegistrableProvider,
} from "../compose.js";
import {
	relaunchInputFor,
	relaunchUnderOpenSesame,
	reportingCredentialRefusals,
	runsAVerb,
	wantsOpenSesameRelaunch,
	withoutCredentials,
	workingDirOf,
} from "../credentials-opensesame.js";
import { runFleetCli } from "../fleet-cli.js";
import { createBareMetalProvider } from "../local-provider.js";
import { removeOwnedDirsOnSignals } from "../owned-temp-dir.js";

// The real composed `hobo` binary. Unlike @hobo/cli's bare bin (which calls
// createHoboCli() un-injected, leaving the cloud verbs as shell stubs), this
// wires the default LOCAL/MOCKED runtimes so collect/plan/up/down/dev run the
// real in-process flow. `hobo up` goes through the embedded broker-runtime
// (prefer wasm-sandbox yards, auto-create camps). Before dispatch, the default
// provider set is recorded as durable registration + approval facts. Bare-metal
// is bootstrapped alongside cloudflare so local Yards are first-class.
const args = process.argv.slice(2);

function writeResult(result: Awaited<ReturnType<HoboCli["run"]>>): number {
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	return result.exitCode;
}

async function runComposed(
	options: DefaultYardRuntimeOptions = {},
): Promise<number> {
	// `hobo fleet` owns its strict parser (tokens only from files, never argv),
	// so its words go to it before the shell's global option parser sees them.
	if (args[0] === "fleet") return runFleetCli(args.slice(1));
	// CI talks to its account relay and GitHub directly. It must work before
	// local Yard provisioning and without creating an unrelated SQLite journal.
	let verb: string | null;
	try {
		verb = parseArgv(args).verb;
	} catch {
		return writeResult(await createHoboCli().run(args));
	}
	if (verb === "ci")
		return writeResult(
			await createHoboCli({ commands: { ci: createCiCommand() } }).run(args),
		);
	// The live Pulumi lane's temporary workspace is removed on exit; as the entry
	// point, this process has owned temporary directories removed on a signal too.
	removeOwnedDirsOnSignals();
	const runtime = createDefaultYardRuntime({
		dataDir: join(defaultHoboHome(), "runtime"),
		...options,
	});
	await bootstrapDefaultProviders(runtime, [
		toRegistrableProvider(createCloudflareProvider()),
		createBareMetalProvider(),
	]);
	const cli = createComposedHoboCli({
		yardRuntime: runtime,
		requireRealExecution: true,
	});
	const result = await cli.run(args);

	if (result.stdout) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	return result.exitCode;
}

// HOBO_CREDENTIALS=opensesame (ADR-0170): before composing anything, run this
// same invocation once more under `opensesame dev --agent run`, and exit as it
// did. The relaunched child carries HOBO_OPENSESAME_CHILD=1 and composes. It
// gets only the Node options that read no environment or code from disk, and
// hobo.credentials.json is read from the directory the verb works in (--cwd).
// Help and usage errors run no verb: they are answered here, composed with no
// credential and an IaC lane that refuses, without starting OpenSesame.
process.exitCode = !wantsOpenSesameRelaunch(process.env)
	? await reportingCredentialRefusals(() => runComposed())
	: runsAVerb(args)
		? await relaunchUnderOpenSesame(
				relaunchInputFor(process, workingDirOf(args, process.cwd())),
			)
		: await reportingCredentialRefusals(() =>
				runComposed(withoutCredentials()),
			);
