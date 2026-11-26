// data-models/freight.cue and the TypeScript parse boundary must agree: what
// writeFreightManifest emits and what the ledger records vets clean, and what
// the parser refuses, CUE refuses too.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	FreightOrigin,
	FreightRecordSchema,
	FreightSubject,
	TrustedPublisherRecordSchema,
} from "../../src/_generated/cd_pb.js";
import {
	createFreightLedger,
	parseFreightManifest,
	writeFreightManifest,
} from "../../src/freight/index.js";
import { parseTrustedPublisher } from "../../src/ingest/index.js";
import { manifest } from "./builders.js";
import {
	clock,
	context,
	MapArtifactVerifier,
	MemoryEventStore,
	RecordingTelemetry,
	TENANT,
} from "./fakes.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = resolve(here, "../../data-models/freight.cue");

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
const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-freight-cue-"));
let written = 0;

function vets(definition: string, value: JsonValue): boolean {
	if (!cue) throw new Error("cue binary not found");
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

describe.skipIf(cue === undefined)(
	"freight.cue agrees with the parse boundary (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it("vets what writeFreightManifest emits and what the ledger records", async () => {
			const parsed = parseFreightManifest(manifest());
			if (!parsed.ok) throw new Error("fixture refused");
			expect(
				vets(
					"#Freight",
					JSON.parse(
						new TextDecoder().decode(writeFreightManifest(parsed.value)),
					),
				),
			).toBe(true);
			const artifacts = new MapArtifactVerifier();
			for (const item of parsed.value.artifacts)
				artifacts.register(item.coordinate, item.digest);
			const time = clock();
			const ledger = createFreightLedger({
				store: new MemoryEventStore(),
				tenant: TENANT,
				now: time.now,
				artifacts,
				telemetry: new RecordingTelemetry(),
			});
			const recorded = await ledger.record(
				{ manifest: parsed.value, origin: FreightOrigin.MANIFEST },
				context(time.now),
			);
			if (!recorded.ok) throw new Error("record refused");
			expect(
				vets("#FreightRecord", toJson(FreightRecordSchema, recorded.value)),
			).toBe(true);
		});

		it("refuses what the parser refuses", () => {
			const document = JSON.parse(
				new TextDecoder().decode(writeFreightManifest(manifest())),
			);
			const rail = { ...document, subject: "FREIGHT_SUBJECT_RAIL" };
			const badDigest = { ...document, declarationHash: "sha256:abc" };
			expect(
				parseFreightManifest(manifest({ subject: FreightSubject.RAIL })).ok,
			).toBe(false);
			expect(vets("#Freight", rail)).toBe(false);
			expect(vets("#Freight", badDigest)).toBe(false);
		});

		it("agrees on trusted publisher records", () => {
			const good = create(TrustedPublisherRecordSchema, {
				name: "github-shop",
				issuer: "https://token.actions.githubusercontent.com",
				audience: "https://cd.acme.example",
				requiredClaims: { repository: "acme/shop" },
				bindles: ["shop"],
			});
			const open = create(TrustedPublisherRecordSchema, {
				...good,
				requiredClaims: {},
			});
			expect(
				parseTrustedPublisher(good).ok &&
					vets(
						"#TrustedPublisherRecord",
						toJson(TrustedPublisherRecordSchema, good),
					),
			).toBe(true);
			expect(
				parseTrustedPublisher(open).ok ||
					vets(
						"#TrustedPublisherRecord",
						toJson(TrustedPublisherRecordSchema, open),
					),
			).toBe(false);
		});
	},
);
