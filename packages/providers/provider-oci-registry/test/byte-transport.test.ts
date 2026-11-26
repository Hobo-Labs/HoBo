/**
 * Byte transports and pushing an image from the artifact store (the release
 * path): binary layers and non-ASCII manifests move byte for byte, so the
 * digest the registry serves is the digest the build recorded. Offline,
 * against the recorded registry world and a recording `fetch`.
 */
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createLatin1FetchTransport,
	declareLatin1Transport,
	isLatin1Transport,
	OCI_REGISTRY_IMAGE_PRODUCT_ID,
	ociLatin1Transport,
	ociRegistryResolverRegistry,
} from "../src/index.js";
import { FakeRegistryWorld, sha256 } from "./support/fake-registry.js";
import { image } from "./support/fixtures.js";

const HOST = "ghcr.test";
const REALM = "https://ghcr.test/token";
const PASSWORD = "fixture-ghcr-token-do-not-leak";
const BINARY = Uint8Array.from({ length: 256 }, (_, index) => index);

function world(denyPull: readonly string[] = []) {
	return new FakeRegistryWorld("latin1", [
		{
			host: HOST,
			auth: {
				kind: "bearer",
				realm: REALM,
				service: HOST,
				username: "hobo-release",
				password: PASSWORD,
			},
			denyPull,
		},
	]);
}

function resolverWith(store: Map<string, Uint8Array>) {
	const resolver = ociRegistryResolverRegistry({
		registry: { host: HOST, authRealms: [REALM] },
		artifactStore: { get: async (digest) => store.get(digest) },
		resolveCredential: async () => ({
			kind: "basic",
			username: "hobo-release",
			password: PASSWORD,
		}),
		transportBodyEncoding: "latin1",
	}).get(OCI_REGISTRY_IMAGE_PRODUCT_ID);
	if (!resolver) throw new Error("oci-registry.image/v1 is not registered");
	return resolver;
}

function request(digest: string, extra: Record<string, string> = {}) {
	return {
		ref: {
			slot: "service" as const,
			productId: OCI_REGISTRY_IMAGE_PRODUCT_ID,
			logicalId: "hobo-cli",
		},
		desired: {
			registry: HOST,
			repository: "hobo-labs/hobo/hobo-cli",
			digest,
			tags: ["0.1.0-alpha.3"],
			copyReferrers: false,
			...extra,
		},
		credentialRef: "env://GITHUB_TOKEN",
	};
}

/** An image whose manifest carries a non-ASCII annotation (UTF-8 bytes). */
function storedImage() {
	const fixture = image({ platform: "amd64", binary: true, size: 4096 });
	const manifest = JSON.parse(fixture.text);
	manifest.annotations = {
		"org.opencontainers.image.description": "HoBo CLI — release image",
	};
	const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
	const store = new Map<string, Uint8Array>([[sha256(bytes), bytes]]);
	for (const blob of fixture.blobs) store.set(blob.digest, blob.bytes);
	return { digest: sha256(bytes), bytes, store, blobs: fixture.blobs };
}

describe("push from the artifact store over a byte transport", () => {
	it("uploads config and layers, PUTs the exact manifest bytes by digest, then the tag; the registry serves the recorded digest", async () => {
		const w = world();
		const stored = storedImage();
		const outcome = await resolverWith(stored.store).reconcile(
			request(stored.digest),
			w.transport,
		);
		expect(outcome.action).toBe("create");
		expect(outcome.outputs.ready).toBe(true);
		expect(outcome.diagnostics[0]).toMatch(/uploaded 2/u);
		const repo = w.repo(HOST, "hobo-labs/hobo/hobo-cli");
		expect(repo.tags.get("0.1.0-alpha.3")).toBe(stored.digest);
		// The registry recomputed the digest from the bytes it received.
		expect(repo.manifests.has(stored.digest)).toBe(true);
		for (const blob of stored.blobs)
			expect(
				Buffer.from(w.hosts.get(HOST)?.blobs.get(blob.digest) ?? []),
			).toEqual(Buffer.from(blob.bytes));
		const puts = w.paths("PUT").filter((path) => path.includes("/manifests/"));
		expect(puts).toEqual([
			`PUT ${HOST}/v2/hobo-labs/hobo/hobo-cli/manifests/${stored.digest}`,
			`PUT ${HOST}/v2/hobo-labs/hobo/hobo-cli/manifests/0.1.0-alpha.3`,
		]);
	});

	it("mounts from a sibling repository when it holds the blob, and uploads only the rest", async () => {
		const w = world();
		const stored = storedImage();
		const base = stored.blobs[1];
		if (!base) throw new Error("fixture has no layer");
		w.seedBlob(HOST, "hobo-labs/hobo/hobo-ci-worker", base.bytes);
		const outcome = await resolverWith(stored.store).reconcile(
			request(stored.digest, {
				sourceRegistry: HOST,
				sourceRepository: "hobo-labs/hobo/hobo-ci-worker",
			}),
			w.transport,
		);
		expect(outcome.diagnostics[0]).toMatch(/mounted 1, uploaded 1/u);
		expect(
			w.repo(HOST, "hobo-labs/hobo/hobo-cli").tags.get("0.1.0-alpha.3"),
		).toBe(stored.digest);
	});

	it("uploads when the credential cannot read the mount source (a mount is never required)", async () => {
		const w = world(["hobo-labs/hobo/hobo-ci-worker"]);
		const stored = storedImage();
		for (const blob of stored.blobs)
			w.seedBlob(HOST, "hobo-labs/hobo/hobo-ci-worker", blob.bytes);
		const outcome = await resolverWith(stored.store).reconcile(
			request(stored.digest, {
				sourceRegistry: HOST,
				sourceRepository: "hobo-labs/hobo/hobo-ci-worker",
			}),
			w.transport,
		);
		expect(outcome.diagnostics[0]).toMatch(/mounted 0, uploaded 2/u);
		expect(outcome.outputs.ready).toBe(true);
	});

	it("refuses when the store lacks a layer, and writes no manifest (nothing substituted)", async () => {
		const w = world();
		const stored = storedImage();
		const layer = stored.blobs[1];
		if (layer) stored.store.delete(layer.digest);
		await expect(
			resolverWith(stored.store).reconcile(request(stored.digest), w.transport),
		).rejects.toMatchObject({ code: "RESOLVER_PROVIDER_REJECTED" });
		expect(w.paths("PUT").some((path) => path.includes("/manifests/"))).toBe(
			false,
		);
	});
});

/** A `fetch` that records what crossed the wire and answers with fixed bytes. */
function recordingFetch(reply: {
	status: number;
	body?: Uint8Array;
	headers?: Record<string, string>;
}) {
	const sent: { url: string; init: RequestInit; bytes: Uint8Array }[] = [];
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		sent.push({
			url: String(input),
			init: init ?? {},
			bytes: new Uint8Array(
				await new Response(init?.body ?? null).arrayBuffer(),
			),
		});
		return new Response(reply.body ? Buffer.from(reply.body) : null, {
			status: reply.status,
			headers: reply.headers ?? {},
		});
	};
	return { sent, fetchImpl };
}

const GET: TransportRequest = {
	method: "GET",
	url: "https://ghcr.test/v2/x/blobs/sha256:00",
	headers: {},
	timeoutMs: 1000,
	maxResponseBytes: 1024,
};

describe("createLatin1FetchTransport", () => {
	it("sends a latin1 body as exactly its bytes and returns the response bytes one code unit each", async () => {
		const { sent, fetchImpl } = recordingFetch({ status: 200, body: BINARY });
		const transport = createLatin1FetchTransport({ fetchImpl });
		expect(isLatin1Transport(transport)).toBe(true);
		const response = await transport({
			...GET,
			method: "PUT",
			body: Buffer.from(BINARY).toString("latin1"),
		});
		expect(sent[0]?.bytes).toEqual(BINARY);
		expect(sent[0]?.init.redirect).toBe("manual");
		expect(Buffer.from(response.body, "latin1")).toEqual(Buffer.from(BINARY));
	});

	it("enforces the response byte cap", async () => {
		const { fetchImpl } = recordingFetch({ status: 200, body: BINARY });
		await expect(
			createLatin1FetchTransport({ fetchImpl })({
				...GET,
				maxResponseBytes: 16,
			}),
		).rejects.toMatchObject({ code: "TRANSPORT_BODY_TOO_LARGE" });
	});
});

describe("ociLatin1Transport", () => {
	it("uses a host transport that is already latin1 as is", () => {
		const host: HttpTransport = declareLatin1Transport(async () => ({
			status: 200,
			headers: {},
			body: "",
		}));
		expect(ociLatin1Transport(host)).toBe(host);
	});

	it("sends ASCII requests through a UTF-8 host and re-expresses its response as latin1", async () => {
		const seen: TransportRequest[] = [];
		const host: HttpTransport = async (request) => {
			seen.push(request);
			return { status: 200, headers: {}, body: '{"d":"—"}' };
		};
		const { sent, fetchImpl } = recordingFetch({ status: 201 });
		const transport = ociLatin1Transport(host, { fetchImpl });
		expect(isLatin1Transport(transport)).toBe(true);
		const response = await transport({ ...GET, body: '{"a":1}' });
		expect(seen).toHaveLength(1);
		expect(sent).toHaveLength(0);
		expect(Buffer.from(response.body, "latin1").toString("utf8")).toBe(
			'{"d":"—"}',
		);
	});

	it("sends a binary body, which a UTF-8 host would re-encode, through the byte transport", async () => {
		const seen: TransportRequest[] = [];
		const host: HttpTransport = async (request) => {
			seen.push(request);
			return { status: 500, headers: {}, body: "" };
		};
		const { sent, fetchImpl } = recordingFetch({ status: 201 });
		const response = await ociLatin1Transport(host, { fetchImpl })({
			...GET,
			method: "PUT",
			body: Buffer.from(BINARY).toString("latin1"),
		});
		expect(response.status).toBe(201);
		expect(seen).toHaveLength(0);
		expect(sent[0]?.bytes).toEqual(BINARY);
	});
});
