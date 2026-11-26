import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertCdEvent,
	CDEVENT_TYPES,
	CDEVENTS_SPEC,
	type CdEvent,
	canonicalJson,
	createCdEventsProjector,
	HOBO_CUSTOM_EVENT_PREFIX,
	projectCdEvents,
} from "../../src/boundary/index.js";
import { fixtureJournal } from "./journal.js";

const here = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(
	readFileSync(join(here, "../../src/boundary/STANDARDS.lock.json"), "utf8"),
);
const goldenPath = join(
	here,
	`golden/cdevents.v${CDEVENTS_SPEC.specversion}.jsonl`,
);
const SOURCE = "/hobo/cd/acme";

function render(events: readonly CdEvent[]): string {
	// One canonical CDEvent per line: byte-stable and diff-friendly.
	// SAFETY: CdEvent is a JSON-shaped record.
	return `${events.map((e) => canonicalJson(e as never)).join("\n")}\n`;
}

describe("CDEvents projection (D17, pinned spec)", () => {
	it("pins the spec version recorded in STANDARDS.lock.json", () => {
		expect(lock.specversion).toBe(CDEVENTS_SPEC.specversion);
		expect(lock.tag).toBe(CDEVENTS_SPEC.tag);
		expect(lock.events).toEqual({
			"artifact.published": CDEVENT_TYPES.artifactPublished,
			"service.deployed": CDEVENT_TYPES.serviceDeployed,
			"service.upgraded": CDEVENT_TYPES.serviceUpgraded,
			"service.rolledback": CDEVENT_TYPES.serviceRolledback,
			"service.removed": CDEVENT_TYPES.serviceRemoved,
			"environment.created": CDEVENT_TYPES.environmentCreated,
			"environment.modified": CDEVENT_TYPES.environmentModified,
			"environment.deleted": CDEVENT_TYPES.environmentDeleted,
		});
	});

	it("CDEvents are golden-pinned and name their spec version", () => {
		const events = projectCdEvents(fixtureJournal(), { source: SOURCE });
		const golden = readFileSync(goldenPath, "utf8");
		expect(render(events)).toBe(golden);
		for (const event of events) {
			expect(event.context.specversion).toBe(lock.specversion);
		}
	});

	it("replay is byte-identical (I8)", () => {
		const a = render(projectCdEvents(fixtureJournal(), { source: SOURCE }));
		const b = render(projectCdEvents(fixtureJournal(), { source: SOURCE }));
		expect(a).toBe(b);
	});

	it("maps the journal onto the pinned vocabulary", () => {
		const types = projectCdEvents(fixtureJournal(), { source: SOURCE }).map(
			(e) => e.context.type,
		);
		expect(types).toEqual([
			CDEVENT_TYPES.artifactPublished,
			CDEVENT_TYPES.artifactPublished,
			CDEVENT_TYPES.environmentCreated,
			CDEVENT_TYPES.serviceDeployed,
			"dev.cdeventsx.hobo-verification.completed.0.1.0",
			"dev.cdeventsx.hobo-freight.qualified.0.1.0",
			CDEVENT_TYPES.artifactPublished,
			CDEVENT_TYPES.serviceUpgraded,
			CDEVENT_TYPES.serviceRolledback,
			"dev.cdeventsx.hobo-freight.yanked.0.1.0",
			CDEVENT_TYPES.environmentModified,
			"dev.cdeventsx.hobo-fanout.halted.0.1.0",
			"dev.cdeventsx.hobo-failover.completed.0.1.0",
			CDEVENT_TYPES.environmentCreated,
			CDEVENT_TYPES.serviceRemoved,
			CDEVENT_TYPES.environmentDeleted,
			"dev.cdeventsx.hobo-rail.recorded.0.1.0",
		]);
	});

	it("rolls back to the previously deployed artifact", () => {
		const events = projectCdEvents(fixtureJournal(), { source: SOURCE });
		const rolledBack = events.find(
			(e) => e.context.type === CDEVENT_TYPES.serviceRolledback,
		);
		expect(rolledBack?.subject.content).toEqual({
			environment: { id: "staging", source: SOURCE },
			artifactId: `pkg:oci/web@sha256%3A${"a".repeat(64)}`,
		});
	});

	it("artifact.published fires on freight.Recorded and keeps a purl coordinate", () => {
		const events = projectCdEvents(fixtureJournal(), { source: SOURCE });
		const published = events
			.filter((e) => e.context.type === CDEVENT_TYPES.artifactPublished)
			.map((e) => e.subject.id);
		expect(published).toEqual([
			`pkg:oci/web@sha256%3A${"a".repeat(64)}`,
			"pkg:npm/%40acme/assets@1.4.0",
			`pkg:oci/web@sha256%3A${"c".repeat(64)}`,
		]);
	});

	it("HoBo-specific facts use the dev.cdeventsx.hobo- custom namespace", () => {
		for (const event of projectCdEvents(fixtureJournal(), { source: SOURCE })) {
			const t = event.context.type;
			expect(
				t.startsWith("dev.cdevents.") || t.startsWith(HOBO_CUSTOM_EVENT_PREFIX),
			).toBe(true);
		}
	});

	it("skips a body that does not parse instead of trusting it", () => {
		const projector = createCdEventsProjector({ source: SOURCE });
		for (const event of fixtureJournal()) projector.apply(event);
		expect(projector.skipped).toBe(1);
	});

	it("refuses an event the pinned schema refuses", () => {
		const valid = projectCdEvents(fixtureJournal(), { source: SOURCE })[3];
		if (valid === undefined) throw new Error("fixture");
		expect(() =>
			assertCdEvent({
				...valid,
				subject: { ...valid.subject, content: { environment: { id: "x" } } },
			}),
		).toThrow(/artifactId is required/);
		expect(() =>
			assertCdEvent({
				...valid,
				subject: {
					...valid.subject,
					content: { ...valid.subject.content, extra: 1 },
				},
			}),
		).toThrow(/has no extra/);
		expect(() =>
			assertCdEvent({
				...valid,
				context: { ...valid.context, specversion: "0.4.1" },
			}),
		).toThrow(/pinned/);
		expect(() =>
			assertCdEvent({
				...valid,
				context: {
					...valid.context,
					type: "dev.cdevents.service.deployed.0.2.0",
				},
			}),
		).toThrow(/not pinned/);
	});
});
