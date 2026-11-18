import fc from "fast-check";
import { expect, it } from "vitest";
import {
	CONNECTION_EVENTS,
	ConnectionService,
	createInMemoryVault,
} from "../src/index.js";

it("refuses replay that gives one alias to different connection identities", () => {
	const actor = { kind: "user" as const, id: "user:alice" };
	const options = {
		tenant: "tenant-a",
		vault: createInMemoryVault({
			reference: "vaultref://fixture",
			rootSecret: "fixture-only",
		}),
	};
	const service = new ConnectionService(options);
	service.create({
		provider: "asana",
		alias: "work",
		subject: actor,
		createdBy: actor,
		stationId: "station:test",
	});
	service.authorize({ idOrAlias: "work", actor });
	service.revoke({ idOrAlias: "work", actor, reason: "retired" });
	const created = service.events.find(
		(event) => event.type === CONNECTION_EVENTS.Created,
	);
	expect(created).toBeDefined();
	if (!created) throw new Error("missing created event");
	const conflicting = {
		...created,
		seq: (service.events.at(-1)?.seq ?? 0) + 1,
		data: { ...created.data, connectionId: "conn_other" },
	};
	expect(() =>
		ConnectionService.fromEvents([...service.events, conflicting], options),
	).toThrow(/alias/i);
	const idCollision = {
		...conflicting,
		data: { ...conflicting.data, alias: created.data.connectionId },
	};
	expect(() =>
		ConnectionService.fromEvents([...service.events, idCollision], options),
	).toThrow(/alias/i);
	const aliasCollision = {
		...conflicting,
		data: { ...conflicting.data, connectionId: "work", alias: "different" },
	};
	expect(() =>
		ConnectionService.fromEvents([...service.events, aliasCollision], options),
	).toThrow(/id/i);
	expect(() =>
		service.create({
			provider: "asana",
			alias: String(created.data.connectionId),
			subject: actor,
			createdBy: actor,
			stationId: "station:test",
		}),
	).toThrow(/alias/i);
});

it("preserves unambiguous names across generated replayed creations", () => {
	fc.assert(
		fc.property(fc.integer({ min: 1, max: 1000000 }), (suffix) => {
			const actor = { kind: "user" as const, id: "user:alice" };
			const options = {
				tenant: "tenant-a",
				vault: createInMemoryVault({
					reference: "vaultref://fixture",
					rootSecret: "fixture-only",
				}),
			};
			const service = new ConnectionService(options);
			const alias = `work-${suffix}`;
			service.create({
				provider: "asana",
				alias,
				subject: actor,
				createdBy: actor,
				stationId: "station:test",
			});
			service.revoke({ idOrAlias: alias, actor, reason: "retired" });
			const created = service.events.find(
				(event) => event.type === CONNECTION_EVENTS.Created,
			);
			if (!created) throw new Error("missing created event");
			const seq = (service.events.at(-1)?.seq ?? 0) + 1;
			for (const data of [
				{ ...created.data, connectionId: `conn-other-${suffix}` },
				{
					...created.data,
					connectionId: `conn-other-${suffix}`,
					alias: created.data.connectionId,
				},
				{ ...created.data, connectionId: alias, alias: `fresh-${suffix}` },
			]) {
				expect(() =>
					ConnectionService.fromEvents(
						[...service.events, { ...created, seq, data }],
						options,
					),
				).toThrow();
			}
			const valid = {
				...created,
				seq,
				data: {
					...created.data,
					connectionId: `conn-other-${suffix}`,
					alias: `fresh-${suffix}`,
				},
			};
			const rebuilt = ConnectionService.fromEvents(
				[...service.events, valid],
				options,
			);
			expect(rebuilt.get(alias)?.status).toBe("revoked");
			expect(rebuilt.get(`fresh-${suffix}`)?.id).toBe(`conn-other-${suffix}`);
		}),
		{ seed: 614448, numRuns: 100 },
	);
});
