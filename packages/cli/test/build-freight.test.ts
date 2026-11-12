import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalManifestHash, parseManifest } from "@hobo/bindles";
import { ArtifactKind } from "@hobo/cd";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	createRegistryFromProviders,
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
import {
	DECLARATION_MEDIA_TYPE,
	FREIGHT_FILE,
	type YardDelivery,
} from "../src/cloud/yard-client.js";
import { runCodegen } from "../src/codegen/run-codegen.js";
import {
	createBuildCommand,
	createFixtureSession,
	createHoboCli,
	createUpCommand,
	writeBuildFixtureProject,
	type YardRuntime,
} from "../src/index.js";
import { isJsonArray, isJsonObject, type JsonValue } from "../src/json.js";
import {
	createFakeDelivery,
	type FakeDelivery,
	fakeFreightManifestCodec,
} from "./cd-delivery-fakes.js";

// Plan 0024 WP15: `hobo build` writes `.hobo/freight.json` with the injected
// `writeFreightManifest` and stores the bytes in the configured artifact
// store, so `hobo up` records the build as LOCAL_BUILD Freight.

const DECLARATION = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		sessions: { type: "data.v1", port: "kv" },
	},
};

let stores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of stores) store.close();
	stores = [];
});

type BuildHarness = Readonly<{
	fake: FakeDelivery;
	delivery: YardDelivery;
	runtime: YardRuntime;
}>;

function harness(): BuildHarness {
	const store = createRuntimeLocalEventStore({
		dataDir: path.join(
			tmpdir(),
			`hobo-cli-build-cd-${Math.random().toString(36).slice(2)}`,
		),
		clock: createManualClock(),
	});
	stores.push(store);
	const iac: IacProvider = {
		id: "mock",
		async preview() {
			return { summary: "preview", changes: 1 };
		},
		async apply(program) {
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy() {},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
	const base = {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac }),
		broker: createInProcessCredentialBroker(),
		registry: createRegistryFromProviders([createCloudflareProvider()]),
	};
	const fake = createFakeDelivery({
		store,
		registry: base.registry,
		orchestrator: base,
		tenant: "hobo-dev",
	});
	const delivery: YardDelivery = {
		cd: fake.cd,
		freightManifest: fakeFreightManifestCodec,
		telemetry: fake.telemetry,
		now: () => 1_700_000_000_000,
	};
	return { fake, delivery, runtime: { ...base, delivery } };
}

function valueOf(
	value: JsonValue | undefined,
	key: string,
): JsonValue | undefined {
	return isJsonObject(value) ? value[key] : undefined;
}

/** A build fixture whose hobo.bindle.json is also a hobo.manifest/v1 declaration. */
async function withDeclaredBuildProject(
	callback: (projectRoot: string) => Promise<void>,
): Promise<void> {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "hobo-build-freight-"));
	try {
		await writeBuildFixtureProject(projectRoot);
		const bindlePath = path.join(projectRoot, "hobo.bindle.json");
		const fixture = JSON.parse(await readFile(bindlePath, "utf8"));
		await writeFile(
			bindlePath,
			`${JSON.stringify({ ...fixture, ...DECLARATION }, null, 2)}\n`,
		);
		await runCodegen({ projectRoot, check: false });
		await callback(projectRoot);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
}

type BuildEnvelope = {
	ok: boolean;
	code: string;
	data: {
		artifacts: Array<{ service: string; digest: string; path: string }>;
		freight?: {
			path: string;
			declarationHash: string;
			artifacts: Array<{ name: string; digest: string; kind: string }>;
			skipped?: string;
		};
	};
};

function buildCli(delivery?: YardDelivery) {
	return createHoboCli({
		commands: {
			build: createBuildCommand({
				requireRealComponentize: false,
				delivery,
			}),
		},
	});
}

describe("hobo build emits Freight", () => {
	it("writes .hobo/freight.json via writeFreightManifest and stores every artifact's bytes", async () => {
		await withDeclaredBuildProject(async (projectRoot) => {
			const { fake, delivery } = harness();
			const result = await buildCli(delivery).run(["build", "--json"], {
				cwd: projectRoot,
			});
			expect(result.exitCode).toBe(0);
			// SAFETY: one JSON envelope on stdout.
			const envelope = JSON.parse(result.stdout) as BuildEnvelope;
			expect(envelope.ok).toBe(true);
			const freight = envelope.data.freight;
			expect(freight?.path).toBe(FREIGHT_FILE);

			const written = await readFile(path.join(projectRoot, FREIGHT_FILE));
			const parsed = fakeFreightManifestCodec.parse(written);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			// Byte-identical to what the injected writer emits for that record.
			expect(Buffer.from(fakeFreightManifestCodec.write(parsed.value))).toEqual(
				Buffer.from(written),
			);
			const declaration = canonicalManifestHash(
				parseManifest(
					JSON.parse(
						await readFile(path.join(projectRoot, "hobo.bindle.json"), "utf8"),
					),
				),
			);
			expect(parsed.value.declarationHash).toBe(declaration);
			expect(parsed.value.bindle).toBe(
				path
					.basename(projectRoot)
					.toLowerCase()
					.replace(/[^a-z0-9-]/g, "-"),
			);
			expect(parsed.value.artifacts).toHaveLength(
				envelope.data.artifacts.length,
			);
			for (const artifact of envelope.data.artifacts) {
				const ref = parsed.value.artifacts.find(
					(a) => a.name === artifact.service,
				);
				expect(ref?.digest).toBe(artifact.digest);
				expect(ref?.kind).not.toBe(ArtifactKind.UNSPECIFIED);
				const stored = fake.blobs.get(artifact.digest);
				expect(stored).toBeDefined();
				expect(Buffer.from(stored ?? new Uint8Array())).toEqual(
					await readFile(path.join(projectRoot, artifact.path)),
				);
			}
			const declarationPut = fake.calls.find(
				(c) =>
					c.port === "artifacts.put" &&
					valueOf(c.input, "mediaType") === DECLARATION_MEDIA_TYPE,
			);
			expect(declarationPut).toBeDefined();
			expect(fake.blobs.has(declaration)).toBe(true);
		});
	});

	it("hobo up records the built artifacts as the LOCAL_BUILD Freight", async () => {
		await withDeclaredBuildProject(async (projectRoot) => {
			const { fake, delivery, runtime } = harness();
			await buildCli(delivery).run(["build", "--json"], { cwd: projectRoot });
			const up = createHoboCli({
				commands: {
					up: createUpCommand({
						runtime,
						session: createFixtureSession({ subject: "dev" }),
					}),
				},
			});
			const result = await up.run(["up", "--json"], { cwd: projectRoot });
			// SAFETY: one JSON envelope on stdout.
			const envelope = JSON.parse(result.stdout) as { status: string };
			expect(envelope.status).toBe("deployed");
			const recorded = fake.calls.find((c) => c.port === "freight.record");
			const built = fakeFreightManifestCodec.parse(
				await readFile(path.join(projectRoot, FREIGHT_FILE)),
			);
			if (!built.ok) throw new Error("freight.json unreadable");
			const recordedArtifacts = valueOf(
				valueOf(recorded?.input, "manifest"),
				"artifacts",
			);
			expect(
				isJsonArray(recordedArtifacts)
					? recordedArtifacts.map((a) => valueOf(a, "digest"))
					: [],
			).toEqual(built.value.artifacts.map((a) => a.digest));
		});
	});

	it("is unchanged without delivery wiring: no freight.json is written", async () => {
		await withDeclaredBuildProject(async (projectRoot) => {
			const result = await buildCli().run(["build", "--json"], {
				cwd: projectRoot,
			});
			expect(result.exitCode).toBe(0);
			// SAFETY: one JSON envelope on stdout.
			const envelope = JSON.parse(result.stdout) as BuildEnvelope;
			expect(envelope.data.freight).toBeUndefined();
			await expect(
				readFile(path.join(projectRoot, FREIGHT_FILE)),
			).rejects.toThrow();
		});
	});

	it("skips Freight visibly when the project has no hobo.manifest/v1 declaration", async () => {
		const projectRoot = await mkdtemp(
			path.join(tmpdir(), "hobo-build-freight-"),
		);
		try {
			await writeBuildFixtureProject(projectRoot);
			await runCodegen({ projectRoot, check: false });
			const { delivery } = harness();
			const result = await buildCli(delivery).run(["build", "--json"], {
				cwd: projectRoot,
			});
			expect(result.exitCode).toBe(0);
			// SAFETY: one JSON envelope on stdout.
			const envelope = JSON.parse(result.stdout) as BuildEnvelope;
			expect(envelope.data.freight?.skipped).toContain("hobo.manifest/v1");
			await expect(
				readFile(path.join(projectRoot, FREIGHT_FILE)),
			).rejects.toThrow();
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	it("refuses with HOBO_BUILD_FREIGHT_DIGEST_MISMATCH when the store addresses bytes differently", async () => {
		await withDeclaredBuildProject(async (projectRoot) => {
			const { delivery } = harness();
			const lying: YardDelivery = {
				...delivery,
				cd: {
					...delivery.cd,
					artifacts: {
						...delivery.cd.artifacts,
						async put(bytes, meta, ctx) {
							const ref = await delivery.cd.artifacts.put(bytes, meta, ctx);
							return { ...ref, digest: `sha256:${"f".repeat(64)}` };
						},
					},
				},
			};
			const result = await buildCli(lying).run(["build", "--json"], {
				cwd: projectRoot,
			});
			expect(result.exitCode).toBe(1);
			// SAFETY: one JSON envelope on stdout.
			const envelope = JSON.parse(result.stdout) as BuildEnvelope & {
				remediation: string[];
			};
			expect(envelope.code).toBe("HOBO_BUILD_FREIGHT_DIGEST_MISMATCH");
			expect(envelope.remediation.length).toBeGreaterThan(0);
			await expect(
				readFile(path.join(projectRoot, FREIGHT_FILE)),
			).rejects.toThrow();
		});
	});
});
