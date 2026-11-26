import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	KeyValueStore,
	KeyValueStoreProvider,
} from "@alchemy.run/aws/CloudFront";
import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { NodeHttpClient } from "@effect/platform-node";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import { ResourceContext } from "alchemy/ResourceContext";
import { Stack } from "alchemy/Stack";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import { CATALOG_ROWS } from "../../../bindles/src/types.js";
import {
	awsViteApp,
	awsViteBindleMappers,
	awsViteSource,
	describeAwsVitePrimitiveSupport,
} from "../src/aws-vite.js";
import {
	type AlchemyBindleMapping,
	mapBindleToAlchemy,
} from "../src/bindle.js";
import { alchemySourceFor } from "../src/source-fence.js";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-aws-vite-"));
	const site = join(dir, "site");
	mkdirSync(site);
	const file = join(site, "index.html");
	writeFileSync(file, "version one");
	let permitted = true;
	let checks = 0;
	let checkLimit = Number.POSITIVE_INFINITY;
	const fence = {
		sourceDigest: `sha256:${"a".repeat(64)}`,
		environmentDigest: `sha256:${"b".repeat(64)}`,
		proofRef: "host:test",
		verify: () =>
			++checks <= checkLimit &&
			permitted &&
			readFileSync(file, "utf8") === "version one",
	};
	const marker = awsViteApp("site");
	const declaration = bindle("shop", (b) => ({
		web: b.web(marker).with(sessionReplay({ enabled: false })),
	}));
	const mapper = awsViteBindleMappers({ projectRoot: dir, sourceFence: fence });
	const requirements = {
		assessRequirements: () => ({ status: "supported" as const }),
	};
	const stack = {
		name: "Shop",
		stage: "test",
		resources: {},
		bindings: {},
		actions: {},
	};
	// SAFETY: the fixture supplies the Alchemy services used by resource construction.
	const run = (program: ReturnType<typeof mapBindleToAlchemy>, dev = false) =>
		Effect.runPromise(
			program.pipe(
				Effect.provideService(StackContext, stack),
				Effect.provideService(Stage, "test"),
				Effect.provideService(AlchemyContext, {
					dotAlchemy: dir,
					dev,
					adopt: false,
				}),
			) as Effect.Effect<AlchemyBindleMapping>,
		);
	return {
		dir,
		site,
		file,
		fence,
		marker,
		declaration,
		mapper,
		requirements,
		stack,
		run,
		revoke: () => {
			permitted = false;
		},
		denyAfter: (limit: number) => {
			checkLimit = limit;
		},
		close: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const official = process.env.HOBO_ALCHEMY_AWS_EMULATOR === "1" ? it : it.skip;

describe("AWS Alchemy Vite mapping", () => {
	it("maps a Bindle web app to the exact live Alchemy Vite composite and fences its build source", async () => {
		const f = fixture();
		try {
			const mapped = await f.run(
				mapBindleToAlchemy(f.declaration, f.mapper, f.requirements),
			);
			expect(mapped.primary.web?.Type).toBe("Website.Server");
			expect(Object.keys(f.stack.bindings)).toEqual(["web/Bucket"]);
			expect(mapped.resources.map((r) => [r.FQN, r.Type]).sort()).toEqual(
				[
					["web/Bucket", "AWS.S3.Bucket"],
					["web/Build", "Website.Server"],
					["web/Distribution", "AWS.CloudFront.Distribution"],
					["web/Files", "AWS.Website.AssetDeployment"],
					["web/Invalidation", "AWS.CloudFront.Invalidation"],
					["web/KvEntries", "AWS.CloudFront.KvEntries"],
					["web/KvStore", "AWS.CloudFront.KeyValueStore"],
					["web/OriginAccessControl", "AWS.CloudFront.OriginAccessControl"],
					["web/ViewerRequest", "AWS.CloudFront.Function"],
				].sort(),
			);
			const primary = mapped.primary.web;
			if (!primary) throw new Error("missing build");
			expect(alchemySourceFor(primary)?.claim).toMatchObject(
				awsViteSource("shop", "web", f.site),
			);
			const binding = alchemySourceFor(primary);
			if (!binding) throw new Error("source binding missing");
			writeFileSync(f.file, "changed");
			expect(binding.verify(binding.claim)).toBe(false);
			const support = describeAwsVitePrimitiveSupport(CATALOG_ROWS, {
				projectRoot: f.dir,
				sourceFence: f.fence,
			}).find((entry) => entry.kind === "web");
			expect(support).toMatchObject({
				status: "partial",
				bindsEntrypoint: true,
			});
			expect(support?.resourceTypes).toHaveLength(9);
		} finally {
			f.close();
		}
	});
	official(
		"reconciles the Vite composite's CloudFront key-value store with the AWS Emulator",
		async () => {
			const endpoint = new URL(process.env.HOBO_ALCHEMY_AWS_ENDPOINT ?? "");
			if (
				endpoint.protocol !== "https:" ||
				!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
			)
				throw new Error("AWS Emulator endpoint must be HTTPS loopback");
			const caPath = process.env.HOBO_ALCHEMY_AWS_CA;
			if (!caPath) throw new Error("AWS Emulator CA is required");
			const ca = await readFile(caPath);
			const f = fixture();
			try {
				const mapped = await f.run(
					mapBindleToAlchemy(f.declaration, f.mapper, f.requirements),
				);
				const resource = mapped.resources.find(
					(entry) => entry.FQN === "web/KvStore",
				);
				if (!resource || resource.Type !== KeyValueStore.Type)
					throw new Error("Vite key-value store missing");
				const credentials = {
					accessKeyId: Redacted.make("local"),
					secretAccessKey: Redacted.make("local"),
				};
				const layer = Layer.mergeAll(
					Endpoint.of(endpoint.origin),
					Credentials.fromCredentials(credentials, "us-east-1"),
					Layer.succeed(
						AWSEnvironment,
						Effect.succeed({
							accountId: "000000000000",
							region: "us-east-1",
							credentials: Effect.succeed({
								...credentials,
								region: "us-east-1",
								sessionToken: undefined,
							}),
						}),
					),
					Layer.succeed(Stack, f.stack),
					Layer.succeed(Stage, "test"),
					Layer.succeed(ResourceContext, {
						logicalId: resource.LogicalId,
						fqn: resource.FQN,
						instanceId: "12345678901234567890123456789012",
						type: KeyValueStore.Type,
					}),
					NodeHttpClient.layerUndiciOptions({
						connect: { ca, servername: "localhost" },
					}),
				);
				// SAFETY: the test supplies the services needed by this provider lifecycle operation.
				const output = await Effect.runPromise(
					Effect.gen(function* () {
						const provider = yield* Provider.Provider<KeyValueStore>(
							KeyValueStore.Type,
						);
						return yield* provider.reconcile({
							id: resource.LogicalId,
							fqn: resource.FQN,
							instanceId: "12345678901234567890123456789012",
							news: resource.Props,
							olds: undefined,
							output: undefined,
							bindings: [],
							session: noopSession,
						});
					}).pipe(
						Effect.provide(KeyValueStoreProvider()),
						Effect.provide(layer),
					) as Effect.Effect<
						KeyValueStore["Attributes"],
						Provider.ProviderError,
						never
					>,
				);
				expect(output.keyValueStoreArn).toMatch(
					/^arn:aws:cloudfront::000000000000:key-value-store\//u,
				);
			} finally {
				f.close();
			}
		},
		30_000,
	);

	it("rejects source changes after admission before the composite is registered", async () => {
		const f = fixture();
		try {
			const program = mapBindleToAlchemy(
				f.declaration,
				f.mapper,
				f.requirements,
			);
			writeFileSync(f.file, "changed");
			await expect(f.run(program)).rejects.toMatchObject({
				code: "SOURCE_FENCE_UNVERIFIED",
			});
			expect(Object.keys(f.stack.resources)).toEqual([]);
		} finally {
			f.close();
		}
	});
	it("does not publish resources or bindings if the source fence is revoked during construction", async () => {
		const f = fixture();
		try {
			f.denyAfter(2);
			const program = mapBindleToAlchemy(
				f.declaration,
				f.mapper,
				f.requirements,
			);
			await expect(f.run(program)).rejects.toMatchObject({
				code: "SOURCE_FENCE_UNVERIFIED",
			});
			expect(Object.keys(f.stack.resources)).toEqual([]);
			expect(Object.keys(f.stack.bindings)).toEqual([]);
		} finally {
			f.close();
		}
	});
	it("rejects Alchemy local mode because it does not produce the live composite", async () => {
		const f = fixture();
		try {
			await expect(
				f.run(
					mapBindleToAlchemy(f.declaration, f.mapper, f.requirements),
					true,
				),
			).rejects.toMatchObject({ code: "MAPPING_INCOMPLETE" });
			expect(Object.keys(f.stack.resources)).toEqual([]);
			expect(Object.keys(f.stack.bindings)).toEqual([]);
		} finally {
			f.close();
		}
	});
	it("rejects enabled session replay and unbound dependencies", () => {
		const f = fixture();
		try {
			const replay = bindle("shop", (b) => ({ web: b.web(f.marker) }));
			expect(() =>
				mapBindleToAlchemy(replay, f.mapper, f.requirements),
			).toThrow("session replay must be disabled");
			const graph = bindle("shop", (b) => {
				const bucket = b.bucket();
				return {
					bucket,
					web: b
						.web(f.marker)
						.with(sessionReplay({ enabled: false }))
						.dependsOn(bucket),
				};
			});
			expect(() => mapBindleToAlchemy(graph, f.mapper, f.requirements)).toThrow(
				"dependencies are not bound",
			);
		} finally {
			f.close();
		}
	});
	it("rejects a pre-existing resource identity without replacing it", async () => {
		const f = fixture();
		const existing = Object.freeze({ name: "existing" });
		try {
			Object.defineProperty(f.stack.resources, "web/Build", {
				value: existing,
				enumerable: true,
			});
			await expect(
				f.run(mapBindleToAlchemy(f.declaration, f.mapper, f.requirements)),
			).rejects.toMatchObject({ code: "BINDLE_IDENTITY_COLLISION" });
			expect(
				Object.getOwnPropertyDescriptor(f.stack.resources, "web/Build")?.value,
			).toBe(existing);
			expect(Object.keys(f.stack.resources)).toEqual(["web/Build"]);
			expect(Object.keys(f.stack.bindings)).toEqual([]);
		} finally {
			f.close();
		}
	});
	it("rejects generated resource names that exceed Alchemy state identity bounds", () => {
		const f = fixture();
		try {
			const name = "a".repeat(195);
			const declaration = bindle("shop", (b) => ({
				[name]: b.web(f.marker).with(sessionReplay({ enabled: false })),
			}));
			expect(() =>
				mapBindleToAlchemy(declaration, f.mapper, f.requirements),
			).toThrow("state identities");
			expect(Object.keys(f.stack.resources)).toEqual([]);
		} finally {
			f.close();
		}
	});
	it("rejects a root that escapes through a symlink", () => {
		const f = fixture();
		const outside = mkdtempSync(join(tmpdir(), "hobo-aws-vite-outside-"));
		try {
			symlinkSync(outside, join(f.dir, "escape"));
			const declaration = bindle("shop", (b) => ({
				web: b
					.web(awsViteApp("escape"))
					.with(sessionReplay({ enabled: false })),
			}));
			expect(() =>
				mapBindleToAlchemy(declaration, f.mapper, f.requirements),
			).toThrow("inside the project root");
		} finally {
			f.close();
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
