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
// Known gap, not asserted as correct: the composed PromotionService has no
// placed-Camps reader or fan-out aggregate gate (packages/cd/src/compose/
// wire.ts), so the fan-out's promotion does not yet write the Set the agent
// converges; the converge legs below write that Set through the
// desired-state ledger directly (see the it.todo at the end).
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJson } from "@bufbuild/protobuf";
import {
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
	ReconcileObservationRecordSchema,
	type ReconcilerId,
	ReconcilerMode,
	ReconcileStatus,
	ResourceObservationSchema,
	SetOrigin,
	TaintEffect,
} from "@hobo/cd";
import { diffResolvedSets } from "@hobo/cd/sets";
import {
	parseRunnerHosts,
	runnerFleetDelivery,
	runnerFleetTopology,
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

describe("the runner fleet delivered in process (durable SQLite, fake runner host)", () => {
	it("enrolls, decides placement, defers an unready pilot host, swaps the controller digest and restores it on a failed verify", {
		timeout: 120_000,
	}, async () => {
		const home = await freshDir();
		// The box worker's data directory, as the controller mounts it.
		const workerDir = join(home, "worker");
		await mkdir(workerDir);
		const worker = workerHostFiles(join(workerDir, "worker.sqlite"));
		const host = new FakeRunnerHost({
			running: PREVIOUS,
			unhealthy: [BROKEN],
			worker,
		});
		await host.beat();
		const now = () => host.nowMs;
		const hosts = parseRunnerHosts(
			await readFile(
				join(REPO, "packages/ci-gh-actions/deploy/runner-fleet/hosts.json"),
				"utf8",
			),
		);
		if (!hosts.ok) throw new Error("hosts.json does not parse");
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
		const agentConfig = join(home, "agent.runner-host.json");
		await writeFile(
			agentConfig,
			JSON.stringify({
				...AGENT_CONFIG,
				worker: { database: worker.database },
			}),
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
		});
		if (!opened.ok) throw new Error(opened.reasons[0]?.message);
		const station = opened.value;
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

			// Enrollment, double opt-in.
			const keys = agentKeys();
			const token = await station.cd.enrollment.issueToken(
				{
					campSet: FLEET,
					campIds: [BOX],
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
						{ reconcilerId, campIds: [BOX] },
						operator("ops-bob"),
					)
				).ok,
			).toBe(true);

			// The agent, composed as `agent run` composes it on the box: the
			// job ports are its own, read from the worker's data directory; only
			// the container engine is the fake's.
			const chosen = await agentRealizer({
				simulate: false,
				env: { [CD_RUNNER_HOST_ENV]: agentConfig },
				cwd: home,
				now,
				sleep: async (ms) => {
					host.nowMs += ms;
					await host.beat();
				},
				campIds: [BOX],
				simulated: () => {
					throw new Error("not simulated");
				},
				runnerHost: host.ports(),
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

			const ops = operator("ops-alice");
			// Inventory scans the journal from where it starts (cold start).
			await station.cd.inventory.tick(ops);

			async function recordFreight(image: string) {
				const recorded = await station.cd.ingest.manifest(
					{
						manifest: fromJson(FreightManifestRecordSchema, {
							schemaVersion: "hobo.freight-manifest/v1",
							bindle: FLEET,
							// No declaration is stored under it: the fleet's planning
							// declaration is not composed (see the report).
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
			// The Set a promotion of `image` would write for the box, written
			// through the desired-state ledger directly: this bypasses promotion,
			// which cannot write it yet (the known gap in the file comment).
			async function setFor(image: string, deltaId: string, freightId: string) {
				const resolved = runnerHostResolvedSet({
					campId: BOX,
					image,
					tenant: station.config.tenant,
				});
				const current = await station.cd.desired.current(BOX);
				const base = current
					? await station.cd.desired.resolved(current)
					: undefined;
				const delta = await station.cd.desired.open(
					create(DeltaRecordSchema, {
						deltaId,
						campId: BOX,
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
			// What the requested promotion then does is the known gap (see the
			// file comment and the it.todo below): it is not asserted here.

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
			await agentStore.close();
		} finally {
			await station.close();
		}
	});

	it.todo(
		"the PROGRESSIVE_PER_GROUP fan-out's pilot promotion writes the runner-host Set the agent converges (needs a placed-Camps reader and fan-out aggregate gate on the composed PromotionService, packages/cd/src/compose/wire.ts)",
	);
});
