// HoBo delivering its own CI relay through @hobo/cd: Freight, the preview ->
// production pipeline, the gate, the conductor realizer and the probe
// verification, all offline (a fake Vercel realization, a fake probe
// transport, an injected clock, a temporary SQLite journal).
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import type { ManifestV1 } from "@hobo/bindles";
import {
	FreightSourceRecordSchema,
	HookKind,
	HookPoint,
	HookRecordSchema,
} from "@hobo/cd";
import { HOBO_CI_COMPONENTS, hoboSelfDeliverySources } from "@hobo/cd/compose";
import { compileProjectManifest } from "@hobo/cli";
import { capability, type HttpTransport } from "@hobo/core";
import type { Yard } from "@hobo/yards";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
} from "../src/ci-relay-delivery.js";
import { loadRelayJoinedYards, loadRelayYard } from "../src/ci-relay-yard.js";

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
	finalized: string[];
	clock: { now: number };
}>;

const homes: string[] = [];

afterAll(async () => {
	await Promise.all(
		homes.map((home) => rm(home, { recursive: true, force: true })),
	);
});

async function harness(): Promise<Harness> {
	const home = await mkdtemp(join(tmpdir(), "relay-delivery-"));
	homes.push(home);
	return {
		home,
		deployed: [],
		probed: [],
		finalized: [],
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

	it("verifies preview with /healthz and production with /healthz and /readyz, failing closed on no data", () => {
		const [preview, production] = records.pipelines[0]?.nodes ?? [];
		// The preview Camp has no config-service binding, so its /readyz answers
		// 503 started:false: requiring it would block every production deploy.
		for (const [node, urls] of [
			[preview, [`${PREVIEW}/healthz`]],
			[production, [`${PRODUCTION}/healthz`, `${PRODUCTION}/readyz`]],
		] as const) {
			expect(node?.verification?.failOnNoData).toBe(true);
			expect(node?.verification?.probes.map((probe) => probe.urlRef)).toEqual(
				urls,
			);
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
			"kv",
			"queue",
			"schedule",
		]);
		const [compute] = provider.capabilities;
		expect(compute?.satisfies({ port: "database" }).kind).toBe("none");
		expect(
			compute?.satisfies({ port: "compute", features: ["gpu"] }).kind,
		).toBe("partial");
		for (const port of ["kv", "queue"]) {
			const entry = provider.capabilities.find((item) => item.port === port);
			expect(entry?.satisfies({ port })).toEqual({ kind: "full" });
			expect(entry?.satisfies({ port, features: ["unlisted"] })).toEqual({
				kind: "partial",
				missing: ["unlisted"],
			});
		}
		const withoutQueue = relayYardRegistryProvider({
			...yard,
			bindings: yard.bindings.filter(
				(row) => row.profile !== capability.queue.atLeastOnce,
			),
		});
		expect(
			withoutQueue.capabilities.some((entry) => entry.port === "queue"),
		).toBe(false);
	});

	it("keeps a joined secret projection under its own Yard and does not invent other capabilities", async () => {
		const joined = await loadRelayJoinedYards(RELAY_DIR, yard);
		const configYard = joined.find(
			(member) => member.providerId === "infisical",
		);
		if (!configYard) throw new Error("missing joined config Yard");
		const provider = relayYardRegistryProvider(configYard, true);
		expect(provider.id).toBe("yard:hobo-ci-relay-config");
		expect(provider.capabilities.map((entry) => entry.port)).toEqual([
			"secretRef",
		]);
		const secrets = provider.capabilities.find(
			(entry) => entry.port === "secretRef",
		);
		expect(
			secrets?.satisfies({ port: "secretRef", features: ["access"] }).kind,
		).toBe("full");
		expect(
			secrets?.satisfies({ port: "secretRef", features: ["put"] }).kind,
		).toBe("partial");
		const noProjection = relayYardRegistryProvider(
			{
				...configYard,
				bindings: configYard.bindings.filter(
					(row) => row.profile !== capability.secretRef.runtimeProjection,
				),
			},
			true,
		);
		expect(
			noProjection.capabilities.some((entry) => entry.port === "secretRef"),
		).toBe(false);
		const withOtherBindings: Yard = {
			...configYard,
			bindings: [...configYard.bindings, ...yard.bindings],
		};
		expect(
			relayYardRegistryProvider(withOtherBindings, true).capabilities.map(
				(entry) => entry.port,
			),
		).toEqual(["secretRef"]);
		expect(
			await loadRelayJoinedYards(RELAY_DIR, { ...yard, name: "other" }),
		).toEqual([]);
	});

	it("does not advertise key-value or queue ports without matching Yard bindings", () => {
		const withoutDataPorts: Yard = {
			...yard,
			bindings: yard.bindings.filter(
				(row) =>
					row.profile !== capability.kv.keyValue &&
					row.profile !== capability.kv.redisCompatible &&
					row.profile !== capability.kv.valkey &&
					row.profile !== capability.queue.atLeastOnce &&
					row.profile !== capability.queue.fifo,
			),
		};
		expect(
			relayYardRegistryProvider(withoutDataPorts).capabilities.map(
				(entry) => entry.port,
			),
		).toEqual(["compute", "schedule"]);
	});

	it("recognizes generic key-value and FIFO bindings without inventing guarantees", () => {
		const alternate: Yard = {
			...yard,
			bindings: yard.bindings.map((row) =>
				row.profile === capability.kv.redisCompatible
					? { ...row, profile: capability.kv.keyValue }
					: row.profile === capability.queue.atLeastOnce
						? { ...row, profile: capability.queue.fifo }
						: row,
			),
		};
		const provider = relayYardRegistryProvider(alternate);
		const kv = provider.capabilities.find((entry) => entry.port === "kv");
		const queue = provider.capabilities.find((entry) => entry.port === "queue");
		expect(kv?.satisfies({ port: "kv" })).toEqual({ kind: "full" });
		expect(kv?.satisfies({ port: "kv", features: ["eventual"] })).toEqual({
			kind: "partial",
			missing: ["eventual"],
		});
		expect(queue?.satisfies({ port: "queue" })).toEqual({ kind: "full" });
	});
});

describe("deliverRelay: HoBo's relay delivered by @hobo/cd", () => {
	it("refuses delivery when the relay is not a member of the declared Junction", async () => {
		const h = await harness();
		const outcome = await deliver(h, "preview", { yard: { ...yard } });
		expect(outcome).toMatchObject({
			ok: false,
			code: RELAY_DELIVERY_REFUSAL.promotionRefused,
		});
		expect(h.deployed).toEqual([]);
	});

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
		expect(h.probed).not.toContain(`${PREVIEW}/readyz`);
		// The shared CD journal `hobo deploy` reads: no private relay journal.
		expect(existsSync(join(h.home, "cd"))).toBe(true);
		expect(existsSync(join(h.home, "ci-relay"))).toBe(false);
		const types = await journalTypes({
			backend: "sqlite",
			path: join(h.home, "cd", "journal.sqlite"),
		});
		// The rollout ledger is stored under the family a durable journal
		// accepts; no private encoding is left behind.
		expect(types.some((type) => type.startsWith("rollout."))).toBe(true);
		expect(
			types.some(
				(type) =>
					type.startsWith("cd.rollout.") || type.startsWith("cdrollout."),
			),
		).toBe(false);
	}, 60_000);

	it("delivers into the shared store HOBO_CD_SQLITE_PATH names, then production from the same journal", async () => {
		const h = await harness();
		const path = join(h.home, "shared", "journal.sqlite");
		const env = { HOBO_USER: "relay-test", HOBO_CD_SQLITE_PATH: path };
		const preview = await deliver(h, "preview", { env });
		expect(preview.ok, preview.ok ? "" : preview.message).toBe(true);
		const production = await deliver(h, "production", { env });
		expect(production.ok, production.ok ? "" : production.message).toBe(true);
		if (!production.ok) return;
		expect(production.report.state).toBe("PROMOTED");
		// The rollouts ran on the named journal, not a private one.
		const types = await journalTypes({ backend: "sqlite", path });
		expect(types.some((type) => type.startsWith("rollout."))).toBe(true);
		expect(existsSync(join(h.home, "ci-relay"))).toBe(false);
	}, 120_000);

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

	it("refuses, before deploying, a production run without a finalizer once a staged run injected the hook", async () => {
		const h = await harness();
		const stagedPreview = await deliver(h, "preview");
		expect(stagedPreview.ok).toBe(true);
		const staged = await deliver(h, "production", {
			finalizePromotion: async () => undefined,
		});
		expect(staged.ok, staged.ok ? "" : staged.message).toBe(true);
		const nextSource = {
			repository: "Hobo-Labs/HoBo",
			ref: "main",
			sha: "3".repeat(40),
		};
		const nextPreview = await deliver(h, "preview", { source: nextSource });
		expect(nextPreview.ok).toBe(true);
		const later = await deliver(h, "production", { source: nextSource });
		expect(later.ok).toBe(false);
		if (later.ok) return;
		expect(later.code).toBe(RELAY_DELIVERY_REFUSAL.recordsInvalid);
		expect(later.message).toContain("HOBO_CI_RELAY_STAGED_PRODUCTION=true");
		expect(h.deployed.map((pin) => pin.sha)).toEqual([
			SHA,
			SHA,
			"3".repeat(40),
		]);
	}, 180_000);

	it.each([
		["no finalizer configured", undefined],
		[
			"a finalizer configured",
			async () =>
				({
					ok: false as const,
					code: "HOBO_CI_TEST_FINALIZER",
					message: "must not run",
				}) as const,
		],
	])(
		"refuses records that declare the finalization hook themselves, with %s",
		async (_case, finalizePromotion) => {
			const h = await harness();
			const stagedPreview = await deliver(h, "preview");
			expect(stagedPreview.ok).toBe(true);
			const withFinalizationHook: DeliveryModule = {
				...records,
				pipelines: records.pipelines.map((pipelineRecord) => ({
					...pipelineRecord,
					nodes: pipelineRecord.nodes.map((pipelineNode) =>
						pipelineRecord.name === HOBO_CI_COMPONENTS.relay.pipeline &&
						pipelineNode.name === "production"
							? {
									...pipelineNode,
									hooks: [
										...pipelineNode.hooks,
										create(HookRecordSchema, {
											kind: HookKind.SUITE,
											point: HookPoint.AFTER_QUALIFIED,
											ref: "relay:finalize-promotion",
										}),
									],
								}
							: pipelineNode,
					),
				})),
			};
			const outcome = await deliver(h, "production", {
				records: withFinalizationHook,
				...(finalizePromotion !== undefined
					? { finalizePromotion }
					: undefined),
			});
			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.code).toBe(RELAY_DELIVERY_REFUSAL.recordsInvalid);
			expect(outcome.message).toContain(
				"ref is reserved for hobo ci deploy's own injection",
			);
			expect(h.deployed).toEqual([
				{ repository: "Hobo-Labs/HoBo", ref: "main", sha: SHA },
			]);
		},
		120_000,
	);

	it("returns a finalizer's failure as the delivery's own result", async () => {
		const h = await harness();
		expect((await deliver(h, "preview")).ok).toBe(true);
		const outcome = await deliver(h, "production", {
			finalizePromotion: async () => ({
				ok: false as const,
				code: "HOBO_CI_DEPLOY_LIVE_VERIFICATION_FAILED",
				message: "the public origin never became healthy for the commit",
				data: { rollback: "completed" },
			}),
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("HOBO_CI_DEPLOY_LIVE_VERIFICATION_FAILED");
		expect(outcome.message).toContain("never became healthy");
		expect(outcome.realization).toMatchObject({
			data: { rollback: "completed" },
		});
	}, 120_000);

	it("retries a finished staged promotion from the durable handover without deploying again", async () => {
		const h = await harness();
		expect((await deliver(h, "preview")).ok).toBe(true);
		const finalizer = async ({
			handover,
		}: {
			readonly handover: Readonly<Record<string, string>>;
		}) => {
			h.finalized.push(String(handover.deploymentId));
			return undefined;
		};
		const first = await deliver(h, "production", {
			finalizePromotion: finalizer,
		});
		expect(first.ok, first.ok ? "" : first.message).toBe(true);
		const retry = await deliver(h, "production", {
			finalizePromotion: finalizer,
		});
		expect(retry.ok, retry.ok ? "" : retry.message).toBe(true);
		expect(h.deployed).toHaveLength(2);
		expect(h.finalized).toEqual(["dpl_2", "dpl_2"]);
	}, 240_000);

	it("never finalizes another promotion's candidate when a newer promotion replaced the Camp's Set", async () => {
		const h = await harness();
		const other = {
			repository: "Hobo-Labs/HoBo",
			ref: "main",
			sha: "3".repeat(40),
		};
		expect((await deliver(h, "preview")).ok).toBe(true);
		const finalized: string[] = [];
		const promoted = await deliver(h, "production", {
			finalizePromotion: async ({ handover }) => {
				finalized.push(String(handover.deploymentId));
				return undefined;
			},
		});
		expect(promoted.ok, promoted.ok ? "" : promoted.message).toBe(true);
		expect(finalized).toHaveLength(1);
		expect((await deliver(h, "preview", { source: other })).ok).toBe(true);
		const promotedOther = await deliver(h, "production", {
			source: other,
			finalizePromotion: async ({ handover }) => {
				finalized.push(String(handover.deploymentId));
				return undefined;
			},
		});
		expect(
			promotedOther.ok,
			promotedOther.ok ? "" : promotedOther.message,
		).toBe(true);
		expect(finalized).toHaveLength(2);
		const retried = await deliver(h, "production", {
			finalizePromotion: async () => {
				finalized.push("must-not-run");
				return undefined;
			},
		});
		expect(retried.ok).toBe(false);
		if (retried.ok) return;
		expect(retried.code).toBe(RELAY_DELIVERY_REFUSAL.promotionRefused);
		expect(retried.message).toContain("another promotion's candidate");
		expect(finalized).toHaveLength(2);
	}, 240_000);

	it("never reports a wait-free staged promotion as successful before its finalizer ran", async () => {
		const h = await harness();
		expect((await deliver(h, "preview")).ok).toBe(true);
		const finalized: string[] = [];
		const outcome = await deliver(h, "production", {
			wait: false,
			finalizePromotion: async ({ handover }) => {
				finalized.push(String(handover.deploymentId));
				return undefined;
			},
		});
		expect(outcome.ok).toBe(false);
		expect(finalized).toEqual([]);
	}, 120_000);

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

	it("treats a wait limit of zero as a deadline already passed, not as no limit", async () => {
		const h = await harness();
		let reads = 0;
		let sleeps = 0;
		const outcome = await deliver(h, "preview", {
			realization: {
				async deploy(source) {
					h.deployed.push(source);
					return {
						ok: true,
						outputs: {
							deploymentId: "dpl_0",
							url: "https://hobo-ci-0.vercel.app",
							target: "preview",
						},
					};
				},
				async readyState() {
					reads += 1;
					return "BUILDING";
				},
			},
			limitMs: 0,
			sleep: async (ms) => {
				sleeps += 1;
				h.clock.now += ms;
			},
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe(RELAY_DELIVERY_REFUSAL.incomplete);
		expect(reads).toBe(1);
		expect(sleeps).toBe(0);
	}, 60_000);
});

async function journalTypes(
	config: Parameters<typeof openCdStore>[0],
): Promise<string[]> {
	const opened = await openCdStore(config, { now: () => Date.now() });
	try {
		const types: string[] = [];
		for await (const entry of opened.store.readAll({ tenant: "local" }))
			types.push(entry.event.type);
		return types;
	} finally {
		await opened.close();
	}
}
