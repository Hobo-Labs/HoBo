// HoBo delivering its own CI relay through @hobo/cd: Freight, the preview ->
// production pipeline, the gate, the conductor realizer and the probe
// verification, all offline (a fake Vercel realization, a fake probe
// transport, an injected clock, a temporary SQLite journal).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { toJson } from "@bufbuild/protobuf";
import type { ManifestV1 } from "@hobo/bindles";
import { FreightSourceRecordSchema, ReconcileStatus } from "@hobo/cd";
import { HOBO_CI_COMPONENTS, hoboSelfDeliverySources } from "@hobo/cd/compose";
import { compileProjectManifest } from "@hobo/cli";
import type { HttpTransport } from "@hobo/core";
import type { Yard } from "@hobo/yards";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type DeliveryModule,
	loadDeliveryFile,
} from "../src/cd-delivery-module.js";
import { openCdStore } from "../src/cd-store.js";
import {
	deliverRelay,
	RELAY_DELIVERY_FILE,
	RELAY_DELIVERY_REFUSAL,
	type RelayRealization,
	type RelaySourcePin,
	relayCampId,
	relayYardRegistryProvider,
	reportedStatus,
	withStorableRolloutTypes,
} from "../src/ci-relay-delivery.js";
import { loadRelayYard } from "../src/ci-relay-yard.js";

const RELAY_DIR = resolve(import.meta.dirname, "../../ci-vercel");
const PREVIEW = "https://relay-preview.example.test";
const PRODUCTION = "https://relay.example.test";
const SHA = "1".repeat(40);

let yard: Yard;
let declaration: ManifestV1;
let records: DeliveryModule;
let unconfigured: DeliveryModule;

beforeAll(async () => {
	const loadedYard = await loadRelayYard(RELAY_DIR);
	if (!loadedYard) throw new Error("the relay Yard did not load");
	yard = loadedYard;
	const manifest = await compileProjectManifest(RELAY_DIR);
	if (!manifest) throw new Error("the relay Bindle did not compile");
	declaration = manifest;
	// The module reads its origins once when it loads: load it under each
	// environment through a distinct module URL.
	const load = async (env: Record<string, string>, tag: string) => {
		const saved = { ...process.env };
		Object.assign(process.env, env);
		try {
			const outcome = await loadDeliveryFile(RELAY_DELIVERY_FILE, {
				cwd: RELAY_DIR,
				importModule: async (path) => {
					const { tsImport } = await import("tsx/esm/api");
					return tsImport(
						`${new URL(`file://${path}`).href}?${tag}`,
						import.meta.url,
					);
				},
			});
			if (!outcome.ok) throw new Error(outcome.message);
			return outcome.value;
		} finally {
			for (const key of Object.keys(env)) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	};
	records = await load(
		{ HOBO_CI_RELAY_URL: PRODUCTION, HOBO_CI_RELAY_PREVIEW_URL: PREVIEW },
		"configured",
	);
	unconfigured = await load(
		{ HOBO_CI_RELAY_URL: "", HOBO_CI_RELAY_PREVIEW_URL: "" },
		"unconfigured",
	);
}, 60_000);

type Harness = Readonly<{
	home: string;
	deployed: RelaySourcePin[];
	probed: string[];
	clock: { now: number };
}>;

async function harness(): Promise<Harness> {
	return {
		home: await mkdtemp(join(tmpdir(), "relay-delivery-")),
		deployed: [],
		probed: [],
		clock: { now: Date.UTC(2026, 10, 12, 12) },
	};
}

function realization(
	h: Harness,
	options: { readyState?: string; refuse?: boolean } = {},
): RelayRealization {
	return {
		async deploy(source) {
			h.deployed.push(source);
			if (options.refuse)
				return {
					ok: false,
					code: "HOBO_CI_DEPLOY_VERCEL_REFUSED",
					message: "Vercel refused the deploy (HTTP 403). forbidden",
					data: { status: 403 },
				};
			return {
				ok: true,
				outputs: {
					deploymentId: `dpl_${h.deployed.length}`,
					url: `https://hobo-ci-${h.deployed.length}.vercel.app`,
					target: "preview",
				},
			};
		},
		async readyState() {
			return options.readyState ?? "READY";
		},
	};
}

function probes(
	h: Harness,
	status: number | "unreachable" = 200,
): HttpTransport {
	return async (request) => {
		h.probed.push(request.url);
		if (status === "unreachable") throw new Error("connect ECONNREFUSED");
		return { status, headers: {}, body: "" };
	};
}

function deliver(
	h: Harness,
	target: "preview" | "production",
	overrides: Partial<Parameters<typeof deliverRelay>[0]> = {},
) {
	return deliverRelay({
		cwd: RELAY_DIR,
		env: { HOBO_USER: "relay-test" },
		home: h.home,
		yard,
		declaration,
		target,
		source: { repository: "Hobo-Labs/HoBo", ref: "main", sha: SHA },
		realization: realization(h),
		http: probes(h),
		records,
		now: () => h.clock.now,
		sleep: async (ms) => {
			h.clock.now += ms;
		},
		intervalMs: 5_000,
		feedWaitMs: 20,
		limitMs: 30 * 60_000,
		...overrides,
	});
}

describe("the relay's delivery records (deploy/delivery.ts)", () => {
	it("declares the relay pipeline preview -> production with production fed only by preview", () => {
		const [pipeline] = records.pipelines;
		expect(pipeline?.name).toBe(HOBO_CI_COMPONENTS.relay.pipeline);
		expect(pipeline?.bindle).toBe(HOBO_CI_COMPONENTS.relay.bindle);
		expect(pipeline?.nodes.map((node) => node.name)).toEqual([
			"preview",
			"production",
		]);
		const production = pipeline?.nodes[1];
		expect(production?.fromNodes).toEqual(["preview"]);
		expect(production?.fromSources).toEqual([]);
		expect(production?.campIds).toEqual([relayCampId(yard, "production")]);
		expect(pipeline?.nodes[0]?.campIds).toEqual([relayCampId(yard, "preview")]);
	});

	it("verifies each node with /healthz and /readyz probes that fail closed on no data", () => {
		const [preview, production] = records.pipelines[0]?.nodes ?? [];
		for (const [node, origin] of [
			[preview, PREVIEW],
			[production, PRODUCTION],
		] as const) {
			expect(node?.verification?.failOnNoData).toBe(true);
			expect(node?.verification?.probes.map((probe) => probe.urlRef)).toEqual([
				`${origin}/healthz`,
				`${origin}/readyz`,
			]);
			expect(
				node?.verification?.probes.every(
					(probe) => probe.expectStatus === 200 && probe.minSuccessRatio === 1,
				),
			).toBe(true);
		}
	});

	it("probes a reserved .invalid host when an origin is not configured", () => {
		const urls = unconfigured.pipelines[0]?.nodes.flatMap(
			(node) => node.verification?.probes.map((probe) => probe.urlRef) ?? [],
		);
		expect(
			urls?.every((url) => new URL(url).hostname.endsWith(".invalid")),
		).toBe(true);
	});

	it("defines the relay source exactly as hoboSelfDeliverySources builds it", () => {
		const [relay] = hoboSelfDeliverySources({
			ciPipeline: "Hobo-Labs/HoBo",
		});
		expect(records.sources).toHaveLength(1);
		const [declared] = records.sources;
		if (!relay || !declared) throw new Error("missing source");
		expect(toJson(FreightSourceRecordSchema, declared)).toEqual(
			toJson(FreightSourceRecordSchema, relay),
		);
	});
});

describe("Matching for the relay (the Yard's declared catalog)", () => {
	it("advertises only the ports the relay Yard's rows cover, in its regions", () => {
		const provider = relayYardRegistryProvider(yard);
		expect(provider.id).toBe("yard:hobo-ci-relay");
		expect(provider.regions).toEqual(["iad1"]);
		expect(provider.capabilities.map((capability) => capability.port)).toEqual([
			"compute",
			"data",
		]);
		const [compute] = provider.capabilities;
		expect(compute?.satisfies({ port: "database" }).kind).toBe("none");
		expect(
			compute?.satisfies({ port: "compute", features: ["gpu"] }).kind,
		).toBe("partial");
	});
});

describe("deliverRelay: HoBo's relay delivered by @hobo/cd", () => {
	it("records Freight, promotes to preview, realizes it and qualifies it on passing probes", async () => {
		const h = await harness();
		const outcome = await deliver(h, "preview");
		expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.report.state).toBe("PROMOTED");
		expect(outcome.report.campId).toBe(relayCampId(yard, "preview"));
		expect(outcome.report.freightId).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(outcome.handover.url).toBe("https://hobo-ci-1.vercel.app");
		expect(outcome.handover.readyState).toBe("READY");
		expect(h.deployed).toEqual([
			{ repository: "Hobo-Labs/HoBo", ref: "main", sha: SHA },
		]);
		expect(h.probed).toContain(`${PREVIEW}/healthz`);
		expect(h.probed).toContain(`${PREVIEW}/readyz`);
	}, 60_000);

	it("refuses production before anything is deployed when preview has not qualified the commit", async () => {
		const h = await harness();
		const outcome = await deliver(h, "production");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe(RELAY_DELIVERY_REFUSAL.notQualified);
		expect(h.deployed).toEqual([]);
	}, 60_000);

	it("promotes to production the exact commit preview qualified", async () => {
		const h = await harness();
		const preview = await deliver(h, "preview");
		expect(preview.ok).toBe(true);
		const production = await deliver(h, "production");
		expect(production.ok, production.ok ? "" : production.message).toBe(true);
		if (!production.ok || !preview.ok) return;
		expect(production.report.freightId).toBe(preview.report.freightId);
		expect(production.report.state).toBe("PROMOTED");
		expect(h.deployed.map((pin) => pin.sha)).toEqual([SHA, SHA]);
		expect(h.probed).toContain(`${PRODUCTION}/readyz`);
	}, 60_000);

	it("records two commits as two Freight, and production refuses the one preview has not qualified", async () => {
		const h = await harness();
		expect((await deliver(h, "preview")).ok).toBe(true);
		const other = await deliver(h, "production", {
			source: {
				repository: "Hobo-Labs/HoBo",
				ref: "main",
				sha: "2".repeat(40),
			},
		});
		expect(other.ok).toBe(false);
		if (other.ok) return;
		expect(other.code).toBe(RELAY_DELIVERY_REFUSAL.notQualified);
	}, 60_000);

	it("fails verification closed when the probes answer 503, and never qualifies the Freight", async () => {
		const h = await harness();
		const outcome = await deliver(h, "preview", { http: probes(h, 503) });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe(RELAY_DELIVERY_REFUSAL.verificationFailed);
		const production = await deliver(h, "production");
		expect(production.ok).toBe(false);
		if (production.ok) return;
		expect(production.code).toBe(RELAY_DELIVERY_REFUSAL.notQualified);
	}, 60_000);

	it("fails verification closed when the relay cannot be reached (no data)", async () => {
		const h = await harness();
		const outcome = await deliver(h, "preview", {
			http: probes(h, "unreachable"),
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe(RELAY_DELIVERY_REFUSAL.verificationFailed);
	}, 60_000);

	it("returns a Vercel refusal from the realizer as the deploy's own result", async () => {
		const h = await harness();
		const outcome = await deliver(h, "preview", {
			realization: realization(h, { refuse: true }),
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("HOBO_CI_DEPLOY_VERCEL_REFUSED");
		expect(outcome.realization?.data).toEqual({ status: 403 });
	}, 60_000);

	it("reports a deployment that ends ERROR as not ready, never converged", async () => {
		const h = await harness();
		const outcome = await deliver(h, "preview", {
			realization: realization(h, { readyState: "ERROR" }),
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("HOBO_CI_DEPLOY_NOT_READY");
		expect(outcome.handover?.readyState).toBe("ERROR");
	}, 60_000);
});

describe("journal compatibility for the relay's CD composition", () => {
	it("stores the rollout ledger's two-dot types under a valid family and reads them back as declared", async () => {
		const journal = (
			await openCdStore({ backend: "memory" }, { now: () => Date.now() })
		).store;
		const actor = { kind: "user", id: "relay-test" } as const;
		await expect(
			journal.append(
				"cd-rollout-x",
				[{ type: "cd.rollout.Started", data: {} }],
				{
					expectedSeq: 0,
					actor,
					tenant: "local",
				},
			),
		).rejects.toThrow(/family\.PastTenseFact/);
		const store = withStorableRolloutTypes(journal);
		await store.append(
			"cd-rollout-x",
			[{ type: "cd.rollout.Started", data: {} }],
			{ expectedSeq: 0, actor, tenant: "local" },
		);
		const read: string[] = [];
		for await (const event of store.read("cd-rollout-x")) read.push(event.type);
		expect(read).toEqual(["cd.rollout.Started"]);
		const all: string[] = [];
		for await (const entry of store.readAll({
			tenant: "local",
			filter: { type: "cd.rollout.Started" },
		}))
			all.push(entry.event.streamId);
		expect(all).toEqual(["cd-rollout-x"]);
	});

	it("reads a reconciler's reported status from its { schema, observation } envelope, highest fence first", async () => {
		const campId = relayCampId(yard, "preview");
		const { store } = await openCdStore(
			{ backend: "memory" },
			{ now: () => Date.now() },
		);
		await store.append(
			`cd-camp-status-${campId}`,
			[
				{ fence: "2", status: "RECONCILE_STATUS_CONVERGED" },
				{ fence: "1", status: "RECONCILE_STATUS_CONVERGING" },
			].map(({ fence, status }) => ({
				type: "deployment.StatusObserved",
				data: {
					schema: "hobo.cd.reconcile-status/v1",
					observation: { campId, setId: "set_a", fenceToken: fence, status },
				},
			})),
			{
				expectedSeq: 0,
				actor: { kind: "user", id: "relay-test" },
				tenant: "local",
			},
		);
		const observed = await reportedStatus(store, campId);
		expect(observed?.fenceToken).toBe("2");
		expect(observed?.status).toBe(ReconcileStatus.CONVERGED);
	});
});
