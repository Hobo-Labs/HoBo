/**
 * The fleet's boundary contract, replayed.
 *
 * `contracts/pacts/postgres-fleet.pact.json` states what a reconciler may
 * expect of one backend's log and of a majority read. Each interaction is run
 * here against the same code the SQL backend and the reconciler use, so the
 * contract cannot drift from the behaviour it describes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type AssignmentEntry,
	type AssignmentReply,
	Health,
	parseMemberName,
} from "@hobo/fleet";
import {
	parseAssignmentEntry,
	resolveAssignment,
} from "@hobo/fleet/assignment";
import { describe, expect, it } from "vitest";
import { MemoryReplica } from "./fleet-model.js";

type WireEntry = Omit<
	AssignmentEntry,
	"active" | "target" | "lossWindowMs" | "members"
> & {
	readonly active?: string;
	readonly target?: string;
	readonly lossWindowMs?: number;
};
type WireReply =
	| { readonly replica: string; readonly rows: readonly WireEntry[] }
	| { readonly replica: string; readonly failure: "unreachable" };
type Interaction = {
	readonly description: string;
	readonly request: {
		readonly path: string;
		readonly body: {
			readonly held?: readonly WireEntry[];
			readonly entry?: WireEntry;
			readonly members?: readonly string[];
			readonly replies?: readonly WireReply[];
		};
	};
	readonly response: {
		readonly body: {
			readonly outcome?: string;
			readonly status?: string;
			readonly epoch?: number;
			readonly active?: string;
		};
	};
};
type Pact = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly Interaction[];
};

// SAFETY: the pact is this package's own checked-in contract with this shape.
const pact = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("../contracts/pacts/postgres-fleet.pact.json", import.meta.url),
		),
		"utf8",
	),
) as Pact;

function fromWire(entry: WireEntry): AssignmentEntry {
	return parseAssignmentEntry({
		...entry,
		active:
			entry.active === undefined ? undefined : parseMemberName(entry.active),
		target:
			entry.target === undefined ? undefined : parseMemberName(entry.target),
		lossWindowMs: entry.lossWindowMs,
		members: undefined,
	});
}

describe("fleet boundary contract", () => {
	it("names both sides and has interactions", () => {
		expect(pact.consumer.name).toBe("hobo-database-fleet-reconciler");
		expect(pact.provider.name).toBe("hobo-postgres-fleet-backend");
		expect(pact.interactions.length).toBeGreaterThanOrEqual(8);
	});

	for (const interaction of pact.interactions)
		it(interaction.description, () => {
			const { body } = interaction.request;
			const expected = interaction.response.body;
			if (interaction.request.path === "/fleet/assignments/accept") {
				const replica = new MemoryReplica(parseMemberName("a"));
				for (const held of body.held ?? []) replica.rows.push(fromWire(held));
				if (body.entry === undefined) throw new Error("pact has no entry");
				expect(replica.apply(fromWire(body.entry))).toBe(expected.outcome);
				return;
			}
			expect(interaction.request.path).toBe("/fleet/assignments/resolve");
			const replies = (body.replies ?? []).map(
				(reply): AssignmentReply =>
					"rows" in reply
						? {
								replica: parseMemberName(reply.replica),
								rows: reply.rows.map(fromWire),
							}
						: {
								replica: parseMemberName(reply.replica),
								failure: Health.UNREACHABLE,
							},
			);
			const resolution = resolveAssignment(
				(body.members ?? []).map((name) => parseMemberName(name)),
				replies,
			);
			expect(resolution.status).toBe(expected.status);
			if (resolution.status === "current") {
				expect(resolution.assignment.epoch).toBe(expected.epoch);
				expect(resolution.assignment.active).toBe(expected.active);
			}
			if (resolution.status === "undecided")
				expect(resolution.epoch).toBe(expected.epoch);
		});
});
