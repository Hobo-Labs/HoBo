// HoBo's runner fleet delivered by its own @hobo/cd, end to end and offline
// (plan 0024; packages/ci-gh-actions/deploy/runner-fleet/README.md).
//
// 1. The BUILT binary against the repository's real delivery module: the
//    agent enrolls by double opt-in, the fleet's Placement is decidable
//    (its declared Rail approves the fleet's provider), and `agent run` on a
//    box worker registers the runner-host realizer with the worker's job
//    ports and runs its loop, and so does a local runner whose controller
//    is a supervised process (its runner presence read from its state
//    directory).
// 2. In process, on the durable SQLite journal, the same records in JSON
//    form, a Station composed by `openCdRuntime` and an agent composed the
//    way `agent run` composes it (its job ports read from a fake box
//    worker's data directory), over a loopback transport to the Station's
//    own feed (real SVID + DPoP): placement decide, a PROGRESSIVE_PER_GROUP
//    fan-out over the pilot group that defers an unready host, a converge
//    that swaps the controller digest, and a failed verify that restores it.
//
// 3. The fan-out end to end through the composed PromotionService, over a
//    pilot (the box) and a fleet-ring host: the pilot's promotion is
//    admitted (lineage from the recorded placement decision, the aggregate
//    gate within the Rail's max_fanout_camps and the Station budget), and
//    Matching plans the Freight its source discovered with the fleet's
//    declared Bindle on the runner-host offering, so the promotion writes
//    the box's Set with the Freight's image on its runner-host row. The
//    agent converges it, the Station's runner-host suite verifies it from
//    the agent's own report, the pilot qualifies and the fleet group starts.
//    A version that fails verify is restored by the agent, swapped to once
//    only, and halts the fan-out before the fleet group.
//
// Legs 2 and the process host adopt a host's first Set (what it runs today)
// through the desired-state ledger: a fresh host is not placed until its
// agent has reported, and it reports against a Set.
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJson } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	AssemblyRule,
	CampClaimRecordSchema,
	CampConditionType,
	type CampId,
	type CdContext,
	ConditionStatus,
	DeltaRecordSchema,
	EnrollmentState,
	FanoutStrategy,
	type FeedResponse,
	type FreightId,
	FreightManifestRecordSchema,
	FreightOrigin,
	PromotionState,
	ReconcileObservationRecordSchema,
	type ReconcilerId,
	ReconcilerMode,
	ReconcileStatus,
	ResourceObservationSchema,
	RolloutStrategy,
	SetOrigin,
	TaintEffect,
} from "@hobo/cd";
import { diffResolvedSets } from "@hobo/cd/sets";
import { definitionDigest, SOURCE_LABEL } from "@hobo/cd/sources";
import {
	parseRunnerHosts,
	RUNNER_IMAGE_SOURCE,
	RUNNER_RELEASE_ARTIFACTS,
	runnerFleetDelivery,
	runnerFleetTopology,
	runnerHostRealizationParameters,
} from "@hobo/ci-gh-actions";
import {
	runnerFleetRail,
	workerHostFiles,
} from "@hobo/ci-gh-actions/runner-host";
import type {
	HttpTransport,
	JsonObject,
	JsonValue,
	TransportRequest,
} from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";
import { agentRealizer } from "../src/cd-agent.js";
import {
	CD_RUNNER_HOST_ENV,
	ingestRunnerHostHealth,
	RUNNER_HOST_UNREADY_TAINT,
} from "../src/cd-agent-runner-host.js";
import { runCdDeploySubcommand } from "../src/cd-deploy.js";
import { agentReconciler, openCdRuntime } from "../src/cd-runtime.js";
import { openCdStore } from "../src/cd-store.js";
import { isJsonArray, isJsonObject } from "../src/json.js";
import {
	digestOf,
	FakeRunnerHost,
	imageAt,
	runnerHostResolvedSet,
} from "./fixtures/runner-host-fake.js";
import { SupervisedRunnerHost } from "./fixtures/runner-host-supervised.js";

const PACKAGE = join(import.meta.dirname, "..");
const REPO = join(PACKAGE, "..", "..");
const BIN = join(PACKAGE, "dist", "bin", "hobo.js");
const MODULE = "packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts";
// SAFETY: the runner fleet's Camp id for host `box` (hobo-ci-runners/<host id>).
const BOX = "hobo-ci-runners/box" as CampId;
const FLEET = "hobo-ci-runner-fleet";
/**
 * Recorded OCI image manifests the fake registry serves: each image's digest
 * is the sha256 of its manifest bytes, so Freight ingest verifies it at its
 * coordinate exactly as it would against GHCR.
 */
const MANIFESTS = new Map(
	["previous", "target", "broken"].map((release) => {
		const body = JSON.stringify({
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			annotations: { "org.opencontainers.image.version": release },
		});
		return [release, body] as const;
	}),
);
const imageOf = (release: string) =>
	imageAt(
		createHash("sha256")
			.update(MANIFESTS.get(release) ?? "")
			.digest("hex"),
	);
const PREVIOUS = imageOf("previous");
const TARGET = imageOf("target");
const BROKEN = imageOf("broken");

/** A registry that serves only the recorded manifests (offline). */
const registry: HttpTransport = async (request) => {
	for (const body of MANIFESTS.values()) {
		const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
		if (
			request.url ===
			`https://ghcr.io/v2/hobo-labs/hobo/hobo-ci-worker/manifests/${digest}`
		)
			return {
				status: 200,
				headers: {
					"content-type": "application/vnd.oci.image.manifest.v1+json",
					"docker-content-digest": digest,
				},
				body,
			};
	}
	return { status: 404, headers: {}, body: "" };
};
const AGENT_CONFIG = {
	hostId: "box",
	hostKind: "box-worker",
	credentialRef: "env://HOBO_CI_GHCR_READ_TOKEN",
};

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
async function freshDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cd-runner-fleet-"));
	dirs.push(dir);
	return dir;
}

type AgentKeys = Readonly<{ privateJwk: JsonObject; publicJwk: JsonObject }>;

/** An agent key pair: the private JWK stays with the agent, the public one enrolls. */
function agentKeys(): AgentKeys {
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "P-256",
	});
	// SAFETY: node:crypto exports a JWK object.
	const privateJwk = privateKey.export({ format: "jwk" }) as JsonObject;
	// SAFETY: as above.
	const publicJwk = publicKey.export({ format: "jwk" }) as JsonObject;
	return { privateJwk, publicJwk };
}

type Envelope = Readonly<{
	ok: boolean;
	code?: string;
	message?: string;
	data?: JsonObject;
}>;

/** One `hobo deploy … --json` run of the built binary from the repo root. */
function deploy(
	home: string,
	argv: readonly string[],
	env: Readonly<Record<string, string>> = {},
): Promise<Envelope> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BIN, "deploy", ...argv, "--json"], {
			cwd: REPO,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				HOBO_HOME: home,
				NODE_NO_WARNINGS: "1",
				HOBO_CD_TOPOLOGY: MODULE,
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", () => {
			try {
				// SAFETY: --json prints one envelope; the fields read here are its own.
				resolve(JSON.parse(stdout) as Envelope);
			} catch {
				reject(new Error(`no JSON envelope: ${stdout}\n${stderr}`));
			}
		});
	});
}

/**
 * `hobo deploy agent run … --json` of the built binary, stopped with SIGTERM
 * after `ms` unless it exits first (a refusal exits at once).
 */
function runAgentFor(
	home: string,
	argv: readonly string[],
	env: Readonly<Record<string, string>>,
	ms: number,
): Promise<Envelope & { exitedEarly: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[BIN, "deploy", "agent", "run", ...argv, "--json"],
			{
				cwd: REPO,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					HOBO_HOME: home,
					NODE_NO_WARNINGS: "1",
					...env,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		let exitedEarly = true;
		const timer = setTimeout(() => {
			exitedEarly = false;
			child.kill("SIGTERM");
		}, ms);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", () => {
			clearTimeout(timer);
			try {
				// SAFETY: --json prints one envelope; the fields read here are its own.
				resolve({ ...(JSON.parse(stdout) as Envelope), exitedEarly });
			} catch {
				reject(new Error(`no JSON envelope: ${stdout}\n${stderr}`));
			}
		});
	});
}

/** A member of an envelope or event body, by path (array members by index). */
function pick(
	value: JsonValue | undefined,
	...path: string[]
): JsonValue | undefined {
	let at = value;
	for (const key of path) {
		if (isJsonArray(at)) at = at[Number(key)];
		else if (isJsonObject(at)) at = at[key];
		else return undefined;
	}
	return at;
}

// The built-binary legs need `pnpm --filter @hobo/hobo build`. Outside CI a
// missing binary skips them; in CI it fails loudly instead of passing empty.
it.runIf(Boolean(process.env.CI) && !existsSync(BIN))(
	"the built binary the runner fleet's binary legs run is present in CI",
	() => {
		expect.fail(
			`${BIN} is missing: build @hobo/hobo before this suite (pnpm --filter @hobo/hobo build)`,
		);
	},
);

describe.skipIf(!existsSync(BIN))(
	"the runner fleet through the built binary",
	{ timeout: 180_000 },
	() => {
		it("enrolls a runner host's agent by double opt-in and decides the fleet's Placement", async () => {
			const home = await freshDir();
			const applied = await deploy(home, [
				"pipeline",
				"apply",
				"--file",
				MODULE,
			]);
			expect(applied.ok, applied.message).toBe(true);

			const keys = agentKeys();
			const publicFile = join(home, "public.jwk.json");
			await writeFile(publicFile, JSON.stringify(keys.publicJwk));
			const token = await deploy(home, [
				"agent",
				"token",
				"--camp-set",
				FLEET,
				"--camp",
				BOX,
			]);
			expect(token.ok, token.message).toBe(true);
			const enrolled = await deploy(home, [
				"agent",
				"enroll",
				"--token",
				String(pick(token.data, "token")),
				"--jwk-file",
				publicFile,
			]);
			expect(enrolled.ok, enrolled.message).toBe(true);
			expect(["ENROLLMENT_STATE_PENDING", EnrollmentState.PENDING]).toContain(
				pick(enrolled.data, "state"),
			);
			const id = String(pick(enrolled.data, "reconciler", "reconcilerId"));
			// Grant 1 and grant 2 come from separate principals (I24).
			const approved = await deploy(home, ["agent", "approve-key", id], {
				HOBO_USER: "ops-alice",
			});
			expect(approved.ok, approved.message).toBe(true);
			const sameHand = await deploy(
				home,
				["agent", "accept", id, "--camp", BOX],
				{ HOBO_USER: "ops-alice" },
			);
			expect(sameHand.ok).toBe(false);
			const accepted = await deploy(
				home,
				["agent", "accept", id, "--camp", BOX],
				{ HOBO_USER: "ops-bob" },
			);
			expect(accepted.ok, accepted.message).toBe(true);
			expect(["ENROLLMENT_STATE_ACCEPTED", EnrollmentState.ACCEPTED]).toContain(
				pick(accepted.data, "reconciler", "enrollment"),
			);

			// The module's Rail approves the fleet's provider: placement no longer
			// refuses rail-providers-unknown. The box has not contacted the Station
			// yet, so it is tainted unreachable and nothing is placed: fail closed.
			const decided = await deploy(home, [
				"placement",
				"decide",
				FLEET,
				"--pipeline",
				FLEET,
				"--node",
				"fleet",
				"--station",
				"local",
			]);
			expect(decided.ok).toBe(false);
			expect(decided.code).toBe("placement-unsatisfiable");

			// The same Camps without the module's Rail: placement fails closed.
			const camps = join(home, "camps-only.json");
			const hosts = parseRunnerHosts(
				await readFile(
					join(REPO, "packages/ci-gh-actions/deploy/runner-fleet/hosts.json"),
					"utf8",
				),
			);
			if (!hosts.ok) throw new Error("hosts.json does not parse");
			await writeFile(
				camps,
				JSON.stringify({
					camps: runnerFleetTopology(hosts.value, { stationId: "" }),
				}),
			);
			const railless = await deploy(
				home,
				[
					"placement",
					"decide",
					FLEET,
					"--pipeline",
					FLEET,
					"--node",
					"fleet",
					"--station",
					"local",
				],
				{ HOBO_CD_TOPOLOGY: camps },
			);
			expect(railless.code).toBe("rail-providers-unknown");
		});

		it("agent run on a box worker wires the worker's job ports and runs, and so does a local runner", async () => {
			const home = await freshDir();
			const keys = agentKeys();
			const keyFile = join(home, "agent.jwk.json");
			const svidFile = join(home, "agent.svid");
			const config = join(home, "agent.runner-host.json");
			const workerDir = join(home, "worker");
			await mkdir(workerDir);
			await writeFile(keyFile, JSON.stringify(keys.privateJwk));
			await writeFile(svidFile, "");
			await writeFile(
				config,
				JSON.stringify({
					...AGENT_CONFIG,
					worker: { database: join(workerDir, "worker.sqlite") },
				}),
			);
			const argv = [
				"agent",
				"run",
				"--feed",
				"https://station.invalid/v1/cd/",
				"--reconciler",
				"rec_box",
				"--key-file",
				keyFile,
				"--svid-file",
				svidFile,
				"--camp",
				BOX,
			];
			const without = await deploy(home, argv);
			expect(without.code).toBe("compose-realizer-missing");
			// The box worker: every port is wired, so the agent loop starts (the
			// Station here is unreachable, so it never converges) and stops
			// cleanly on SIGTERM rather than refusing.
			const runner = await runAgentFor(
				home,
				argv.slice(2),
				{ HOBO_CD_TOPOLOGY: MODULE, [CD_RUNNER_HOST_ENV]: config },
				8_000,
			);
			expect(runner.exitedEarly, runner.message).toBe(false);
			expect(runner.ok, runner.message).toBe(true);
			expect(pick(runner.data, "reconcilerId")).toBe("rec_box");

			// A local runner: its controller is a process its supervisor runs,
			// and its runner's GitHub presence is read from its state directory
			// (runner-presence.json). Every port is wired, so the loop starts.
			await writeFile(
				config,
				JSON.stringify({
					...AGENT_CONFIG,
					hostKind: "local-runner",
					worker: { directory: workerDir },
					controller: { mode: "process", releases: join(home, "releases") },
				}),
			);
			const local = await runAgentFor(
				home,
				argv.slice(2),
				{ HOBO_CD_TOPOLOGY: MODULE, [CD_RUNNER_HOST_ENV]: config },
				8_000,
			);
			expect(local.exitedEarly, local.message).toBe(false);
			expect(local.ok, local.message).toBe(true);
		});
	},
);

/** A loopback "HTTPS" transport into the Station's own delivery feed. */
function loopback(
	handle: (
		request: Parameters<HttpTransport>[0] & object,
	) => Promise<FeedResponse>,
): HttpTransport {
	return async (request: TransportRequest) => {
		const response = await handle(request);
		let body: string;
		if (response.body instanceof Uint8Array)
			body = new TextDecoder().decode(response.body);
		else {
			const parts: string[] = [];
			for await (const chunk of response.body)
				parts.push(new TextDecoder().decode(chunk));
			body = parts.join("");
		}
		return { status: response.status, headers: { ...response.headers }, body };
	};
}

/**
 * The in-process fleet: a Station composed by `openCdRuntime` over the
 * durable SQLite journal and the delivery module's records, each host's
 * agent enrolled by double opt-in and composed the way `agent run` composes
 * it (its job ports read from a fake worker's data directory), over a
 * loopback transport to the Station's own feed. The declared hosts are
 * hosts.json's, plus `fleetHosts` (each in the `fleet` ring, as a mesh
 * node). Every host shares one clock: an agent's sleep advances them all.
 */
async function openFleet(
	extra: Partial<Parameters<typeof openCdRuntime>[0]> = {},
	fleetHosts: readonly string[] = [],
) {
	const home = await freshDir();
	const declared = parseRunnerHosts(
		await readFile(
			join(REPO, "packages/ci-gh-actions/deploy/runner-fleet/hosts.json"),
			"utf8",
		),
	);
	if (!declared.ok) throw new Error("hosts.json does not parse");
	const hosts = parseRunnerHosts(
		JSON.stringify([
			...declared.value,
			...fleetHosts.map((id) => ({
				id,
				kind: "mesh-node",
				runnerLabels: ["hobo"],
				ring: "fleet",
			})),
		]),
	);
	if (!hosts.ok) throw new Error(hosts.problems.join("; "));
	// Each host's worker data directory, as its controller mounts it.
	const boxes = new Map<
		CampId,
		Readonly<{
			hostId: string;
			host: FakeRunnerHost;
			worker: ReturnType<typeof workerHostFiles>;
			config: string;
		}>
	>();
	for (const runner of hosts.value) {
		const workerDir = join(home, `worker-${runner.id}`);
		await mkdir(workerDir);
		const worker = workerHostFiles(join(workerDir, "worker.sqlite"));
		const host = new FakeRunnerHost({
			hostId: runner.id,
			labels: runner.runnerLabels,
			running: PREVIOUS,
			unhealthy: [BROKEN],
			worker,
		});
		await host.beat();
		const config = join(home, `agent.${runner.id}.json`);
		await writeFile(
			config,
			JSON.stringify({
				...AGENT_CONFIG,
				hostId: runner.id,
				hostKind: runner.kind,
				worker: { database: worker.database },
			}),
		);
		// SAFETY: the runner fleet's Camp id for the host (hobo-ci-runners/<host id>).
		boxes.set(`hobo-ci-runners/${runner.id}` as CampId, {
			hostId: runner.id,
			host,
			worker,
			config,
		});
	}
	const clock = boxes.get(BOX)?.host;
	if (!clock) throw new Error("hosts.json declares no box");
	const now = () => clock.nowMs;
	/** Advance the shared clock; each host's worker beats its advert. */
	async function advance(ms: number) {
		for (const { host } of boxes.values()) {
			host.nowMs += ms;
			await host.beat();
		}
	}
	const delivery = runnerFleetDelivery(hosts.value, {
		repository: "Hobo-Labs/HoBo",
	});
	// The delivery module's exports as data (records, Camps and the
	// Rail), as a plain ES module: the .ts module itself loads through
	// tsx, whose state is process-wide (see cd-topology-files.test.ts).
	const module = join(home, "hobo.delivery.mjs");
	const exports = {
		...delivery,
		camps: runnerFleetTopology(hosts.value, { stationId: "" }),
		rails: [runnerFleetRail()],
	};
	await writeFile(
		module,
		Object.entries(exports)
			.map(
				([name, value]) => `export const ${name} = ${JSON.stringify(value)};`,
			)
			.join("\n"),
	);
	const env = { HOBO_HOME: home };
	// Every accepted report's health ingest must succeed; a failure is
	// reported here, never dropped.
	const ingestErrors: Error[] = [];
	const opened = await openCdRuntime({
		env,
		home,
		cwd: home,
		simulate: false,
		now,
		topologyFiles: [module],
		http: registry,
		onRunnerHostIngestError: (error) => ingestErrors.push(error),
		...extra,
	});
	if (!opened.ok) throw new Error(opened.reasons[0]?.message);
	const station = opened.value;
	const agentStores: { close(): Promise<void> }[] = [];
	try {
		const operator = (id: string): CdContext => ({
			tenant: station.config.tenant,
			principal: { kind: "user", id },
			now,
		});
		const applied = await runCdDeploySubcommand(
			station.host,
			["pipeline", "apply"],
			{ file: module, format: "json" },
		);
		expect(applied.ok, applied.message).toBe(true);

		// One agent per host, enrolled by double opt-in and composed as
		// `agent run` composes it on that host: the job ports are its own,
		// read from the worker's data directory; only the container engine
		// is the fake's.
		const agents = new Map<
			CampId,
			Readonly<{
				agent: ReturnType<typeof agentReconciler>;
				agentCtx: CdContext;
			}>
		>();
		for (const [campId, box] of boxes) {
			const keys = agentKeys();
			const token = await station.cd.enrollment.issueToken(
				{
					campSet: FLEET,
					campIds: [campId],
					mode: ReconcilerMode.AGENT,
					ttlMs: 600_000,
				},
				operator("ops-alice"),
			);
			if (!token.ok) throw new Error(token.reasons[0]?.message);
			const enrolled = await station.cd.enrollment.enroll(
				{ token: token.value.token, publicJwk: keys.publicJwk, claims: [] },
				operator("ops-alice"),
			);
			if (!enrolled.ok) throw new Error(enrolled.reasons[0]?.message);
			// SAFETY: the id the enrollment ledger just minted.
			const reconcilerId = enrolled.value.reconciler
				.reconcilerId as ReconcilerId;
			expect(
				(
					await station.cd.enrollment.approveKey(
						reconcilerId,
						operator("ops-alice"),
					)
				).ok,
			).toBe(true);
			expect(
				(
					await station.cd.enrollment.accept(
						{ reconcilerId, campIds: [campId] },
						operator("ops-bob"),
					)
				).ok,
			).toBe(true);
			const chosen = await agentRealizer({
				simulate: false,
				env: { [CD_RUNNER_HOST_ENV]: box.config },
				cwd: home,
				now,
				sleep: advance,
				campIds: [campId],
				simulated: () => {
					throw new Error("not simulated");
				},
				runnerHost: box.host.ports(),
			});
			if (!chosen.ok) throw new Error(chosen.reasons[0]?.message);
			const agentStore = await openCdStore({ backend: "memory" }, { now });
			agentStores.push(agentStore);
			const agent = agentReconciler({
				feedUrl: "https://station.test/v1/cd/",
				reconcilerId,
				privateJwk: keys.privateJwk,
				svid: "",
				campIds: [campId],
				realizer: chosen.value,
				store: agentStore.store,
				tenant: station.config.tenant,
				now,
				http: loopback(async (request) => {
					const url = new URL(request.url);
					return station.cd.feed.handle(
						{
							method: request.method,
							path: `${url.pathname}${url.search}`,
							headers: request.headers,
							body: new TextEncoder().encode(request.body ?? ""),
						},
						new AbortController().signal,
					);
				}),
			});
			agents.set(campId, {
				agent,
				agentCtx: {
					tenant: station.config.tenant,
					principal: { kind: "service", id: `agent:${reconcilerId}` },
					now,
				},
			});
		}

		const ops = operator("ops-alice");
		// Inventory scans the journal from where it starts (cold start).
		await station.cd.inventory.tick(ops);

		async function recordFreight(image: string) {
			const recorded = await station.cd.ingest.manifest(
				{
					manifest: fromJson(FreightManifestRecordSchema, {
						schemaVersion: "hobo.freight-manifest/v1",
						bindle: FLEET,
						// Ingested by hand, not discovered by the fleet's source:
						// no declaration is stored under it, so promotion cannot
						// plan it and the legs that use it write the Set directly.
						declarationHash: `sha256:${createHash("sha256").update(`${FLEET}@${image}`).digest("hex")}`,
						artifacts: [
							{
								name: "hobo-ci-worker",
								kind: "ARTIFACT_KIND_OCI_IMAGE",
								digest: digestOf(image),
								coordinate: image,
								ecosystem: "oci",
							},
						],
					}),
				},
				ops,
			);
			if (!recorded.ok) throw new Error(recorded.reasons[0]?.message);
			return recorded.value;
		}
		/**
		 * One image version as the fleet's source discovers it: its Freight
		 * names the applied source by its definition digest (the source has
		 * no declaration member), which is what lets the Station plan it with
		 * the fleet's declared Bindle.
		 */
		async function discoverFreight(image: string) {
			const source = (await station.cd.sources.list()).find(
				(entry) => entry.name === RUNNER_IMAGE_SOURCE,
			);
			if (!source) throw new Error("the fleet's source is not applied");
			const recorded = await station.cd.freight.record(
				{
					manifest: fromJson(FreightManifestRecordSchema, {
						schemaVersion: "hobo.freight-manifest/v1",
						bindle: FLEET,
						declarationHash: definitionDigest(source),
						artifacts: [
							{
								name: "hobo-ci-worker",
								kind: "ARTIFACT_KIND_OCI_IMAGE",
								digest: digestOf(image),
								coordinate: image,
								ecosystem: "oci",
							},
						],
						labels: { [SOURCE_LABEL]: RUNNER_IMAGE_SOURCE },
					}),
					origin: FreightOrigin.SOURCE_DISCOVERY,
					sourceName: RUNNER_IMAGE_SOURCE,
				},
				ops,
			);
			if (!recorded.ok) throw new Error(recorded.reasons[0]?.message);
			return recorded.value;
		}
		// The Set adopting what a host runs today, written through the
		// desired-state ledger directly (a fresh host is not placed until
		// its agent has reported, and it reports against a Set).
		async function setFor(
			image: string,
			deltaId: string,
			freightId: string,
			campId: CampId = BOX,
		) {
			const resolved = runnerHostResolvedSet({
				campId,
				image,
				tenant: station.config.tenant,
			});
			const current = await station.cd.desired.current(campId);
			const base = current
				? await station.cd.desired.resolved(current)
				: undefined;
			const delta = await station.cd.desired.open(
				create(DeltaRecordSchema, {
					deltaId,
					campId,
					freightId,
					baseSetId: current?.setId ?? "",
					intent: "promote",
					changes: diffResolvedSets(base, resolved),
				}),
				ops,
			);
			if (!delta.ok) throw new Error(delta.reasons[0]?.message);
			const set = await station.cd.desired.apply(
				{
					deltaId,
					gateDecisionId: `gate-${deltaId}`,
					resolved,
					origin: SetOrigin.PROMOTION,
				},
				ops,
			);
			if (!set.ok) throw new Error(set.reasons[0]?.message);
			return set.value;
		}

		const box = boxes.get(BOX);
		const boxAgent = agents.get(BOX);
		if (!box || !boxAgent) throw new Error("no box agent");
		return {
			station,
			host: box.host,
			worker: box.worker,
			boxes,
			agents,
			advance,
			now,
			ingestErrors,
			operator,
			ops,
			agent: boxAgent.agent,
			agentCtx: boxAgent.agentCtx,
			recordFreight,
			discoverFreight,
			setFor,
			async close() {
				for (const store of agentStores) await store.close();
				await station.close();
			},
		};
	} catch (error) {
		for (const store of agentStores) await store.close();
		await station.close();
		throw error;
	}
}

describe("the runner fleet delivered in process (durable SQLite, fake runner host)", () => {
	it("enrolls, decides placement, defers an unready pilot host, swaps the controller digest and restores it on a failed verify", {
		timeout: 120_000,
	}, async () => {
		const fleet = await openFleet();
		const {
			station,
			host,
			worker,
			now,
			ingestErrors,
			ops,
			agent,
			agentCtx,
			recordFreight,
			setFor,
		} = fleet;
		try {
			// Before the agent's first report the box was never contacted: it
			// carries the automatic unreachable taint and is not placed.
			const unplaced = await station.cd.placement.decide(
				{
					placement: FLEET,
					pipeline: FLEET,
					node: "fleet",
					stationId: station.config.stationId,
					subject: { classifications: [], residency: [] },
				},
				ops,
			);
			expect(unplaced.ok ? "" : unplaced.reasons[0]?.code).toBe(
				"placement-unsatisfiable",
			);

			// Baseline: the digest the box runs today, adopted as its first Set.
			const baseline = await recordFreight(PREVIOUS);
			await setFor(PREVIOUS, "delta_e2e_baseline", baseline.freightId);
			const adopted = await agent.reconcileOnce(BOX, agentCtx);
			expect(ReconcileStatus[adopted.status]).toBe("CONVERGED");
			expect(host.calls).not.toContain(`pull ${PREVIOUS}`);
			await station.cd.inventory.tick(ops);
			const reachable = await station.cd.inventory.status(BOX);
			expect(reachable?.taints).toEqual([]);
			expect(
				reachable?.conditions.some(
					(c) =>
						c.type === CampConditionType.READY &&
						c.status === ConditionStatus.TRUE &&
						c.reason === "runner-host-healthy",
				),
			).toBe(true);

			// Placement decides the fleet: the box, in the pilot group.
			const decided = await station.cd.placement.decide(
				{
					placement: FLEET,
					pipeline: FLEET,
					node: "fleet",
					stationId: station.config.stationId,
					subject: { classifications: [], residency: [] },
				},
				ops,
			);
			if (!decided.ok) throw new Error(decided.reasons[0]?.message);
			const box = decided.value.candidates.find((c) => c.campId === BOX);
			expect(box?.selected).toBe(true);
			expect(
				decided.value.groups.find((g) => g.name === "pilot")?.campIds,
			).toEqual([BOX]);

			// An unready report taints the box NO_PLACE (as the feed's ingest
			// does for an agent's report whose advert expired).
			const ingest = (ready: boolean) =>
				ingestRunnerHostHealth({
					inventory: station.cd.inventory,
					observation: create(ReconcileObservationRecordSchema, {
						campId: BOX,
						resources: [
							create(ResourceObservationSchema, {
								resource: "runner-controller",
								kind: "hobo-ci.runner-host/v1",
							}),
						],
						claims: [
							{
								name: "hobo.ci/mesh-advert",
								value: ready ? "fresh" : "expired",
							},
							{
								name: "hobo.ci/mesh-advert-valid-until",
								value: new Date(
									host.nowMs + (ready ? 60_000 : -1),
								).toISOString(),
							},
							{ name: "hobo.ci/runner-host-ready", value: String(ready) },
						].map((claim) => create(CampClaimRecordSchema, claim)),
					}),
					tenant: station.config.tenant,
					now,
				});
			expect(await ingest(false)).toEqual({ ingested: true, ready: false });

			// A PROGRESSIVE_PER_GROUP fan-out of new Freight over the decision:
			// the mandatory pilot group runs first, one host in flight.
			const freight = await recordFreight(TARGET);
			const pipeline = await station.cd.pipelines.get(FLEET);
			const node = pipeline?.nodes.find((n) => n.name === "fleet");
			if (!node?.fanout) throw new Error("the fleet node has no fan-out");
			expect(FanoutStrategy[node.fanout.strategy]).toBe(
				"PROGRESSIVE_PER_GROUP",
			);
			const started = await station.cd.fanout.start(
				{
					pipeline: FLEET,
					node: "fleet",
					// SAFETY: the id the Freight ledger just recorded.
					freightId: freight.freightId as FreightId,
					decision: decided.value,
					fanout: node.fanout,
					departure: node.departure,
					idempotencyKey: "fanout-e2e-1",
				},
				ops,
			);
			if (!started.ok) throw new Error(started.reasons[0]?.message);
			const progressed = async () => {
				const out: { campId: string; outcome: string; code: string }[] = [];
				for await (const event of station.store.read(
					`cd-fanout-${started.value.fanoutId}`,
				))
					if (event.type === "fanout.Progressed")
						out.push({
							campId: String(pick(event.data, "campId")),
							outcome: String(pick(event.data, "outcome")),
							code: String(pick(event.data, "reasons", "0", "code") ?? ""),
						});
				return out;
			};
			// The unready pilot host is deferred at its turn, not requested.
			await station.cd.fanout.tick(ops);
			expect((await progressed())[0]).toEqual({
				campId: BOX,
				outcome: "deferred",
				code: "camp-tainted",
			});
			// Ready again: the taint clears and the pilot's one host is
			// requested on the next tick (max concurrency 1).
			expect(await ingest(true)).toEqual({ ingested: true, ready: true });
			await station.cd.fanout.tick(ops);
			expect((await progressed()).map((p) => p.outcome)).toContain("requested");
			// What the requested promotion then does is the next test's subject
			// (file comment, 3); this run's Freight was ingested by hand, not
			// discovered by the fleet's source, so promotion cannot plan it and
			// the legs below write the Set directly.

			// The converge the pilot's promotion asks for: drain, swap by digest, verify.
			const swapped = await setFor(
				TARGET,
				"delta_e2e_target",
				freight.freightId,
			);
			const converged = await agent.reconcileOnce(BOX, agentCtx);
			expect(ReconcileStatus[converged.status]).toBe("CONVERGED");
			expect(converged.setId).toBe(swapped.setId);
			expect(converged.resources[0]?.physicalId).toBe(
				`hobo-ci-runners/box/controller@${digestOf(TARGET)}`,
			);
			expect(host.runningImage()).toBe(TARGET);
			expect(host.calls).toEqual(
				expect.arrayContaining([`pull ${TARGET}`, `stop ${PREVIOUS}`]),
			);
			// Admission was closed through the worker's marker and reopened.
			expect(existsSync(worker.admissionPaused)).toBe(false);

			// A failed verify restores the previous digest.
			const broken = await recordFreight(BROKEN);
			await setFor(BROKEN, "delta_e2e_broken", broken.freightId);
			const blocked = await agent.reconcileOnce(BOX, agentCtx);
			expect(ReconcileStatus[blocked.status]).toBe("BLOCKED");
			expect(blocked.reasons.at(-1)?.code).toBe("runner-host-verify-failed");
			expect(host.runningImage()).toBe(TARGET);
			expect(host.admission).toBe(true);
			expect(blocked.resources[0]?.physicalId).toBe(
				`hobo-ci-runners/box/controller@${digestOf(TARGET)}`,
			);
			const after = await station.cd.desired.status(BOX);
			expect(ReconcileStatus[after?.status ?? 0]).toBe("BLOCKED");
			// Restored and serving: the host is ready, so it is not tainted.
			expect(
				(await station.cd.inventory.status(BOX))?.taints.some(
					(t) =>
						t.key === RUNNER_HOST_UNREADY_TAINT &&
						t.effect === TaintEffect.NO_PLACE,
				),
			).toBe(false);
			expect(ingestErrors).toEqual([]);
		} finally {
			await fleet.close();
		}
	});

	it("a fan-out's pilot promotion writes the runner-host Set, the agent converges it, the pilot qualifies and the next group starts; a failed verify restores the previous digest", {
		timeout: 120_000,
	}, async () => {
		const budgetAsked: string[] = [];
		// SAFETY: the runner fleet's Camp id for host `mesh-a` (hobo-ci-runners/<host id>).
		const MESH = "hobo-ci-runners/mesh-a" as CampId;
		const fleet = await openFleet(
			{
				fanoutCost: {
					quote: async () => 1,
					budget: async (stationId) => {
						budgetAsked.push(stationId);
						return { limit: 10, used: 0 };
					},
				},
			},
			["mesh-a"],
		);
		const {
			station,
			ops,
			boxes,
			agents,
			advance,
			ingestErrors,
			recordFreight,
			discoverFreight,
			setFor,
		} = fleet;
		const agentOf = (campId: CampId) => {
			const found = agents.get(campId);
			if (!found) throw new Error(`no agent for ${campId}`);
			return found;
		};
		const hostOf = (campId: CampId) => {
			const found = boxes.get(campId)?.host;
			if (!found) throw new Error(`no host for ${campId}`);
			return found;
		};
		const reconcile = (campId: CampId) =>
			agentOf(campId).agent.reconcileOnce(campId, agentOf(campId).agentCtx);
		/** The runner-host row of the Camp's current Set, as promotion wrote it. */
		async function rowOf(campId: CampId) {
			const current = await station.cd.desired.current(campId);
			const resolved = current
				? await station.cd.desired.resolved(current)
				: undefined;
			return {
				set: current,
				row: resolved?.plan.resources.find(
					(resource) => resource.productId === "hobo-ci.runner-host/v1",
				),
				match: resolved?.matches[0],
			};
		}
		async function progressed(fanoutId: string) {
			const out: { campId: string; outcome: string; code: string }[] = [];
			for await (const event of station.store.read(`cd-fanout-${fanoutId}`))
				if (event.type === "fanout.Progressed")
					out.push({
						campId: String(pick(event.data, "campId")),
						outcome: String(pick(event.data, "outcome")),
						code: String(pick(event.data, "reasons", "0", "code") ?? ""),
					});
			return out;
		}
		/**
		 * The Station's loop a minute at a time, every host's agent reporting
		 * each minute (as `agent run` does), until `done` or 30 minutes.
		 */
		async function runMinutes(done: () => Promise<boolean>, stepMs = 60_000) {
			for (let step = 0; step < 30 && !(await done()); step += 1) {
				await advance(stepMs);
				for (const campId of [BOX, MESH]) await reconcile(campId);
				await stationTick();
			}
			expect(await done()).toBe(true);
		}
		/** One pass of the Station's tick loop (the steps `serve cd` runs). */
		async function stationTick() {
			await station.cd.inventory.tick(ops);
			await station.cd.fanout.tick(ops);
			await station.cd.promotions.tick(ops);
			await station.cd.rollouts.tick(ops);
			await station.cd.verification.tick(ops);
			await station.cd.promotions.tick(ops);
			await station.cd.fanout.tick(ops);
		}
		try {
			// Each host adopts what it runs today (no pull: already running).
			const baseline = await recordFreight(PREVIOUS);
			for (const campId of [BOX, MESH]) {
				await setFor(
					PREVIOUS,
					`delta_adopt_${campId.split("/")[1]}`,
					baseline.freightId,
					campId,
				);
				expect(ReconcileStatus[(await reconcile(campId)).status]).toBe(
					"CONVERGED",
				);
			}
			await station.cd.inventory.tick(ops);
			const decided = await station.cd.placement.decide(
				{
					placement: FLEET,
					pipeline: FLEET,
					node: "fleet",
					stationId: station.config.stationId,
					subject: { classifications: [], residency: [] },
				},
				ops,
			);
			if (!decided.ok) throw new Error(decided.reasons[0]?.message);
			expect(
				decided.value.groups.map((group) => [group.name, group.campIds]),
			).toEqual([
				["pilot", [BOX]],
				["fleet", [MESH]],
			]);
			const pipeline = await station.cd.pipelines.get(FLEET);
			const node = pipeline?.nodes.find((n) => n.name === "fleet");
			if (!node?.fanout) throw new Error("the fleet node has no fan-out");
			expect(RolloutStrategy[node.strategy]).toBe("ALL_AT_ONCE");

			// New image Freight, the way the node takes it: from its source.
			const target = await discoverFreight(TARGET);
			const started = await station.cd.fanout.start(
				{
					pipeline: FLEET,
					node: "fleet",
					// SAFETY: the id the Freight ledger just recorded.
					freightId: target.freightId as FreightId,
					decision: decided.value,
					fanout: node.fanout,
					departure: node.departure,
					idempotencyKey: "fanout-e2e-target",
				},
				ops,
			);
			if (!started.ok) throw new Error(started.reasons[0]?.message);
			const fanoutId = started.value.fanoutId;

			// The pilot's turn: its promotion is admitted (lineage from the
			// recorded decision, the aggregate gate within the Rail's cap and
			// the Station budget) and Matching resolves the Freight into the
			// box's Set: the runner-host row on the box's own provider, its
			// image the Freight's, pinned by digest.
			await stationTick();
			await stationTick();
			expect(budgetAsked).toContain(station.config.stationId);
			const [promotion] = await station.cd.promotions.list({ campId: BOX });
			expect(promotion?.fanoutId).toBe(fanoutId);
			const pilot = await rowOf(BOX);
			expect(pilot.set?.freightId).toBe(target.freightId);
			expect(pilot.set?.origin).toBe(SetOrigin.PROMOTION);
			expect(pilot.row?.name).toBe("runner-controller");
			expect(pilot.row?.realizationParameters).toEqual({ image: TARGET });
			expect(pilot.match?.providerId).toBe("self-hosted");
			// Only the pilot moves: the fleet group waits for it.
			expect((await rowOf(MESH)).set?.freightId).toBe(baseline.freightId);
			expect((await progressed(fanoutId)).map((p) => p.campId)).not.toContain(
				MESH,
			);

			// The box's agent converges that Set: drain, swap by digest, verify.
			const converged = await reconcile(BOX);
			expect(ReconcileStatus[converged.status]).toBe("CONVERGED");
			expect(converged.setId).toBe(pilot.set?.setId);
			expect(hostOf(BOX).runningImage()).toBe(TARGET);
			expect(hostOf(BOX).calls).toEqual(
				expect.arrayContaining([`pull ${TARGET}`, `stop ${PREVIOUS}`]),
			);

			// Observed converged and held for the soak: the pilot qualifies,
			// and the next group (the fleet ring) starts.
			await runMinutes(async () =>
				(await progressed(fanoutId)).some((p) => p.campId === MESH),
			);
			const afterPilot = await progressed(fanoutId);
			expect(afterPilot).toContainEqual({
				campId: BOX,
				outcome: "succeeded",
				code: "",
			});
			expect(afterPilot.find((p) => p.campId === MESH)?.outcome).toBe(
				"requested",
			);
			const next = await rowOf(MESH);
			expect(next.set?.freightId).toBe(target.freightId);
			expect(next.row?.realizationParameters).toEqual({ image: TARGET });
			expect(ReconcileStatus[(await reconcile(MESH)).status]).toBe("CONVERGED");
			expect(hostOf(MESH).runningImage()).toBe(TARGET);
			await runMinutes(async () =>
				(await progressed(fanoutId)).some(
					(p) => p.campId === MESH && p.outcome === "succeeded",
				),
			);

			// A version that fails verify: the pilot's promotion writes it,
			// the agent swaps, sees it unhealthy and restores the previous
			// digest, and does not swap to it again on its later passes. The
			// pilot never qualifies, so the fan-out halts at its progress
			// deadline and the fleet group never starts.
			const broken = await discoverFreight(BROKEN);
			const halted = await station.cd.fanout.start(
				{
					pipeline: FLEET,
					node: "fleet",
					// SAFETY: the id the Freight ledger just recorded.
					freightId: broken.freightId as FreightId,
					decision: decided.value,
					fanout: node.fanout,
					departure: node.departure,
					idempotencyKey: "fanout-e2e-broken",
				},
				ops,
			);
			if (!halted.ok) throw new Error(halted.reasons[0]?.message);
			await stationTick();
			await stationTick();
			expect((await rowOf(BOX)).row?.realizationParameters).toEqual({
				image: BROKEN,
			});
			const blocked = await reconcile(BOX);
			expect(ReconcileStatus[blocked.status]).toBe("BLOCKED");
			expect(blocked.reasons.at(-1)?.code).toBe("runner-host-verify-failed");
			expect(hostOf(BOX).runningImage()).toBe(TARGET);
			expect(hostOf(BOX).admission).toBe(true);
			await runMinutes(
				async () =>
					(await progressed(halted.value.fanoutId)).some(
						(p) => p.campId === BOX && p.outcome === "failed",
					),
				10 * 60_000,
			);
			expect(
				hostOf(BOX).calls.filter((call) => call === `pull ${BROKEN}`),
			).toHaveLength(1);
			expect(hostOf(BOX).runningImage()).toBe(TARGET);
			expect(
				ReconcileStatus[(await station.cd.desired.status(BOX))?.status ?? 0],
			).toBe("BLOCKED");
			const [failedPromotion] = await station.cd.promotions.list({
				campId: BOX,
			});
			expect(failedPromotion?.freightId).toBe(broken.freightId);
			expect(PromotionState[failedPromotion?.state ?? 0]).toBe("FAILED");
			expect(
				(await progressed(halted.value.fanoutId)).map((p) => p.campId),
			).not.toContain(MESH);
			expect(hostOf(MESH).runningImage()).toBe(TARGET);
			expect(ingestErrors).toEqual([]);
		} finally {
			await fleet.close();
		}
	});
	it("swaps a process host to the release its Freight pairs with the image, from the delivery module's source down to the supervisor", {
		timeout: 120_000,
	}, async () => {
		const home = await freshDir();
		const dataDirectory = join(home, "data");
		const host = new SupervisedRunnerHost({ dataDirectory });
		const now = () => host.nowMs;
		const hosts = parseRunnerHosts(
			await readFile(
				join(REPO, "packages/ci-gh-actions/deploy/runner-fleet/hosts.json"),
				"utf8",
			),
		);
		if (!hosts.ok) throw new Error("hosts.json does not parse");
		// The fleet's delivery module with its controller releases published.
		const delivery = runnerFleetDelivery(hosts.value, {
			repository: "Hobo-Labs/HoBo",
			releaseIndexBase: "https://releases.hobo.test/hobo-ci/",
		});
		const [source] = delivery.sources;
		const subscription = (name: string) => {
			const found = source?.subscriptions.find(
				(entry) => entry.artifactName === name,
			);
			if (!found) throw new Error(`the source has no ${name} subscription`);
			return found;
		};
		const module = join(home, "hobo.delivery.mjs");
		await writeFile(
			module,
			Object.entries({
				...delivery,
				camps: runnerFleetTopology(hosts.value, { stationId: "" }),
				rails: [runnerFleetRail()],
			})
				.map(
					([name, value]) => `export const ${name} = ${JSON.stringify(value)};`,
				)
				.join("\n"),
		);
		// What the release build publishes beside the index: one file per release.
		const releases = join(home, "releases");
		await mkdir(releases);
		const bodies = ["export const v = 1;\n", "export const v = 2;\n"];
		const releaseDigests: string[] = [];
		for (const body of bodies) {
			const hex = createHash("sha256").update(body).digest("hex");
			await writeFile(join(releases, `${hex}.mjs`), body);
			releaseDigests.push(`sha256:${hex}`);
		}
		const agentConfig = join(home, "agent.runner-host.json");
		await writeFile(
			agentConfig,
			JSON.stringify({
				...AGENT_CONFIG,
				worker: { database: host.files.database },
				controller: { mode: "process", releases },
			}),
		);
		const opened = await openCdRuntime({
			env: { HOBO_HOME: home },
			home,
			cwd: home,
			simulate: false,
			now,
			topologyFiles: [module],
			http: registry,
		});
		if (!opened.ok) throw new Error(opened.reasons[0]?.message);
		const station = opened.value;
		try {
			const ops: CdContext = {
				tenant: station.config.tenant,
				principal: { kind: "user", id: "ops-alice" },
				now,
			};
			const applied = await runCdDeploySubcommand(
				station.host,
				["pipeline", "apply"],
				{ file: module, format: "json" },
			);
			expect(applied.ok, applied.message).toBe(true);
			// The applied source pairs the image with the releases.
			const appliedSource = (await station.cd.sources.list()).find(
				(entry) => entry.name === RUNNER_IMAGE_SOURCE,
			);
			expect(appliedSource?.assembly).toBe(AssemblyRule.SAME_VERSION);
			expect(appliedSource?.subscriptions).toHaveLength(3);

			// One version's Freight as the source assembles it: the image from
			// GHCR (its manifest digest) and the worker release from the index
			// (its bytes' digest, the bytes held in the artifact store).
			const worker = subscription(RUNNER_RELEASE_ARTIFACTS.workerRelease);
			const image = subscription("hobo-ci-worker");
			async function recordVersion(index: number, release: string) {
				const body = bodies[index] ?? "";
				await station.cd.artifacts.put(
					new TextEncoder().encode(body),
					{
						name: worker.artifactName,
						kind: ArtifactKind.FUNCTION_BUNDLE,
						mediaType: "text/javascript",
					},
					ops,
				);
				const version = ["previous", "target"][index] ?? "";
				const manifestDigest = digestOf(imageOf(version));
				const recorded = await station.cd.ingest.manifest(
					{
						manifest: fromJson(FreightManifestRecordSchema, {
							schemaVersion: "hobo.freight-manifest/v1",
							bindle: FLEET,
							declarationHash: `sha256:${createHash("sha256").update(`${FLEET}@${version}`).digest("hex")}`,
							artifacts: [
								{
									name: image.artifactName,
									kind: image.artifactKind,
									digest: manifestDigest,
									coordinate: imageOf(version),
									ecosystem: "oci",
								},
								{
									name: worker.artifactName,
									kind: worker.artifactKind,
									digest: release,
									coordinate: `https://releases.hobo.test/hobo-ci/${release.slice(7)}.mjs`,
									ecosystem: "http",
								},
							],
						}),
					},
					ops,
				);
				if (!recorded.ok) throw new Error(recorded.reasons[0]?.message);
				return recorded.value;
			}

			const keys = agentKeys();
			const token = await station.cd.enrollment.issueToken(
				{
					campSet: FLEET,
					campIds: [BOX],
					mode: ReconcilerMode.AGENT,
					ttlMs: 600_000,
				},
				ops,
			);
			if (!token.ok) throw new Error(token.reasons[0]?.message);
			const enrolled = await station.cd.enrollment.enroll(
				{ token: token.value.token, publicJwk: keys.publicJwk, claims: [] },
				ops,
			);
			if (!enrolled.ok) throw new Error(enrolled.reasons[0]?.message);
			// SAFETY: the id the enrollment ledger just minted.
			const reconcilerId = enrolled.value.reconciler
				.reconcilerId as ReconcilerId;
			await station.cd.enrollment.approveKey(reconcilerId, ops);
			const accepted = await station.cd.enrollment.accept(
				{ reconcilerId, campIds: [BOX] },
				{ ...ops, principal: { kind: "user", id: "ops-bob" } },
			);
			expect(accepted.ok).toBe(true);
			// The agent `agent run` composes on a process host: every port its
			// own default (the supervisor's control files, the data directory).
			const chosen = await agentRealizer({
				simulate: false,
				env: { [CD_RUNNER_HOST_ENV]: agentConfig },
				cwd: home,
				now,
				sleep: async (ms) => {
					host.nowMs += ms;
					await host.tick();
				},
				campIds: [BOX],
				simulated: () => {
					throw new Error("not simulated");
				},
			});
			if (!chosen.ok) throw new Error(chosen.reasons[0]?.message);
			const agentStore = await openCdStore({ backend: "memory" }, { now });
			const agent = agentReconciler({
				feedUrl: "https://station.test/v1/cd/",
				reconcilerId,
				privateJwk: keys.privateJwk,
				svid: "",
				campIds: [BOX],
				realizer: chosen.value,
				store: agentStore.store,
				tenant: station.config.tenant,
				now,
				http: loopback(async (request) => {
					const url = new URL(request.url);
					return station.cd.feed.handle(
						{
							method: request.method,
							path: `${url.pathname}${url.search}`,
							headers: request.headers,
							body: new TextEncoder().encode(request.body ?? ""),
						},
						new AbortController().signal,
					);
				}),
			});
			const agentCtx: CdContext = {
				tenant: station.config.tenant,
				principal: { kind: "service", id: `agent:${reconcilerId}` },
				now,
			};
			// The Set each recorded Freight resolves to: its runner-host row's
			// parameters come from the Freight's own artifacts, as promotion
			// binds them (file comment, 3); applied directly here, since this
			// leg's Freight is ingested by hand rather than source-discovered.
			async function converge(index: number) {
				const release = releaseDigests[index] ?? "";
				const freight = await recordVersion(index, release);
				const parameters = runnerHostRealizationParameters(
					freight.manifest?.artifacts ?? [],
				);
				if (!parameters) throw new Error("the Freight has no image");
				const resolved = runnerHostResolvedSet({
					campId: BOX,
					parameters,
					tenant: station.config.tenant,
				});
				const current = await station.cd.desired.current(BOX);
				const deltaId = `delta_process_${index}`;
				const delta = await station.cd.desired.open(
					create(DeltaRecordSchema, {
						deltaId,
						campId: BOX,
						freightId: freight.freightId,
						baseSetId: current?.setId ?? "",
						intent: "promote",
						changes: diffResolvedSets(
							current ? await station.cd.desired.resolved(current) : undefined,
							resolved,
						),
					}),
					ops,
				);
				if (!delta.ok) throw new Error(delta.reasons[0]?.message);
				const set = await station.cd.desired.apply(
					{
						deltaId,
						gateDecisionId: `gate-${deltaId}`,
						resolved,
						origin: SetOrigin.PROMOTION,
					},
					ops,
				);
				if (!set.ok) throw new Error(set.reasons[0]?.message);
				return {
					parameters,
					observed: await agent.reconcileOnce(BOX, agentCtx),
				};
			}

			const first = await converge(0);
			expect(ReconcileStatus[first.observed.status]).toBe("CONVERGED");
			expect(host.running()).toEqual([releaseDigests[0]]);
			const second = await converge(1);
			expect(ReconcileStatus[second.observed.status]).toBe("CONVERGED");
			// The host runs the release by its bytes' digest, not the image's
			// manifest digest the same Freight carries.
			expect(second.parameters.workerRelease).toBe(
				`${RUNNER_RELEASE_ARTIFACTS.workerRelease}@${releaseDigests[1]}`,
			);
			expect(digestOf(second.parameters.image)).not.toBe(releaseDigests[1]);
			expect(host.running()).toEqual([releaseDigests[1]]);
			expect(second.observed.resources[0]?.physicalId).toBe(
				`hobo-ci-runners/box/controller@${releaseDigests[1]}`,
			);
			await agentStore.close();
		} finally {
			await station.close();
		}
	});
});
