import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import { PoolHost } from "@alchemy.run/rivet/Host";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { setup } from "rivetkit";
import { describe, expect, it, vi } from "vitest";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	hashAlchemyPriorState,
} from "../src/index.js";
import { createRivetPrimitiveMappers } from "../src/rivet.js";
import { createRivetMultiPoolPrimitiveMappers } from "../src/rivet-multi.js";
import { createRivetHttpActor } from "../src/rivet-runtime.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

function fixture(directory: string) {
	const main = join(directory, "app.js");
	const dependency = join(directory, "dependency.js");
	writeFileSync(main, 'import "./dependency.js"; export default {};');
	writeFileSync(dependency, "export const value = 1;");
	// The verifier models a trusted host's fenced closure. Production hosts must
	// hold the immutable sandbox/artifact fence; hashing at check time alone does not.
	const digest = () =>
		`sha256:${createHash("sha256")
			.update(
				JSON.stringify([
					readFileSync(main, "utf8"),
					readFileSync(dependency, "utf8"),
				]),
			)
			.digest("hex")}`;
	const sourceDigest = digest();
	const entrypoint = () => () => new Response("ok");
	const binding = createRivetHttpActor({
		actorName: "web",
		entrypoint,
		authorize: () => true,
	});
	const registry = setup({ use: { web: binding.actor }, noWelcome: true });
	let active = true;
	const source = {
		main,
		resourceName: "web",
		kind: "web" as const,
		actorName: "web",
		sourceDigest,
		registry,
		binding,
		verifySource: () => true,
		sourceFence: {
			sourceDigest,
			environmentDigest: `sha256:${"b".repeat(64)}`,
			proofRef: "host:immutable-source",
			verify: (claim: { sourceDigest: string; sourcePath: string }) =>
				active &&
				claim.sourceDigest === sourceDigest &&
				claim.sourcePath === main &&
				digest() === sourceDigest,
		},
	};
	const input = {
		declaration: {
			name: "web",
			kind: "web",
			stableId: "web:web",
			declaredAllow: [],
			dependsOn: [],
			annotations: [],
		},
		entrypoint,
		requirements: {},
		bindleName: "app",
		dependencyDeclarations: {},
		dependencies: {},
	};
	return {
		source,
		input,
		main,
		dependency,
		revoke: () => {
			active = false;
		},
	};
}

describe("Rivet source and dependency closure fence", () => {
	it.each([
		"main",
		"dependency",
		"revocation",
	] as const)("rejects %s changes after source review", (change) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-source-"));
		try {
			const f = fixture(directory);
			const mapper = createRivetPrimitiveMappers(f.source).web;
			expect(() => mapper.validate(f.input)).not.toThrow();
			if (change === "revocation") f.revoke();
			else appendFileSync(f[change], "\n// changed");
			expect(() => mapper.validate(f.input)).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("accepts only the active, unchanged closure across eight bounded combinations", () => {
		for (let state = 0; state < 8; state++) {
			const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-source-state-"));
			try {
				const f = fixture(directory);
				const mapper = createRivetPrimitiveMappers(f.source).web;
				if (state & 1) appendFileSync(f.main, "\n// changed");
				if (state & 2) appendFileSync(f.dependency, "\n// changed");
				if (state & 4) f.revoke();
				if (state === 0) expect(() => mapper.validate(f.input)).not.toThrow();
				else
					expect(() => mapper.validate(f.input)).toThrow(
						"RIVET_SOURCE_UNVERIFIED",
					);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	});

	it("requires a source fence pinned to the reviewed source digest", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-source-"));
		try {
			const f = fixture(directory);
			const missing = { ...f.source };
			Reflect.deleteProperty(missing, "sourceFence");
			expect(() => createRivetPrimitiveMappers(missing)).toThrow();
			expect(() =>
				createRivetPrimitiveMappers({
					...f.source,
					sourceFence: {
						...f.source.sourceFence,
						sourceDigest: `sha256:${"f".repeat(64)}`,
					},
				}),
			).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"unchanged",
		"before-admission",
		"after-admission",
		"during-host-declaration",
		"during-provider-apply",
		"pool-revoked-after-admission",
		"pool-revoked-during-provider-apply",
		"pool-unchanged-destroy",
		"pool-revoked-before-destroy",
		"revoked",
	] as const)("enforces %s source authorization across a real Alchemy plan and apply", async (change) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-source-apply-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(directory);
			let poolAuthorized = true;
			let providerEffects = 0;
			let providerDeletes = 0;
			let hostCalls = 0;
			let trustedPriorStateDigest: string | undefined;
			const storedState: NonNullable<Parameters<typeof inMemoryState>[0]> = {};
			const registry = Layer.effect(
				Providers,
				Provider.collection([DurableObjectResource]),
			).pipe(
				Layer.provide(
					Provider.succeed(DurableObjectResource, {
						reconcile: () =>
							Effect.sync(() => {
								providerEffects++;
								if (change === "during-provider-apply") f.revoke();
								if (change === "pool-revoked-during-provider-apply")
									poolAuthorized = false;
								return {
									name: "web",
									pool: "pool",
									endpoint: "https://rivet.test",
									namespace: "test",
									token: undefined,
								};
							}),
						delete: () =>
							Effect.sync(() => {
								providerDeletes++;
							}),
					}),
				),
			);
			const pool: PoolHost["Service"] = {
				deployExternal: () =>
					Effect.sync(() => {
						hostCalls++;
						if (change === "during-host-declaration" && hostCalls > 1)
							appendFileSync(
								f.dependency,
								"\n// changed during host declaration",
							);
					}),
				deployCrate: () => Effect.void,
			};
			const mapper = change.startsWith("pool-")
				? createRivetMultiPoolPrimitiveMappers(
						[
							{
								source: f.source,
								poolDigest: `sha256:${"1".repeat(64)}`,
								isolationDigest: `sha256:${"2".repeat(64)}`,
								poolHost: pool,
							},
						],
						() => poolAuthorized,
					).web
				: createRivetPrimitiveMappers(f.source).web;
			const declarations = mapper.build(f.input);
			const stack = Stack(
				"App",
				{ providers: registry, state: inMemoryState(storedState) },
				declarations.pipe(
					Effect.provideService(PoolHost, pool),
					Effect.map(() => ({})),
				),
			);
			const admit = vi.fn(async (requestId: string) => {
				if (change === "after-admission")
					appendFileSync(f.dependency, "\n// changed after admission");
				if (change === "pool-revoked-after-admission") poolAuthorized = false;
				return {
					requestId,
					targetId: "yard",
					status: "admitted",
					code: "",
					message: "",
					budget: { evaluation: "allowed", reservation: "held" },
					reservation: {
						reservationId: `iac:${requestId}`,
						executionDigest: `sha256:${"4".repeat(64)}`,
					},
					requestDigest: `sha256:${"c".repeat(64)}`,
					inventoryHash: `sha256:${"d".repeat(64)}`,
					modelHash: `sha256:${"e".repeat(64)}`,
					quoteHash: `sha256:${"f".repeat(64)}`,
				};
			});
			const uncertain = vi.fn();
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				route: routeFixture({ inventoryHash: `sha256:${"d".repeat(64)}` }).port,
				resolveRoute: async ({ requestId }) => ({
					requestId: requestId ?? "request",
					operation: testOperation,
				}),
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "App",
					stage: "test",
					programResourceId: "app",
					sourceDigest: f.source.sourceDigest,
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							providerId: "rivet",
							providerAccountRef: "account",
							productId: "actor",
						},
					],
				}),
				composite: {
					proofRef: "host:immutable-source",
					environmentDigest: `sha256:${"b".repeat(64)}`,
					sourceRequirements: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							bindleName: "app",
							applicationName: "web",
							sourceKind: "rivet-http",
							sourcePath: f.main,
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims, historicalSources, operation }) =>
						sourceClaims.length === 1 &&
						sourceClaims[0]?.sourcePath === f.main &&
						(operation === "destroy"
							? poolAuthorized &&
								historicalSources.length === 1 &&
								historicalSources[0]?.priorStateDigest ===
									trustedPriorStateDigest
							: historicalSources.length === 0),
				},
				financial: {
					assess: (inventory) => ({ inventory }),
					admit,
					revalidate: () => true,
					uncertain,
				},
			});
			const program = {
				programId: "app",
				deploymentId: "d",
				resourceId: "app",
				provider: "rivet",
				driver: "external",
				action: "apply" as const,
				stackName: "App",
				operationGeneration: "generation-1",
			};
			await provider.preview(program);
			const previewHostCalls = hostCalls;
			if (change === "before-admission")
				appendFileSync(f.dependency, "\n// changed before admission");
			if (change === "revoked") f.revoke();
			if (
				change === "unchanged" ||
				change === "pool-unchanged-destroy" ||
				change === "pool-revoked-before-destroy"
			) {
				await provider.applyWithAdmission(program, "request");
				expect(providerEffects).toBe(1);
				const priorState = storedState.App?.test?.web;
				if (priorState === undefined)
					throw new Error("missing authoritative prior state");
				trustedPriorStateDigest = hashAlchemyPriorState(priorState);
				const destroy = {
					...program,
					action: "destroy" as const,
					operationGeneration: "generation-2",
				};
				const authenticDigest = trustedPriorStateDigest;
				if (change === "pool-revoked-before-destroy") poolAuthorized = false;
				trustedPriorStateDigest = `sha256:${"f".repeat(64)}`;
				await expect(provider.preview(destroy)).rejects.toThrow();
				expect(providerDeletes).toBe(0);
				trustedPriorStateDigest = authenticDigest;
				if (change === "pool-revoked-before-destroy") {
					await expect(provider.preview(destroy)).rejects.toThrow();
					expect(providerDeletes).toBe(0);
				} else {
					await provider.preview(destroy);
					await provider.destroyWithAdmission(destroy, "destroy-request");
					expect(providerDeletes).toBe(1);
				}
			} else {
				const failure = await provider
					.applyWithAdmission(program, "request")
					.then(
						() => undefined,
						(error) => error,
					);
				expect(failure).toBeInstanceOf(Error);
				expect(providerEffects).toBe(
					change === "during-provider-apply" ||
						change === "pool-revoked-during-provider-apply"
						? 1
						: 0,
				);
				if (
					change === "after-admission" ||
					change === "during-provider-apply" ||
					change.startsWith("pool-revoked-")
				) {
					expect(admit).toHaveBeenCalledOnce();
					expect(uncertain).toHaveBeenCalledOnce();
					expect(failure).toMatchObject({
						requiresReconciliation: true,
						reservationId: "iac:request",
					});
					if (
						change === "during-provider-apply" ||
						change === "pool-revoked-during-provider-apply"
					)
						expect(failure).toMatchObject({
							code: "SOURCE_FENCE_UNCERTAIN",
							executionOutcome: "completed",
						});
				} else {
					expect(admit).not.toHaveBeenCalled();
					expect(hostCalls).toBe(
						previewHostCalls + (change === "during-host-declaration" ? 1 : 0),
					);
				}
			}
		} finally {
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
