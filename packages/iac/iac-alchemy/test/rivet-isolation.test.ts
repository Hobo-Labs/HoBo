import { tmpdir } from "node:os";
import { join } from "node:path";
import { PoolHost } from "@alchemy.run/rivet/Host";
import * as Namespace from "alchemy/Namespace";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { setup } from "rivetkit";
import { describe, expect, it } from "vitest";
import { mapBindleToAlchemy } from "../src/bindle.js";
import { createRivetPrimitiveMappers } from "../src/rivet.js";
import { createRivetHttpActor } from "../src/rivet-runtime.js";

const options = {
	assessRequirements: () => ({ status: "supported" as const }),
};
const stack = () => ({
	name: "App",
	stage: "test",
	resources: {},
	bindings: {},
	actions: {},
});

function execute<A, E, R>(effect: Effect.Effect<A, E, R>, target = stack()) {
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the test supplies the Alchemy stack and PoolHost used by these constructors.
	return Effect.runPromise(
		effect.pipe(Effect.provideService(StackContext, target)) as Effect.Effect<
			A,
			E,
			never
		>,
	);
}

function mapped(name: string, kind: "api" | "service" | "web") {
	const entrypoint = () => () => new Response(name);
	const binding = createRivetHttpActor({
		actorName: "web",
		entrypoint,
		authorize: () => true,
	});
	const sourceDigest = `sha256:${"a".repeat(64)}`;
	const source = {
		main: join(tmpdir(), `${name}.ts`),
		resourceName: "web",
		kind,
		actorName: "web",
		sourceDigest,

		sourceFence: {
			sourceDigest,
			environmentDigest: `sha256:${"b".repeat(64)}`,
			proofRef: "test:source-fence",
			verify: () => true,
		},
		registry: setup({ use: { web: binding.actor }, noWelcome: true }),
		binding,
		verifySource: () => true,
	};
	const app = {
		name,
		resources: {
			web: {
				kind,
				name: "web",
				stableId: `${kind}:web`,
				declaredAllow: [],
				dependsOn: [],
				annotations: [],
			},
		},
		edges: [],
		requirements: {},
		entrypoint: () => entrypoint,
	};
	return mapBindleToAlchemy(app, createRivetPrimitiveMappers(source), options);
}

function pool(deployments: string[]): PoolHost["Service"] {
	return {
		deployExternal: ({ main }) =>
			Effect.sync(() => {
				deployments.push(main);
			}),
		deployCrate: () => Effect.void,
	};
}

describe("Rivet Bindle identity isolation", () => {
	it.each([
		"web",
		"api",
		"service",
	] as const)("rejects a second %s actor before its pool deployment", async (kind) => {
		for (const mode of ["sequential", "concurrent"] as const) {
			const deployments: string[] = [];
			const first = mapped("first", kind);
			const second = mapped("second", kind);
			const program =
				mode === "sequential"
					? Effect.gen(function* () {
							yield* first;
							yield* second;
						})
					: Effect.all([first, second], { concurrency: "unbounded" });
			await expect(
				execute(
					program.pipe(Effect.provideService(PoolHost, pool(deployments))),
				),
			).rejects.toThrow("BINDLE_IDENTITY_COLLISION");
			expect(deployments).toHaveLength(1);
			if (mode === "sequential")
				expect(deployments).toEqual([join(tmpdir(), "first.ts")]);
			else
				expect([
					join(tmpdir(), "first.ts"),
					join(tmpdir(), "second.ts"),
				]).toContain(deployments[0]);
		}
	});

	it("rejects an Alchemy namespace that would change the attested actor FQN", async () => {
		const deployments: string[] = [];
		const program = Namespace.push("first", mapped("first", "web")).pipe(
			Effect.provideService(PoolHost, pool(deployments)),
		);
		await expect(execute(program)).rejects.toThrow("RIVET_SOURCE_MISMATCH");
		expect(deployments).toEqual([]);
	});

	it("keeps distinct stack objects without claiming physical pool isolation", async () => {
		const deployments: string[] = [];
		const host = pool(deployments);
		const first = await execute(
			mapped("first", "web").pipe(Effect.provideService(PoolHost, host)),
		);
		const second = await execute(
			mapped("second", "web").pipe(Effect.provideService(PoolHost, host)),
		);
		expect(first.primary.web?.FQN).toBe("web");
		expect(second.primary.web?.FQN).toBe("web");
		expect(first.primary.web).not.toBe(second.primary.web);
		expect(deployments).toEqual([
			join(tmpdir(), "first.ts"),
			join(tmpdir(), "second.ts"),
		]);
	});
});
