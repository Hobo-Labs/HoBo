import { mkdtempSync, rmSync } from "node:fs";
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
import { describe, expect, it } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import {
	bindRivetAsyncQueueSource,
	createRivetQueueActor,
	rivetAsyncQueueResource,
} from "../src/rivet-queue.js";

function fixture() {
	const binding = createRivetQueueActor({
		actorName: "jobs",
		now: Date.now,
		authorize: ({ actorKey }) => actorKey[0] === "tenant",
	});
	const registry = setup({ use: { jobs: binding.actor }, noWelcome: true });
	const poolHost = {
		deployExternal: () => Effect.void,
		deployCrate: () => Effect.void,
	};
	const source = {
		poolHost,
		bindleName: "queue-app",
		sourceFence: {
			sourceDigest: `sha256:${"a".repeat(64)}`,
			environmentDigest: `sha256:${"d".repeat(64)}`,
			proofRef: "host:source",
			verify: () => true,
		},
		poolDigest: `sha256:${"b".repeat(64)}`,
		isolationDigest: `sha256:${"c".repeat(64)}`,
		main: "/src/jobs.ts",
		resourceName: "jobs",
		sourceDigest: `sha256:${"a".repeat(64)}`,
		registry,
		binding,
		verifySource: () => true,
	};
	return { binding, registry, source };
}

describe("Alchemy Rivet async queue resource", () => {
	it("requires the exact standalone actor and host-verified source", () => {
		const f = fixture();
		expect(bindRivetAsyncQueueSource(f.source).binding).toBe(f.binding);
		expect(() =>
			bindRivetAsyncQueueSource({ ...f.source, resourceName: "other" }),
		).toThrow();
		expect(() =>
			bindRivetAsyncQueueSource({ ...f.source, verifySource: () => false }),
		).toThrow();
	});
	it("constructs an actual Alchemy Rivet DurableObject for the reviewed queue program", async () => {
		const f = fixture();
		const deployed: string[] = [];
		const registry = Layer.effect(
			Providers,
			Provider.collection([DurableObjectResource]),
		).pipe(
			Layer.provide(
				Provider.succeed(DurableObjectResource, {
					reconcile: () =>
						Effect.succeed({
							name: "jobs",
							pool: "pool",
							endpoint: "https://rivet.test",
							namespace: "test",
							token: undefined,
						}),
					delete: () => Effect.void,
				}),
			),
		);
		const pool = Layer.succeed(PoolHost, {
			deployExternal: (input) =>
				Effect.sync(() => {
					deployed.push(input.main);
				}),
			deployCrate: () => Effect.void,
		});
		const source = {
			...f.source,
			poolHost: {
				deployExternal: (input) =>
					Effect.sync(() => {
						deployed.push(input.main);
					}),
				deployCrate: () => Effect.void,
			},
		};
		const stack = Stack(
			"Queue",
			{ providers: Layer.merge(registry, pool), state: inMemoryState() },
			rivetAsyncQueueResource(source).pipe(Effect.map(() => ({}))),
		);
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-queue-alchemy-"));
		const previous = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		try {
			const provider = createAlchemyIacProvider({
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				composite: {
					proofRef: "host:source",
					environmentDigest: `sha256:${"d".repeat(64)}`,
					sourceRequirements: [
						{
							resourceId: "jobs",
							resourceType: "Rivet.DurableObject",
							bindleName: "queue-app",
							applicationName: "jobs",
							sourceKind: "rivet-async-queue",
							sourcePath: f.source.main,
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) =>
						sourceClaims.length === 1 &&
						sourceClaims[0]?.sourcePath === f.source.main,
				},
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "Queue",
					stage: "test",
					programResourceId: "queue",
					sourceDigest: f.source.sourceDigest,
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "jobs",
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
				programId: "queue",
				deploymentId: "d",
				resourceId: "queue",
				provider: "rivet",
				driver: "external",
				action: "apply",
				stackName: "Queue",
			});
			expect(result.changes).toBe(1);
			expect(deployed).toEqual([f.source.main]);
		} finally {
			if (previous === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

it("rechecks source and pool ownership before declaring a queue resource", async () => {
	const f = fixture();
	let valid = true;
	const source = {
		...f.source,
		sourceFence: { ...f.source.sourceFence, verify: () => valid },
		verifySource: () => valid,
	};
	const program = rivetAsyncQueueResource(source);
	valid = false;
	await expect(Effect.runPromise(program)).rejects.toThrow();
});

it("rejects coercible pool and source digests without invoking conversion", () => {
	const f = fixture();
	for (const key of ["poolDigest", "isolationDigest", "sourceDigest"]) {
		let converted = false;
		const source = { ...f.source };
		Object.defineProperty(source, key, {
			value: {
				toString() {
					converted = true;
					return `sha256:${"a".repeat(64)}`;
				},
			},
			enumerable: true,
		});
		expect(() => bindRivetAsyncQueueSource(source)).toThrow();
		expect(converted).toBe(false);
	}
});
