/**
 * Replays `contracts/libsql-ephemeral-state.pact.json` from both sides.
 *
 * Consumer: the binding, driven through the port, must send exactly the
 * pact's statements and arguments, and turn the pact's rows into the port
 * results the scenario expects. Provider: a real libSQL database (a local
 * `file:` one, through `@libsql/client`) must answer every statement with the
 * pact's rows. The Hrana-over-HTTP envelope around these statements belongs
 * to `@libsql/client`, not to this package, and is not re-pinned here.
 */
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { libsqlStatements } from "../src/index.js";
import { temporaryDatabase } from "./fixtures/contexts.js";
import {
	decodeArg,
	encodeRows,
	loadStatementPact,
	replayClient,
} from "./fixtures/pact.js";
import { pactPort, runPactScenario } from "./fixtures/pact-scenario.js";

describe("libSQL ephemeral-state statement pact", () => {
	it("consumer: the binding sends exactly the pact's statements, in order", async () => {
		const interactions = loadStatementPact();
		const { client, sent } = replayClient(interactions);
		const observed = await runPactScenario(pactPort(client));

		expect(sent).toEqual(
			interactions.map((interaction) => interaction.request.statement),
		);
		expect(observed).toEqual([
			{ applied: true, version: "inc-1:1" },
			{ applied: false },
			{ value: '{"runner":"r-1"}', version: "inc-1:1" },
			{ applied: true, version: "inc-1:2" },
			false,
			[
				{
					value: '{"runner":"r-1","state":"dispatched"}',
					version: "inc-1:2",
				},
				undefined,
			],
			5,
			3,
			false,
			true,
		]);
	});

	it("provider: a libSQL database answers every statement with the pact's rows", async () => {
		const database = temporaryDatabase();
		const client = createClient({ url: database.url });
		try {
			await client.batch(
				libsqlStatements("hobo_ephemeral_state").schema.map((sql) => ({
					sql,
					args: [],
				})),
				"write",
			);
			for (const interaction of loadStatementPact()) {
				const { sql, args } = interaction.request.statement;
				const result = await client.execute({ sql, args: args.map(decodeArg) });
				expect(encodeRows(result), interaction.description).toEqual(
					interaction.response.rows,
				);
			}
		} finally {
			client.close();
			database.remove();
		}
	});
});
