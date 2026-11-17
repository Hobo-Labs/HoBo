import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Namespace as KvNamespace } from "@alchemy.run/cloudflare/KV/Namespace";
import * as Namespace from "alchemy/Namespace";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { mapBindleToAlchemy } from "../src/bindle.js";
import {
	cloudflareBindleMappers,
	cloudflareViteApp,
} from "../src/cloudflare.js";
import {
	firstApplication,
	secondApplication,
} from "./fixtures/cloudflare-isolation-app.js";

const options = {
	assessRequirements: () => ({ status: "supported" as const }),
};
// Only this test harness stubs the host's source-isolation authority.
const sourceFence = {
	sourceDigest: `sha256:${"a".repeat(64)}`,
	environmentDigest: `sha256:${"b".repeat(64)}`,
	proofRef: "test:isolated-runtime",
	verify: () => true,
};
const stack = () => ({
	name: "App",
	stage: "test",
	resources: {},
	bindings: {},
	actions: {},
});
const definition = (name: string, kind: string) => ({
	name,
	resources: {
		store: {
			kind,
			name: "store",
			stableId: `${kind}:store`,
			declaredAllow: [],
			dependsOn: [],
			annotations: [],
		},
	},
	edges: [],
	requirements: {},
	entrypoint: () => undefined,
});

function execute<A, E, R>(effect: Effect.Effect<A, E, R>, target = stack()) {
	// SAFETY: the test supplies the Alchemy stack used by the real constructors.
	return Effect.runPromise(
		effect.pipe(Effect.provideService(StackContext, target)) as Effect.Effect<
			A,
			E,
			never
		>,
	);
}

describe("Cloudflare Bindle identity isolation", () => {
	it.each([
		"kv",
		"bucket",
		"queue",
	] as const)("rejects same-named %s infrastructure in sequential and concurrent Bindles", async (kind) => {
		for (const mode of ["sequential", "concurrent"] as const) {
			const mappers = cloudflareBindleMappers({ workerModules: {} });
			const first = mapBindleToAlchemy(
				definition("first", kind),
				mappers,
				options,
			);
			const second = mapBindleToAlchemy(
				definition("second", kind),
				mappers,
				options,
			);
			const program =
				mode === "sequential"
					? Effect.gen(function* () {
							yield* first;
							yield* second;
						})
					: Effect.all([first, second], { concurrency: "unbounded" });
			await expect(execute(program)).rejects.toThrow(
				"BINDLE_IDENTITY_COLLISION",
			);
		}
	});

	it("rejects a native namespace declared before the Bindle", async () => {
		const program = Effect.gen(function* () {
			yield* KvNamespace("store", {});
			yield* mapBindleToAlchemy(
				definition("app", "kv"),
				cloudflareBindleMappers({ workerModules: {} }),
				options,
			);
		});
		await expect(execute(program)).rejects.toThrow("BINDLE_IDENTITY_COLLISION");
	});

	it.each([
		"kv",
		"bucket",
		"queue",
	] as const)("allows separately namespaced %s declarations in one stack", async (kind) => {
		const mappers = cloudflareBindleMappers({ workerModules: {} });
		const first = mapBindleToAlchemy(
			definition("first", kind),
			mappers,
			options,
		);
		const second = mapBindleToAlchemy(
			definition("second", kind),
			mappers,
			options,
		);
		const result = await execute(
			Effect.all([
				Namespace.push("first", first),
				Namespace.push("second", second),
			]),
		);
		expect(result.map((item) => item.primary.store?.FQN)).toEqual([
			"first/store",
			"second/store",
		]);
	});

	it.each([
		"web",
		"api",
		"service",
	] as const)("rejects two %s entrypoints that would share a real Worker", async (kind) => {
		const directory = dirname(fileURLToPath(import.meta.url));
		const app = (value: typeof firstApplication) => ({
			...value,
			resources: {
				web: { ...value.resources.web, kind, stableId: `${kind}:web` },
			},
		});
		const first = mapBindleToAlchemy(
			app(firstApplication),
			cloudflareBindleMappers({
				workerModules: {
					web: join(directory, "fixtures/cloudflare-isolation-first.ts"),
				},
				sourceFence,
			}),
			options,
		);
		const second = mapBindleToAlchemy(
			app(secondApplication),
			cloudflareBindleMappers({
				workerModules: {
					web: join(directory, "fixtures/cloudflare-isolation-second.ts"),
				},
				sourceFence,
			}),
			options,
		);
		await expect(
			execute(
				Effect.gen(function* () {
					yield* first;
					yield* second;
				}),
			),
		).rejects.toThrow("BINDLE_IDENTITY_COLLISION");
	});

	it("rejects two Vite websites that would share a real Worker", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cf-isolation-"));
		try {
			mkdirSync(join(directory, "site"));
			const marker = cloudflareViteApp("site");
			const app = (name: string) => ({
				...firstApplication,
				name,
				resources: {
					web: {
						...firstApplication.resources.web,
						annotations: [
							...firstApplication.resources.web.annotations,
							{
								provider: "hobo",
								option: "webapp",
								config: { framework: "vite", root: "site" },
							},
						],
					},
				},
				entrypoint: () => marker,
			});
			const mappers = cloudflareBindleMappers({
				workerModules: {},
				projectRoot: directory,
				sourceFence,
			});
			const program = Effect.gen(function* () {
				yield* mapBindleToAlchemy(app("first"), mappers, options);
				yield* mapBindleToAlchemy(app("second"), mappers, options);
			});
			await expect(execute(program)).rejects.toThrow(
				"BINDLE_IDENTITY_COLLISION",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
