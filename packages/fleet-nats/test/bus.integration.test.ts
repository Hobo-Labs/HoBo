/**
 * `runBusConformance` on the real bus: the authority's connection to a
 * provisioned tenant on `nats-server` (TLS, operator mode, full resolver).
 * Also the journal store on the `FLEET_JOURNAL` stream `provisionTopology`
 * created, as the authority user, and the journal import against it.
 */
import type { PositionedEvent } from "@hobo/core";
import { runBusConformance } from "@hobo/fleet/testing";
import { credsAuthenticator } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { open } from "../src/bus/connection.js";
import { connectAuthorityBus } from "../src/bus/index.js";
import { importJournal } from "../src/journal/import.js";
import { journalTransportOver } from "../src/journal/nats.js";
import { openJournalStore } from "../src/journal/store.js";
import {
	requireBinary,
	SKIP_INTEGRATION,
	startNats,
	type TestNats,
} from "./support/nats-server.js";

describe.skipIf(SKIP_INTEGRATION)("the bus on nats-server", () => {
	let nats: TestNats | undefined;
	beforeAll(async () => {
		nats = await startNats();
	}, 60_000);
	afterAll(async () => {
		await nats?.stop();
	});

	it("has nats-server", () => {
		requireBinary();
	});

	runBusConformance(async () => {
		if (nats === undefined) throw new Error("nats-server did not start");
		return connectAuthorityBus({
			servers: [nats.url],
			credentials: nats.provisioned.staticCredentials.authority,
			trust: () => {
				throw new Error("no trust record published yet");
			},
			log: () => undefined,
		});
	});

	it("runs the journal store on the provisioned FLEET_JOURNAL as the authority, and imports into it idempotently", async () => {
		if (nats === undefined) throw new Error("nats-server did not start");
		const journal = () =>
			open({
				servers: [nats?.url ?? ""],
				authenticator: credsAuthenticator(
					new TextEncoder().encode(
						nats?.provisioned.staticCredentials.authority ?? "",
					),
				),
				name: "hobo-fleet-journal-test",
				persistent: false,
			}).then(journalTransportOver);
		const store = openJournalStore(await journal());
		const options = {
			actor: { kind: "service" as const, id: "fleet-journal-test" },
			tenant: nats.tenant,
		};
		await store.append(
			"fleet-member-a",
			[
				{ type: "fleet.EnrollmentRequested", data: { n: 1 } },
				{ type: "fleet.MemberActivated", data: { n: 2 } },
			],
			{ ...options, expectedSeq: 0 },
		);
		await store.append(
			"fleet-trust",
			[{ type: "fleet.TrustRotated", data: { sequence: 1 } }],
			{ ...options, expectedSeq: 0 },
		);
		const all: PositionedEvent[] = [];
		for await (const item of store.readAll()) all.push(item);
		expect(all.map((item) => item.event.seq)).toEqual([1, 2, 1]);
		await store.close();

		const importer = await journal();
		try {
			// The journal holds exactly this import: nothing to write.
			expect(await importJournal(importer, all)).toEqual({
				ok: true,
				value: { imported: 0, present: 3 },
			});
			// It holds more than this import: not a prefix, so a conflict.
			const shorter = await importJournal(importer, all.slice(0, 1));
			expect(shorter.ok).toBe(false);
			if (!shorter.ok) expect(shorter.error.code).toBe("conflict");
		} finally {
			await importer.close();
		}
	});
});
