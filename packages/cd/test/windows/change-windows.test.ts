// createChangeWindows (D10, I17): governed definitions and overrides, FREEZE
// over ALLOW, DST-correct evaluation, fail-closed on anything undecidable.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type ChangeWindowRecord,
	ChangeWindowRecordSchema,
	SelectorRecordSchema,
	WindowKind,
	WindowOverrideRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import type { DeltaIntent } from "../../src/ports.js";
import {
	createChangeWindows,
	parseChangeWindow,
	WINDOW_METRIC,
	WINDOW_REASON,
} from "../../src/windows/index.js";
import {
	AGENT,
	clock,
	context,
	HOUR,
	MemoryEventStore,
	RecordingAuthorizer,
	RecordingTelemetry,
	TENANT,
} from "../pipelines/fakes.js";

function window(fields: Partial<Omit<ChangeWindowRecord, "$typeName">>): ChangeWindowRecord {
	return create(ChangeWindowRecordSchema, {
		kind: WindowKind.FREEZE,
		timezone: "UTC",
		rollbackAllowed: true,
		...fields,
	});
}

function setup(start = Date.parse("2026-11-12T12:00:00Z")) {
	const c = clock(start);
	const store = new MemoryEventStore(c.now);
	const authorizer = new RecordingAuthorizer();
	const telemetry = new RecordingTelemetry();
	const windows = createChangeWindows({ store, tenant: TENANT, now: c.now, authorizer, telemetry });
	const ctx = context(c.now);
	const evaluate = (atIso: string, names: readonly string[], intent: DeltaIntent = "promote", campId = "prod-1", labels: Record<string, string> = {}) =>
		windows.evaluate({ campId: campId as never, labels, envType: "production", windowNames: names, atMs: Date.parse(atIso), intent });
	return { c, store, authorizer, telemetry, windows, ctx, evaluate };
}

describe("define", () => {
	it("records window.Defined once per distinct definition, stamped with the principal", async () => {
		const { windows, ctx, store, telemetry } = setup();
		const w = window({ name: "holiday", startsAt: "2026-12-20T00:00:00Z", endsAt: "2027-01-02T00:00:00Z" });
		const first = await windows.define(w, ctx);
		const again = await windows.define(w, ctx);
		expect(first.ok && again.ok).toBe(true);
		expect(store.events(CD_EVENTS.WindowDefined)).toHaveLength(1);
		if (first.ok) expect(first.value.definedBy).toBe("user:ops@acme");
		expect(await windows.list()).toHaveLength(1);
		expect(telemetry.named(WINDOW_METRIC.defined)).toHaveLength(1);
	});

	it("refuses an invalid window with every problem and a remediation", async () => {
		const { windows, ctx } = setup();
		const result = await windows.define(
			window({ name: "Bad Name", kind: WindowKind.UNSPECIFIED, timezone: "Mars/Olympus", startsAt: "yesterday", rrule: "FREQ=SECONDLY" }),
			ctx,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const codes = result.reasons.map((r) => r.code);
			expect(codes).toContain(WINDOW_REASON.invalid);
			expect(codes).toContain(WINDOW_REASON.timezoneInvalid);
			expect(codes).toContain(WINDOW_REASON.rruleInvalid);
			expect(result.reasons.every((r) => r.remediation !== "")).toBe(true);
		}
	});

	it("is governed: a proposal-only agent cannot define, a denied action is refused", async () => {
		const { windows, c, authorizer } = setup();
		const w = window({ name: "nightly", startsAt: "2026-11-12T00:00:00Z", endsAt: "2026-11-13T00:00:00Z" });
		const agent = await windows.define(w, context(c.now, AGENT));
		expect(!agent.ok && agent.reasons[0]?.code).toBe(WINDOW_REASON.proposalOnly);
		authorizer.deny.add("window.define");
		const denied = await windows.define(w, context(c.now));
		expect(!denied.ok && denied.reasons[0]?.code).toBe(WINDOW_REASON.unauthorized);
		expect(authorizer.calls.every((call) => call.action === "window.define")).toBe(true);
	});

	it("parses documents with rollback allowed by default (D10)", () => {
		const parsed = parseChangeWindow({ name: "q4", kind: "WINDOW_KIND_FREEZE", timezone: "UTC", startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-02T00:00:00Z" });
		expect(parsed.ok && parsed.value.rollbackAllowed).toBe(true);
		const strict = parseChangeWindow({ name: "q4", kind: "WINDOW_KIND_FREEZE", timezone: "UTC", startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-02T00:00:00Z", rollbackAllowed: false });
		expect(strict.ok && strict.value.rollbackAllowed).toBe(false);
		expect(parseChangeWindow("nope").ok).toBe(false);
	});
});

describe("evaluate", () => {
	it("FREEZE dominates ALLOW", async () => {
		const { windows, ctx, evaluate } = setup();
		await windows.define(window({ name: "business-hours", kind: WindowKind.ALLOW, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9", durationMs: BigInt(8 * HOUR), startsAt: "2026-11-02T09:00:00Z" }), ctx);
		await windows.define(window({ name: "launch", startsAt: "2026-11-12T10:00:00Z", endsAt: "2026-11-12T14:00:00Z" }), ctx);
		const both = await evaluate("2026-11-12T12:00:00Z", ["business-hours", "launch"]);
		expect(both).toMatchObject({ open: false, activeFreezes: ["launch"] });
		expect(both.nextOpenAtMs).toBe(Date.parse("2026-11-12T14:00:00Z"));
		expect((await evaluate("2026-11-12T15:00:00Z", ["business-hours", "launch"])).open).toBe(true);
	});

	it("an ALLOW window permits change only inside an occurrence and names the next opening", async () => {
		const { windows, ctx, evaluate } = setup();
		await windows.define(window({ name: "business-hours", kind: WindowKind.ALLOW, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9", durationMs: BigInt(8 * HOUR), startsAt: "2026-11-02T09:00:00Z" }), ctx);
		const saturday = await evaluate("2026-11-14T12:00:00Z", ["business-hours"]);
		expect(saturday.open).toBe(false);
		expect(saturday.nextOpenAtMs).toBe(Date.parse("2026-11-16T09:00:00Z"));
		expect((await evaluate("2026-11-13T16:59:59Z", ["business-hours"])).open).toBe(true);
		expect((await evaluate("2026-11-13T17:00:00Z", ["business-hours"])).open).toBe(false);
	});

	it("evaluates an America/Chicago weekend freeze DST-correctly (golden)", async () => {
		const { windows, ctx, evaluate } = setup();
		// Friday 17:00 local for 63 h; the 2026-03-06 occurrence spans the spring-forward night.
		await windows.define(window({ name: "weekend", timezone: "America/Chicago", rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0", durationMs: BigInt(63 * HOUR), startsAt: "2026-01-02T23:00:00Z" }), ctx);
		expect((await evaluate("2026-03-06T22:59:59Z", ["weekend"])).open).toBe(true);
		expect((await evaluate("2026-03-06T23:00:00Z", ["weekend"])).open).toBe(false);
		const closed = await evaluate("2026-03-08T12:00:00Z", ["weekend"]);
		expect(closed.nextOpenAtMs).toBe(Date.parse("2026-03-09T14:00:00Z"));
		// After the transition the freeze starts at 17:00 CDT = 22:00Z.
		expect((await evaluate("2026-03-13T21:59:59Z", ["weekend"])).open).toBe(true);
		expect((await evaluate("2026-03-13T22:00:00Z", ["weekend"])).open).toBe(false);
	});

	it("evaluates a Europe/London nightly freeze DST-correctly (golden)", async () => {
		const { windows, ctx, evaluate } = setup();
		await windows.define(window({ name: "nightly", timezone: "Europe/London", rrule: "FREQ=DAILY;BYHOUR=0;BYMINUTE=30", durationMs: BigInt(2 * HOUR), startsAt: "2026-03-01T00:30:00Z" }), ctx);
		// GMT: 00:30Z–02:30Z.
		expect((await evaluate("2026-03-28T00:30:00Z", ["nightly"])).open).toBe(false);
		expect((await evaluate("2026-03-28T02:30:00Z", ["nightly"])).open).toBe(true);
		// BST from 2026-03-29: 00:30 local = 23:30Z the evening before; 2 h exact.
		expect((await evaluate("2026-03-29T23:30:00Z", ["nightly"])).open).toBe(false);
		expect((await evaluate("2026-03-30T01:29:59Z", ["nightly"])).open).toBe(false);
		expect((await evaluate("2026-03-30T01:30:00Z", ["nightly"])).open).toBe(true);
		// Back to GMT after 2026-10-25.
		expect((await evaluate("2026-10-26T00:29:59Z", ["nightly"])).open).toBe(true);
		expect((await evaluate("2026-10-26T00:30:00Z", ["nightly"])).open).toBe(false);
	});

	it("allows rollback through a freeze unless the freeze forbids it", async () => {
		const { windows, ctx, evaluate } = setup();
		await windows.define(window({ name: "soft", startsAt: "2026-11-12T10:00:00Z", endsAt: "2026-11-12T14:00:00Z", rollbackAllowed: true }), ctx);
		expect(await evaluate("2026-11-12T12:00:00Z", ["soft"], "rollback")).toMatchObject({ open: true, rollbackAllowed: true });
		await windows.define(window({ name: "hard", startsAt: "2026-11-12T10:00:00Z", endsAt: "2026-11-12T14:00:00Z", rollbackAllowed: false }), ctx);
		expect(await evaluate("2026-11-12T12:00:00Z", ["soft", "hard"], "rollback")).toMatchObject({ open: false, rollbackAllowed: false });
	});

	it("fails closed on a named window that does not exist", async () => {
		const { evaluate } = setup();
		const result = await evaluate("2026-11-12T12:00:00Z", ["typo"]);
		expect(result).toMatchObject({ open: false, activeFreezes: ["typo"] });
		expect(result.nextOpenAtMs).toBeUndefined();
	});

	it("applies an unnamed window only through a non-empty selector, and unknown dimensions narrow", async () => {
		const { windows, ctx, evaluate } = setup();
		await windows.define(window({ name: "template", startsAt: "2026-11-12T10:00:00Z", endsAt: "2026-11-12T14:00:00Z" }), ctx);
		expect((await evaluate("2026-11-12T12:00:00Z", [])).open).toBe(true);
		await windows.define(
			window({ name: "eu-freeze", selector: create(SelectorRecordSchema, { jurisdictions: ["EU"] }), startsAt: "2026-11-12T10:00:00Z", endsAt: "2026-11-12T14:00:00Z" }),
			ctx,
		);
		expect((await evaluate("2026-11-12T12:00:00Z", [], "promote", "prod-1", { "hobo.cd/jurisdiction": "US" })).open).toBe(true);
		expect((await evaluate("2026-11-12T12:00:00Z", [], "promote", "prod-1", { "hobo.cd/jurisdiction": "EU" })).open).toBe(false);
		// No jurisdiction label: a FREEZE with a jurisdiction selector still applies.
		expect((await evaluate("2026-11-12T12:00:00Z", [])).activeFreezes).toEqual(["eu-freeze"]);
	});

	it("fails closed when a window definition in the journal cannot be read", async () => {
		const { store, evaluate, telemetry } = setup();
		await store.seed("cd-window-corrupt", CD_EVENTS.WindowDefined, "not a record");
		const result = await evaluate("2026-11-12T12:00:00Z", []);
		expect(result).toMatchObject({ open: false, activeFreezes: ["corrupt"], rollbackAllowed: true });
		expect(telemetry.named(WINDOW_METRIC.unreadable)).toHaveLength(1);
	});

	it("I17: no apply while a window is closed, except a permitted rollback or a recorded override", async () => {
		const { windows, ctx, evaluate, c } = setup();
		await windows.define(window({ name: "freeze", startsAt: "2026-11-12T10:00:00Z", endsAt: "2026-11-13T10:00:00Z" }), ctx);
		for (const intent of ["promote", "config", "drift-remediate", "failover", "posture-remediate"] as const)
			expect((await evaluate("2026-11-12T12:00:00Z", ["freeze"], intent)).open, intent).toBe(false);
		expect((await evaluate("2026-11-12T12:00:00Z", ["freeze"], "rollback")).open).toBe(true);
		await windows.override(
			create(WindowOverrideRecordSchema, { window: "freeze", campIds: ["prod-1"], reason: "hotfix INC-42", expiresAt: new Date(c.now() + HOUR).toISOString() }),
			ctx,
		);
		expect(await evaluate("2026-11-12T12:30:00Z", ["freeze"])).toMatchObject({ open: true, overrides: ["freeze"] });
	});
});

describe("override", () => {
	it("is governed, expiring, scoped to its Camps and recorded with the decision", async () => {
		const { windows, ctx, c, store, evaluate, telemetry } = setup();
		await windows.define(window({ name: "freeze", startsAt: "2026-11-12T10:00:00Z", endsAt: "2026-11-13T10:00:00Z" }), ctx);
		const granted = await windows.override(
			create(WindowOverrideRecordSchema, { window: "freeze", campIds: ["prod-1"], reason: "INC-42", expiresAt: new Date(c.now() + 2 * HOUR).toISOString() }),
			ctx,
		);
		expect(granted.ok).toBe(true);
		if (granted.ok) expect(granted.value).toMatchObject({ grantedBy: "user:ops@acme", decisionId: "dec-2" });
		expect(store.events(CD_EVENTS.WindowOverridden)).toHaveLength(1);
		expect((await evaluate("2026-11-12T13:00:00Z", ["freeze"], "promote", "prod-2")).open).toBe(false);
		expect((await evaluate("2026-11-12T13:59:59Z", ["freeze"])).open).toBe(true);
		expect((await evaluate("2026-11-12T14:00:00Z", ["freeze"])).open).toBe(false);
		expect(telemetry.named(WINDOW_METRIC.overridden)).toHaveLength(1);
	});

	it("refuses overrides longer than four hours, expired, unscoped, unexplained, unknown or by an agent", async () => {
		const { windows, ctx, c } = setup();
		await windows.define(window({ name: "freeze", startsAt: "2026-11-12T10:00:00Z", endsAt: "2026-11-13T10:00:00Z" }), ctx);
		const base = { window: "freeze", campIds: ["prod-1"], reason: "INC", expiresAt: new Date(c.now() + HOUR).toISOString() };
		const cases: [Partial<typeof base>, string, boolean?][] = [
			[{ expiresAt: new Date(c.now() + 4 * HOUR + 1).toISOString() }, WINDOW_REASON.overrideTooLong],
			[{ expiresAt: new Date(c.now() - 1).toISOString() }, WINDOW_REASON.overrideInvalid],
			[{ campIds: [] }, WINDOW_REASON.overrideInvalid],
			[{ reason: " " }, WINDOW_REASON.overrideInvalid],
			[{ window: "nope" }, WINDOW_REASON.notFound],
			[{}, WINDOW_REASON.proposalOnly, true],
		];
		for (const [patch, code, asAgent] of cases) {
			const result = await windows.override(create(WindowOverrideRecordSchema, { ...base, ...patch }), asAgent ? context(c.now, AGENT) : ctx);
			expect(!result.ok && result.reasons[0]?.code, code).toBe(code);
		}
	});
});
