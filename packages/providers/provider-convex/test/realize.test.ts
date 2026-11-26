import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	CONVEX_DRIVER,
	createConvexProvider,
	realizeResourcePlan,
} from "../src/index.js";

describe("realize — convex-deploy driver programs", () => {
	it("a database plan realizes as deployment + document-db with resolvable outputs", () => {
		const { driver } = realizeResourcePlan({
			name: "orders",
			port: "database",
			provider: "@hobo/provider-convex",
		});
		assert.equal(driver.driver, CONVEX_DRIVER);
		assert.deepEqual(
			driver.resources.map((resource) => resource.type),
			["convex:deployment", "convex:document-db"],
		);
		// Output refs resolve against declared resource outputs (asserted by
		// the parse-don't-validate emit gate; spot-check the shape here too).
		assert.equal(
			driver.outputs.deploymentUrl,
			"${resources.deployment.outputs.url}",
		);
		assert.equal(
			driver.outputs.connectionRef,
			"${resources.orders.outputs.connectionRef}",
		);
	});

	it("compute and objectStore plans map to their equivalence classes", () => {
		const compute = realizeResourcePlan({
			name: "site",
			port: "compute",
			provider: "@hobo/provider-convex",
		});
		assert.equal(compute.driver.resources[1]?.type, "convex:function-host");
		const storage = realizeResourcePlan({
			name: "uploads",
			port: "objectStore",
			provider: "@hobo/provider-convex",
		});
		assert.equal(storage.driver.resources[1]?.type, "convex:file-storage");
	});

	it("an unsupported port fails closed with remediation", () => {
		assert.throws(
			() =>
				realizeResourcePlan({
					name: "jobs",
					port: "queue",
					provider: "@hobo/provider-convex",
				}),
			/cannot realize port queue.*supported/u,
		);
	});

	it("the provider surface realizes through the same path", () => {
		const provider = createConvexProvider();
		const { driver } = provider.realize({
			name: "orders",
			port: "database",
			provider: provider.id,
		});
		assert.equal(driver.deployment, "orders-us");
	});
});
