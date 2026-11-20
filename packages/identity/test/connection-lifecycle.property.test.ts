import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	CONNECTION_EVENTS,
	type ConnectionEvent,
	ConnectionService,
	createConnectionHealthChangedEvent,
	createInMemoryVault,
} from "../src/index.js";

const actor = { kind: "user" as const, id: "user:alice" };
const actions = [
	"authorize",
	"rotate",
	"needs-reauth",
	"revoke",
	"replay-created",
	"replay-authorized",
	"replay-health",
	"replay-needs-reauth",
	"replay-rotated",
] as const;

describe("connection revocation histories", () => {
	it("never revives a revoked connection through commands or late facts", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom(...actions), { minLength: 1, maxLength: 30 }),
				(history) => {
					const options = {
						tenant: "tenant-a",
						vault: createInMemoryVault({
							reference: "vaultref://fixture",
							rootSecret: "fixture-only",
						}),
						now: () => "2026-07-27T12:00:00.000Z",
					};
					let service = new ConnectionService(options);
					service.create({
						provider: "asana",
						alias: "work",
						subject: actor,
						createdBy: actor,
						scopes: ["tasks:read"],
						stationId: "station:test",
					});
					service.authorize({ idOrAlias: "work", actor });
					service.rotate({ idOrAlias: "work", actor });
					service.markNeedsReauth({ idOrAlias: "work", reason: "expired" });
					service.authorize({ idOrAlias: "work", actor });
					const fact = (type: ConnectionEvent["type"]) => {
						const found = service.events.find((event) => event.type === type);
						if (!found) throw new Error(`missing fixture fact ${type}`);
						return found;
					};
					const oldFacts = {
						"replay-created": fact(CONNECTION_EVENTS.Created),
						"replay-authorized": fact(CONNECTION_EVENTS.Authorized),
						"replay-health": createConnectionHealthChangedEvent({
							connectionId: service.get("work")?.id ?? "",
							tenant: "tenant-a",
							status: "active",
						}),
						"replay-needs-reauth": fact(CONNECTION_EVENTS.NeedsReauth),
						"replay-rotated": fact(CONNECTION_EVENTS.Rotated),
					};
					service.revoke({ idOrAlias: "work", actor, reason: "compromised" });
					for (const action of history) {
						const previousLength = service.events.length;
						if (action === "authorize") {
							expect(() =>
								service.authorize({ idOrAlias: "work", actor }),
							).toThrow(/revoked/);
							expect(service.events).toHaveLength(previousLength);
						} else if (action === "rotate") {
							expect(() =>
								service.rotate({ idOrAlias: "work", actor }),
							).toThrow(/revoked/);
							expect(service.events).toHaveLength(previousLength);
						} else if (action === "needs-reauth") {
							expect(() =>
								service.markNeedsReauth({ idOrAlias: "work", reason: "late" }),
							).toThrow(/revoked/);
							expect(service.events).toHaveLength(previousLength);
						} else if (action === "revoke") {
							service.revoke({ idOrAlias: "work", actor, reason: "again" });
						} else {
							const late = {
								...oldFacts[action],
								seq: (service.events.at(-1)?.seq ?? 0) + 1,
							};
							service = ConnectionService.fromEvents(
								[...service.events, late],
								options,
							);
						}
						expect(service.get("work")?.status).toBe("revoked");
						expect(
							service.resolveForToken({
								idOrAlias: "work",
								provider: "asana",
								subject: actor,
								scopes: ["tasks:read"],
							}),
						).toMatchObject({ status: "denied", code: "connection-revoked" });
					}
				},
			),
			{ seed: 614447, numRuns: 200 },
		);
	});
});
