// data-models/sources.cue and the TypeScript parse boundary must agree: what
// parseFreightSource returns and what a poll journals vets clean, and the
// structural refusals the parser makes, CUE makes too.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	AssemblyRule,
	FreightSourceRecordSchema,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import {
	createFreightSources,
	createSubscriptionDrivers,
	parseFreightSource,
} from "../../src/sources/index.js";
import { isRecord } from "../../src/sources/json.js";
import { OCI_FIXTURES } from "./oci-fixtures.js";
import {
	asLedger,
	clock,
	context,
	FakeAuthorizer,
	FakeLedger,
	FakeProvenance,
	FixtureTransport,
	MemoryEventStore,
	StaticCredentials,
	TENANT,
} from "./support.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = resolve(here, "../../data-models/sources.cue");

/** `cue` on PATH, else the repo-pinned binary under an ancestor's `.tools/cue/<version>/cue`. */
function findCue(): string | undefined {
	try {
		execFileSync("cue", ["version"], { stdio: "ignore" });
		return "cue";
	} catch {
		let directory = here;
		while (dirname(directory) !== directory) {
			const tools = join(directory, ".tools", "cue");
			if (existsSync(tools)) {
				for (const version of readdirSync(tools).sort().reverse()) {
					const binary = join(tools, version, "cue");
					if (existsSync(binary)) return binary;
				}
			}
			directory = dirname(directory);
		}
		return undefined;
	}
}

const cue = findCue();
const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-sources-cue-"));
let written = 0;

function vets(definition: string, value: JsonValue): boolean {
	if (!cue)
		throw new Error("cue binary not found (install it via mise or .tools/cue)");
	written += 1;
	const file = join(scratch, `value-${written}.json`);
	writeFileSync(file, JSON.stringify(value));
	try {
		execFileSync(cue, ["vet", "-d", definition, schema, file], {
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

const image = create(SubscriptionRecordSchema, {
	name: "image",
	kind: SubscriptionKind.OCI_REPOSITORY,
	locator: "registry.example.com/team/app",
	requireProvenance: true,
	trustedBuilderIds: ["https://ci.example/builder"],
});

function parsedJson(
	record: Parameters<typeof parseFreightSource>[0],
): JsonValue {
	const parsed = parseFreightSource(record, "ops@acme");
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.reasons));
	return toJson(FreightSourceRecordSchema, parsed.value);
}

describe("sources.cue", () => {
	it("vets every normalized source the parser returns", () => {
		const records = [
			create(FreightSourceRecordSchema, {
				name: "app",
				bindle: "web",
				subscriptions: [image],
			}),
			create(FreightSourceRecordSchema, {
				name: "paired",
				bindle: "web",
				assembly: AssemblyRule.SAME_COMMIT,
				subscriptions: [
					image,
					create(SubscriptionRecordSchema, {
						name: "decl",
						kind: SubscriptionKind.GIT_REPOSITORY,
						locator: "https://git.example.com/acme/web.git",
						branch: "main",
						includePaths: ["deploy"],
					}),
				],
			}),
			create(FreightSourceRecordSchema, {
				name: "ci",
				bindle: "web",
				subscriptions: [
					create(SubscriptionRecordSchema, {
						name: "wasm",
						kind: SubscriptionKind.HOBO_CI,
						locator: "web-build",
						artifactName: "dist/web.wasm",
						artifactKind: ArtifactKind.WASM_COMPONENT,
					}),
				],
			}),
			create(FreightSourceRecordSchema, {
				name: "rail-prod",
				bindle: "rail-prod",
				subscriptions: [
					create(SubscriptionRecordSchema, {
						name: "rail",
						kind: SubscriptionKind.HOBO_RAIL,
					}),
				],
			}),
			create(FreightSourceRecordSchema, {
				name: "npm",
				bindle: "web",
				subscriptions: [
					create(SubscriptionRecordSchema, {
						name: "pkg",
						kind: SubscriptionKind.PACKAGE_REGISTRY,
						ecosystem: "npm",
						locator: "@acme/web",
						semverRange: "^1.0.0",
					}),
				],
			}),
		];
		for (const record of records)
			expect(
				vets("#SourceFreightSource", parsedJson(record)),
				record.name,
			).toBe(true);
	});

	it("refuses what the parser refuses for structural reasons", () => {
		const good = parsedJson(
			create(FreightSourceRecordSchema, {
				name: "app",
				bindle: "web",
				subscriptions: [image],
			}),
		);
		if (!isRecord(good)) throw new Error("json");
		const mutate = (patch: Readonly<Record<string, JsonValue>>): JsonValue => ({
			...good,
			...patch,
		});
		expect(vets("#SourceFreightSource", mutate({ name: "App!" }))).toBe(false);
		expect(vets("#SourceFreightSource", mutate({ subscriptions: [] }))).toBe(
			false,
		);
		expect(
			vets(
				"#SourceFreightSource",
				mutate({ assembly: "ASSEMBLY_RULE_SAME_COMMIT" }),
			),
		).toBe(false);
		const subscription = toJson(
			SubscriptionRecordSchema,
			create(SubscriptionRecordSchema, {
				...image,
				discoveryLimit: 20,
				selection: 1,
			}),
		);
		if (!isRecord(subscription)) throw new Error("json");
		const withSub = (patch: Readonly<Record<string, JsonValue>>) =>
			mutate({ subscriptions: [{ ...subscription, ...patch }] });
		expect(vets("#SourceFreightSource", withSub({}))).toBe(true);
		expect(
			vets(
				"#SourceFreightSource",
				withSub({ locator: "https://user:pw@registry.example.com/x" }),
			),
		).toBe(false);
		expect(
			vets(
				"#SourceFreightSource",
				withSub({
					kind: "SUBSCRIPTION_KIND_HTTP_INDEX",
					artifactKind: "ARTIFACT_KIND_STATIC_ASSETS",
				}),
			),
		).toBe(false);
		expect(
			vets("#SourceFreightSource", withSub({ requireProvenance: false })),
		).toBe(false);
		expect(vets("#SourceFreightSource", withSub({ discoveryLimit: 500 }))).toBe(
			false,
		);
	});

	it("vets every journaled discovery record and its meta", async () => {
		const time = clock();
		const store = new MemoryEventStore();
		const fixture = new FixtureTransport(OCI_FIXTURES);
		const sources = createFreightSources({
			store,
			tenant: TENANT,
			now: time.now,
			ledger: asLedger(new FakeLedger()),
			drivers: createSubscriptionDrivers({
				http: fixture.http,
				credentials: new StaticCredentials({}),
			}),
			provenance: new FakeProvenance(),
			authorizer: new FakeAuthorizer(),
			webhookSecrets: new StaticCredentials({}),
		});
		const ctx = context(time.now);
		expect(
			(
				await sources.define(
					create(FreightSourceRecordSchema, {
						name: "app",
						bindle: "web",
						subscriptions: [image],
					}),
					ctx,
				)
			).ok,
		).toBe(true);
		expect((await sources.poll("app", ctx)).ok).toBe(true);
		const events = store
			.events(CD_STREAMS.source("app"))
			.filter((event) => event.type === CD_EVENTS.SourceArtifactDiscovered);
		expect(events.map((event) => event.meta?.outcome)).toEqual([
			"skipped",
			"skipped",
			"recorded",
		]);
		for (const event of events) {
			// SAFETY: the journal stores protobuf JSON written by the service.
			expect(vets("#SourceDiscoveredArtifact", event.data as JsonValue)).toBe(
				true,
			);
			expect(vets("#SourceDiscoveryMeta", event.meta ?? null)).toBe(true);
		}
		const defined = store
			.events(CD_STREAMS.source("app"))
			.find((event) => event.type === CD_EVENTS.SourceDefined);
		// SAFETY: the journal stores protobuf JSON written by the service.
		expect(vets("#SourceFreightSource", defined?.data as JsonValue)).toBe(true);
	});
});
