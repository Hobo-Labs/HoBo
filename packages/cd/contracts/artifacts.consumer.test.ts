// PACT consumer verification for the three WP3 boundaries:
// - artifacts.pact.json: artifact store → S3-compatible object store (HTTP);
// - artifacts.registries.pact.json: artifact verifier → package/image registries (HTTP);
// - artifacts.provenance.pact.json: build attestation → provenance verifier (message).
// The real store, verifier and provenance verifier must issue exactly the
// hand-authored requests and turn the hand-authored responses into the
// expected results.
import {
	create,
	fromJson,
	type JsonObject,
	type JsonValue,
	toJson,
} from "@bufbuild/protobuf";
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	ArtifactRefSchema,
	FreightManifestRecordSchema,
	ProvenanceRefSchema,
} from "../src/_generated/cd_pb.js";
import {
	createArtifactStore,
	createArtifactVerifier,
} from "../src/artifacts/index.js";
import { isJsonObject, isJsonString, jsonOf } from "../src/artifacts/json.js";
import { createS3Backend } from "../src/artifacts/s3.js";
import { createStoreOver } from "../src/artifacts/store.js";
import { createProvenanceVerifier } from "../src/provenance/index.js";
import {
	context,
	MemoryEventStore,
	pinned,
	StaticCredentials,
	T0,
	TENANT,
} from "../test/artifacts/fakes.js";
import s3Pact from "./artifacts.pact.json" with { type: "json" };
import provenancePact from "./artifacts.provenance.pact.json" with {
	type: "json",
};
import registryPact from "./artifacts.registries.pact.json" with {
	type: "json",
};

type HttpInteraction = Readonly<{
	description: string;
	request: Readonly<{
		method: string;
		path: string;
		query?: Readonly<Record<string, readonly string[]>>;
		headers?: Readonly<Record<string, string>>;
		body?: Readonly<{ content: JsonValue }>;
		matchingRules?: Readonly<{
			header?: Readonly<
				Record<
					string,
					Readonly<{ matchers: readonly Readonly<{ regex?: string }>[] }>
				>
			>;
		}>;
	}>;
	response: Readonly<{
		status: number;
		headers?: Readonly<Record<string, string>>;
		body?: Readonly<{ content: JsonValue }>;
	}>;
}>;

function headerRule(
	interaction: HttpInteraction,
	name: string,
): RegExp | undefined {
	for (const [path, rule] of Object.entries(
		interaction.request.matchingRules?.header ?? {},
	)) {
		const key = path.replace(/^\$\.header\.?/, "").replace(/^\['|'\]$/g, "");
		const regex = rule.matchers[0]?.regex;
		if (key.toLowerCase() === name.toLowerCase() && regex !== undefined)
			return new RegExp(regex);
	}
	return undefined;
}

/** A Pact body or document as a JSON object (throws when it is not one). */
function objectOf<T>(value: T): JsonObject {
	const json = jsonOf(value);
	if (!isJsonObject(json)) throw new Error("expected a JSON object");
	return json;
}

function text(content: JsonValue | undefined): string {
	if (content === undefined) return "";
	return isJsonString(content) ? content : JSON.stringify(content);
}

function mismatch(
	interaction: HttpInteraction,
	request: TransportRequest,
): string | undefined {
	const url = new URL(request.url);
	const expected = interaction.request;
	if (request.method !== expected.method) return "method";
	if (url.pathname !== expected.path) return "path";
	const query = expected.query ?? {};
	const names = new Set(url.searchParams.keys());
	if (names.size !== Object.keys(query).length) return "query keys";
	for (const [name, values] of Object.entries(query))
		if (
			JSON.stringify(url.searchParams.getAll(name)) !== JSON.stringify(values)
		)
			return `query ${name}`;
	const sent = Object.fromEntries(
		Object.entries(request.headers).map(([name, value]) => [
			name.toLowerCase(),
			value,
		]),
	);
	for (const [name, value] of Object.entries(expected.headers ?? {})) {
		const actual = sent[name.toLowerCase()];
		const rule = headerRule(interaction, name);
		if (actual === undefined || (rule ? !rule.test(actual) : actual !== value))
			return `header ${name}`;
	}
	if (
		expected.body !== undefined &&
		(request.body ?? "") !== text(expected.body.content)
	)
		return "body";
	return undefined;
}

function respond(interaction: HttpInteraction): TransportResponse {
	return {
		status: interaction.response.status,
		headers: { ...interaction.response.headers },
		body: text(interaction.response.body?.content),
	};
}

/** Serves the named interactions; each request must match one of them exactly. */
function pactTransport(
	interactions: readonly HttpInteraction[],
	descriptions: readonly string[],
) {
	const pool = descriptions.map((description) => {
		const found = interactions.find((item) => item.description === description);
		if (found === undefined)
			throw new Error(`Pact interaction missing: ${description}`);
		return found;
	});
	const used: string[] = [];
	const failures: string[] = [];
	const hosts: string[] = [];
	const http: HttpTransport = async (request) => {
		hosts.push(new URL(request.url).host);
		const reasons = pool.map(
			(interaction) => [interaction, mismatch(interaction, request)] as const,
		);
		const hit = reasons.find(([, reason]) => reason === undefined)?.[0];
		if (hit === undefined) {
			failures.push(
				`${request.method} ${request.url}: ${reasons.map(([interaction, reason]) => `${interaction.description} (${reason})`).join("; ")}`,
			);
			return { status: 599, headers: {}, body: "" };
		}
		used.push(hit.description);
		return respond(hit);
	};
	return { http, used, failures, hosts };
}

const S3: readonly HttpInteraction[] = s3Pact.interactions;
const REGISTRIES: readonly HttpInteraction[] = registryPact.interactions;
const BYTES = new TextEncoder().encode("hello artifact");
const META = {
	name: "api.wasm",
	kind: ArtifactKind.WASM_COMPONENT,
	mediaType: "application/wasm",
} as const;

function s3Store(
	http: HttpTransport,
	tuning?: Parameters<typeof createS3Backend>[2],
) {
	const config = {
		backend: "s3-compatible" as const,
		endpoint: "https://objects.example.test",
		bucket: "hobo-artifacts",
		region: "us-east-1",
		credentialRef: "vault://cd/artifacts",
		credentials: new StaticCredentials({
			accessKeyId: "AKIDEXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		}),
		http,
	};
	const deps = { store: new MemoryEventStore(), tenant: TENANT, now: () => T0 };
	return tuning === undefined
		? createArtifactStore(config, deps)
		: createStoreOver(createS3Backend(config, deps.now, tuning), deps);
}

describe("artifact store → S3-compatible object store (artifacts.pact.json)", () => {
	it("is a v4 HTTP Pact", () => {
		expect(s3Pact.metadata.pactSpecification.version).toBe("4.0.0");
		expect(
			s3Pact.interactions.every((item) => item.type === "Synchronous/HTTP"),
		).toBe(true);
	});

	it("puts a new blob with a conditional create", async () => {
		const pact = pactTransport(S3, [
			"put a new blob with a conditional create",
		]);
		const ref = await s3Store(pact.http).put(BYTES, META, context());
		expect(pact.failures).toEqual([]);
		expect(pact.used).toEqual(["put a new blob with a conditional create"]);
		expect(ref.digest).toBe(
			`sha256:${s3Pact.interactions[0]?.request.path.split("/").at(-1)}`,
		);
	});

	it("treats 412 as the existing blob and verifies it by reading", async () => {
		const pact = pactTransport(S3, [
			"put a blob that already exists",
			"get a stored blob",
		]);
		await s3Store(pact.http).put(BYTES, META, context());
		expect(pact.failures).toEqual([]);
		expect(pact.used).toEqual([
			"put a blob that already exists",
			"get a stored blob",
		]);
	});

	it("reads, checks, deletes and lists blobs", async () => {
		const digest = pinned(`sha256:${S3[0]?.request.path.split("/").at(-1)}`);
		const stored = pactTransport(S3, ["get a stored blob"]);
		expect(await s3Store(stored.http).get(digest)).toEqual(BYTES);
		const missing = pactTransport(S3, [
			"get a missing blob",
			"check a missing blob",
		]);
		const store = s3Store(missing.http);
		expect(await store.get(digest)).toBeUndefined();
		expect(await store.has(digest)).toBe(false);
		const deleting = pactTransport(S3, ["delete a blob"]);
		await s3Store(deleting.http).delete(digest, "operator cleanup", context());
		const listing = pactTransport(S3, ["list blobs"]);
		const listed: string[] = [];
		for await (const item of s3Store(listing.http).list(
			new AbortController().signal,
		))
			listed.push(item);
		expect(listed).toEqual([digest]);
		for (const pact of [stored, missing, deleting, listing])
			expect(pact.failures).toEqual([]);
	});

	it("uploads multipart and completes conditionally", async () => {
		const steps = [
			"start a multipart upload",
			"upload part 1",
			"upload part 2",
			"complete a multipart upload conditionally",
		];
		const pact = pactTransport(S3, steps);
		await s3Store(pact.http, {
			multipartThresholdBytes: 4,
			partSizeChars: 12,
			maxBlobBytes: 1024,
		}).put(BYTES, META, context());
		expect(pact.failures).toEqual([]);
		expect(pact.used).toEqual(steps);
	});
});

describe("artifact verifier → registries (artifacts.registries.pact.json)", () => {
	it("is a v4 HTTP Pact covering every registered ecosystem", () => {
		expect(registryPact.metadata.pactSpecification.version).toBe("4.0.0");
		expect(REGISTRIES).toHaveLength(8);
	});

	it("verifies one artifact per ecosystem from the contracted responses", async () => {
		const pact = pactTransport(
			REGISTRIES,
			REGISTRIES.map((item) => item.description),
		);
		const deps = {
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => T0,
		};
		const artifacts = createArtifactStore({ backend: "memory" }, deps);
		const pkg = new TextEncoder().encode(registryPact.metadata.bytes);
		const stored = await artifacts.put(
			pkg,
			{
				name: "pkg",
				kind: ArtifactKind.PACKAGE,
				mediaType: "application/octet-stream",
			},
			context(),
		);
		const oci = REGISTRIES[0]?.request.path.split("/").at(-1) ?? "";
		const ref = (
			name: string,
			ecosystem: string,
			coordinate: string,
			digest = stored.digest,
		) =>
			create(ArtifactRefSchema, {
				name,
				kind: ArtifactKind.PACKAGE,
				digest,
				coordinate,
				ecosystem,
			});
		const verifier = createArtifactVerifier({
			...deps,
			artifacts,
			http: pact.http,
		});
		const outcome = await verifier.verify(
			create(FreightManifestRecordSchema, {
				artifacts: [
					ref("api-image", "oci", `ghcr.io/acme/api:1.2.3@${oci}`, oci),
					ref("npm", "npm", "pkg:npm/%40acme/api@1.2.3"),
					ref(
						"acme_api-1.2.3-py3-none-any.whl",
						"pypi",
						"pkg:pypi/acme-api@1.2.3",
					),
					ref("nuget", "nuget", "pkg:nuget/Acme.Api@1.2.3"),
					ref("jar", "maven", "pkg:maven/com.acme/api@1.2.3"),
					ref("crate", "cargo", "pkg:cargo/serde@1.0.1"),
					ref("gem", "rubygems", "pkg:gem/rack@3.1.8"),
				],
			}),
			context(),
		);
		expect(pact.failures).toEqual([]);
		expect(
			outcome.ok
				? []
				: outcome.reasons.map(
						(reason) => `${reason.subject}: ${reason.code} ${reason.message}`,
					),
		).toEqual([]);
		expect(new Set(pact.used)).toEqual(
			new Set(REGISTRIES.map((item) => item.description)),
		);
		expect(new Set(pact.hosts)).toEqual(
			new Set([
				"ghcr.io",
				"registry.npmjs.org",
				"pypi.org",
				"api.nuget.org",
				"repo.maven.apache.org",
				"index.crates.io",
				"rubygems.org",
			]),
		);
	});
});

describe("attestation → provenance verifier (artifacts.provenance.pact.json)", () => {
	it("is a v4 message Pact", () => {
		expect(provenancePact.metadata.pactSpecification.version).toBe("4.0.0");
		expect(
			provenancePact.interactions.every(
				(item) => item.type === "Synchronous/Messages",
			),
		).toBe(true);
	});

	for (const interaction of provenancePact.interactions) {
		it(interaction.description, async () => {
			const request = interaction.request.contents;
			const at = Date.parse(request.at);
			const verifier = createProvenanceVerifier({
				store: new MemoryEventStore(),
				tenant: TENANT,
				now: () => at,
				http: async () => ({ status: 599, headers: {}, body: "" }),
				trustPolicy: objectOf(request.trustPolicy),
			});
			const outcome = await verifier.verify(
				{
					statement: Buffer.from(request.statementBase64, "base64"),
					bundle: new TextEncoder().encode(JSON.stringify(request.bundle)),
					subjects: request.subjects.map((subject) =>
						fromJson(ArtifactRefSchema, objectOf(subject)),
					),
					trustedBuilderIds: request.trustedBuilderIds,
					trustedSignerIdentities: request.trustedSignerIdentities,
				},
				context(() => at),
			);
			const expected = interaction.response[0]?.contents;
			expect(
				outcome.ok
					? {
							ok: true,
							provenance: outcome.value.map((item) =>
								toJson(ProvenanceRefSchema, item),
							),
						}
					: { ok: false, codes: outcome.reasons.map((reason) => reason.code) },
			).toEqual(expected);
		});
	}
});
