import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromJson, type JsonValue as ProtoJson } from "@bufbuild/protobuf";
import { CD_EVENTS, FreightOrigin, SetOrigin, SetRecordSchema } from "@hobo/cd";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	createRegistryFromProviders,
	type IacProgram,
	type IacProvider,
} from "@hobo/cloud";
import { createInMemoryActorHost } from "@hobo/data";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { DELIVERY_REFUSAL, FREIGHT_FILE } from "../src/cloud/yard-client.js";
import {
	createDownCommand,
	createFixtureSession,
	createHoboCli,
	createUpCommand,
	persistSession,
	type YardRuntime,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";
import {
	createFakeDelivery,
	type FakeDelivery,
	type FakeKnobs,
	fakeFreightManifestCodec,
} from "./cd-delivery-fakes.js";

// Plan 0024 WP15 (D13): `hobo up` declares desired state. It records
// LOCAL_BUILD Freight, promotes it into the deployment Camp, and an
// in-process conductor converges it with `reconcileOnce`; `down` is a
// teardown Delta. The UpResult/DownResult contracts are unchanged.

const HELLO_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions", "assets"],
		},
		sessions: { type: "data.v1", port: "kv" },
		assets: { type: "data.v1", port: "objectStore" },
	},
};

const HELLO_BINDLE_V2 = {
	...HELLO_BINDLE,
	resources: {
		...HELLO_BINDLE.resources,
		service: {
			...HELLO_BINDLE.resources.service,
			image: "oci://registry.example.com/hello-bindle@sha256:def456",
		},
	},
};

let stores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of stores) store.close();
	stores = [];
});

function inMemoryIac(): IacProvider {
	return {
		id: "mock-local-container",
		async preview(program: IacProgram) {
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program: IacProgram) {
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy() {
			/* local backend no-op */
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
}

type Harness = {
	runtime: YardRuntime;
	store: RuntimeLocalEventStore;
	fake: FakeDelivery;
};

function harness(
	knobs: Partial<FakeKnobs> = {},
	overrides: Partial<NonNullable<YardRuntime["delivery"]>> = {},
): Harness {
	const store = createRuntimeLocalEventStore({
		dataDir: path.join(
			tmpdir(),
			`hobo-cli-cd-${Math.random().toString(36).slice(2)}`,
		),
		clock: createManualClock(),
	});
	stores.push(store);
	const base = {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac: inMemoryIac() }),
		broker: createInProcessCredentialBroker(),
		registry: createRegistryFromProviders([createCloudflareProvider()]),
	};
	const fake = createFakeDelivery({
		store,
		registry: base.registry,
		orchestrator: base,
		tenant: "hobo-dev",
		knobs,
	});
	let tick = Date.parse("2026-11-12T00:00:00.000Z");
	return {
		store,
		fake,
		runtime: {
			...base,
			delivery: {
				cd: fake.cd,
				freightManifest: fakeFreightManifestCodec,
				telemetry: fake.telemetry,
				now: () => {
					tick += 1_000;
					return tick;
				},
				...overrides,
			},
		},
	};
}

async function withProject(
	manifest: JsonObject,
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-cli-cd-"));
	await writeBindle(dir, manifest);
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeBindle(dir: string, manifest: JsonObject): Promise<void> {
	await writeFile(
		path.join(dir, "hobo.bindle.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

function cliFor(runtime: YardRuntime) {
	const session = createFixtureSession({ subject: "dev" });
	return createHoboCli({
		commands: {
			up: createUpCommand({ runtime, session }),
			down: createDownCommand({ runtime, session }),
		},
	});
}

type Envelope = {
	ok: boolean;
	status: string;
	code: string;
	remediation?: string[];
	data: {
		deploymentId: string;
		provisioned: string[];
		destroyed: string[];
		identity: string;
		progress: Array<{ type: string; resourceId?: string; detail: string }>;
		delivery?: {
			campId: string;
			freightId: string;
			alias: string;
			setId: string;
			mode: string;
			claimHint?: string;
		};
	};
};

function envelopeOf(stdout: string): Envelope {
	// SAFETY: the CLI writes one JSON envelope on stdout; parsed at the test boundary.
	return JSON.parse(stdout) as Envelope;
}

/** Every event in journal (global position) order, as `type`. */
async function journal(store: RuntimeLocalEventStore): Promise<string[]> {
	const types: string[] = [];
	for await (const event of store.readAll()) types.push(event.event.type);
	return types;
}

async function campSets(store: RuntimeLocalEventStore, campId: string) {
	const sets = [];
	for await (const event of store.read(`cd-camp-${campId}`))
		if (event.type === CD_EVENTS.SetCreated)
			// SAFETY: set.Created bodies are SetRecord protobuf JSON.
			sets.push(fromJson(SetRecordSchema, event.data as ProtoJson));
	return sets;
}

function count(types: readonly string[], type: string): number {
	return types.filter((t) => t === type).length;
}

describe("hobo up declares desired state (D13)", () => {
	it("records LOCAL_BUILD Freight, promotes it into the deployment Camp and converges it in-process", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, fake } = harness();
			const result = await cliFor(runtime).run(["up", "--json"], { cwd });

			expect(result.exitCode).toBe(0);
			const envelope = envelopeOf(result.stdout);
			expect(envelope.status).toBe("deployed");
			expect(envelope.data.provisioned).toEqual([
				"assets",
				"service",
				"sessions",
			]);
			expect(
				envelope.data.progress.filter((p) => p.type === "resource.Provisioned"),
			).toHaveLength(3);
			const campId = envelope.data.delivery?.campId ?? "";
			expect(campId).toBe(envelope.data.deploymentId);

			const record = fake.calls.find((c) => c.port === "freight.record");
			expect(record?.input).toMatchObject({
				origin: FreightOrigin.LOCAL_BUILD,
			});
			const promote = fake.calls.find((c) => c.port === "promotions.promote");
			expect(promote?.input).toMatchObject({
				targets: [campId],
				intent: "up",
				freightId: envelope.data.delivery?.freightId,
			});
			expect(fake.calls.some((c) => c.port === "reconcileOnce")).toBe(true);
		});
	});

	it("journals freight.Recorded -> set.Created -> deployment.Converged in that order", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store } = harness();
			await cliFor(runtime).run(["up", "--json"], { cwd });
			const types = await journal(store);
			const recorded = types.indexOf(CD_EVENTS.FreightRecorded);
			const created = types.indexOf(CD_EVENTS.SetCreated);
			const converged = types.indexOf(CD_EVENTS.Converged);
			expect(recorded).toBeGreaterThanOrEqual(0);
			expect(created).toBeGreaterThan(recorded);
			expect(converged).toBeGreaterThan(created);
		});
	});

	it("re-running up on an unchanged estate creates no duplicate Freight, Set or promotion", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store } = harness();
			const cli = cliFor(runtime);
			const first = envelopeOf(
				(await cli.run(["up", "--json"], { cwd })).stdout,
			);
			const before = await journal(store);
			const second = envelopeOf(
				(await cli.run(["up", "--json"], { cwd })).stdout,
			);
			const after = await journal(store);

			expect(second.status).toBe("deployed");
			expect(second.data.delivery?.freightId).toBe(
				first.data.delivery?.freightId,
			);
			expect(second.data.delivery?.setId).toBe(first.data.delivery?.setId);
			expect(second.data.provisioned).toEqual(first.data.provisioned);
			for (const type of [
				CD_EVENTS.FreightRecorded,
				CD_EVENTS.SetCreated,
				CD_EVENTS.EnvPromoteRequested,
				CD_EVENTS.Converged,
			])
				expect(count(after, type)).toBe(count(before, type));
			expect(
				second.data.progress.filter((p) => p.type === "resource.Provisioned"),
			).toHaveLength(0);
		});
	});

	it("streams reconcile progress while the conductor loop runs", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, fake } = harness();
			const result = await cliFor(runtime).run(["up"], {
				cwd,
				// Interleave progress lines with the port calls they report on.
				onProgress: (line) =>
					fake.calls.push({ port: "progress", input: line }),
			});
			expect(result.exitCode).toBe(0);
			const at = (
				predicate: (c: { port: string; input: unknown }) => boolean,
			) => fake.calls.findIndex(predicate);
			const line = (prefix: string) =>
				at((c) => c.port === "progress" && String(c.input).startsWith(prefix));
			const firstPromote = at((c) => c.port === "promotions.promote");
			const firstReconcile = at((c) => c.port === "reconcileOnce");
			// Each line is emitted as it happens, not after `up` returns.
			expect(line("freight.Recorded")).toBeGreaterThanOrEqual(0);
			expect(line("freight.Recorded")).toBeLessThan(firstPromote);
			expect(line("set.Created")).toBeGreaterThan(firstPromote);
			expect(line("set.Created")).toBeLessThan(firstReconcile);
			expect(line("deployment.Converged")).toBeGreaterThan(firstReconcile);
		});
	});

	it("emits delivery metrics through the TelemetrySink", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, fake } = harness();
			await cliFor(runtime).run(["up", "--json"], { cwd });
			const outcome = fake.metrics.find(
				(m) => m.name === "hobo.cli.delivery.outcome",
			);
			expect(outcome?.attributes).toMatchObject({
				verb: "up",
				outcome: "deployed",
			});
			expect(
				fake.metrics.some((m) => m.name === "hobo.cli.delivery.passes"),
			).toBe(true);
			expect(
				fake.metrics.some((m) => m.name === "hobo.cli.delivery.duration"),
			).toBe(true);
		});
	});

	it("maps a gate refusal to the unchanged rejected UpResult with a typed code and remediation", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime } = harness({ gate: "deny" });
			const result = await cliFor(runtime).run(["up", "--json"], { cwd });
			expect(result.exitCode).toBe(1);
			const envelope = envelopeOf(result.stdout);
			expect(envelope.status).toBe("rejected");
			expect(envelope.code).toBe(DELIVERY_REFUSAL.promotionRefused);
			expect(envelope.remediation?.join("\n")).toContain(
				"request the promote grant",
			);
		});
	});

	it("holds instead of applying when the gate requires approval", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime } = harness({ gate: "require-approval" });
			const result = await cliFor(runtime).run(["up", "--json"], { cwd });
			expect(result.exitCode).toBe(1);
			const envelope = envelopeOf(result.stdout);
			expect(envelope.code).toBe(DELIVERY_REFUSAL.promotionHeld);
			expect(envelope.remediation?.join("\n")).toContain("hobo deploy");
		});
	});

	it("reports needs-human with the reconciler's reasons when convergence is blocked", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime } = harness({ blockResource: "sessions" });
			const result = await cliFor(runtime).run(["up", "--json"], { cwd });
			expect(result.exitCode).toBe(1);
			const envelope = envelopeOf(result.stdout);
			expect(envelope.status).toBe("needs-human");
			expect(envelope.code).toBe("HOBO_UP_INCOMPLETE");
			expect(
				envelope.data.progress.some(
					(p) =>
						p.type === CD_EVENTS.ReconcileBlocked &&
						p.detail.includes("apply of sessions failed"),
				),
			).toBe(true);
		});
	});
});

describe("hobo up stays bounded and fail-closed", () => {
	it("reports waiting after the bounded conductor passes when convergence is still in progress", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, fake } = harness({ stall: true }, { maxPasses: 3 });
			const result = await cliFor(runtime).run(["up", "--json"], { cwd });
			expect(result.exitCode).toBe(1);
			const envelope = envelopeOf(result.stdout);
			expect(envelope.status).toBe("waiting");
			expect(envelope.code).toBe("HOBO_UP_INCOMPLETE");
			expect(fake.calls.filter((c) => c.port === "reconcileOnce")).toHaveLength(
				3,
			);
		});
	});

	it("keeps deploying when the TelemetrySink fails, and says so in progress", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime } = harness(
				{},
				{
					telemetry: {
						async spans() {},
						async metrics() {
							throw new Error("collector offline");
						},
					},
				},
			);
			const envelope = envelopeOf(
				(await cliFor(runtime).run(["up", "--json"], { cwd })).stdout,
			);
			expect(envelope.status).toBe("deployed");
			expect(
				envelope.data.progress.some(
					(p) =>
						p.type === "telemetry.Unavailable" &&
						p.detail.includes("collector offline"),
				),
			).toBe(true);
		});
	});

	it("refuses --to and --rollback without CD delivery instead of ignoring them", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime } = harness();
			const { delivery: _delivery, ...legacy } = runtime;
			for (const argv of [
				["up", "--rollback", "--json"],
				["up", "--to", "some-alias", "--json"],
			]) {
				const result = await cliFor(legacy).run(argv, { cwd });
				expect(result.exitCode).toBe(1);
				const envelope = envelopeOf(result.stdout);
				expect(envelope.code).toBe(DELIVERY_REFUSAL.deliveryUnavailable);
				expect(envelope.remediation?.length).toBeGreaterThan(0);
			}
		});
	});
});

describe("hobo up --to and --rollback select desired state", () => {
	it("--to <alias> re-promotes earlier Freight into the Camp", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store } = harness();
			const cli = cliFor(runtime);
			const v1 = envelopeOf((await cli.run(["up", "--json"], { cwd })).stdout);
			await writeBindle(cwd, HELLO_BINDLE_V2);
			const v2 = envelopeOf((await cli.run(["up", "--json"], { cwd })).stdout);
			expect(v2.data.delivery?.freightId).not.toBe(v1.data.delivery?.freightId);

			const alias = v1.data.delivery?.alias ?? "";
			const pinned = envelopeOf(
				(await cli.run(["up", "--to", alias, "--json"], { cwd })).stdout,
			);
			expect(pinned.status).toBe("deployed");
			expect(pinned.data.delivery?.freightId).toBe(v1.data.delivery?.freightId);
			expect(pinned.data.delivery?.mode).toBe("to");
			const sets = await campSets(store, v1.data.delivery?.campId ?? "");
			expect(sets.at(-1)?.freightId).toBe(v1.data.delivery?.freightId);
		});
	});

	it("--to <freight id> works by id as well as alias", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime } = harness();
			const cli = cliFor(runtime);
			const v1 = envelopeOf((await cli.run(["up", "--json"], { cwd })).stdout);
			await writeBindle(cwd, HELLO_BINDLE_V2);
			await cli.run(["up", "--json"], { cwd });
			const pinned = envelopeOf(
				(
					await cli.run(
						["up", "--to", v1.data.delivery?.freightId ?? "", "--json"],
						{ cwd },
					)
				).stdout,
			);
			expect(pinned.data.delivery?.freightId).toBe(v1.data.delivery?.freightId);
		});
	});

	it("--to an unknown revision is refused with HOBO_FREIGHT_UNKNOWN and a next step", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store } = harness();
			const result = await cliFor(runtime).run(
				["up", "--to", "no-such-alias", "--json"],
				{ cwd },
			);
			expect(result.exitCode).toBe(1);
			const envelope = envelopeOf(result.stdout);
			expect(envelope.code).toBe(DELIVERY_REFUSAL.freightUnknown);
			expect(envelope.remediation?.join("\n")).toContain(
				"hobo deploy freight list",
			);
			expect(count(await journal(store), CD_EVENTS.SetCreated)).toBe(0);
		});
	});

	it("--rollback re-applies the predecessor Set through the rollback path", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store, fake } = harness();
			const cli = cliFor(runtime);
			const v1 = envelopeOf((await cli.run(["up", "--json"], { cwd })).stdout);
			await writeBindle(cwd, HELLO_BINDLE_V2);
			await cli.run(["up", "--json"], { cwd });
			const rolled = envelopeOf(
				(await cli.run(["up", "--rollback", "--json"], { cwd })).stdout,
			);
			expect(rolled.status).toBe("deployed");
			expect(rolled.data.delivery?.mode).toBe("rollback");
			expect(rolled.data.delivery?.freightId).toBe(v1.data.delivery?.freightId);
			expect(fake.calls.some((c) => c.port === "promotions.rollback")).toBe(
				true,
			);
			const sets = await campSets(store, v1.data.delivery?.campId ?? "");
			expect(sets.at(-1)?.origin).toBe(SetOrigin.ROLLBACK);
		});
	});

	it("--rollback with nothing to roll back to is refused with HOBO_ROLLBACK_UNAVAILABLE", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime } = harness();
			const result = await cliFor(runtime).run(["up", "--rollback", "--json"], {
				cwd,
			});
			expect(result.exitCode).toBe(1);
			const envelope = envelopeOf(result.stdout);
			expect(envelope.code).toBe(DELIVERY_REFUSAL.rollbackUnavailable);
			expect(envelope.remediation?.length).toBeGreaterThan(0);
		});
	});
});

describe("hobo down is a teardown Delta", () => {
	it("applies a TEARDOWN Set, converges it and reports the unchanged DownResult", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store, fake } = harness();
			const cli = cliFor(runtime);
			const up = envelopeOf((await cli.run(["up", "--json"], { cwd })).stdout);
			const result = await cli.run(["down", "--json"], { cwd });
			expect(result.exitCode).toBe(0);
			const envelope = envelopeOf(result.stdout);
			expect(envelope.status).toBe("destroyed");
			expect([...envelope.data.destroyed].sort()).toEqual([
				"assets",
				"service",
				"sessions",
			]);
			// Dependents tear down before their dependencies.
			expect(envelope.data.destroyed.indexOf("service")).toBeLessThan(
				envelope.data.destroyed.indexOf("sessions"),
			);
			const promote = fake.calls
				.filter((c) => c.port === "promotions.promote")
				.at(-1);
			expect(promote?.input).toMatchObject({ intent: "down" });
			const sets = await campSets(store, up.data.delivery?.campId ?? "");
			expect(sets.at(-1)?.origin).toBe(SetOrigin.TEARDOWN);
		});
	});

	it("down on an estate already torn down is idempotent", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store } = harness();
			const cli = cliFor(runtime);
			await cli.run(["up", "--json"], { cwd });
			await cli.run(["down", "--json"], { cwd });
			const before = count(await journal(store), CD_EVENTS.SetCreated);
			const again = envelopeOf(
				(await cli.run(["down", "--json"], { cwd })).stdout,
			);
			expect(again.status).toBe("destroyed");
			expect(again.data.destroyed).toEqual([]);
			expect(count(await journal(store), CD_EVENTS.SetCreated)).toBe(before);
		});
	});

	it("down before any up destroys nothing and writes nothing", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store } = harness();
			const result = envelopeOf(
				(await cliFor(runtime).run(["down", "--json"], { cwd })).stdout,
			);
			expect(result.status).toBe("destroyed");
			expect(result.data.destroyed).toEqual([]);
			expect(count(await journal(store), CD_EVENTS.SetCreated)).toBe(0);
		});
	});

	it("up after down re-deploys the same Freight with a new Set", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store } = harness();
			const cli = cliFor(runtime);
			const first = envelopeOf(
				(await cli.run(["up", "--json"], { cwd })).stdout,
			);
			await cli.run(["down", "--json"], { cwd });
			const again = envelopeOf(
				(await cli.run(["up", "--json"], { cwd })).stdout,
			);
			expect(again.status).toBe("deployed");
			expect(again.data.delivery?.freightId).toBe(
				first.data.delivery?.freightId,
			);
			expect(again.data.provisioned).toEqual(["assets", "service", "sessions"]);
			const sets = await campSets(store, first.data.delivery?.campId ?? "");
			expect(sets.map((s) => s.origin)).toEqual([
				SetOrigin.UP,
				SetOrigin.TEARDOWN,
				SetOrigin.UP,
			]);
		});
	});
});

describe("hobo up --anonymous deploy-and-claim", () => {
	it("deploys as the anonymous principal, then a signed-in up claims the same estate without duplicates", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, store, fake } = harness();
			const account = createFixtureSession({ subject: "ada" });
			await persistSession(cwd, account);
			const cli = createHoboCli({
				commands: {
					up: createUpCommand({ runtime }),
					down: createDownCommand({ runtime }),
				},
			});

			const anonymous = envelopeOf(
				(await cli.run(["up", "--anonymous", "--json"], { cwd })).stdout,
			);
			expect(anonymous.status).toBe("deployed");
			expect(anonymous.data.identity).toBe("user:anonymous");
			expect(anonymous.data.delivery?.mode).toBe("anonymous");
			expect(anonymous.data.delivery?.claimHint).toContain("hobo claim");
			const recorded = fake.calls.find((c) => c.port === "freight.record");
			expect(recorded?.input).toMatchObject({
				manifest: { labels: { "hobo.dev/anonymous": "true" } },
			});

			const before = await journal(store);
			const claimed = envelopeOf(
				(await cli.run(["up", "--json"], { cwd })).stdout,
			);
			expect(claimed.status).toBe("deployed");
			expect(claimed.data.identity).toBe("user:ada");
			expect(claimed.data.delivery?.freightId).toBe(
				anonymous.data.delivery?.freightId,
			);
			const after = await journal(store);
			expect(count(after, CD_EVENTS.SetCreated)).toBe(
				count(before, CD_EVENTS.SetCreated),
			);
		});
	});

	it("--temporary is the same as --anonymous", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime } = harness();
			const envelope = envelopeOf(
				(await cliFor(runtime).run(["up", "--temporary", "--json"], { cwd }))
					.stdout,
			);
			expect(envelope.data.delivery?.mode).toBe("anonymous");
			expect(envelope.data.identity).toBe("user:anonymous");
		});
	});
});

describe("hobo up consumes the Freight that hobo build wrote", () => {
	async function writeFreightFile(
		cwd: string,
		fake: FakeDelivery,
		bindleHash: string,
	): Promise<string> {
		const bytes = new TextEncoder().encode("component bytes");
		const ref = await fake.cd.artifacts.put(
			bytes,
			{ name: "hello-bindle", kind: 1, mediaType: "application/wasm" },
			{
				tenant: "hobo-dev",
				principal: { kind: "user", id: "user:dev" },
				now: () => 0,
			},
		);
		const manifest = {
			schemaVersion: "hobo.freight-manifest/v1",
			bindle: path
				.basename(cwd)
				.toLowerCase()
				.replace(/[^a-z0-9-]/g, "-"),
			declarationHash: bindleHash,
			artifacts: [
				{
					name: ref.name,
					kind: "ARTIFACT_KIND_WASM_COMPONENT",
					digest: ref.digest,
					coordinate: ref.coordinate,
					mediaType: ref.mediaType,
					ecosystem: "store",
				},
			],
		};
		await mkdir(path.join(cwd, ".hobo"), { recursive: true });
		await writeFile(path.join(cwd, FREIGHT_FILE), JSON.stringify(manifest));
		return ref.digest;
	}

	it("records the build's artifacts as the Freight", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, fake } = harness();
			const { canonicalManifestHash, parseManifest } = await import(
				"@hobo/bindles"
			);
			const digest = await writeFreightFile(
				cwd,
				fake,
				canonicalManifestHash(parseManifest(HELLO_BINDLE)),
			);
			const envelope = envelopeOf(
				(await cliFor(runtime).run(["up", "--json"], { cwd })).stdout,
			);
			expect(envelope.status).toBe("deployed");
			const recorded = fake.calls.find((c) => c.port === "freight.record");
			expect(recorded?.input).toMatchObject({
				manifest: { artifacts: [{ digest }] },
			});
		});
	});

	it("refuses a stale freight.json with HOBO_FREIGHT_STALE (declaration changed after build)", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, fake, store } = harness();
			await writeFreightFile(cwd, fake, `sha256:${"0".repeat(64)}`);
			const result = await cliFor(runtime).run(["up", "--json"], { cwd });
			expect(result.exitCode).toBe(1);
			const envelope = envelopeOf(result.stdout);
			expect(envelope.code).toBe(DELIVERY_REFUSAL.freightStale);
			expect(envelope.remediation?.join("\n")).toContain("hobo build");
			expect(count(await journal(store), CD_EVENTS.FreightRecorded)).toBe(0);
		});
	});

	it("refuses Freight whose artifact bytes are not in the configured store", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, fake } = harness();
			const { canonicalManifestHash, parseManifest } = await import(
				"@hobo/bindles"
			);
			const digest = await writeFreightFile(
				cwd,
				fake,
				canonicalManifestHash(parseManifest(HELLO_BINDLE)),
			);
			fake.blobs.delete(digest);
			const envelope = envelopeOf(
				(await cliFor(runtime).run(["up", "--json"], { cwd })).stdout,
			);
			expect(envelope.code).toBe(DELIVERY_REFUSAL.artifactMissing);
		});
	});

	it("refuses an unparseable freight.json with HOBO_FREIGHT_INVALID", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime } = harness();
			await mkdir(path.join(cwd, ".hobo"), { recursive: true });
			await writeFile(path.join(cwd, FREIGHT_FILE), "{not json");
			const envelope = envelopeOf(
				(await cliFor(runtime).run(["up", "--json"], { cwd })).stdout,
			);
			expect(envelope.code).toBe(DELIVERY_REFUSAL.freightInvalid);
		});
	});
});

describe("hobo up stores the declaration the Freight names", () => {
	it("puts the canonical Bindle bytes in the artifact store under declaration_hash", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const { runtime, fake } = harness();
			await cliFor(runtime).run(["up", "--json"], { cwd });
			const { canonicalManifestHash, parseManifest, serializeManifest } =
				await import("@hobo/bindles");
			const bindle = parseManifest(HELLO_BINDLE);
			const stored = fake.blobs.get(canonicalManifestHash(bindle));
			expect(stored && new TextDecoder().decode(stored)).toBe(
				serializeManifest(bindle),
			);
		});
	});
});
