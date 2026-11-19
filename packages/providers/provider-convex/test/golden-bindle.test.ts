// Golden coverage (ADR-0144 §5): a pure portable Bindle using only abstract
import assert from "node:assert/strict";
import { assertNoBindleProviderSelection, bindle } from "@hobo/bindles";
import { describe, it } from "vitest";

import { convexImpedanceFindings, createConvexProvider } from "../src/index.js";

function goldenBindle() {
	return bindle("orders-app", (b) => ({
		api: b.api(),
		orders: b.data().allow("read", "write", "query"),
		uploads: b.bucket().allow("read", "write"),
	}));
}

describe("golden: portable Bindle → Convex realization", () => {
	it("the Bindle is provider-neutral by construction", () => {
		const definition = goldenBindle();
		assertNoBindleProviderSelection(definition);
		assert.deepEqual(definition.resources.orders?.declaredAllow, [
			"read",
			"write",
			"query",
		]);
		assert.deepEqual(definition.resources.uploads?.declaredAllow, [
			"read",
			"write",
		]);
		assert.deepEqual(definition.resources.orders?.annotations, []);
	});

	it("the same abstract requests are satisfied by Convex capabilities", () => {
		const provider = createConvexProvider();
		const requests = [
			{ port: "database", features: ["document", "reactive"] },
			{ port: "objectStore", features: ["durable"] },
			{ port: "compute", features: ["http", "managed"] },
		];
		for (const request of requests) {
			const verdicts = provider.capabilities.map((capability) =>
				capability.satisfies(request),
			);
			assert.ok(
				verdicts.some((verdict) => verdict.kind === "full"),
				`expected a full verdict for ${request.port}`,
			);
		}
	});

	it("realization is honest: the document paradigm passes, relational blocks", () => {
		assert.ok(
			!convexImpedanceFindings({ paradigm: "document" }).some(
				(finding) => finding.severity === "block",
			),
		);
		assert.ok(
			convexImpedanceFindings({ paradigm: "relational" }).some(
				(finding) => finding.severity === "block",
			),
		);
	});
});
