/**
 * The SQL replica of the one-active assignment register (O15, replica half).
 *
 * `runReplicaConformance` of `@hobo/fleet/testing` holds the SQL replica to
 * what every replica must do, over the `SqlExecutor` double of
 * `fleet-sql-double.ts`, which answers the replica's statements the way
 * Postgres would (every column as text, `members` as a `text[]`). The cases
 * below pin what is Postgres about it: member sets round-trip through the
 * nullable `members` column, a row without one reads back as before, and the
 * control tables gain the column on a log created before it existed.
 */
import { type AssignmentEntry, Health, parseMemberName } from "@hobo/fleet";
import { assignmentKey, readAssignmentReplies } from "@hobo/fleet/assignment";
import { runReplicaConformance } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import {
	classifyFleetFailure,
	ensureFleetControlTables,
	parseFleetLayout,
	sqlAssignmentRegister,
	sqlAssignmentReplica,
} from "../src/index.js";
import { FleetSqlDouble } from "./fleet-sql-double.js";

const layout = parseFleetLayout({
	dataPrefix: "app_",
	controlPrefix: "app_fleet_",
});

const A = parseMemberName("a");
const B = parseMemberName("b");
const C = parseMemberName("c");

function entry(
	epoch: number,
	members: readonly (typeof A)[] | undefined,
): AssignmentEntry {
	return {
		epoch,
		active: A,
		sealed: false,
		target: undefined,
		reason: epoch === 1 ? "bootstrap" : "pin-members",
		lossWindowMs: undefined,
		decidedAtMs: epoch === 1 ? 0 : 1_800_000_000_000,
		decidedBy: epoch === 1 ? "bootstrap" : "service:reconcile",
		members,
	};
}

runReplicaConformance((id) =>
	sqlAssignmentReplica({ id, executor: new FleetSqlDouble() }, layout),
);

describe("the SQL replica's members column", () => {
	it("writes a member set as a text[] and reads it back sorted, as written", async () => {
		const executor = new FleetSqlDouble();
		const replica = sqlAssignmentReplica({ id: "a", executor }, layout);
		expect(await replica.accept(entry(1, undefined))).toBe("accepted");
		expect(await replica.accept(entry(2, [A, B, C]))).toBe("accepted");
		expect(executor.log.map((row) => row.members)).toEqual([null, "{a,b,c}"]);
		const read = await replica.read();
		expect(read.map((row) => row.members)).toEqual([undefined, [A, B, C]]);
		expect(read.map(assignmentKey)).toEqual([
			assignmentKey(entry(1, undefined)),
			assignmentKey(entry(2, [A, B, C])),
		]);
	});

	it("tells two entries apart that differ only in their member set", async () => {
		const executor = new FleetSqlDouble();
		const replica = sqlAssignmentReplica({ id: "a", executor }, layout);
		await replica.accept(entry(1, undefined));
		await replica.accept(entry(2, [A, B]));
		expect(await replica.accept(entry(2, [A, B]))).toBe("duplicate");
		expect(await replica.accept(entry(2, [A, B, C]))).toBe("conflict");
		expect(await replica.accept(entry(2, undefined))).toBe("conflict");
	});

	it("refuses a members column that is not a list of member names", async () => {
		const executor = new FleetSqlDouble();
		const replica = sqlAssignmentReplica({ id: "a", executor }, layout);
		await replica.accept(entry(1, undefined));
		const [row] = executor.log;
		if (row === undefined) throw new Error("no row");
		row.members = '{"a b"}';
		await expect(replica.read()).rejects.toThrow(/list of member names/u);
	});

	it("answers busy while a copy holds the fleet's lock", async () => {
		const executor = new FleetSqlDouble();
		executor.locked = true;
		const replica = sqlAssignmentReplica({ id: "a", executor }, layout);
		expect(await replica.accept(entry(1, undefined))).toBe("busy");
	});

	it("adds the column to a log created before member sets existed", async () => {
		const executor = new FleetSqlDouble();
		await ensureFleetControlTables({ id: "a", executor }, layout);
		const ddl = executor.statements.join("\n");
		expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS app_fleet_assignments \(/u);
		expect(ddl).toMatch(/members text\[\],/u);
		expect(ddl).toContain(
			"ALTER TABLE app_fleet_assignments ADD COLUMN IF NOT EXISTS members text[]",
		);
	});

	it("classifies a backend that does not answer as the fleet's Health", async () => {
		const executor = new FleetSqlDouble();
		executor.up = false;
		const register = sqlAssignmentRegister([{ id: "a", executor }], layout);
		expect(await readAssignmentReplies(register)).toEqual([
			{ replica: "a", failure: Health.UNREACHABLE },
		]);
		expect(classifyFleetFailure(undefined)).toBe(Health.UNKNOWN);
		expect(
			classifyFleetFailure(new Error("password authentication failed")),
		).toBe(Health.AUTH);
		expect(classifyFleetFailure(new Error("project quota exceeded"))).toBe(
			Health.QUOTA_EXHAUSTED,
		);
	});
});
