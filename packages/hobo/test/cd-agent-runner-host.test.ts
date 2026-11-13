// `hobo deploy agent run` on a runner host: which realizer it registers
// (cd-agent.ts), the runner-host realizer as a @hobo/cd Realizer
// (cd-agent-runner-host.ts), and the Station Rails a delivery module declares
// (cd-declared-rails.ts). Offline, with a fake runner host.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	CampClaimRecordSchema,
	CampConditionType,
	type CampId,
	type CdContext,
	type FenceToken,
	ReasonRecordSchema,
	ReconcileObservationRecordSchema,
	type ReconcilerId,
	ReconcileStatus,
	ResourceObservationSchema,
	SetRecordSchema,
	SignalSource,
	TaintEffect,
} from "@hobo/cd";
import type { RailCatalog } from "@hobo/cd/compose";
import {
	createRunnerHostResolver,
	runnerFleetRail,
} from "@hobo/ci-gh-actions/runner-host";
import { afterEach, describe, expect, it } from "vitest";
import { agentRealizer } from "../src/cd-agent.js";
import {
	CD_RUNNER_HOST_ENV,
	createRunnerHostRealizer,
	ingestRunnerHostHealth,
	parseRunnerHostAgentConfig,
	RUNNER_HOST_UNREADY_TAINT,
	runnerHostImageOf,
} from "../src/cd-agent-runner-host.js";
import {
	declaredRailCatalog,
	parseDeclaredRails,
} from "../src/cd-declared-rails.js";
import { parseDeliveryModule } from "../src/cd-delivery-module.js";
import { openCdRuntime, stationOriginOf } from "../src/cd-runtime.js";
import {
	digestOf,
	FakeRunnerHost,
	imageAt,
	runnerHostResolvedSet,
} from "./fixtures/runner-host-fake.js";
import {
	SupervisedRunnerHost,
	writeReleases,
} from "./fixtures/runner-host-supervised.js";

// SAFETY: the runner fleet's Camp id for host `box` (hobo-ci-runners/<host id>).
const BOX = "hobo-ci-runners/box" as CampId;
const PREVIOUS = imageAt("1");
const TARGET = imageAt("2");
const BROKEN = imageAt("3");
const CONFIG = {
	hostId: "box",
	hostKind: "box-worker",
	credentialRef: "env://HOBO_CI_GHCR_READ_TOKEN",
};
const ctx: CdContext = {
	tenant: "local",
	principal: { kind: "service", id: "test" },
	now: () => 0,
};

function realizeInput(image: string | undefined, campId: CampId = BOX) {
	return {
		campId,
		desired: create(SetRecordSchema, { setId: "set_target", campId }),
		resolved: runnerHostResolvedSet({
			campId,
			...(image ? { image } : undefined),
		}),
		// SAFETY: opaque ids a lease would carry; the realizer only echoes them.
		reconcilerId: "rec_box" as ReconcilerId,
		// SAFETY: as above.
		fence: 7n as FenceToken,
		signal: new AbortController().signal,
	};
}

function realizerFor(host: FakeRunnerHost) {
	return agentRealizer({
		simulate: false,
		env: { [CD_RUNNER_HOST_ENV]: configPath },
		cwd: "/",
		now: () => host.nowMs,
		sleep: async (ms) => {
			host.nowMs += ms;
		},
		campIds: [BOX],
		simulated: () => {
			throw new Error("not simulated");
		},
		runnerHost: host.ports(),
	});
}

let dir = "";
let configPath = "";
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = "";
});
async function writeConfig(
	value: Readonly<Record<string, unknown>> = CONFIG,
): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "runner-host-agent-"));
	configPath = join(dir, "agent.runner-host.json");
	await writeFile(configPath, JSON.stringify(value));
	return configPath;
}

describe("runner-host agent config", () => {
	it("parses a host's config", () => {
		const parsed = parseRunnerHostAgentConfig({
			...CONFIG,
			docker: { binary: "/usr/bin/docker" },
			worker: { database: "/var/lib/hobo-ci/worker.sqlite" },
			drainDeadlineMs: 7_200_000,
		});
		expect(parsed.ok && parsed.value).toEqual({
			...CONFIG,
			dockerBinary: "/usr/bin/docker",
			workerDatabase: "/var/lib/hobo-ci/worker.sqlite",
			drainDeadlineMs: 7_200_000,
		});
		const relative = parseRunnerHostAgentConfig({
			...CONFIG,
			worker: { database: "worker.sqlite" },
		});
		expect(relative.ok ? "" : relative.reasons[0]?.message).toContain(
			"worker must be {database: <absolute path",
		);
	});

	it("parses a process-mode controller and a local runner's state directory", () => {
		const parsed = parseRunnerHostAgentConfig({
			...CONFIG,
			hostKind: "local-runner",
			worker: { directory: "/home/dev/.hobo/ci-local/" },
			controller: { mode: "process", releases: "https://releases.hobo.test/w" },
		});
		expect(parsed.ok && parsed.value).toEqual({
			...CONFIG,
			hostKind: "local-runner",
			workerDatabase: "/home/dev/.hobo/ci-local/worker.sqlite",
			controller: { mode: "process", releases: "https://releases.hobo.test/w" },
		});
		for (const controller of [
			{ mode: "process" },
			{ mode: "process", releases: "http://releases.hobo.test/" },
			{ mode: "process", releases: "https://user:secret@releases.hobo.test/" },
			{ mode: "vm" },
		]) {
			const refused = parseRunnerHostAgentConfig({ ...CONFIG, controller });
			const message = refused.ok ? "" : (refused.reasons[0]?.message ?? "");
			expect(message).toContain("controller must be {mode: container}");
			expect(message).not.toContain("secret");
		}
	});

	it("refuses a credential value where a locator belongs, and unknown fields", () => {
		const parsed = parseRunnerHostAgentConfig({
			...CONFIG,
			credentialRef: "ghp_notalocator",
			extra: true,
		});
		expect(parsed.ok).toBe(false);
		const message = parsed.ok ? "" : (parsed.reasons[0]?.message ?? "");
		expect(message).toContain("credentialRef must be a credential locator");
		expect(message).toContain("unknown field extra");
		expect(message).not.toContain("ghp_notalocator");
	});
});

describe("agent run --feed", () => {
	it("takes the documented /v1/cd/ feed URL as the Station origin, and passes anything else through", () => {
		expect(stationOriginOf("https://station.example/v1/cd/")).toBe(
			"https://station.example",
		);
		expect(stationOriginOf("https://station.example")).toBe(
			"https://station.example",
		);
		expect(stationOriginOf("https://station.example/other/")).toBe(
			"https://station.example/other/",
		);
		expect(stationOriginOf("http://station.example/v1/cd/")).toBe(
			"http://station.example",
		);
	});
});

describe("agent realizer selection (hobo deploy agent run)", () => {
	it("refuses compose-realizer-missing when the host configures none", async () => {
		const chosen = await agentRealizer({
			simulate: false,
			env: {},
			cwd: "/",
			now: () => 0,
			campIds: [BOX],
			simulated: () => {
				throw new Error("not simulated");
			},
		});
		expect(chosen.ok ? "" : chosen.reasons[0]?.code).toBe(
			"compose-realizer-missing",
		);
	});

	it("registers the runner-host realizer with the worker's job ports and the engine CLI, no injected ports", async () => {
		await writeConfig();
		const chosen = await agentRealizer({
			simulate: false,
			// The worker's journal path, as the box worker itself reads it.
			env: {
				[CD_RUNNER_HOST_ENV]: configPath,
				HOBO_CI_WORKER_DB: join(dir, "worker.sqlite"),
			},
			cwd: "/",
			now: () => 0,
			campIds: [BOX],
			simulated: () => {
				throw new Error("not simulated");
			},
		});
		expect(chosen.ok ? "" : chosen.reasons[0]?.message).toBe("");
	});

	it("registers the realizer on a local runner: its presence is read from its state directory", async () => {
		await writeConfig({
			...CONFIG,
			hostKind: "local-runner",
			controller: { mode: "process", releases: "/var/lib/hobo-ci/releases" },
		});
		const chosen = await agentRealizer({
			simulate: false,
			env: { [CD_RUNNER_HOST_ENV]: configPath },
			cwd: "/",
			now: () => 0,
			campIds: [BOX],
			simulated: () => {
				throw new Error("not simulated");
			},
		});
		expect(chosen.ok ? "" : chosen.reasons[0]?.message).toBe("");
	});

	it("refuses by name a controller port a composition leaves unwired", async () => {
		await writeConfig({
			...CONFIG,
			controller: { mode: "process", releases: "/var/lib/hobo-ci/releases" },
		});
		const chosen = await agentRealizer({
			simulate: false,
			env: { [CD_RUNNER_HOST_ENV]: configPath },
			cwd: "/",
			now: () => 0,
			campIds: [BOX],
			simulated: () => {
				throw new Error("not simulated");
			},
			runnerHost: { process: { status: async () => undefined } },
		});
		const reason = chosen.ok ? undefined : chosen.reasons[0];
		expect(reason?.code).toBe("runner-host-interface-missing");
		expect(reason?.message).toContain("process.run, process.stage");
		expect(reason?.message).not.toContain("jobs.");
	});

	it("refuses an agent started for another host's Camp", async () => {
		await writeConfig();
		const host = new FakeRunnerHost();
		const chosen = await agentRealizer({
			simulate: false,
			env: { [CD_RUNNER_HOST_ENV]: configPath },
			cwd: "/",
			now: () => 0,
			// SAFETY: another runner host's Camp id, the refusal under test.
			campIds: [BOX, "hobo-ci-runners/mesh-1" as CampId],
			simulated: () => {
				throw new Error("not simulated");
			},
			runnerHost: host.ports(),
		});
		expect(chosen.ok ? "" : chosen.reasons[0]?.code).toBe(
			"runner-host-camp-unbound",
		);
	});
});

describe("the runner-host realizer as a @hobo/cd Realizer", () => {
	it("reads the image from the Set's runner-host row, pinned by digest", () => {
		expect(
			runnerHostImageOf(runnerHostResolvedSet({ campId: BOX, image: TARGET })),
		).toBe(TARGET);
		expect(
			runnerHostImageOf(runnerHostResolvedSet({ campId: BOX })),
		).toBeUndefined();
	});

	it("converges by draining, swapping the controller by digest and verifying", async () => {
		await writeConfig();
		const host = new FakeRunnerHost({ running: PREVIOUS });
		const chosen = await realizerFor(host);
		if (!chosen.ok) throw new Error(chosen.reasons[0]?.message);
		const observed = await chosen.value.converge(realizeInput(TARGET), ctx);
		expect(observed.status).toBe(ReconcileStatus.CONVERGED);
		expect(observed.setId).toBe("set_target");
		expect(observed.fenceToken).toBe("7");
		expect(observed.resources[0]?.physicalId).toBe(
			`hobo-ci-runners/box/controller@${digestOf(TARGET)}`,
		);
		expect(observed.resources[0]?.attributes).toEqual({});
		expect(host.runningImage()).toBe(TARGET);
		expect(host.calls).toEqual(
			expect.arrayContaining([`pull ${TARGET}`, "pause", "resume"]),
		);
		const ready = observed.claims.find(
			(claim) => claim.name === "hobo.ci/runner-host-ready",
		);
		expect(ready?.value).toBe("true");
	});

	it("a failed verify restores the previous digest and reports BLOCKED with the realizer's code", async () => {
		await writeConfig();
		const host = new FakeRunnerHost({ running: PREVIOUS, unhealthy: [BROKEN] });
		const chosen = await realizerFor(host);
		if (!chosen.ok) throw new Error(chosen.reasons[0]?.message);
		const observed = await chosen.value.converge(realizeInput(BROKEN), ctx);
		expect(observed.status).toBe(ReconcileStatus.BLOCKED);
		expect(observed.setId).toBe("");
		expect(observed.reasons[0]?.code).toBe("runner-host-verify-failed");
		expect(observed.reasons[0]?.message).toContain(
			`restored and observed the previous controller ${digestOf(PREVIOUS)}`,
		);
		expect(host.runningImage()).toBe(PREVIOUS);
		expect(observed.resources[0]?.physicalId).toBe(
			`hobo-ci-runners/box/controller@${digestOf(PREVIOUS)}`,
		);
		expect(host.admission).toBe(true);
	});

	it("observe is CONVERGED only at the Set's digest, serving; otherwise DRIFTED", async () => {
		await writeConfig();
		const host = new FakeRunnerHost({ running: PREVIOUS });
		const chosen = await realizerFor(host);
		if (!chosen.ok) throw new Error(chosen.reasons[0]?.message);
		expect(
			(await chosen.value.observe(realizeInput(PREVIOUS), ctx)).status,
		).toBe(ReconcileStatus.CONVERGED);
		expect((await chosen.value.observe(realizeInput(TARGET), ctx)).status).toBe(
			ReconcileStatus.DRIFTED,
		);
	});

	it("converge is CONVERGED only at the Set's digest: a healthy controller at another digest is CONVERGING", async () => {
		const host = new FakeRunnerHost({ running: PREVIOUS });
		const resolver = createRunnerHostResolver({
			hostId: "box",
			hostKind: "box-worker",
			host: host.ports(),
			now: () => host.nowMs,
		});
		const realizer = createRunnerHostRealizer({
			// A resolver whose reconcile reports success without moving the
			// host: the realizer must not take its word for the digest.
			resolver: {
				...resolver,
				reconcile: async (request, transport) => {
					const read = await resolver.read?.(request, transport);
					if (!read) throw new Error("no controller");
					return read;
				},
			},
			hostId: "box",
			credentialRef: CONFIG.credentialRef,
			now: () => host.nowMs,
		});
		const observed = await realizer.converge(realizeInput(TARGET), ctx);
		expect(observed.status).toBe(ReconcileStatus.CONVERGING);
		expect(observed.setId).toBe("");
		expect(observed.resources[0]?.physicalId).toBe(
			`hobo-ci-runners/box/controller@${digestOf(PREVIOUS)}`,
		);
		expect((await realizer.converge(realizeInput(PREVIOUS), ctx)).status).toBe(
			ReconcileStatus.CONVERGED,
		);
	});

	it("a Set without a runner-host row is BLOCKED, the host untouched", async () => {
		const host = new FakeRunnerHost({ running: PREVIOUS });
		const realizer = createRunnerHostRealizer({
			resolver: {
				providerId: "hobo-ci",
				productId: "hobo-ci.runner-host/v1",
				async reconcile() {
					throw new Error("must not be called");
				},
				async delete() {},
			},
			hostId: "box",
			credentialRef: CONFIG.credentialRef,
			now: () => host.nowMs,
		});
		const observed = await realizer.converge(realizeInput(undefined), ctx);
		expect(observed.status).toBe(ReconcileStatus.BLOCKED);
		expect(observed.reasons[0]?.code).toBe("runner-host-image-unresolved");
		expect(host.calls).toEqual([]);
	});
});

describe("runner-host health reaches Camp inventory (Station side)", () => {
	it("an unready host is tainted NO_PLACE with health conditions, and untainted once ready", async () => {
		const home = await mkdtemp(join(tmpdir(), "runner-host-health-"));
		dir = home;
		const topology = join(home, "camps.json");
		await writeFile(
			topology,
			JSON.stringify({
				camps: [
					{
						campId: BOX,
						yardId: "hobo-ci-runners",
						provider: "self-hosted",
						envType: "ci",
						labels: { "hobo.ci/serves-hobo": "true" },
					},
				],
			}),
		);
		let nowMs = Date.parse("2026-11-12T10:00:00.000Z");
		const opened = await openCdRuntime({
			env: { HOBO_HOME: home },
			home,
			cwd: home,
			simulate: false,
			now: () => nowMs,
			topologyFiles: [topology],
		});
		if (!opened.ok) throw new Error(opened.reasons[0]?.message);
		const station = opened.value;
		try {
			const host = new FakeRunnerHost({ running: PREVIOUS });
			const report = (claims: readonly { name: string; value: string }[]) =>
				create(ReconcileObservationRecordSchema, {
					campId: BOX,
					resources: [
						create(ResourceObservationSchema, {
							resource: "runner-controller",
							kind: "hobo-ci.runner-host/v1",
						}),
					],
					claims: claims.map((claim) => create(CampClaimRecordSchema, claim)),
				});
			const expired = [
				{ name: "hobo.ci/mesh-advert", value: "expired" },
				{
					name: "hobo.ci/mesh-advert-valid-until",
					value: new Date(nowMs - 1).toISOString(),
				},
				{ name: "hobo.ci/runner-host-ready", value: "false" },
			];
			const ingest = (claims: typeof expired) =>
				ingestRunnerHostHealth({
					inventory: station.cd.inventory,
					observation: report(claims),
					tenant: station.config.tenant,
					now: () => nowMs,
				});
			// Concurrent reports race nothing: each states readiness outright.
			expect(
				await Promise.all([ingest(expired), ingest(expired), ingest(expired)]),
			).toEqual(Array(3).fill({ ingested: true, ready: false }));
			const tainted = await station.cd.inventory.status(BOX);
			expect(
				tainted?.taints.filter((t) => t.key === RUNNER_HOST_UNREADY_TAINT),
			).toHaveLength(1);
			expect(
				tainted?.taints.find((t) => t.key === RUNNER_HOST_UNREADY_TAINT)
					?.effect,
			).toBe(TaintEffect.NO_PLACE);
			expect(
				tainted?.conditions.find(
					(c) =>
						c.type === CampConditionType.READY &&
						c.source === SignalSource.HEALTH_SOURCE,
				)?.reason,
			).toBe("mesh-advert-expired");

			nowMs += 1_000;
			const fresh = [
				{ name: "hobo.ci/mesh-advert", value: "fresh" },
				{
					name: "hobo.ci/mesh-advert-valid-until",
					value: new Date(nowMs + 60_000).toISOString(),
				},
				{ name: "hobo.ci/runner-host-ready", value: "true" },
			];
			expect(await Promise.all([ingest(fresh), ingest(fresh)])).toEqual(
				Array(2).fill({ ingested: true, ready: true }),
			);
			const cleared = await station.cd.inventory.status(BOX);
			expect(
				cleared?.taints.some((t) => t.key === RUNNER_HOST_UNREADY_TAINT),
			).toBe(false);
			// Only a runner-host agent's report is read as runner health.
			const other = create(ReconcileObservationRecordSchema, { campId: BOX });
			expect(
				await ingestRunnerHostHealth({
					inventory: station.cd.inventory,
					observation: other,
					tenant: station.config.tenant,
					now: () => nowMs,
				}),
			).toEqual({ ingested: false });
			expect(host.calls).toEqual([]);
		} finally {
			await station.close();
		}
	});
});

describe("a failed health ingest is reported, never silent", () => {
	it("rejects with the inventory's refusal, for the feed wrapper to hand to onError", async () => {
		const refused = {
			ok: false as const,
			reasons: [
				create(ReasonRecordSchema, {
					code: "camp-unknown",
					message: "not declared",
				}),
			],
		};
		const unused = async () => {
			throw new Error("not reached after a refused observe");
		};
		await expect(
			ingestRunnerHostHealth({
				inventory: {
					observe: async () => refused,
					taint: unused,
					untaint: unused,
				},
				observation: create(ReconcileObservationRecordSchema, {
					campId: BOX,
					resources: [
						create(ResourceObservationSchema, {
							resource: "runner-controller",
							kind: "hobo-ci.runner-host/v1",
						}),
					],
				}),
				tenant: "local",
				now: () => 0,
			}),
		).rejects.toThrow(
			`runner-host-health-ingest-failed: observe for ${BOX}: camp-unknown: not declared`,
		);
	});
});

describe("Station Rails declared beside the runner fleet's Camps", () => {
	const journal = (active?: Awaited<ReturnType<RailCatalog["active"]>>) =>
		({
			active: async () => active,
			byDigest: async () => undefined,
		}) satisfies RailCatalog;

	it("a delivery module may export rails; the Rail binds the Camp set and approves its provider", async () => {
		expect(
			parseDeliveryModule({ rails: [runnerFleetRail()], camps: [] }).ok,
		).toBe(true);
		const parsed = parseDeclaredRails(
			{ rails: [runnerFleetRail()] },
			{ stationId: "station-a", source: "hobo.delivery.ts" },
		);
		if (!parsed.ok) throw new Error(parsed.message);
		const catalog = declaredRailCatalog(journal(), parsed.value);
		if (!catalog.ok) throw new Error("conflict");
		const active = await catalog.value.active("station-a");
		expect(active?.delivery).toEqual({ campSets: ["hobo-ci-runner-fleet"] });
		expect(active?.railDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		expect(await catalog.value.approvedProviders("station-a")).toEqual([
			"self-hosted",
		]);
		expect(await catalog.value.approvedProviders("station-b")).toBeUndefined();
	});

	it("a Rail the Station's journal activated wins, and its providers stay unknown (fail closed)", async () => {
		const parsed = parseDeclaredRails(
			{ rails: [runnerFleetRail()] },
			{ stationId: "station-a", source: "hobo.delivery.ts" },
		);
		if (!parsed.ok) throw new Error(parsed.message);
		const governed = {
			railId: "rail-governed",
			railDigest: `sha256:${"9".repeat(64)}` as const,
			stationId: "station-a",
			status: "active" as const,
		};
		const catalog = declaredRailCatalog(journal(governed), parsed.value);
		if (!catalog.ok) throw new Error("conflict");
		expect((await catalog.value.active("station-a"))?.railId).toBe(
			"rail-governed",
		);
		expect(await catalog.value.approvedProviders("station-a")).toBeUndefined();
	});

	it("refuses a Rail without approved providers, and two Rails for one Station", () => {
		const empty = parseDeclaredRails(
			{ rails: [{ ...runnerFleetRail(), approvedProviders: [] }] },
			{ stationId: "s", source: "f" },
		);
		expect(empty.ok ? "" : empty.code).toBe("cd-topology-invalid");
		const two = parseDeclaredRails(
			{
				rails: [runnerFleetRail(), { ...runnerFleetRail(), version: "2" }],
			},
			{ stationId: "s", source: "f" },
		);
		if (!two.ok) throw new Error(two.message);
		const catalog = declaredRailCatalog(journal(), two.value);
		expect(catalog.ok ? "" : catalog.reasons[0]?.code).toBe("cd-rail-conflict");
	});
});

describe("agent run on a host whose controller is a supervised process (in-process e2e)", () => {
	/**
	 * `agentRealizer` with the host's own default ports: the supervisor's
	 * control files and the worker's data directory, nothing injected. The
	 * realizer's waits run the host (supervisor pass, worker beat).
	 */
	async function processAgent(
		options: Readonly<{
			hostKind?: "box-worker" | "local-runner";
			unhealthy?: (images: string[]) => string[];
			offline?: boolean;
		}> = {},
	) {
		await writeConfig();
		const source = join(dir, "releases");
		const images = await writeReleases(source, [
			"export const v = 1;\n",
			"export const v = 2;\n",
			"export const v = 3;\n",
		]);
		const local = options.hostKind === "local-runner";
		const host = new SupervisedRunnerHost({
			dataDirectory: join(dir, "data"),
			hostKind: options.hostKind ?? "box-worker",
			unhealthy: (options.unhealthy?.(images) ?? []).map(digestOf),
			...(options.offline ? { offline: true } : undefined),
		});
		await writeFile(
			configPath,
			JSON.stringify({
				...CONFIG,
				hostKind: options.hostKind ?? "box-worker",
				worker: local
					? { directory: join(dir, "data") }
					: { database: join(dir, "data", "worker.sqlite") },
				controller: { mode: "process", releases: source },
			}),
		);
		const chosen = await agentRealizer({
			simulate: false,
			env: { [CD_RUNNER_HOST_ENV]: configPath },
			cwd: "/",
			now: () => host.nowMs,
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
		return { realizer: chosen.value, host, images };
	}

	it("swaps the box worker by digest under its supervisor and converges on the advert at the new version", async () => {
		const { realizer, host, images } = await processAgent();
		const [v1, v2] = images;
		const first = await realizer.converge(realizeInput(v1), ctx);
		expect(first.status).toBe(ReconcileStatus.CONVERGED);
		const second = await realizer.converge(realizeInput(v2), ctx);
		expect(second.status).toBe(ReconcileStatus.CONVERGED);
		expect(second.resources[0]?.physicalId).toBe(
			`hobo-ci-runners/box/controller@${digestOf(v2 ?? "")}`,
		);
		expect(host.running()).toEqual([digestOf(v2 ?? "")]);
		expect(
			second.claims.find((claim) => claim.name === "hobo.ci/runner-host-ready")
				?.value,
		).toBe("true");
		expect((await realizer.observe(realizeInput(v2), ctx)).status).toBe(
			ReconcileStatus.CONVERGED,
		);
	});

	it("restores the previous release when the new one never serves, BLOCKED with the realizer's code", async () => {
		const { realizer, host, images } = await processAgent({
			unhealthy: (all) => [all[2] ?? ""],
		});
		const [v1, , broken] = images;
		await realizer.converge(realizeInput(v1), ctx);
		const observed = await realizer.converge(realizeInput(broken), ctx);
		expect(observed.status).toBe(ReconcileStatus.BLOCKED);
		expect(observed.reasons[0]?.code).toBe("runner-host-verify-failed");
		expect(observed.reasons[0]?.message).toContain(
			`restored and observed the previous controller ${digestOf(v1 ?? "")}`,
		);
		expect(host.running()).toEqual([digestOf(v1 ?? "")]);
		expect(observed.resources[0]?.physicalId).toBe(
			`hobo-ci-runners/box/controller@${digestOf(v1 ?? "")}`,
		);
	});

	it("converges a local runner once its runner is online in GitHub, and not before", async () => {
		const online = await processAgent({ hostKind: "local-runner" });
		const [v1] = online.images;
		expect((await online.realizer.converge(realizeInput(v1), ctx)).status).toBe(
			ReconcileStatus.CONVERGED,
		);

		const offline = await processAgent({
			hostKind: "local-runner",
			offline: true,
		});
		const blocked = await offline.realizer.converge(
			realizeInput(offline.images[0]),
			ctx,
		);
		expect(blocked.status).toBe(ReconcileStatus.BLOCKED);
		expect(blocked.reasons[0]?.message).toContain(
			"no registered runner is online",
		);
	});
});
