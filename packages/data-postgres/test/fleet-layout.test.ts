import { describe, expect, it } from "vitest";
import { insertionOrder } from "../src/fleet/replication.js";
import { isReplicatedTable, parseFleetLayout } from "../src/index.js";

describe("fleet layout", () => {
	it("the empty prefix copies a whole schema except control and excluded tables", () => {
		const layout = parseFleetLayout({
			dataPrefix: "",
			controlPrefix: "hobo_fleet_",
			excludedTables: ["schema_migrations"],
		});
		expect(isReplicatedTable(layout, "events")).toBe(true);
		expect(isReplicatedTable(layout, "streams")).toBe(true);
		expect(isReplicatedTable(layout, "hobo_fleet_assignments")).toBe(false);
		expect(isReplicatedTable(layout, "schema_migrations")).toBe(false);
	});
});

describe("insertionOrder", () => {
	it("puts every referenced table before the tables pointing at it", () => {
		const order = insertionOrder([
			{ name: "events", references: ["streams"] },
			{ name: "outbox", references: ["events"] },
			{ name: "streams", references: [] },
			{ name: "alpha", references: [] },
		]).map((table) => table.name);
		expect(order).toEqual(["alpha", "streams", "events", "outbox"]);
	});

	it("orders a cycle deterministically rather than looping", () => {
		expect(
			insertionOrder([
				{ name: "b", references: ["a"] },
				{ name: "a", references: ["b"] },
			]).map((table) => table.name),
		).toEqual(["b", "a"]);
	});
});
