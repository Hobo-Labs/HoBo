/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: this test's conformance walker is a parse boundary: it reads records as untyped protobuf JSON and checks each key and value against cd.proto's text, so it must accept unknown input. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MeshNode } from "@hobo/ci/mesh";
import { describe, expect, it } from "vitest";
import {
	parseRunnerHosts,
	RUNNER_FLEET_BINDLE,
	RUNNER_FLEET_CAMP_SET,
	RUNNER_FLEET_PIPELINE,
	RUNNER_FLEET_YARD,
	RUNNER_IMAGE_RELEASE_TAG_PATTERN,
	RUNNER_IMAGE_SOURCE,
	RUNNER_RELEASE_ARTIFACTS,
	runnerFleetCampObservations,
	runnerFleetDelivery,
	runnerFleetRail,
	runnerFleetTopology,
	runnerHostRealizationParameters,
	runnerHostReferenceParameter,
} from "../src/runner-fleet-delivery.js";

const root = join(import.meta.dirname, "..", "..", "..");
const deployDir = join(root, "packages/ci-gh-actions/deploy/runner-fleet");

const HOSTS = [
	{ id: "box", kind: "box-worker", runnerLabels: ["hobo", "hobo-trunk"] },
	{ id: "mesh-a", kind: "mesh-node", runnerLabels: ["hobo"], ring: "pilot" },
	{
		id: "laptop",
		kind: "local-runner",
		runnerLabels: ["hobo-local-host"],
	},
];

function hosts() {
	const parsed = parseRunnerHosts(JSON.stringify(HOSTS));
	if (!parsed.ok) throw new Error(parsed.problems.join("; "));
	return parsed.value;
}

// ── A tiny reader of cd.proto: each message's fields and each enum's values,
// so the records here are checked against @hobo/cd's frozen wire schema
// without a package dependency on @hobo/cd.
type ProtoField = Readonly<{ type: string; repeated: boolean; map: boolean }>;
function readProto(): Readonly<{
	messages: Map<string, Map<string, ProtoField>>;
	enums: Map<string, Set<string>>;
}> {
	const text = readFileSync(
		join(root, "packages/cd/data-models/cd.proto"),
		"utf8",
	);
	const messages = new Map<string, Map<string, ProtoField>>();
	const enums = new Map<string, Set<string>>();
	for (const block of text.matchAll(
		/^(message|enum) (\w+) \{([\s\S]*?)^\}/gmu,
	)) {
		const [, kind, name = "", body = ""] = block;
		if (kind === "enum") {
			enums.set(
				name,
				new Set(
					[...body.matchAll(/^\s*(\w+) = \d+;/gmu)].map((m) => m[1] ?? ""),
				),
			);
			continue;
		}
		const fields = new Map<string, ProtoField>();
		for (const m of body.matchAll(
			/^\s*(repeated )?(map<[^>]+>|[\w.]+) (\w+) = \d+;/gmu,
		)) {
			const snake = m[3] ?? "";
			const camel = snake.replace(/_([a-z])/gu, (_, c: string) =>
				c.toUpperCase(),
			);
			fields.set(camel, {
				type: m[2] ?? "",
				repeated: m[1] !== undefined,
				map: (m[2] ?? "").startsWith("map<"),
			});
		}
		messages.set(name, fields);
	}
	return { messages, enums };
}

function conformance(
	value: unknown,
	message: string,
	at: string,
	proto: ReturnType<typeof readProto>,
): string[] {
	const fields = proto.messages.get(message);
	if (!fields) return [`${at}: no message ${message}`];
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return [`${at}: not an object`];
	const problems: string[] = [];
	for (const [key, item] of Object.entries(value)) {
		const field = fields.get(key);
		if (!field) {
			problems.push(`${at}.${key}: not a field of ${message}`);
			continue;
		}
		const items = field.repeated ? (item as unknown[]) : [item];
		if (field.repeated && !Array.isArray(item)) {
			problems.push(`${at}.${key}: repeated field is not an array`);
			continue;
		}
		for (const [index, one] of items.entries()) {
			const where = field.repeated ? `${at}.${key}[${index}]` : `${at}.${key}`;
			if (field.map) continue;
			if (proto.messages.has(field.type))
				problems.push(...conformance(one, field.type, where, proto));
			else if (proto.enums.has(field.type)) {
				if (!proto.enums.get(field.type)?.has(String(one)))
					problems.push(`${where}: ${String(one)} is not a ${field.type}`);
			} else if (/^u?int64$/u.test(field.type)) {
				if (typeof one !== "string" || !/^\d+$/u.test(one))
					problems.push(`${where}: 64-bit integers are decimal strings`);
			}
		}
	}
	return problems;
}

describe("runner hosts are parsed once (parse, don't validate)", () => {
	it("parseRunnerHosts accepts the three host kinds and defaults the ring to fleet", () => {
		const parsed = hosts();
		expect(parsed.map((h) => [h.id, h.kind, h.ring])).toEqual([
			["box", "box-worker", "fleet"],
			["laptop", "local-runner", "fleet"],
			["mesh-a", "mesh-node", "pilot"],
		]);
	});

	it("parseRunnerHosts refuses unknown labels, duplicate ids, a local runner on a fleet label and a fleet with no pilot", () => {
		const malformed = parseRunnerHosts(
			JSON.stringify([
				{ id: "box", kind: "box-worker", runnerLabels: ["hobo-arc"] },
				{ id: "Bad Id", kind: "local-runner", runnerLabels: ["hobo"] },
			]),
		);
		expect(malformed.ok).toBe(false);
		if (malformed.ok) return;
		expect(malformed.code).toBe("runner-hosts-invalid");
		expect(malformed.problems.join("\n")).toMatch(/hosts\.0\.runnerLabels\.0/u);
		expect(malformed.problems.join("\n")).toMatch(
			/hosts\.1\.id: not a lowercase host id/u,
		);
		const bad = parseRunnerHosts(
			JSON.stringify([
				{ id: "box", kind: "box-worker", runnerLabels: ["hobo"] },
				{ id: "box", kind: "mesh-node", runnerLabels: ["hobo"] },
				{ id: "laptop", kind: "local-runner", runnerLabels: ["hobo"] },
				{ id: "x", kind: "mesh-node", runnerLabels: ["hobo-local-host"] },
			]),
		);
		expect(bad.ok).toBe(false);
		if (bad.ok) return;
		expect(bad.code).toBe("runner-hosts-invalid");
		expect(bad.problems.join("\n")).toMatch(/duplicate host id box/u);
		expect(bad.problems.join("\n")).toMatch(
			/local-runner serves only hobo-local-host/u,
		);
		expect(bad.problems.join("\n")).toMatch(
			/only a local-runner serves hobo-local-host/u,
		);
		expect(bad.problems.join("\n")).toMatch(/no pilot host/u);
		expect(bad.remediation).toMatch(/hosts\.json/u);
	});

	it("parseRunnerHosts refuses something that is not a list, or not JSON", () => {
		expect(parseRunnerHosts(JSON.stringify({ hosts: [] })).ok).toBe(false);
		expect(parseRunnerHosts("[").ok).toBe(false);
	});
});

describe("runner hosts become Camps", () => {
	it("runnerFleetTopology declares one MANAGED Camp per host, Yard-scoped, with its ring and labels", () => {
		const camps = runnerFleetTopology(hosts(), { stationId: "hobo" });
		expect(camps.map((c) => c.campId)).toEqual([
			`${RUNNER_FLEET_YARD}/box`,
			`${RUNNER_FLEET_YARD}/laptop`,
			`${RUNNER_FLEET_YARD}/mesh-a`,
		]);
		const box = camps[0];
		expect(box?.yardId).toBe(RUNNER_FLEET_YARD);
		expect(box?.stationId).toBe("hobo");
		expect(box?.envType).toBe("ci");
		expect(box?.management).toBe("CAMP_MANAGEMENT_MANAGED");
		expect(box?.labels).toMatchObject({
			"hobo.ci/runner-fleet": "true",
			"hobo.ci/runner-ring": "fleet",
			"hobo.ci/runner-host": "box-worker",
			"hobo.ci/serves-hobo": "true",
			"hobo.ci/serves-hobo-trunk": "true",
			"hobo.ci/serves-hobo-local-host": "false",
		});
		expect(camps[2]?.labels["hobo.ci/runner-ring"]).toBe("pilot");
	});
});

describe("the delivery module for the runner fleet", () => {
	const delivery = runnerFleetDelivery(hosts(), {
		repository: "Hobo-Labs/HoBo",
	});

	it("binds a Camp set for the hobo-ci-runner-fleet Bindle by label, never by Bindle", () => {
		expect(delivery.campSets).toEqual([
			{
				name: RUNNER_FLEET_CAMP_SET,
				selector: { labels: { "hobo.ci/runner-fleet": "true" } },
				definedBy: "packages/ci-gh-actions/deploy/runner-fleet",
			},
		]);
		expect(RUNNER_FLEET_BINDLE).toBe("hobo-ci-runner-fleet");
	});

	it("discovers the runner image as Freight by polling GHCR for release tags", () => {
		const [source] = delivery.sources;
		expect(source?.name).toBe(RUNNER_IMAGE_SOURCE);
		expect(source?.bindle).toBe(RUNNER_FLEET_BINDLE);
		expect(source?.automatic).toBe(true);
		expect(source?.subscriptions).toEqual([
			expect.objectContaining({
				kind: "SUBSCRIPTION_KIND_OCI_REPOSITORY",
				locator: "ghcr.io/hobo-labs/hobo/hobo-ci-worker",
				selection: "SELECTION_STRATEGY_LEXICAL",
				allowPattern: RUNNER_IMAGE_RELEASE_TAG_PATTERN,
				artifactKind: "ARTIFACT_KIND_OCI_IMAGE",
				credentialRef: "env://HOBO_CI_GHCR_READ_TOKEN",
			}),
		]);
		expect(
			new RegExp(RUNNER_IMAGE_RELEASE_TAG_PATTERN, "u").test(
				"release-20261112093000-v0123456789ab",
			),
		).toBe(true);
		expect(
			new RegExp(RUNNER_IMAGE_RELEASE_TAG_PATTERN, "u").test("v0123456789ab"),
		).toBe(false);
		expect(
			new RegExp(RUNNER_IMAGE_RELEASE_TAG_PATTERN, "u").test("latest"),
		).toBe(false);
	});

	it("places the fleet in a pilot group first, then the rest", () => {
		const [placement] = delivery.placements;
		expect(placement?.campSets).toEqual([RUNNER_FLEET_CAMP_SET]);
		expect(placement?.count).toBe(0);
		expect(placement?.groups).toEqual([
			{
				name: "pilot",
				selector: { labels: { "hobo.ci/runner-ring": "pilot" } },
				maxSize: 1,
			},
			{
				name: "fleet",
				selector: { labels: { "hobo.ci/runner-ring": "fleet" } },
			},
		]);
	});

	it("rolls out PROGRESSIVE_PER_GROUP with a mandatory pilot, a failure budget and a quorum, and never deletes a departing host", () => {
		const [pipeline] = delivery.pipelines;
		expect(pipeline?.name).toBe(RUNNER_FLEET_PIPELINE);
		expect(pipeline?.bindle).toBe(RUNNER_FLEET_BINDLE);
		const [node] = pipeline?.nodes ?? [];
		expect(node?.placement).toBe(placement());
		expect(node?.campIds).toBeUndefined();
		expect(node?.fromSources).toEqual([RUNNER_IMAGE_SOURCE]);
		expect(node?.autoPromotion).toBe("AUTO_PROMOTION_NEWEST");
		expect(node?.fanout).toEqual({
			strategy: "FANOUT_STRATEGY_PROGRESSIVE_PER_GROUP",
			maxConcurrency: 1,
			minSuccessMs: "600000",
			progressDeadlineMs: "10800000",
			maxFailures: 1,
			mandatoryGroups: ["pilot"],
			rollbackOnHalt: true,
		});
		expect(node?.quorum).toEqual({ minQualifiedPercent: 50 });
		expect(node?.departure).toBe("DEPARTURE_ACTION_ORPHAN");
		function placement() {
			return delivery.placements[0]?.name;
		}
	});

	it("pairs each image with the controller releases of the same version, each identified by its own bytes", () => {
		const paired = runnerFleetDelivery(hosts(), {
			repository: "Hobo-Labs/HoBo",
			releaseIndexBase: "https://releases.hobo.test/hobo-ci/",
		});
		const [source] = paired.sources;
		expect(source?.assembly).toBe("ASSEMBLY_RULE_SAME_VERSION");
		expect(source?.subscriptions.slice(1)).toEqual(
			Object.values(RUNNER_RELEASE_ARTIFACTS).map((artifact) => ({
				name: artifact,
				kind: "SUBSCRIPTION_KIND_HTTP_INDEX",
				locator: `https://releases.hobo.test/hobo-ci/index.${artifact}.json`,
				selection: "SELECTION_STRATEGY_LEXICAL",
				allowPattern: RUNNER_IMAGE_RELEASE_TAG_PATTERN,
				artifactName: artifact,
				artifactKind: "ARTIFACT_KIND_FUNCTION_BUNDLE",
			})),
		);
		// The same records without releases stay as they were.
		expect(delivery.sources[0]?.assembly).toBe("ASSEMBLY_RULE_INDEPENDENT");
		expect(() =>
			runnerFleetDelivery(hosts(), {
				repository: "Hobo-Labs/HoBo",
				releaseIndexBase: "http://releases.hobo.test/",
			}),
		).toThrow(/https:\/\//u);
		const problems = paired.sources.flatMap((r, i) =>
			conformance(r, "FreightSourceRecord", `sources[${i}]`, readProto()),
		);
		expect(problems).toEqual([]);
	});

	it("maps a Freight to the runner-host row: the image by manifest digest, each release by its bytes' digest", () => {
		const image = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${"a".repeat(64)}`;
		const worker = `sha256:${"b".repeat(64)}`;
		const local = `sha256:${"c".repeat(64)}`;
		const parameters = runnerHostRealizationParameters([
			{
				name: "hobo-ci-worker",
				digest: `sha256:${"a".repeat(64)}`,
				coordinate: image,
			},
			{
				name: RUNNER_RELEASE_ARTIFACTS.workerRelease,
				digest: worker,
				coordinate: `https://releases.hobo.test/${"b".repeat(64)}.mjs`,
			},
			{
				name: RUNNER_RELEASE_ARTIFACTS.localRunnerRelease,
				digest: local,
				coordinate: `https://releases.hobo.test/${"c".repeat(64)}.mjs`,
			},
		]);
		expect(parameters).toEqual({
			image,
			workerRelease: `hobo-ci-worker-release@${worker}`,
			localRunnerRelease: `hobo-ci-local-runner-release@${local}`,
		});
		// A Freight without releases asks container hosts only.
		expect(
			runnerHostRealizationParameters([
				{ name: "hobo-ci-worker", digest: "", coordinate: image },
			]),
		).toEqual({ image });
		expect(
			runnerHostRealizationParameters([
				{ name: "hobo-ci-worker", digest: "", coordinate: "ghcr.io/x:latest" },
			]),
		).toBeUndefined();
		expect(runnerHostReferenceParameter("box-worker", "container")).toBe(
			"image",
		);
		expect(runnerHostReferenceParameter("mesh-node", "process")).toBe(
			"workerRelease",
		);
		expect(runnerHostReferenceParameter("local-runner", "process")).toBe(
			"localRunnerRelease",
		);
	});

	it("every record conforms to @hobo/cd's cd.proto wire schema", () => {
		const proto = readProto();
		const problems = [
			...delivery.sources.flatMap((r, i) =>
				conformance(r, "FreightSourceRecord", `sources[${i}]`, proto),
			),
			...delivery.campSets.flatMap((r, i) =>
				conformance(r, "CampSetRecord", `campSets[${i}]`, proto),
			),
			...delivery.placements.flatMap((r, i) =>
				conformance(r, "PlacementRecord", `placements[${i}]`, proto),
			),
			...delivery.pipelines.flatMap((r, i) =>
				conformance(r, "PipelineRecord", `pipelines[${i}]`, proto),
			),
		];
		expect(problems).toEqual([]);
	});

	it("deploy/runner-fleet/hobo.delivery.ts exports exactly the delivery-module records of the declared hosts", async () => {
		const declared = parseRunnerHosts(
			readFileSync(join(deployDir, "hosts.json"), "utf8"),
		);
		expect(declared.ok).toBe(true);
		if (!declared.ok) return;
		const module: Record<string, unknown> = await import(
			join(deployDir, "hobo.delivery.ts")
		);
		// `hobo deploy pipeline apply` refuses any other export; `camps` and
		// `rails` are the topology `hobo deploy --yard` reads (packages/hobo/CD.md).
		expect(Object.keys(module).sort()).toEqual([
			"campSets",
			"camps",
			"pipelines",
			"placements",
			"rails",
			"sources",
		]);
		const generated = runnerFleetDelivery(declared.value, {
			repository: "Hobo-Labs/HoBo",
		});
		const { camps, rails, ...records } = module;
		expect(records).toEqual({ ...generated });
		expect(camps).toEqual(
			runnerFleetTopology(declared.value, { stationId: "" }),
		);
		expect(rails).toEqual([runnerFleetRail()]);
	});

	it("every record carries the schema version @hobo/cd's parsers require", () => {
		expect(delivery.sources[0]?.schemaVersion).toBe("hobo.cd.source/v1");
		expect(delivery.placements[0]?.schemaVersion).toBe("hobo.cd.placement/v1");
		expect(delivery.pipelines[0]?.schemaVersion).toBe("hobo.cd.pipeline/v1");
	});
});

describe("fleet health and lease signals feed Camp inventory conditions", () => {
	const now = Date.parse("2026-11-12T10:00:00.000Z");
	const node = (over: Partial<MeshNode>): MeshNode => ({
		id: "box",
		freeSlots: 1,
		healthy: true,
		labels: ["hobo", "hobo-trunk"],
		validUntilMs: now + 30_000,
		sinceMs: now - 60_000,
		...over,
	});
	const conditions = (
		observed: ReturnType<typeof runnerFleetCampObservations>,
		campId: string,
	) =>
		Object.fromEntries(
			(observed.find((o) => o.campId === campId)?.conditions ?? []).map((c) => [
				c.type,
				[c.status, c.reason],
			]),
		);

	it("a fresh, healthy advertisement is REACHABLE, LEASED and READY from the health source", () => {
		const observed = runnerFleetCampObservations(hosts(), [node({})], now);
		const box = observed.find((o) => o.campId === `${RUNNER_FLEET_YARD}/box`);
		expect(box?.source).toBe("SIGNAL_SOURCE_HEALTH_SOURCE");
		expect(conditions(observed, `${RUNNER_FLEET_YARD}/box`)).toEqual({
			CAMP_CONDITION_TYPE_REACHABLE: [
				"CONDITION_STATUS_TRUE",
				"mesh-advert-fresh",
			],
			CAMP_CONDITION_TYPE_LEASED: [
				"CONDITION_STATUS_TRUE",
				"mesh-lease-valid-until:2026-11-12T10:00:30.000Z",
			],
			CAMP_CONDITION_TYPE_READY: [
				"CONDITION_STATUS_TRUE",
				"runner-host-healthy",
			],
		});
		expect(box?.conditions[0]?.since).toBe("2026-11-12T09:59:00.000Z");
	});

	it("a draining or pressured host is reachable but not READY", () => {
		const observed = runnerFleetCampObservations(
			hosts(),
			[node({ healthy: false })],
			now,
		);
		expect(
			conditions(observed, `${RUNNER_FLEET_YARD}/box`)
				.CAMP_CONDITION_TYPE_READY,
		).toEqual(["CONDITION_STATUS_FALSE", "runner-host-draining-or-pressured"]);
	});

	it("an expired advertisement loses its lease, and a missing one is unknown, never assumed healthy", () => {
		const observed = runnerFleetCampObservations(
			hosts(),
			[node({ validUntilMs: now - 1 })],
			now,
		);
		expect(conditions(observed, `${RUNNER_FLEET_YARD}/box`)).toEqual({
			CAMP_CONDITION_TYPE_REACHABLE: [
				"CONDITION_STATUS_FALSE",
				"mesh-advert-expired",
			],
			CAMP_CONDITION_TYPE_LEASED: [
				"CONDITION_STATUS_FALSE",
				"mesh-lease-expired",
			],
			CAMP_CONDITION_TYPE_READY: [
				"CONDITION_STATUS_FALSE",
				"mesh-advert-expired",
			],
		});
		expect(conditions(observed, `${RUNNER_FLEET_YARD}/mesh-a`)).toEqual({
			CAMP_CONDITION_TYPE_REACHABLE: [
				"CONDITION_STATUS_UNKNOWN",
				"mesh-advert-missing",
			],
			CAMP_CONDITION_TYPE_LEASED: [
				"CONDITION_STATUS_UNKNOWN",
				"mesh-advert-missing",
			],
			CAMP_CONDITION_TYPE_READY: [
				"CONDITION_STATUS_UNKNOWN",
				"mesh-advert-missing",
			],
		});
	});

	it("the labels a host advertises are claims, so a host that stopped serving a declared label reads as inconsistent", () => {
		const observed = runnerFleetCampObservations(
			hosts(),
			[node({ labels: ["hobo"] })],
			now,
		);
		const box = observed.find((o) => o.campId === `${RUNNER_FLEET_YARD}/box`);
		expect(box?.claims).toEqual([
			{
				name: "label:hobo.ci/serves-hobo",
				value: "true",
				reportedBy: "mesh:box",
				observedAt: "2026-11-12T10:00:00.000Z",
			},
			{
				name: "label:hobo.ci/serves-hobo-local-host",
				value: "false",
				reportedBy: "mesh:box",
				observedAt: "2026-11-12T10:00:00.000Z",
			},
			{
				name: "label:hobo.ci/serves-hobo-trunk",
				value: "false",
				reportedBy: "mesh:box",
				observedAt: "2026-11-12T10:00:00.000Z",
			},
		]);
		const proto = readProto();
		for (const o of observed)
			expect([
				...o.conditions.flatMap((c, i) =>
					conformance(c, "CampConditionRecord", `conditions[${i}]`, proto),
				),
				...o.claims.flatMap((c, i) =>
					conformance(c, "CampClaimRecord", `claims[${i}]`, proto),
				),
			]).toEqual([]);
	});
});

describe("each runner host runs a HoBo CD agent beside its controller", () => {
	const unit = readFileSync(join(deployDir, "hobo-cd-agent.service"), "utf8");
	const env = readFileSync(join(deployDir, "agent.env.example"), "utf8");

	it("hobo-cd-agent.service runs `hobo deploy agent run` with every flag the agent runtime requires", () => {
		const exec = unit.match(/^ExecStart=(.*)$/mu)?.[1] ?? "";
		expect(exec).toMatch(/\bhobo deploy agent run\b/u);
		for (const flag of [
			"--feed",
			"--reconciler",
			"--key-file",
			"--svid-file",
			"--camp",
		])
			expect(exec).toContain(`${flag} `);
		// Outbound only: nothing listens.
		expect(unit).not.toMatch(/ListenStream|--port/u);
	});

	it("the agent does not start before double opt-in enrollment left a key and an SVID", () => {
		expect(unit).toMatch(/^ConditionPathExists=.*agent\.jwk\.json$/mu);
		expect(unit).toMatch(/^ConditionPathExists=.*agent\.svid$/mu);
	});

	it("agent.env.example names an https feed and a declared runner host Camp, and holds no secret", () => {
		expect(env).toMatch(/^HOBO_CD_FEED_URL=https:\/\/.*\/v1\/cd\/$/mu);
		const camp = env.match(/^HOBO_CD_CAMP_ID=(.*)$/mu)?.[1];
		const declared = parseRunnerHosts(
			readFileSync(join(deployDir, "hosts.json"), "utf8"),
		);
		expect(declared.ok).toBe(true);
		if (!declared.ok) return;
		expect(declared.value.map((h) => `${RUNNER_FLEET_YARD}/${h.id}`)).toContain(
			camp,
		);
		expect(env).not.toMatch(/TOKEN|SECRET|PRIVATE|"d"/u);
	});
});
