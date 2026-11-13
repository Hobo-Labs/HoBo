#!/usr/bin/env node
/**
 * The runner controller's supervisor: runs the box worker (or a local
 * runner) as a release staged by digest in the worker's data directory and
 * swaps it when the host's CD agent asks (`src/runner-controller-process.ts`;
 * `deploy/runner-fleet/README.md`, "A controller that runs as a process").
 *
 * - `HOBO_CI_WORKER_DB` names the worker's journal; its directory is the data
 *   directory (default: the worker's own default path).
 * - `HOBO_CI_CONTROLLER_RELEASE` (optional) is a release file to adopt on
 *   first start: it is hashed, staged by its digest and requested, unless the
 *   agent has already asked for a release.
 * - `HOBO_CI_CONTROLLER_ARGS` (optional) is a JSON array of arguments the
 *   release is started with (a local runner's release takes `["daemon"]`).
 *
 * It starts each release as `node <release> ...args`, never through a shell,
 * with `HOBO_CI_CONTROLLER_DIGEST` set. SIGTERM or SIGINT stops the child
 * (the worker drains on SIGTERM) and then the supervisor.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	createControllerSupervisor,
	defaultWorkerDatabasePath,
	nodeControllerLauncher,
	readControllerDesired,
	stageControllerRelease,
	workerHostFiles,
	writeControllerDesired,
} from "@hobo/ci-gh-actions";
import { z } from "zod";

const log = (
	event: string,
	fields: Readonly<Record<string, string | number>> = {},
) => process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);

function fail(message: string): never {
	log("hobo_ci_controller_supervisor_failed", { message });
	process.exit(1);
}

const files = workerHostFiles(
	resolve(
		process.env.HOBO_CI_WORKER_DB?.trim() ||
			defaultWorkerDatabasePath(process.env, homedir()),
	),
);

const ControllerArgs = z.array(z.string().max(256)).max(16);
function parseControllerArgs(raw: string): string[] {
	try {
		const parsed = ControllerArgs.safeParse(JSON.parse(raw));
		if (parsed.success) return parsed.data;
	} catch {
		// Not JSON: refused below like any other malformed value.
	}
	return fail(
		"HOBO_CI_CONTROLLER_ARGS must be a JSON array of up to 16 strings",
	);
}
const rawArgs = process.env.HOBO_CI_CONTROLLER_ARGS?.trim();
const args = rawArgs ? parseControllerArgs(rawArgs) : [];

const adopt = process.env.HOBO_CI_CONTROLLER_RELEASE?.trim();
if (adopt && !(await readControllerDesired(files))) {
	const bytes = await readFile(resolve(adopt)).catch(() =>
		fail(`HOBO_CI_CONTROLLER_RELEASE ${adopt} is not readable`),
	);
	const digest = await stageControllerRelease(files, bytes);
	await writeControllerDesired(files, {
		generation: 1,
		digest,
		requestedAtMs: Date.now(),
	});
	log("hobo_ci_controller_release_adopted", { digest });
}

const { HOBO_CI_CONTROLLER_RELEASE: _adopted, ...env } = process.env;
const supervisor = createControllerSupervisor({
	files,
	launch: nodeControllerLauncher({ args, env }),
	log,
});

let stopping = false;
const timer = setInterval(() => {
	if (!stopping)
		void supervisor.tick().catch((error: Error) =>
			log("hobo_ci_controller_supervisor_tick_failed", {
				message: error.message,
			}),
		);
}, 1_000);
await supervisor.tick();

const stop = () => {
	if (stopping) return;
	stopping = true;
	clearInterval(timer);
	void supervisor.shutdown().finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
