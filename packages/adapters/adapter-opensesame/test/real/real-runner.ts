/** Plays each scenario of the proxied-run pact against the real binary. */

import type { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";

import type { parseCredentialBindings } from "../../src/binding.js";
import type {
	ObservedRun,
	Scenario,
	ScenarioRunner,
} from "../support/proxied-run-provider.js";
import { runRawSchema, UNBOUNDED_SCHEMA } from "../support/raw-run.js";
import type { Kit } from "./kit.js";
import { get, runChild } from "./run-child.js";
import { Sandbox, STORE_PASSPHRASE } from "./sandbox.js";
import { startUpstream, UPSTREAM_HOST } from "./tls.js";

const IN_SCOPE = `https://${UPSTREAM_HOST}/v9/projects/x`;

export function createRealRunner(kit: Kit): ScenarioRunner {
	return {
		async run(scenario: Scenario, bindings): Promise<ObservedRun> {
			const sandbox = Sandbox.create(kit);
			const upstream = await startUpstream(sandbox.pki);
			try {
				return await play(sandbox, upstream, scenario, bindings);
			} finally {
				await upstream.close();
				sandbox.cleanup();
			}
		},
	};
}

async function play(
	sandbox: Sandbox,
	upstream: Awaited<ReturnType<typeof startUpstream>>,
	scenario: Scenario,
	bindings: ReturnType<typeof parseCredentialBindings>,
): Promise<ObservedRun> {
	const env = sandbox.runEnv(upstream);
	if (scenario === "plugin-absent") sandbox.init();
	else if (scenario === "no-sealed-entry") {
		sandbox.init();
		sandbox.installPlugin();
	} else sandbox.setUp();
	if (scenario === "plugin-changed")
		appendFileSync(sandbox.installedPlugin(), "\0");

	if (scenario === "scope-unbounded") {
		const outcome = runRawSchema(sandbox.kit.opensesame, env, UNBOUNDED_SCHEMA);
		return {
			outcome,
			childEnv: undefined,
			leaked: sandbox.filesNaming(sandbox.token).length > 0,
		};
	}
	const plan =
		scenario === "misdirected"
			? {
					lingerMs: 60_000,
					requests: [
						get(IN_SCOPE, "in scope"),
						get("https://collect.evil.test/x", "misdirected"),
					],
				}
			: scenario === "sigterm"
				? { wait: true, requests: [get(IN_SCOPE, "in scope")] }
				: { requests: [get(IN_SCOPE, "in scope")] };
	const runEnv =
		scenario === "wrong-passphrase"
			? { ...env, OPENSESAME_STORE_PASSWORD: `not-${STORE_PASSPHRASE}` }
			: env;
	// SIGTERM goes to OpenSesame the way a supervisor's would: through the adapter.
	const whileHeld =
		scenario === "sigterm"
			? async (host: EventEmitter) => {
					host.emit("SIGTERM", "SIGTERM");
				}
			: undefined;
	const run = await runChild(sandbox, plan, {
		bindings,
		env: runEnv,
		whileHeld,
	});
	const everything = [
		run.stderr,
		JSON.stringify(run.outcome),
		run.argv.join("\n"),
		Object.values(run.childEnv ?? {}).join("\n"),
	].join("\n");
	return {
		outcome: run.outcome,
		childEnv: run.childEnv,
		leaked:
			everything.includes(sandbox.token) ||
			sandbox.filesNaming(sandbox.token).length > 0,
	};
}
