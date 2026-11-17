import type { PoolHost } from "@alchemy.run/rivet/Host";
import * as Effect from "effect/Effect";
import { setup } from "rivetkit";
import { describe, expect, it } from "vitest";
import {
	describeAlchemyPrimitiveSupport,
	mapBindleToAlchemy,
} from "../src/bindle.js";
import { createRivetPrimitiveMappers } from "../src/rivet.js";
import { createRivetMultiPoolPrimitiveMappers } from "../src/rivet-multi.js";
import { createRivetHttpActor } from "../src/rivet-runtime.js";

const kinds = ["api", "web", "service"] as const;
const catalog = [
	...kinds.map((factory) => ({ factory, allowVerbs: [] })),
	{ factory: "queue", allowVerbs: ["enqueue", "dequeue"] },
	{ factory: "topic", allowVerbs: ["publish", "subscribe"] },
];

function application(kind: (typeof kinds)[number], index: number) {
	const entrypoint = () => () => new Response(kind);
	const binding = createRivetHttpActor({
		actorName: kind,
		entrypoint,
		authorize: () => true,
	});
	const sourceDigest = `sha256:${"a".repeat(64)}`;
	const source = {
		main: `/src/${kind}.ts`,
		resourceName: kind,
		kind,
		actorName: kind,
		sourceDigest,
		sourceFence: {
			sourceDigest,
			environmentDigest: `sha256:${"b".repeat(64)}`,
			proofRef: "test:source-fence",
			verify: () => true,
		},
		registry: setup({ use: { [kind]: binding.actor }, noWelcome: true }),
		binding,
		verifySource: () => true,
	};
	const poolHost: PoolHost["Service"] = {
		deployExternal: () => Effect.void,
		deployCrate: () => Effect.void,
	};
	return {
		source,
		entrypoint,
		poolHost,
		poolDigest: `sha256:${String(index + 1).repeat(64)}`,
		isolationDigest: `sha256:${String(index + 1).repeat(64)}`,
	};
}

describe("Rivet source-aware primitive capabilities", () => {
	it.each(
		kinds,
	)("reports only the supplied %s source as partially mapped", (kind) => {
		const { source } = application(kind, 0);
		const mappers = createRivetPrimitiveMappers(source);
		expect(Object.isFrozen(mappers)).toBe(true);
		expect(
			kinds.every((key) => Object.isFrozen(mappers[key].resourceTypes)),
		).toBe(true);
		expect(Object.isFrozen(mappers[kind].limitations)).toBe(true);
		const rows = describeAlchemyPrimitiveSupport(catalog, mappers);
		for (const row of rows) {
			if (row.kind === kind) {
				expect(row.status).toBe("partial");
				expect(row.resourceTypes).toEqual(["Rivet.DurableObject"]);
				expect(row.limitations.join(" ")).toContain("dependencies");
			} else expect(row.status).toBe("unsupported");
		}
	});

	it("refuses a declaration of an HTTP kind not attested by its source", () => {
		const { source, entrypoint } = application("web", 0);
		const declaration = {
			name: "web",
			kind: "api",
			stableId: "api:web",
			declaredAllow: [],
			dependsOn: [],
			annotations: [],
		};
		expect(() =>
			mapBindleToAlchemy(
				{
					name: "app",
					resources: { web: declaration },
					edges: [],
					requirements: {},
					entrypoint: () => entrypoint,
				},
				createRivetPrimitiveMappers(source),
				{ assessRequirements: () => ({ status: "supported" }) },
			),
		).toThrow("PRIMITIVE_UNSUPPORTED");
	});

	it("reports exactly the source kinds in every nonempty multi-pool combination", () => {
		for (let mask = 1; mask < 8; mask++) {
			const entries = kinds.flatMap((kind, index) =>
				mask & (1 << index) ? [application(kind, index)] : [],
			);
			const mappers = createRivetMultiPoolPrimitiveMappers(entries, () => true);
			expect(Object.isFrozen(mappers)).toBe(true);
			expect(
				kinds.every((key) => Object.isFrozen(mappers[key].resourceTypes)),
			).toBe(true);
			const rows = describeAlchemyPrimitiveSupport(catalog, mappers);
			for (const [index, kind] of kinds.entries()) {
				expect(rows.find((row) => row.kind === kind)?.status).toBe(
					mask & (1 << index) ? "partial" : "unsupported",
				);
			}
			expect(rows.find((row) => row.kind === "topic")?.status).toBe(
				"unsupported",
			);
			expect(rows.find((row) => row.kind === "queue")?.status).toBe(
				"unsupported",
			);
		}
	});
});
