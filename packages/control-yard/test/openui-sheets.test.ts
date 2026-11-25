/**
 * Schema-derived sheets and the confirm path back into management ops.
 *
 * These sheets are the UI's whole write surface: every mutation a user can make
 * from the yard goes through `confirmSheet`. That makes two things worth
 * pinning that a reading of the code will not settle.
 *
 * **The confirm mapping is a dispatch on a string.** Each sheet declares which
 * management op its confirm calls, and `confirmSheet` switches on it. A wrong
 * arm here does not fail — it calls a *different real operation* with the user's
 * values. Confirming a rail approval that actually activates is the shape of
 * that bug, and nothing in the UI would look wrong. So every arm gets a test
 * asserting which handler ran and what it received.
 *
 * **The sheets must render before there is state.** Every one takes an optional
 * snapshot, because the yard draws before the projection lands. A sheet that
 * assumed state would throw during first paint, and the failure would look like
 * the whole surface being broken rather than one panel arriving early. So each
 * sheet is built twice: with a snapshot and without.
 *
 * The optional-value handling in `connectionCreate` gets particular attention.
 * Alias and scopes are omitted rather than sent empty, and the difference is
 * not cosmetic: an empty alias would name a connection `""`, and an empty scope
 * array is a different request than no scopes at all.
 */

import type { ManagementResult } from "@hobo/management";
import { describe, expect, it } from "vitest";

import {
	confirmSheet,
	type GenerativeSheet,
	type SheetConfirmHandlers,
	sheetForConnectionAuthorize,
	sheetForConnectionCreate,
	sheetForCostBooth,
	sheetForDoctor,
	sheetForRailLifecycle,
	streamSheet,
} from "../src/openui/sheets.js";

function snapshot(overrides: Record<string, unknown> = {}) {
	return {
		occupancy: { stationId: "station:acme", seq: 1 },
		rails: [{ contentHash: "rail-aaa" }, { contentHash: "rail-bbb" }],
		connections: [
			{ id: "conn-1", alias: "work", status: "active" },
			{ id: "conn-2", alias: "home", status: "pending" },
		],
		metering: { quotaUsed: 12, quotaLimit: 100, spendCapUsd: 40 },
		doctor: { hazards: ["station-closed"], hint: "reopen the station" },
		...overrides,
	} as never;
}

function fieldValue(sheet: GenerativeSheet, name: string) {
	return sheet.fields.find((f) => f.name === name)?.value;
}

/** Handlers that record which one ran and with what. */
function handlers() {
	const calls: { op: string; input: unknown }[] = [];
	const ok: ManagementResult = { ok: true, code: "HOBO_OK", message: "done" };
	const record = (op: string) => (input: unknown) => {
		calls.push({ op, input });
		return ok;
	};
	return {
		calls,
		handlers: {
			connectionCreate: record("connectionCreate"),
			connectionAuthorize: record("connectionAuthorize"),
			stationRailsActivate: record("stationRailsActivate"),
			stationRailsApprove: record("stationRailsApprove"),
			stationRailsPublish: record("stationRailsPublish"),
			doctorSnapshot: () => {
				calls.push({ op: "doctorSnapshot", input: undefined });
				return ok;
			},
		} as unknown as SheetConfirmHandlers,
	};
}

describe("every sheet renders without a projection", () => {
	// The yard draws before the projection lands. A sheet that assumed state
	// would throw during first paint, and that reads as the whole surface being
	// broken rather than one panel arriving early.
	const builders = [
		["connection.create", () => sheetForConnectionCreate()],
		["connection.authorize", () => sheetForConnectionAuthorize("conn-1")],
		["rail.lifecycle", () => sheetForRailLifecycle()],
		["cost.plan", () => sheetForCostBooth()],
		["doctor.hazards", () => sheetForDoctor()],
	] as const;

	for (const [kind, build] of builders) {
		it(`builds ${kind} from nothing`, () => {
			const sheet = build();
			expect(sheet.kind).toBe(kind);
			expect(sheet.fields.length).toBeGreaterThan(0);
			expect(sheet.streamChunks.length).toBeGreaterThan(0);
		});
	}

	it("gives every sheet a confirm op that confirmSheet can dispatch", () => {
		// A sheet whose confirmOp has no arm would fall to the exhaustive default
		// and return an error the user cannot act on. TypeScript catches a bad
		// literal; it does not catch a sheet nobody wired up.
		const { calls, handlers: h } = handlers();
		for (const [, build] of builders) {
			confirmSheet(build(), {}, h);
		}
		expect(calls).toHaveLength(builders.length);
	});
});

describe("the connection create sheet", () => {
	it("falls back to the local station when there is no projection", () => {
		// Leaving this blank would submit a connection scoped to no station, and
		// the failure would surface far from the form.
		expect(fieldValue(sheetForConnectionCreate(), "stationId")).toBe(
			"station:local",
		);
	});

	it("shows the real station once the projection lands", () => {
		expect(fieldValue(sheetForConnectionCreate(snapshot()), "stationId")).toBe(
			"station:acme",
		);
	});

	it("marks the station read-only so the form cannot retarget it", () => {
		// A connection belongs to the station the user is looking at. An editable
		// field here would let them create it somewhere they are not.
		const field = sheetForConnectionCreate().fields.find(
			(f) => f.name === "stationId",
		);
		expect(field?.type).toBe("readonly");
	});

	it("requires a provider", () => {
		const field = sheetForConnectionCreate().fields.find(
			(f) => f.name === "provider",
		);
		expect(field?.required).toBe(true);
	});
});

describe("the connection authorize sheet", () => {
	it("finds the connection by id", () => {
		const sheet = sheetForConnectionAuthorize("conn-2", snapshot());
		expect(fieldValue(sheet, "status")).toBe("pending");
	});

	it("finds the connection by alias too", () => {
		// The user types whichever they remember. Supporting only ids would make
		// the alias decorative.
		const sheet = sheetForConnectionAuthorize("home", snapshot());
		expect(fieldValue(sheet, "status")).toBe("pending");
	});

	it("says unknown rather than blank for a connection it cannot find", () => {
		// A blank status reads as "not yet loaded", which invites the user to wait
		// for something that is never going to arrive.
		const sheet = sheetForConnectionAuthorize("ghost", snapshot());
		expect(fieldValue(sheet, "status")).toBe("unknown");
	});

	it("says unknown when there is no projection at all", () => {
		expect(fieldValue(sheetForConnectionAuthorize("conn-1"), "status")).toBe(
			"unknown",
		);
	});

	it("echoes what the user asked to authorize", () => {
		const sheet = sheetForConnectionAuthorize("conn-1", snapshot());
		expect(fieldValue(sheet, "idOrAlias")).toBe("conn-1");
		expect(sheet.description).toContain("conn-1");
	});
});

describe("the rail lifecycle sheet", () => {
	it("offers every known rail", () => {
		const field = sheetForRailLifecycle(snapshot()).fields.find(
			(f) => f.name === "hashOrId",
		);
		expect(field?.options).toEqual(["rail-aaa", "rail-bbb"]);
	});

	it("preselects the first rail", () => {
		// A select with no value submits empty and the op fails on a rail that was
		// visibly listed right above the button.
		expect(fieldValue(sheetForRailLifecycle(snapshot()), "hashOrId")).toBe(
			"rail-aaa",
		);
	});

	it("offers nothing rather than a stale option when no rails exist", () => {
		const field = sheetForRailLifecycle().fields.find(
			(f) => f.name === "hashOrId",
		);
		expect(field?.options).toEqual([]);
		expect(field?.value).toBe("");
	});

	it("offers approve and activate as the two lifecycle moves", () => {
		const field = sheetForRailLifecycle(snapshot()).fields.find(
			(f) => f.name === "action",
		);
		expect(field?.options).toEqual(["approve", "activate"]);
	});
});

describe("the cost booth sheet", () => {
	it("reads the metering projection", () => {
		const sheet = sheetForCostBooth(snapshot());
		expect(fieldValue(sheet, "quotaUsed")).toBe(12);
		expect(fieldValue(sheet, "quotaLimit")).toBe(100);
		expect(fieldValue(sheet, "spendCapUsd")).toBe(40);
	});

	it("shows zeros rather than blanks before the projection lands", () => {
		// A blank spend cap in a cost panel is ambiguous between "none set" and
		// "not loaded". Zero is at least a number the operator can question.
		expect(fieldValue(sheetForCostBooth(), "spendCapUsd")).toBe(0);
	});

	it("is entirely read-only", () => {
		// The booth reports the rail's billing policy; it does not set it. An
		// editable field would imply the user can raise their own spend cap here.
		expect(
			sheetForCostBooth(snapshot()).fields.every((f) => f.type === "readonly"),
		).toBe(true);
	});
});

describe("the doctor sheet", () => {
	it("lists the hazards", () => {
		expect(fieldValue(sheetForDoctor(snapshot()), "hazards")).toBe(
			"station-closed",
		);
	});

	it("joins several hazards into one readable line", () => {
		const sheet = sheetForDoctor(
			snapshot({ doctor: { hazards: ["a", "b"], hint: "" } }),
		);
		expect(fieldValue(sheet, "hazards")).toBe("a, b");
	});

	it("says none explicitly rather than showing an empty field", () => {
		// "(none)" is a health report. An empty field is indistinguishable from a
		// panel that failed to load, which is the opposite reassurance.
		const sheet = sheetForDoctor(
			snapshot({ doctor: { hazards: [], hint: "" } }),
		);
		expect(fieldValue(sheet, "hazards")).toBe("(none)");
	});

	it("says none when there is no projection either", () => {
		expect(fieldValue(sheetForDoctor(), "hazards")).toBe("(none)");
	});

	it("shows the hint when there is one", () => {
		expect(fieldValue(sheetForDoctor(snapshot()), "hint")).toBe(
			"reopen the station",
		);
	});
});

describe("streaming a sheet", () => {
	it("emits each chunk before the sheet itself", () => {
		// The chunks exist so the panel has something to show while it assembles.
		// Emitting the sheet first would make them pointless.
		const sheet = sheetForCostBooth();
		const events = [...streamSheet(sheet)];
		expect(events.slice(0, -1).every((e) => e.type === "chunk")).toBe(true);
		expect(events.at(-1)).toEqual({ type: "done", sheet });
	});

	it("emits every chunk the sheet declares", () => {
		const sheet = sheetForConnectionCreate();
		const chunks = [...streamSheet(sheet)]
			.filter((e) => e.type === "chunk")
			.map((e) => e.text);
		expect(chunks).toEqual([...sheet.streamChunks]);
	});

	it("still finishes for a sheet with no chunks", () => {
		// The done event is what the panel waits on. Skipping it would leave the
		// UI spinning forever on a sheet that had nothing to narrate.
		const sheet = { ...sheetForCostBooth(), streamChunks: [] };
		expect([...streamSheet(sheet)]).toEqual([{ type: "done", sheet }]);
	});
});

describe("confirming a sheet", () => {
	it("routes each sheet to its own management op", () => {
		// This is the mapping that matters most: a wrong arm calls a different
		// real operation with the user's values, and nothing in the UI looks
		// wrong. Confirming an approval that actually activates is that bug.
		const cases = [
			[sheetForConnectionCreate(), "connectionCreate"],
			[sheetForConnectionAuthorize("c"), "connectionAuthorize"],
			[sheetForRailLifecycle(), "stationRailsActivate"],
			[sheetForCostBooth(), "doctorSnapshot"],
			[sheetForDoctor(), "doctorSnapshot"],
		] as const;
		for (const [sheet, op] of cases) {
			const { calls, handlers: h } = handlers();
			confirmSheet(sheet, {}, h);
			expect(calls[0]?.op).toBe(op);
		}
	});

	it("passes the provider through on create", () => {
		const { calls, handlers: h } = handlers();
		confirmSheet(sheetForConnectionCreate(), { provider: "asana" }, h);
		expect(calls[0]?.input).toEqual({ provider: "asana" });
	});

	it("omits an absent alias rather than sending an empty one", () => {
		// An empty alias would name the connection "", which then shows as a blank
		// row the user cannot refer to.
		const { calls, handlers: h } = handlers();
		confirmSheet(
			sheetForConnectionCreate(),
			{ provider: "asana", alias: "" },
			h,
		);
		expect(calls[0]?.input).not.toHaveProperty("alias");
	});

	it("omits absent scopes rather than sending an empty list", () => {
		// No scopes and an empty scope list are different requests: one takes the
		// provider's default grant, the other asks for nothing at all.
		const { calls, handlers: h } = handlers();
		confirmSheet(
			sheetForConnectionCreate(),
			{ provider: "asana", scopes: "" },
			h,
		);
		expect(calls[0]?.input).not.toHaveProperty("scopes");
	});

	it("splits scopes on commas and trims them", () => {
		// The field is free text with a comma hint, so users leave spaces. An
		// untrimmed " write" is not the scope the provider knows.
		const { calls, handlers: h } = handlers();
		confirmSheet(
			sheetForConnectionCreate(),
			{ provider: "asana", scopes: "read, write , admin" },
			h,
		);
		expect((calls[0]?.input as { scopes: string[] }).scopes).toEqual([
			"read",
			"write",
			"admin",
		]);
	});

	it("drops empty entries left by a trailing comma", () => {
		// Requesting an empty-string scope is a rejection from most providers, and
		// the user's real mistake was a stray keystroke.
		const { calls, handlers: h } = handlers();
		confirmSheet(
			sheetForConnectionCreate(),
			{ provider: "asana", scopes: "read,,write," },
			h,
		);
		expect((calls[0]?.input as { scopes: string[] }).scopes).toEqual([
			"read",
			"write",
		]);
	});

	it("sends an empty provider rather than guessing one", () => {
		// The op decides what to do about a missing provider. Substituting a
		// default here would create a connection to something nobody chose.
		const { calls, handlers: h } = handlers();
		confirmSheet(sheetForConnectionCreate(), {}, h);
		expect(calls[0]?.input).toEqual({ provider: "" });
	});

	it("carries the station through when the form supplies one", () => {
		const { calls, handlers: h } = handlers();
		confirmSheet(
			sheetForConnectionCreate(),
			{ provider: "asana", stationId: "station:acme" },
			h,
		);
		expect(calls[0]?.input).toMatchObject({ stationId: "station:acme" });
	});

	it("passes the rail hash through on a lifecycle confirm", () => {
		const { calls, handlers: h } = handlers();
		confirmSheet(sheetForRailLifecycle(), { hashOrId: "rail-aaa" }, h);
		expect(calls[0]?.input).toEqual({ hashOrId: "rail-aaa" });
	});

	it("dispatches an approve sheet to approve, not activate", () => {
		// The two rail ops differ in consequence: approving records assent,
		// activating puts the rail in the path of live traffic.
		const { calls, handlers: h } = handlers();
		confirmSheet(
			{ ...sheetForRailLifecycle(), confirmOp: "stationRailsApprove" },
			{ hashOrId: "rail-aaa" },
			h,
		);
		expect(calls[0]?.op).toBe("stationRailsApprove");
	});

	it("hands a publish sheet its whole value set", () => {
		// Publish takes an open-ended rail document rather than named fields, so
		// narrowing it here would silently drop policy the user authored.
		const { calls, handlers: h } = handlers();
		const values = { name: "main", budgetUsd: 100 };
		confirmSheet(
			{ ...sheetForRailLifecycle(), confirmOp: "stationRailsPublish" },
			values,
			h,
		);
		expect(calls[0]?.input).toEqual(values);
	});

	it("returns whatever the management op returned", () => {
		// The sheet is a form, not a policy layer. Rewriting the result would hide
		// a refusal the op made deliberately.
		const refusal: ManagementResult = {
			ok: false,
			code: "denied",
			message: "no",
		};
		const result = confirmSheet(sheetForDoctor(), {}, {
			doctorSnapshot: () => refusal,
		} as unknown as SheetConfirmHandlers);
		expect(result).toBe(refusal);
	});

	it("refuses a sheet whose confirm op it does not recognise", () => {
		// Reached only if a sheet is built with an op outside the union — a
		// hand-rolled sheet, or one from a newer build. Falling through to a real
		// handler would be far worse than an error.
		const result = confirmSheet(
			{ ...sheetForDoctor(), confirmOp: "somethingElse" } as never,
			{},
			handlers().handlers,
		);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("unknown-sheet-op");
	});
});
