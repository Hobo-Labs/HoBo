import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import { fromJson, toJson } from "@bufbuild/protobuf";
import { alchemyTarget, createAlchemyIacProvider } from "@hobo/iac-alchemy";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { setup } from "rivetkit";
import { describe, expect, it } from "vitest";
import { TopicSourceClaimSchema } from "../src/_generated/topic_source_claim_pb.js";
import {
	bindRivetDurableTopicBusSource,
	createRivetDurableTopicBusActor,
	RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	type RivetDurableTopicBusSource,
	rivetDurableTopicBusResource,
} from "../src/index.js";
import { testStateOwnership } from "./route-fixture.js";

const sourceDigest = `sha256:${"a".repeat(64)}`;
const environmentDigest = `sha256:${"d".repeat(64)}`;
const semanticDigest = environmentDigest;

function runResource(resource: Effect.Effect<unknown, never, Providers>) {
	return Effect.runPromise(
		resource.pipe(
			Effect.provideService(Providers, {
				kind: "ProviderCollection",
				get: () => undefined,
				providers: {},
			}),
		),
	);
}

function fixture() {
	const binding = createRivetDurableTopicBusActor({
		actorName: "events",
		semanticDigest,
		now: () => 1000,
		resolveScope: () => ({ tenant: "tenant", instance: "instance" }),
		authorize: () => true,
		authorizeInstanceScope: () => true,
		verifyIngress: () => true,
	});
	const registry = setup({ use: { events: binding.actor }, noWelcome: true });
	const calls: string[] = [];
	const source: RivetDurableTopicBusSource = {
		main: "/src/events-main.ts",
		resourceName: "events",
		bindleName: "events-app",
		sourceDigest,
		sourceFence: {
			sourceDigest,
			environmentDigest,
			proofRef: "host:topic-source",
			verify: () => true,
		},
		poolDigest: `sha256:${"b".repeat(64)}`,
		isolationDigest: `sha256:${"c".repeat(64)}`,
		poolHost: {
			deployExternal: ({ main }: { main: string }) =>
				Effect.sync(() => {
					calls.push(main);
				}),
			deployCrate: () => Effect.void,
		},
		registry,
		binding,
		verifySource: (claim) =>
			claim.binding === binding &&
			claim.binding.semanticDigest === semanticDigest &&
			claim.registry === registry &&
			claim.main === "/src/events-main.ts",
	};
	return { binding, registry, calls, source };
}

describe("Alchemy Rivet durable topic bus resource", () => {
	it("exposes the actor's bus profile without claiming legacy WIT support", () => {
		const { binding } = fixture();
		expect(binding.capabilities).toEqual(RIVET_DURABLE_TOPIC_BUS_CAPABILITIES);
		expect(binding.capabilities).toMatchObject({
			topicCreation: true,
			publish: true,
			readRetainedLog: false,
			compaction: true,
			consumerGroups: true,
			leases: true,
			acknowledgement: true,
			deadLetter: true,
			legacyWit: false,
		});
	});

	it("accepts only the exact branded actor, registry and host-attested source", () => {
		const f = fixture();
		expect(bindRivetDurableTopicBusSource(f.source).binding).toBe(f.binding);
		expect(() =>
			bindRivetDurableTopicBusSource({
				...f.source,
				binding: { ...f.binding },
			}),
		).toThrow("RIVET_SOURCE_MISMATCH");
		expect(() =>
			bindRivetDurableTopicBusSource({
				...f.source,
				resourceName: "another",
			}),
		).toThrow("RIVET_SOURCE_MISMATCH");
		expect(() =>
			bindRivetDurableTopicBusSource({
				...f.source,
				verifySource: () => false,
			}),
		).toThrow("RIVET_SOURCE_UNVERIFIED");
		expect(() =>
			bindRivetDurableTopicBusSource({
				...f.source,
				verifySource: () => {
					throw new Error("authority offline");
				},
			}),
		).toThrow("RIVET_SOURCE_UNVERIFIED");
		expect(() =>
			bindRivetDurableTopicBusSource({
				...f.source,
				sourceFence: {
					...f.source.sourceFence,
					sourceDigest: `sha256:${"f".repeat(64)}`,
				},
			}),
		).toThrow("RIVET_SOURCE_UNVERIFIED");
		expect(() =>
			bindRivetDurableTopicBusSource({
				...f.source,
				sourceFence: {
					...f.source.sourceFence,
					environmentDigest: `sha256:${"f".repeat(64)}`,
				},
			}),
		).toThrow("RIVET_SOURCE_MISMATCH");
	});

	it("rechecks source, actor semantics and pool ownership before declaring a resource", async () => {
		const f = fixture();
		let valid = true;
		const resource = rivetDurableTopicBusResource({
			...f.source,
			verifySource: () => valid,
		});
		valid = false;
		await expect(runResource(resource)).rejects.toThrow(
			"RIVET_SOURCE_UNVERIFIED",
		);
		expect(f.calls).toEqual([]);
	});

	it("fails closed when the source fence or pool deployment authority changes", async () => {
		const f = fixture();
		let fenced = true;
		const source = {
			...f.source,
			sourceFence: { ...f.source.sourceFence, verify: () => fenced },
		};
		const fencedResource = rivetDurableTopicBusResource(source);
		fenced = false;
		await expect(runResource(fencedResource)).rejects.toThrow(
			"RIVET_SOURCE_UNVERIFIED",
		);
		expect(f.calls).toEqual([]);

		fenced = true;
		const poolResource = rivetDurableTopicBusResource(source);
		Object.defineProperty(source.poolHost, "deployExternal", {
			value: () => Effect.void,
			configurable: true,
		});
		await expect(runResource(poolResource)).rejects.toThrow(
			"RIVET_SOURCE_UNVERIFIED",
		);
		expect(f.calls).toEqual([]);
	});

	it("rejects a registry with any extra actor even if the host approves", () => {
		const f = fixture();
		const registry = setup({
			use: { events: f.binding.actor, extra: f.binding.actor },
			noWelcome: true,
		});
		expect(() =>
			bindRivetDurableTopicBusSource({
				...f.source,
				registry,
				verifySource: () => true,
			}),
		).toThrow("RIVET_SOURCE_MISMATCH");
	});

	it("maps the actor to a real Alchemy DurableObject with an exact topic source claim", async () => {
		const f = fixture();
		let callAccesses = 0;
		Object.defineProperty(f.source.poolHost.deployExternal, "call", {
			get() {
				callAccesses++;
				throw new Error("untrusted function property");
			},
		});
		const providers = Layer.effect(
			Providers,
			Provider.collection([DurableObjectResource]),
		).pipe(
			Layer.provide(
				Provider.succeed(DurableObjectResource, {
					reconcile: () =>
						Effect.succeed({
							name: "events",
							pool: "pool",
							endpoint: "https://rivet.test",
							namespace: "test",
							token: undefined,
						}),
					delete: () => Effect.void,
				}),
			),
		);
		const stack = Stack(
			"Topic",
			{ providers, state: inMemoryState() },
			rivetDurableTopicBusResource(f.source).pipe(Effect.map(() => ({}))),
		);
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-topic-alchemy-"));
		const previous = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		const observed: unknown[] = [];
		try {
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				composite: {
					proofRef: "host:topic-source",
					environmentDigest,
					sourceRequirements: [
						{
							resourceId: "events",
							resourceType: "Rivet.DurableObject",
							bindleName: "events-app",
							applicationName: "events",
							sourceKind: "rivet-async-topic-bus",
							sourcePath: f.source.main,
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) => {
						observed.push(...sourceClaims);
						return (
							sourceClaims.length === 1 &&
							sourceClaims[0]?.sourcePath === f.source.main &&
							sourceClaims[0]?.sourceKind === "rivet-async-topic-bus"
						);
					},
				},
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "Topic",
					stage: "test",
					programResourceId: "topic",
					sourceDigest,
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "events",
							resourceType: "Rivet.DurableObject",
							providerId: "rivet",
							providerAccountRef: "account",
							productId: "actor",
						},
					],
				}),
				financial: {
					assess: (inventory) => ({ inventory }),
					admit: async () => {
						throw new Error("unexpected admission");
					},
					revalidate: () => true,
					uncertain: () => {},
				},
			});
			const result = await provider.preview({
				programId: "topic",
				deploymentId: "d",
				resourceId: "topic",
				provider: "rivet",
				driver: "external",
				action: "apply",
				stackName: "Topic",
			});
			expect(result.changes).toBe(1);
			expect(f.calls).toEqual([f.source.main]);
			expect(callAccesses).toBe(0);
			expect(observed).toContainEqual(
				expect.objectContaining({
					resourceId: "events",
					resourceType: "Rivet.DurableObject",
					sourceKind: "rivet-async-topic-bus",
					sourcePath: f.source.main,
					sourceDigest,
				}),
			);
			const fixture = JSON.parse(
				readFileSync(
					new URL(
						"../data-models/fixtures/valid/bus-source.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			expect(observed).toContainEqual(fixture);
			expect(
				toJson(
					TopicSourceClaimSchema,
					fromJson(TopicSourceClaimSchema, fixture),
				),
			).toEqual(fixture);
		} finally {
			if (previous === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
