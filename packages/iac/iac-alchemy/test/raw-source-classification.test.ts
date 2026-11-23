import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Providers as CloudflareProviders } from "@alchemy.run/cloudflare/Providers";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import {
	DurableObject,
	DurableObjectResource,
	Providers as RivetProviders,
} from "@alchemy.run/rivet";
import { PoolHost } from "@alchemy.run/rivet/Host";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vitest";
import {
	type AlchemyCompositeObservation,
	type AlchemySourceRequirement,
	alchemyTarget,
	createAlchemyIacProvider,
	type FinancialPlan,
	registerAlchemySource,
} from "../src/index.js";
import { testStateOwnership } from "./route-fixture.js";

function fixture(
	kind: "worker" | "rivet",
	directory: string,
	classify: "deny" | "expected" | "registered",
) {
	let declarations = 0;
	let effects = 0;
	const resourceType =
		kind === "worker" ? "Cloudflare.Worker" : "Rivet.DurableObject";
	const sourcePath = "/src/application.ts";
	const sourceDigest = `sha256:${"a".repeat(64)}`;
	const environmentDigest = `sha256:${"b".repeat(64)}`;
	const requirement: AlchemySourceRequirement = {
		resourceId: "web",
		resourceType,
		bindleName: "app",
		applicationName: "web",
		sourceKind: kind,
		sourcePath,
	};
	const claim = {
		...requirement,
		sourceDigest,
		environmentDigest,
		proofRef: "host:raw-source",
	};
	const resource =
		kind === "worker"
			? Worker("web", { main: sourcePath })
			: DurableObject("web", { main: sourcePath }).pipe(
					Effect.provideService(PoolHost, {
						deployExternal: () => Effect.void,
						deployCrate: () => Effect.void,
					}),
				);
	const cloudflare = Layer.effect(
		CloudflareProviders,
		Provider.collection([Worker]),
	).pipe(
		Layer.provide(
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the real Worker resource is used only to install a no-effect test provider; its reconcile must never run during preview.
			Provider.succeed(Worker as never, {
				reconcile: () =>
					Effect.sync(() => {
						effects++;
						throw new Error("unexpected provider effect");
					}),
				delete: () => Effect.void,
			}),
		),
	);
	const rivet = Layer.effect(
		RivetProviders,
		Provider.collection([DurableObjectResource]),
	).pipe(
		Layer.provide(
			Provider.succeed(DurableObjectResource, {
				reconcile: () =>
					Effect.sync(() => {
						effects++;
						return {
							name: "web",
							pool: "pool",
							endpoint: "https://rivet.test",
							namespace: "test",
							token: undefined,
						};
					}),
				delete: () => Effect.void,
			}),
		),
	);
	const stack = Stack(
		"App",
		{ providers: Layer.merge(cloudflare, rivet), state: inMemoryState() },
		Effect.gen(function* () {
			declarations++;
			const actual = yield* resource;
			if (classify === "registered")
				registerAlchemySource(actual, { claim, verify: () => true });
			return {};
		}),
	);
	const verifyPlan = vi.fn(
		({ scope, sourceClaims }: AlchemyCompositeObservation) => {
			if (classify === "deny")
				return !scope.some((item) => item.resourceType === resourceType);
			return (
				sourceClaims.length === 1 &&
				sourceClaims[0]?.resourceType === resourceType
			);
		},
	);
	const composite = {
		proofRef: "host:raw-source",
		environmentDigest,
		sourceRequirements: classify === "deny" ? [] : [requirement],
		verifyEnvironment: () => true,
		verifyPlan,
	};
	const options = {
		stateOwnership: testStateOwnership,
		stack,
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: directory,
		composite,
		target: alchemyTarget({
			targetId: "yard",
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "web",
					resourceType,
					providerId: kind,
					providerAccountRef: "account",
					productId: "app",
				},
			],
		}),
		financial: {
			assess: (inventory: FinancialPlan) => ({ inventory }),
			admit: async () => {
				throw new Error("unexpected admission");
			},
			revalidate: () => false,
			uncertain: () => {},
		},
	};
	const program = {
		programId: "p",
		deploymentId: "d",
		resourceId: "app",
		provider: kind,
		driver: "external",
		action: "apply" as const,
		stackName: "App",
	};
	return {
		options,
		composite,
		program,
		verifyPlan,
		declarations: () => declarations,
		effects: () => effects,
	};
}

describe("raw Alchemy resource source classification", () => {
	it.each([
		["worker", "composite"],
		["worker", "sourceRequirements"],
		["rivet", "composite"],
		["rivet", "sourceRequirements"],
	] as const)("rejects raw %s missing %s before executing stack code", (kind, missing) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-raw-source-"));
		try {
			const f = fixture(kind, directory, "deny");
			Reflect.deleteProperty(
				missing === "composite" ? f.options : f.composite,
				missing,
			);
			expect(() => createAlchemyIacProvider(f.options)).toThrow(
				"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			);
			expect(f.declarations()).toBe(0);
			expect(f.effects()).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"worker",
		"rivet",
	] as const)("rejects an unregistered raw %s when the host expects a source", async (kind) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-raw-source-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(kind, directory, "expected");
			await expect(
				createAlchemyIacProvider(f.options).preview(f.program),
			).rejects.toThrow("SOURCE_FENCE_INCOMPLETE");
			expect(f.effects()).toBe(0);
		} finally {
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"worker",
		"rivet",
	] as const)("lets the host reject a false empty classification for a raw %s", async (kind) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-raw-source-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(kind, directory, "deny");
			await expect(
				createAlchemyIacProvider(f.options).preview(f.program),
			).rejects.toThrow("COMPOSITE_PLAN_UNVERIFIED");
			expect(f.verifyPlan).toHaveBeenCalled();
			expect(f.effects()).toBe(0);
		} finally {
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"worker",
		"rivet",
	] as const)("accepts a raw %s only with an exact host-authorized source claim", async (kind) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-raw-source-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(kind, directory, "registered");
			expect(
				(await createAlchemyIacProvider(f.options).preview(f.program)).changes,
			).toBe(1);
			expect(f.effects()).toBe(0);
		} finally {
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
