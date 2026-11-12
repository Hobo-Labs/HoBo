// `hobo deploy agent run` on a runner host: which realizer it registers
// (cd-agent.ts), the runner-host realizer as a @hobo/cd Realizer
// (cd-agent-runner-host.ts), and the Station Rails a delivery module declares
// (cd-declared-rails.ts). Offline, with a fake runner host.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	type CampId,
	type CdContext,
	type FenceToken,
	type ReconcilerId,
	ReconcileStatus,
	SetRecordSchema,
} from "@hobo/cd";
import type { RailCatalog } from "@hobo/cd/compose";
import { runnerFleetRail } from "@hobo/ci-gh-actions/runner-host";
import { afterEach, describe, expect, it } from "vitest";
import { agentRealizer } from "../src/cd-agent.js";
import {
	CD_RUNNER_HOST_ENV,
	createRunnerHostRealizer,
	parseRunnerHostAgentConfig,
	runnerHostImageOf,
} from "../src/cd-agent-runner-host.js";
import {
	declaredRailCatalog,
	parseDeclaredRails,
} from "../src/cd-declared-rails.js";
import { parseDeliveryModule } from "../src/cd-delivery-module.js";
import {
	digestOf,
	FakeRunnerHost,
	imageAt,
	runnerHostResolvedSet,
} from "./fixtures/runner-host-fake.js";

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
		reconcilerId: "rec_box" as ReconcilerId,
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
async function writeConfig(value: object = CONFIG): Promise<string> {
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
			drainDeadlineMs: 7_200_000,
		});
		expect(parsed.ok && parsed.value).toEqual({
			...CONFIG,
			dockerBinary: "/usr/bin/docker",
			drainDeadlineMs: 7_200_000,
		});
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

	it("registers the runner-host realizer, and refuses by name the job ports this host has not wired", async () => {
		await writeConfig();
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
		expect(chosen.ok).toBe(false);
		const reason = chosen.ok ? undefined : chosen.reasons[0];
		expect(reason?.code).toBe("runner-host-interface-missing");
		expect(reason?.message).toContain(
			"jobs.leases, jobs.meshAdvert, jobs.pauseAdmission, jobs.resumeAdmission, jobs.runners",
		);
		// The container port defaults to the engine CLI, so it is not missing.
		expect(reason?.message).not.toContain("containers.");
	});

	it("refuses an agent started for another host's Camp", async () => {
		await writeConfig();
		const host = new FakeRunnerHost();
		const chosen = await agentRealizer({
			simulate: false,
			env: { [CD_RUNNER_HOST_ENV]: configPath },
			cwd: "/",
			now: () => 0,
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
		expect(catalog.ok ? "" : catalog.reasons[0]?.code).toBe(
			"cd-rail-conflict",
		);
	});
});
