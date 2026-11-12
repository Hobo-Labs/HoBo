// data-models/artifacts.cue and the TypeScript boundary agree: what the store,
// verifier and provenance verifier write vets clean, and what they refuse, CUE
// refuses too.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	ArtifactRefSchema,
	FreightManifestRecordSchema,
	ProvenanceRefSchema,
	ReasonRecordSchema,
} from "../../src/_generated/cd_pb.js";
import {
	createArtifactStore,
	createArtifactVerifier,
} from "../../src/artifacts/index.js";
import { CD_STREAMS } from "../../src/events.js";
import type { Digest } from "../../src/ports.js";
import { createProvenanceVerifier } from "../../src/provenance/index.js";
import {
	actionsAttestBundle,
	actionsAttestStatement,
	createTestTrustRoot,
	GITHUB_BUILDER,
	GITHUB_ISSUER,
	RELEASE_WORKFLOW,
} from "../provenance/sigstore-fixture.js";
import {
	bytesOf,
	context,
	MemoryEventStore,
	ScriptedTransport,
	T0,
	TENANT,
} from "./fakes.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = resolve(here, "../../data-models/artifacts.cue");

function findCue(): string | undefined {
	try {
		execFileSync("cue", ["version"], { stdio: "ignore" });
		return "cue";
	} catch {
		let directory = here;
		while (dirname(directory) !== directory) {
			const tools = join(directory, ".tools", "cue");
			if (existsSync(tools))
				for (const version of readdirSync(tools).sort().reverse()) {
					const binary = join(tools, version, "cue");
					if (existsSync(binary)) return binary;
				}
			directory = dirname(directory);
		}
		return undefined;
	}
}

const cue = findCue();
const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-artifacts-cue-"));
let written = 0;

function vets(definition: string, value: unknown): boolean {
	if (cue === undefined)
		throw new Error(
			"cue is required for the CUE boundary tests (mise install)",
		);
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

describe("artifacts.cue", () => {
	it("accepts what the store journals and rejects tampered bodies", async () => {
		for (const backend of ["memory", "filesystem"] as const) {
			const events = new MemoryEventStore();
			const store = createArtifactStore(
				backend === "memory"
					? { backend }
					: { backend, root: mkdtempSync(join(tmpdir(), "hobo-cd-cue-fs-")) },
				{ store: events, tenant: TENANT, now: () => T0 },
			);
			const ref = await store.put(
				bytesOf(`cue ${backend}`),
				{
					name: "api.wasm",
					kind: ArtifactKind.WASM_COMPONENT,
					mediaType: "application/wasm",
				},
				context(),
			);
			await store.delete(
				ref.digest as Digest,
				"retention: unreferenced past blob grace",
				context(),
			);
			const [stored, deleted] = events.events(CD_STREAMS.artifact(ref.digest));
			expect(vets("#ArtifactStoredRecord", stored?.data)).toBe(true);
			expect(vets("#ArtifactDeletedRecord", deleted?.data)).toBe(true);
			const data = structuredClone(stored?.data) as {
				backend: string;
				artifact: { coordinate: string };
			};
			expect(
				vets("#ArtifactStoredRecord", {
					...data,
					backend: backend === "memory" ? "filesystem" : "memory",
				}),
			).toBe(false);
			expect(
				vets("#ArtifactDeletedRecord", {
					...(deleted?.data as object),
					reason: "",
				}),
			).toBe(false);
		}
	});

	it("rejects artifact refs that are not digest-pinned or that embed credentials", () => {
		const ok = toJson(
			ArtifactRefSchema,
			create(ArtifactRefSchema, {
				name: "api",
				kind: ArtifactKind.OCI_IMAGE,
				digest: `sha256:${"a".repeat(64)}`,
				coordinate: `ghcr.io/acme/api@sha256:${"a".repeat(64)}`,
				ecosystem: "oci",
			}),
		);
		expect(vets("#ArtifactRef", ok)).toBe(true);
		expect(
			vets("#ArtifactRef", {
				...(ok as object),
				digest: `sha256:${"A".repeat(64)}`,
			}),
		).toBe(false);
		expect(
			vets("#ArtifactRef", {
				...(ok as object),
				coordinate: "https://bot:pw@registry.example/app",
			}),
		).toBe(false);
		expect(vets("#ArtifactRef", { ...(ok as object), ecosystem: "hex" })).toBe(
			false,
		);
		expect(
			vets("#ArtifactRef", { ...(ok as object), payload: "inline bytes" }),
		).toBe(false);
	});

	it("accepts a verified ProvenanceRef and the trust policies the verifier accepts", async () => {
		const root = createTestTrustRoot();
		const hex = createHash("sha256").update("wasm").digest("hex");
		const statement = actionsAttestStatement([
			{ name: "api.wasm", sha256: hex },
		]);
		const bundle = actionsAttestBundle(root, {
			statement,
			signedAtMs: Date.UTC(2026, 10, 1),
		});
		const policy = {
			sigstore: { trustedRoot: root.trustedRoot, issuers: [GITHUB_ISSUER] },
		};
		const verifier = createProvenanceVerifier({
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => T0,
			http: new ScriptedTransport().http,
			trustPolicy: policy,
		});
		const outcome = await verifier.verify(
			{
				statement,
				bundle: new TextEncoder().encode(JSON.stringify(bundle)),
				subjects: [
					create(ArtifactRefSchema, {
						name: "api.wasm",
						digest: `sha256:${hex}`,
					}),
				],
				trustedBuilderIds: [GITHUB_BUILDER],
				trustedSignerIdentities: [RELEASE_WORKFLOW],
			},
			context(),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const ref = toJson(ProvenanceRefSchema, outcome.value[0] as never);
		expect(vets("#ProvenanceRef", ref)).toBe(true);
		expect(
			vets("#ProvenanceRef", { ...(ref as object), verified: false }),
		).toBe(false);
		expect(vets("#ProvenanceTrustPolicy", policy)).toBe(true);
		expect(
			vets("#ProvenanceTrustPolicy", {
				sigstore: {
					trustedRoot: "public-good-seed",
					issuers: [GITHUB_ISSUER],
					tlogThreshold: 0,
				},
			}),
		).toBe(false);
		expect(vets("#ProvenanceTrustPolicy", { trustEverything: true })).toBe(
			false,
		);
	});

	it("accepts every refusal the verifier returns", async () => {
		const deps = {
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => T0,
		};
		const artifacts = createArtifactStore({ backend: "memory" }, deps);
		const verifier = createArtifactVerifier({
			...deps,
			artifacts,
			http: new ScriptedTransport().http,
		});
		const outcome = await verifier.verify(
			create(FreightManifestRecordSchema, {
				artifacts: [
					create(ArtifactRefSchema, {
						name: "a",
						digest: `sha256:${"b".repeat(64)}`,
						coordinate: "pkg:gem/absent@1.0.0",
						ecosystem: "rubygems",
					}),
					create(ArtifactRefSchema, {
						name: "b",
						digest: `sha256:${"c".repeat(64)}`,
						coordinate: "ghcr.io/acme/api:latest",
						ecosystem: "oci",
					}),
				],
			}),
			context(),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		for (const reason of outcome.reasons)
			expect(vets("#ReasonRecord", toJson(ReasonRecordSchema, reason))).toBe(
				true,
			);
		expect(vets("#ReasonRecord", { code: "made-up", remediation: "x" })).toBe(
			false,
		);
	});
});
