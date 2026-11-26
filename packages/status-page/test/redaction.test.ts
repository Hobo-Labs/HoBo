import { describe, expect, it } from "vitest";

import {
	assertPublishable,
	contentHashOf,
	createStatusPageProjection,
	parseStatusScope,
	publishStatusPage,
	STATUS_PAGE_EVENTS,
	STATUS_SIGNAL_EVENTS,
	StatusPageRedactionError,
	scanRenderedOutput,
	statusEnvelope,
} from "../src/index.js";

const SCOPE = parseStatusScope({
	kind: "project",
	id: "shop",
	label: "Project shop",
});

const STREAM = "status:test";

function rowWith(
	events: Parameters<ReturnType<typeof createStatusPageProjection>["fold"]>[0],
) {
	return createStatusPageProjection().fold(events).rows["project:shop"];
}

function sloEvent(seq: number, componentId = "kit-web") {
	return statusEnvelope(
		STATUS_SIGNAL_EVENTS.SloMeasured,
		{
			componentId,
			sloName: "availability",
			attainment: 0.9995,
			target: 0.999,
			measuredAt: "2026-08-17T00:00:00.000Z",
		},
		{ streamId: STREAM, seq, ts: "2026-08-17T00:00:00.000Z", project: "shop" },
	);
}

describe("redaction scanning", () => {
	it.each([
		["credential-in-url", "postgres://admin:hunter22@db.example.com/prod"],
		["aws-access-key", "AKIAIOSFODNN7EXAMPLE"],
		["private-key-block", "-----BEGIN RSA PRIVATE KEY-----"],
		["private-ipv4", "10.1.2.3"],
		["private-ipv4", "192.168.0.10"],
		["private-ipv4", "172.31.4.4"],
		["loopback-url", "http://127.0.0.1:8787"],
		["internal-hostname", "db.internal"],
		["email-address", "oncall@example.com"],
		["secret-assignment", "token=deadbeefcafe1234"],
	])("catches %s (%s)", (rule, sample) => {
		const violations = scanRenderedOutput(`status text ${sample} more text`);
		expect(violations.map((v) => v.rule)).toContain(rule);
	});

	it("passes clean rendered output", () => {
		expect(
			scanRenderedOutput("All systems operational. Uptime 99.95% today."),
		).toHaveLength(0);
	});

	it("honors allow predicates for vetted matches", () => {
		const violations = scanRenderedOutput("contact status@hobo.dev for help", {
			allow: [(match) => match === "status@hobo.dev"],
		});
		expect(violations).toHaveLength(0);
	});

	it("assertPublishable throws a typed error with violations", () => {
		expect(() => assertPublishable("leak token=abcdef012345")).toThrow(
			StatusPageRedactionError,
		);
		try {
			assertPublishable("leak token=abcdef012345");
		} catch (error) {
			// SAFETY: assertPublishable throws StatusPageRedactionError by contract.
			expect((error as StatusPageRedactionError).violations[0]?.rule).toBe(
				"secret-assignment",
			);
		}
	});
});

describe("publishStatusPage", () => {
	const evaluate = { scope: SCOPE, evaluatedAt: "2026-08-17T00:05:00.000Z" };

	it("requires a non-empty declared-public allowlist", () => {
		expect(() =>
			publishStatusPage(rowWith([sloEvent(1)]), {
				componentAllowlist: [],
				evaluate,
			}),
		).toThrow(/allowlist/);
	});

	it("filters to the allowlist and hashes the exact rendered bytes", () => {
		const row = rowWith([sloEvent(1), sloEvent(2, "kit-internal")]);
		const published = publishStatusPage(row, {
			componentAllowlist: ["kit-web"],
			evaluate,
		});
		expect(published.model.components.map((c) => c.spec.id)).toEqual([
			"kit-web",
		]);
		expect(published.html).not.toContain("kit-internal");
		expect(published.contentHash).toBe(contentHashOf(published.html));
		expect(published.publishedEvent).toEqual({
			scopeKind: "project",
			scopeId: "shop",
			contentHash: published.contentHash,
			components: ["kit-web"],
		});
	});

	it("does not leak undeclared component health into the public banner", () => {
		const row = rowWith([
			sloEvent(1),
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.IncidentOpened,
				{
					incidentId: "INC-1",
					title: "Internal batch failure",
					impact: "critical",
					affectedComponents: ["kit-internal"],
					currentStatus: "investigating",
				},
				{
					streamId: STREAM,
					seq: 2,
					ts: "2026-08-17T00:01:00.000Z",
					project: "shop",
				},
			),
		]);
		const published = publishStatusPage(row, {
			componentAllowlist: ["kit-web"],
			evaluate,
		});
		expect(published.model.overall.indicator).toBe("none");
		expect(published.model.activeIncidents).toHaveLength(0);
		expect(published.html).not.toContain("Internal batch failure");
	});

	it("keeps incidents that touch a public component", () => {
		const row = rowWith([
			sloEvent(1),
			statusEnvelope(
				STATUS_SIGNAL_EVENTS.IncidentOpened,
				{
					incidentId: "INC-2",
					title: "Web checkout outage",
					impact: "major",
					affectedComponents: ["kit-web", "kit-internal"],
					currentStatus: "identified",
				},
				{
					streamId: STREAM,
					seq: 2,
					ts: "2026-08-17T00:01:00.000Z",
					project: "shop",
				},
			),
		]);
		const published = publishStatusPage(row, {
			componentAllowlist: ["kit-web"],
			evaluate,
		});
		expect(published.model.activeIncidents).toHaveLength(1);
		expect(published.model.overall.indicator).toBe("major");
	});

	it("fails closed when a public incident body carries a secret", () => {
		const row = rowWith([
			sloEvent(1),
			statusEnvelope(
				STATUS_PAGE_EVENTS.IncidentPosted,
				{
					incidentId: "INC-3",
					currentStatus: "identified",
					body: "Root cause: bad config password=supersecret42 in prod.",
				},
				{
					streamId: STREAM,
					seq: 2,
					ts: "2026-08-17T00:02:00.000Z",
					project: "shop",
				},
			),
		]);
		expect(() =>
			publishStatusPage(row, { componentAllowlist: ["kit-web"], evaluate }),
		).toThrow(StatusPageRedactionError);
	});

	it("content hash is stable for identical input and moves when output changes", () => {
		const row = rowWith([sloEvent(1)]);
		const a = publishStatusPage(row, {
			componentAllowlist: ["kit-web"],
			evaluate,
		});
		const b = publishStatusPage(row, {
			componentAllowlist: ["kit-web"],
			evaluate,
		});
		expect(a.contentHash).toBe(b.contentHash);
		const c = publishStatusPage(row, {
			componentAllowlist: ["kit-web"],
			evaluate: { ...evaluate, evaluatedAt: "2026-08-17T00:06:00.000Z" },
		});
		expect(c.contentHash).not.toBe(a.contentHash);
	});
});
