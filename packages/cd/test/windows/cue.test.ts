// data-models/windows.cue and the parse boundary agree: what the service
// records vets clean, and the single-record rules the parser refuses, CUE
// refuses too.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ChangeWindowRecordSchema,
	WindowKind,
	WindowOverrideRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import { compileWindow, createChangeWindows } from "../../src/windows/index.js";
import { jsonOf } from "../../src/windows/journal.js";
import { cue, vets } from "../pipelines/cue.js";
import {
	clock,
	context,
	HOUR,
	MemoryEventStore,
	RecordingAuthorizer,
	TENANT,
} from "../pipelines/fakes.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = resolve(here, "../../data-models/windows.cue");

type WindowInit = Parameters<typeof create<typeof ChangeWindowRecordSchema>>[1];
const window = (fields: WindowInit) => create(ChangeWindowRecordSchema, fields);

describe.skipIf(cue === undefined)(
	"windows.cue agrees with the parse boundary (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it("vets what the service records: window.Defined and window.Overridden bodies", async () => {
			const c = clock(Date.parse("2026-11-12T12:00:00Z"));
			const store = new MemoryEventStore(c.now);
			const windows = createChangeWindows({
				store,
				tenant: TENANT,
				now: c.now,
				authorizer: new RecordingAuthorizer(),
			});
			const ctx = context(c.now);
			const defined = [
				window({
					name: "weekend",
					kind: WindowKind.FREEZE,
					timezone: "America/Chicago",
					rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0",
					durationMs: BigInt(63 * HOUR),
					startsAt: "2026-01-02T23:00:00Z",
					rollbackAllowed: true,
				}),
				window({
					name: "business",
					kind: WindowKind.ALLOW,
					timezone: "Europe/London",
					rrule: "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=12",
					durationMs: BigInt(HOUR),
					startsAt: "2026-01-01T09:00:00Z",
					selector: { envTypes: ["production"], labels: { tier: "web" } },
				}),
				window({
					name: "any-order",
					kind: WindowKind.FREEZE,
					timezone: "UTC",
					rrule: "INTERVAL=2;FREQ=DAILY",
					durationMs: BigInt(HOUR),
					startsAt: "2026-11-01T00:00:00Z",
				}),
				window({
					name: "launch",
					kind: WindowKind.FREEZE,
					timezone: "UTC",
					startsAt: "2026-11-12T10:00:00Z",
					endsAt: "2026-11-13T10:00:00Z",
				}),
			];
			for (const record of defined)
				expect((await windows.define(record, ctx)).ok).toBe(true);
			expect(
				(
					await windows.override(
						create(WindowOverrideRecordSchema, {
							window: "launch",
							campIds: ["prod-1"],
							reason: "INC-42",
							expiresAt: new Date(c.now() + HOUR).toISOString(),
						}),
						ctx,
					)
				).ok,
			).toBe(true);
			for (const event of store.events(CD_EVENTS.WindowDefined))
				expect(vets(schema, "#ChangeWindow", jsonOf(event.data) ?? null)).toBe(
					true,
				);
			const overrides = store.events(CD_EVENTS.WindowOverridden);
			expect(overrides).toHaveLength(1);
			for (const event of overrides)
				expect(
					vets(schema, "#WindowOverride", jsonOf(event.data) ?? null),
				).toBe(true);
		});

		it("refuses what the parser refuses for a single record", () => {
			const base = {
				name: "w",
				kind: WindowKind.FREEZE,
				timezone: "UTC",
				startsAt: "2026-11-12T10:00:00Z",
				endsAt: "2026-11-12T11:00:00Z",
			};
			const cases = [
				window({ ...base, name: "Bad Name" }),
				window({ ...base, kind: WindowKind.UNSPECIFIED }),
				window({ ...base, timezone: "" }),
				window({ ...base, startsAt: "noon" }),
				window({ ...base, endsAt: "" }),
				window({ ...base, rrule: "FREQ=HOURLY" }),
				window({ ...base, rrule: "FREQ=MONTHLY;BYSETPOS=1" }),
				window({ ...base, rrule: "INTERVAL=2" }),
			];
			for (const record of cases) {
				const value = toJson(ChangeWindowRecordSchema, record);
				expect(compileWindow(record).ok, JSON.stringify(value)).toBe(false);
				expect(
					vets(schema, "#ChangeWindow", value),
					JSON.stringify(value),
				).toBe(false);
			}
		});
	},
);
