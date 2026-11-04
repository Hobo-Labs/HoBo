import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deploymentIdFor } from "@hobo/cli";
import {
	collectStream,
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	openSelfHostedYard,
	SELF_HOST_DEPLOYMENT_ID,
	SELF_HOST_DEPLOYMENT_STREAM,
	selfHostTopology,
} from "../src/yard.js";

// The example package itself is the operator's project: the committed
// hobo.bindle.json is the manifest the cloud verbs read, and the dir basename
// is the deployment id. The verbs only READ the project dir; all durable
// control-plane state lands in the per-test dataDir.
const projectDir = fileURLToPath(new URL("..", import.meta.url));

interface EnvelopeData {
	deploymentId?: string;
	planHash?: string;
	provisioned?: readonly string[];
	destroyed?: readonly string[];
}

interface Envelope {
	ok: boolean;
	status: string;
	code?: string;
	data: EnvelopeData;
}

function envelope(stdout: string): Envelope {
	// SAFETY: assertion to `JSON.parse(stdout) as Envelope` is required at this boundary.
	return JSON.parse(stdout) as Envelope;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

async function freshDataDir(): Promise<string> {
	const dataDir = await mkdtemp(path.join(tmpdir(), "self-host-yard-"));
	cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
	return dataDir;
}

describe("self-host-yard", () => {
	it("derives the pinned deployment id from this project dir", () => {
		expect(deploymentIdFor(projectDir)).toBe(SELF_HOST_DEPLOYMENT_ID);
	});

	it("describes the deployment as one Yard / one Camp / one provider from the runtime's own registry", async () => {
		const dataDir = await freshDataDir();
		const hosted = openSelfHostedYard({ dataDir });
		cleanups.push(hosted.close);

		const [providerId, ...rest] = hosted.runtime.registry.providers();
		expect(rest).toEqual([]);
		expect(hosted.topology.kind).toBe("yard");
		expect(hosted.topology.name).toBe("home-yard");
		expect(hosted.topology.providerId).toBe(providerId);
		expect(hosted.topology.camps).toHaveLength(1);
		const homeCamp = hosted.topology.camps[0];
		expect(homeCamp?.envType).toBe("production");
		expect(homeCamp?.derivedProviderId).toBe(providerId);
		// The Camp records WHERE this yard runs: the operator's own disk.
		expect(homeCamp?.runtimeRequirements).toEqual([
			"event-store:sqlite",
			"runtime-local",
		]);
		expect(homeCamp?.labels["hobo.dev/event-store-data-dir"]).toBe(dataDir);
	});

	it("enforces one-provider-per-yard on the topology objects", async () => {
		const dataDir = await freshDataDir();
		const hosted = openSelfHostedYard({ dataDir });
		cleanups.push(hosted.close);

		// A runtime registry with two providers cannot describe ONE yard.
		const twoProviderRuntime = {
			...hosted.runtime,
			registry: {
				...hosted.runtime.registry,
				providers: () => ["@hobo/provider-cloudflare", "@hobo/provider-aws"],
			},
		};
		expect(() => selfHostTopology(twoProviderRuntime, dataDir)).toThrow(
			/exactly one registered provider/,
		);
	});

	it("plan/up/down run end to end and the event log survives a control-plane restart", async () => {
		const dataDir = await freshDataDir();

		// --- First control-plane process: the full lifecycle. ---
		const first = openSelfHostedYard({ dataDir });
		const plan = envelope(
			(await first.cli.run(["plan", "--json"], { cwd: projectDir })).stdout,
		);
		expect(plan.code).not.toBe("HOBO_CLI_STUB");
		expect(plan.ok).toBe(true);
		expect(plan.data.deploymentId).toBe(SELF_HOST_DEPLOYMENT_ID);
		expect(plan.data.planHash).toMatch(/^sha256:/);

		const up = envelope(
			(await first.cli.run(["up", "--json"], { cwd: projectDir })).stdout,
		);
		expect(up.code).not.toBe("HOBO_CLI_STUB");
		expect(up.ok).toBe(true);
		expect(up.status).toBe("deployed");
		const { provisioned } = up.data;
		if (provisioned === undefined) {
			throw new Error("up response missing data.provisioned");
		}
		expect([...provisioned].sort()).toEqual(["api", "web"]);

		const down = envelope(
			(await first.cli.run(["down", "--json"], { cwd: projectDir })).stdout,
		);
		expect(down.ok).toBe(true);
		expect(down.status).toBe("destroyed");
		const { destroyed } = down.data;
		if (destroyed === undefined) {
			throw new Error("down response missing data.destroyed");
		}
		expect([...destroyed].sort()).toEqual(["api", "web"]);

		// The control plane's durable state is a real file on the operator's disk.
		expect(existsSync(path.join(dataDir, "eventstore.sqlite"))).toBe(true);
		first.close();

		// --- Second control-plane process over the SAME dataDir: every
		// deployment fact written before the restart is already in its event
		// store — the operator's disk, not a provider, is the source of truth. ---
		const second = openSelfHostedYard({ dataDir });
		cleanups.push(second.close);
		const replayed = await collectStream(
			second.store,
			SELF_HOST_DEPLOYMENT_STREAM,
		);
		const replayedTypes = replayed.map((event) => event.type);
		expect(replayedTypes).toContain("deployment.Requested");
		expect(replayedTypes).toContain("deployment.Planned");
		expect(replayedTypes).toContain("deployment.Deployed");
		expect(replayedTypes).toContain("resource.Destroyed");
		expect(replayedTypes).toContain("deployment.RolledBack");

		// The restarted yard re-plans the same bindle to the same content-
		// addressed plan (pure read path — no new facts appended).
		const replan = envelope(
			(await second.cli.run(["plan", "--json"], { cwd: projectDir })).stdout,
		);
		expect(replan.ok).toBe(true);
		expect(replan.data.planHash).toBe(plan.data.planHash);

		// --- A bare store over the same dataDir (no yard at all) reads the
		// identical history: the log is plain data on disk. ---
		const audit = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock(),
		});
		cleanups.push(() => audit.close());
		const history = await collectStream(audit, SELF_HOST_DEPLOYMENT_STREAM);
		expect(history.map((event) => event.type)).toEqual(replayedTypes);
		expect(history).toHaveLength(replayed.length);
	});

	it("realizes and tears down exactly what the operator pact pins", async () => {
		// SAFETY: assertion to `.parse( await readFile( new URL( "../contracts/pacts/operator-to-yard.pact.json", import.meta.url, ), "utf8", ), ) as { ` is required at this boundary.
		const pact = JSON.parse(
			await readFile(
				new URL(
					"../contracts/pacts/operator-to-yard.pact.json",
					import.meta.url,
				),
				"utf8",
			),
		) as {
			interactions: {
				response: {
					body: {
						deploymentId: string;
						status: string;
						provisioned?: string[];
						destroyed?: string[];
					};
				};
			}[];
		};
		const [upPin, downPin] = pact.interactions;

		const dataDir = await freshDataDir();
		const hosted = openSelfHostedYard({ dataDir });
		cleanups.push(hosted.close);

		const up = envelope(
			(await hosted.cli.run(["up", "--json"], { cwd: projectDir })).stdout,
		);
		expect(up.data.deploymentId).toBe(upPin?.response.body.deploymentId);
		expect(up.status).toBe(upPin?.response.body.status);
		const { provisioned } = up.data;
		if (provisioned === undefined) {
			throw new Error("pact up response missing data.provisioned");
		}
		expect([...provisioned].sort()).toEqual(upPin?.response.body.provisioned);

		const down = envelope(
			(await hosted.cli.run(["down", "--json"], { cwd: projectDir })).stdout,
		);
		expect(down.data.deploymentId).toBe(downPin?.response.body.deploymentId);
		expect(down.status).toBe(downPin?.response.body.status);
		const { destroyed } = down.data;
		if (destroyed === undefined) {
			throw new Error("pact down response missing data.destroyed");
		}
		expect([...destroyed].sort()).toEqual(downPin?.response.body.destroyed);
	});
});
