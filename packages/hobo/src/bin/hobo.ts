#!/usr/bin/env node
import { join } from "node:path";
import { applyEgressToProcess } from "@hobo/hobo-ci";
// Register TypeScript bindle sources before composing the CLI so `hobo dev`
// runs the flagship src/bindle.ts authoring path without a separate build.
import { register } from "tsx/esm/api";
import { defaultHoboHome } from "../bare-metal-yard.js";

register();

import { createHoboCli, type HoboCli, parseArgv } from "@hobo/cli";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import { createCiCommand } from "../ci-command.js";
import { openBrowser } from "../ci-github-connect.js";
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
import { ciUsesYard, loadOwnerKeys } from "../owner-keys.js";
import {
	createRelayOwnerSessions,
	parseRelayOrigin,
	type RelayConfirmation,
	relayCredentialsOnDemand,
	relayFlagOf,
	relayOnlyOwnerSession,
	withoutRelayFlag,
} from "../relay-owner-session.js";

// The real composed `hobo` binary. Unlike @hobo/cli's bare bin (which calls
// createHoboCli() un-injected, leaving the cloud verbs as shell stubs), this
// wires the default LOCAL/MOCKED runtimes so collect/plan/up/down/dev run the
// real in-process flow. `hobo up` goes through the embedded broker-runtime
// (prefer wasm-sandbox yards, auto-create camps). Before dispatch, the default
// provider set is recorded as durable registration + approval facts. Bare-metal
// is bootstrapped alongside cloudflare so local Yards are first-class.
const relaySessions = createRelayOwnerSessions({
	fetch,
	sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	now: Date.now,
});

async function presentRelayConfirmation(confirmation: RelayConfirmation) {
	process.stderr.write(
		`hobo: open ${confirmation.verificationUri}, sign in as the owner of HoBo's GitHub App installation, and enter the code ${confirmation.userCode}\n`,
	);
	openBrowser(confirmation.verificationUri);
}

function relayOwnerSessionFor(argv: readonly string[]) {
	const flag = relayFlagOf(argv);
	if (flag === undefined) return undefined;
	let origin: ReturnType<typeof parseRelayOrigin>;
	try {
		origin = parseRelayOrigin(flag);
	} catch {
		return undefined;
	}
	return relayOnlyOwnerSession({
		sessions: relaySessions,
		credentials: relayCredentialsOnDemand({
			sessions: relaySessions,
			origin,
			present: presentRelayConfirmation,
		}),
	});
}

const argv = process.argv.slice(2);
const args = argv[0] === "cd" ? withoutRelayFlag(argv) : argv;
const relayOwnerSession =
	argv[0] === "ci" || argv[0] === "cd" ? relayOwnerSessionFor(argv) : undefined;

function writeResult(result: Awaited<ReturnType<HoboCli["run"]>>): number {
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	return result.exitCode;
}

async function runComposed(
	options: DefaultYardRuntimeOptions = {},
): Promise<number> {
	if (args[0] === "fleet") return runFleetCli(args.slice(1));
	// CI talks to its account relay and GitHub directly. It must work before
	// local Yard provisioning and without creating an unrelated SQLite journal.
	let verb: string | null;
	let subcommand: string;
	let help: boolean;
	try {
		const parsed = parseArgv(args);
		verb = parsed.verb;
		subcommand = parsed.args[0] ?? "";
		help = parsed.help;
	} catch {
		return writeResult(await createHoboCli().run(args));
	}
	// Keys the owner keeps across runs (the retained Pulumi workspace's, the
	// claim actions'), read from their secret store into this process's vault.
	const keys = await loadOwnerKeys({
		env: process.env,
		cwd: workingDirOf(args, process.cwd()),
		verb,
		subcommand,
		help,
	});
	if (keys.kind === "refused") {
		process.stderr.write(`hobo: ${keys.message} (${keys.code})\n`);
		return 1;
	}
	// `hobo ci up|down|plan` converge the CI project through the Yard like any
	// lifecycle, so only the relay/run subcommands take this shortcut.
	// (`status` stays here: it inspects the relay connection.)
	if (verb === "ci" && !ciUsesYard(subcommand))
		return writeResult(
			await createHoboCli({
				commands: {
					ci: createCiCommand(
						relayOwnerSession !== undefined
							? {
									ownerCredentials: relayOwnerSession.credentials,
									ownerEntries: relayOwnerSession.entries,
								}
							: {},
					),
				},
			}).run(args),
		);
	// The live Pulumi lane's temporary workspace is removed on exit; as the entry
	// point, this process has owned temporary directories removed on a signal too.
	removeOwnedDirsOnSignals();
	// The box's egress (proxy, bypass list, CA), for every fetch in this
	// process, before anything connects.
	applyEgressToProcess(process.env);
	const runtime = createDefaultYardRuntime({
		dataDir: join(defaultHoboHome(), "runtime"),
		...options,
		projectDir: workingDirOf(args, process.cwd()),
	});
	await bootstrapDefaultProviders(runtime, [
		toRegistrableProvider(createCloudflareProvider()),
		createBareMetalProvider(),
	]);
	const cli = createComposedHoboCli({
		yardRuntime: runtime,
		requireRealExecution: true,
		relaySessions,
		...(relayOwnerSession !== undefined
			? { ownerSession: relayOwnerSession }
			: undefined),
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
