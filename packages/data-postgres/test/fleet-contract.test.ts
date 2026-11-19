import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type FleetAssignment,
	parseFleetAssignment,
} from "@hobo/backend-fleet";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlAssignmentReplica } from "../src/fleet/assignment.js";
import { ensureFleetControlTables } from "../src/fleet/control.js";
import { parseFleetLayout } from "../src/fleet/layout.js";
import type { FleetBackend } from "../src/fleet/sql.js";
import { fleetTestExecutor } from "./fleet-postgres.js";

type WireEntry = Omit<FleetAssignment, "active" | "target" | "lossWindowMs"> & {
	readonly active?: string;
	readonly target?: string;
	readonly lossWindowMs?: number;
};
type Interaction = {
	readonly type: string;
	readonly description: string;
	readonly providerStates: readonly [
		{
			readonly name: string;
			readonly params: { readonly held: readonly WireEntry[] };
		},
	];
	readonly request: { readonly contents: { readonly content: WireEntry } };
	readonly response: readonly [
		{ readonly contents: { readonly content: string } },
	];
};
type Pact = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly metadata: {
		readonly transport: string;
		readonly pactSpecification: { readonly version: string };
	};
	readonly interactions: readonly Interaction[];
};

const pactPath = fileURLToPath(
	new URL("../contracts/pacts/postgres-fleet.pact.json", import.meta.url),
);
const pact: Pact = JSON.parse(readFileSync(pactPath, "utf8"));
const url = process.env.HOBO_TEST_POSTGRES_URL;
const layout = parseFleetLayout({
	dataPrefix: "pact_data_",
	controlPrefix: `fleet_pact_${process.pid}_`,
});

function fromWire(entry: WireEntry): FleetAssignment {
	return parseFleetAssignment({
		...entry,
		active: entry.active,
		target: entry.target,
		lossWindowMs: entry.lossWindowMs,
	});
}

describe("fleet library contract", () => {
	it("records the actual synchronous replica boundary", () => {
		expect(pact.metadata).toMatchObject({
			transport: "library-call",
			pactSpecification: { version: "4.0.0" },
		});
		expect(pact.interactions).toHaveLength(4);
		expect(
			pact.interactions.every(
				(interaction) => interaction.type === "Synchronous/Messages",
			),
		).toBe(true);
	});
});

describe.skipIf(!url)("PostgreSQL fleet replica contract", () => {
	let pool: Pool;
	let backend: FleetBackend;
	beforeAll(async () => {
		pool = new Pool({ connectionString: url, max: 8 });
		backend = { id: "a", executor: fleetTestExecutor(pool) };
		await ensureFleetControlTables(backend, layout);
	});
	afterAll(async () => {
		if (!pool) return;
		await pool.query(
			`DROP TABLE IF EXISTS ${layout.usageObservationsTable}, ${layout.usageTable}, ${layout.watermarkTable}, ${layout.assignmentTable}`,
		);
		await pool.end();
	});

	async function seed(held: readonly WireEntry[]) {
		await pool.query(`TRUNCATE ${layout.assignmentTable}`);
		const replica = sqlAssignmentReplica(backend, layout);
		for (const entry of held) {
			expect(await replica.accept(fromWire(entry))).toBe("accepted");
		}
	}

	it.each(pact.interactions)("$description", async (interaction) => {
		await seed(interaction.providerStates[0].params.held);
		const replica = sqlAssignmentReplica(backend, layout);
		expect(
			await replica.accept(fromWire(interaction.request.contents.content)),
		).toBe(interaction.response[0].contents.content);
	});

	it("verifies recorded requests with the Pact provider verifier", async () => {
		const verified = new Set<string>();
		const messageProvider = async (message: MessageDescriptor) => {
			if (message.content === undefined || Buffer.isBuffer(message.content))
				throw new Error("invalid assignment contract request");
			const input: WireEntry = JSON.parse(JSON.stringify(message.content));
			verified.add(message.description);
			return sqlAssignmentReplica(backend, layout).accept(fromWire(input));
		};
		const messageProviders = Object.fromEntries(
			pact.interactions.map(({ description }) => [
				description,
				messageProvider,
			]),
		);
		const stateHandlers = Object.fromEntries(
			pact.interactions.map(({ providerStates }) => [
				providerStates[0].name,
				async () => seed(providerStates[0].params.held),
			]),
		);
		await new Verifier({
			provider: pact.provider.name,
			pactUrls: [pactPath],
			messageProviders,
			stateHandlers,
			logLevel: "error",
			failIfNoPactsFound: true,
		}).verifyProvider();
		expect([...verified].sort()).toEqual(
			pact.interactions.map(({ description }) => description).sort(),
		);
	}, 30_000);
});
