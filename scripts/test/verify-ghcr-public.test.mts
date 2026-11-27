import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { verifyPublicGhcrImage } from "../ci/verify-ghcr-public.mts";

const media = {
	image: "application/vnd.oci.image.manifest.v1+json",
	index: "application/vnd.oci.image.index.v1+json",
	config: "application/vnd.oci.image.config.v1+json",
	layer: "application/vnd.oci.image.layer.v1.tar+gzip",
};
function descriptor(bytes: Buffer, mediaType: string) {
	return {
		mediaType,
		digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		size: bytes.length,
	};
}
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
type JsonDocument = { [key: string]: JsonValue };
function encoded(value: JsonDocument): Buffer {
	return Buffer.from(JSON.stringify(value));
}
function fixture() {
	const config = Buffer.from("configuration");
	const layer = Buffer.from("layer-content");
	const attConfig = Buffer.from("{}");
	const attLayer = Buffer.from("attestation");
	const blobs = [config, layer, attConfig, attLayer];
	const image = encoded({
		schemaVersion: 2,
		mediaType: media.image,
		config: descriptor(config, media.config),
		layers: [descriptor(layer, media.layer)],
	});
	const attestation = encoded({
		schemaVersion: 2,
		mediaType: media.image,
		config: descriptor(attConfig, media.config),
		layers: [descriptor(attLayer, media.layer)],
	});
	const child = descriptor(image, media.image);
	const attChild = {
		...descriptor(attestation, media.image),
		annotations: { "vnd.docker.reference.type": "attestation-manifest" },
	};
	const root = encoded({
		schemaVersion: 2,
		mediaType: media.index,
		manifests: [child, attChild],
	});
	const rootDesc = descriptor(root, media.index);
	const manifestMap = new Map(
		[root, image, attestation].map((b) => [
			descriptor(b, media.image).digest,
			b,
		]),
	);
	const blobMap = new Map(
		blobs.map((b) => [descriptor(b, media.layer).digest, b]),
	);
	return {
		root,
		rootDesc,
		child,
		attChild,
		image,
		attestation,
		manifestMap,
		blobMap,
		ref: `ghcr.io/hobo-labs/hobo/hobo-sdk@${rootDesc.digest}`,
	};
}
type Call = { url: string; options: RequestInit | undefined };
function requestAuthorization(options: RequestInit | undefined): string | null {
	if (!options?.headers) return null;
	if (options.headers instanceof Headers)
		return options.headers.get("authorization");
	if (Array.isArray(options.headers)) {
		for (const [key, value] of options.headers)
			if (key.toLowerCase() === "authorization") return value;
		return null;
	}
	// SAFETY: RequestInit.headers is Headers, string[][], or Record<string, string>; the branches above exclude the other shapes.
	const record = options.headers as Record<string, string>;
	for (const [key, value] of Object.entries(record))
		if (key.toLowerCase() === "authorization") return value;
	return null;
}
function registry(
	f: ReturnType<typeof fixture>,
	mutate?: (url: URL, response: Response) => Response,
) {
	const calls: Call[] = [];
	const fetcher: typeof fetch = async (input, options) => {
		const url = new URL(String(input));
		calls.push({ url: url.href, options });
		let response: Response;
		if (url.pathname === "/token")
			response = Response.json({ token: "public-token" });
		else if (
			url.hostname === "ghcr.io" &&
			url.pathname.includes("/manifests/")
		) {
			const body = f.manifestMap.get(url.pathname.split("/").at(-1) ?? "");
			response = body
				? new Response(new Uint8Array(body))
				: new Response("", { status: 404 });
		} else if (url.hostname === "ghcr.io" && url.pathname.includes("/blobs/")) {
			const digest = url.pathname.split("/").at(-1) ?? "";
			response = new Response(null, {
				status: 307,
				headers: {
					location: `https://pkg-containers.githubusercontent.com/blobs/${digest}?sig=secret`,
				},
			});
		} else if (url.hostname === "pkg-containers.githubusercontent.com") {
			const body = f.blobMap.get(url.pathname.split("/").at(-1) ?? "");
			response = body
				? new Response(new Uint8Array(body))
				: new Response("", { status: 404 });
		} else response = new Response("", { status: 404 });
		return mutate ? mutate(url, response) : response;
	};
	return { fetcher, calls };
}

test("verifies an anonymous index, runnable image, attestation and every referenced blob", async () => {
	const f = fixture();
	const mock = registry(f);
	await verifyPublicGhcrImage(f.ref, mock.fetcher);
	assert.equal(
		mock.calls.filter(
			(c) => new URL(c.url).hostname === "pkg-containers.githubusercontent.com",
		).length,
		4,
	);
	assert.equal(
		mock.calls.filter((c) => c.url.includes("/manifests/")).length,
		3,
	);
	assert.equal(mock.calls[0]?.options?.headers, undefined);
	assert.equal(
		new URL(mock.calls[0]?.url ?? "").searchParams.get("scope"),
		"repository:hobo-labs/hobo/hobo-sdk:pull",
	);
	for (const call of mock.calls.filter(
		(c) => new URL(c.url).hostname === "pkg-containers.githubusercontent.com",
	)) {
		assert.equal(
			new Headers(call.options?.headers).has("authorization"),
			false,
		);
		assert.equal(call.options?.redirect, "error");
	}
});

test("rejects anonymous denial and malformed references", async () => {
	const prev = process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS;
	process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS = "0";
	try {
		await assert.rejects(
			verifyPublicGhcrImage(
				fixture().ref,
				async () => new Response("", { status: 401 }),
			),
			/HTTP 401/u,
		);
	} finally {
		if (prev === undefined) delete process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS;
		else process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS = prev;
	}
	await assert.rejects(
		verifyPublicGhcrImage(fixture().ref.replace("ghcr.io", "example.com")),
		/Expected/u,
	);
});

test("retries transient anonymous token 401 while GHCR visibility propagates", async () => {
	const f = fixture();
	const prev = process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS;
	process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS = "0,0,0";
	try {
		let attempts = 0;
		const a = registry(f, (url, res) => {
			if (url.pathname === "/token") {
				attempts += 1;
				if (attempts < 3) return new Response("", { status: 401 });
			}
			return res;
		});
		const result = await verifyPublicGhcrImage(f.ref, a.fetcher);
		assert.equal(result.manifestCount, 3);
		assert.equal(attempts, 3);
	} finally {
		if (prev === undefined) delete process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS;
		else process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS = prev;
	}
});

test("exchanges anonymous bearer token via manifest challenge when direct token is denied", async () => {
	const f = fixture();
	const prev = process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS;
	process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS = "0";
	try {
		let tokenCalls = 0;
		const base = registry(f);
		const fetcher: typeof fetch = async (input, init) => {
			const url = new URL(String(input));
			if (url.hostname === "ghcr.io" && url.pathname === "/token") {
				tokenCalls += 1;
				if (tokenCalls === 1) return new Response("", { status: 401 });
			}
			if (
				url.hostname === "ghcr.io" &&
				url.pathname.includes("/manifests/") &&
				requestAuthorization(init) === null
			)
				return new Response("", {
					status: 401,
					headers: {
						"www-authenticate":
							'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:hobo-labs/hobo-sdk:pull"',
					},
				});
			return base.fetcher(input, init);
		};
		const result = await verifyPublicGhcrImage(f.ref, fetcher);
		assert.equal(result.manifestCount, 3);
	} finally {
		if (prev === undefined) delete process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS;
		else process.env.HOBO_GHCR_PUBLIC_VERIFY_RETRY_MS = prev;
	}
});

test("rejects a changed child manifest and a missing or changed layer", async () => {
	const f = fixture();
	const a = registry(f, (url, res) =>
		url.pathname.endsWith(f.child.digest) ? new Response("wrong") : res,
	);
	await assert.rejects(
		verifyPublicGhcrImage(f.ref, a.fetcher),
		/manifest size mismatch|manifest digest mismatch/u,
	);
	const b = fixture();
	const target = [...b.blobMap.keys()][1];
	const missing = registry(b, (url, res) =>
		url.hostname === "pkg-containers.githubusercontent.com" &&
		url.pathname.endsWith(target ?? "")
			? new Response("", { status: 404 })
			: res,
	);
	await assert.rejects(
		verifyPublicGhcrImage(b.ref, missing.fetcher),
		/HTTP 404/u,
	);
	const altered = registry(b, (url, res) =>
		url.hostname === "pkg-containers.githubusercontent.com" &&
		url.pathname.endsWith(target ?? "")
			? new Response("layer-contEnt")
			: res,
	);
	await assert.rejects(
		verifyPublicGhcrImage(b.ref, altered.fetcher),
		/blob digest or size mismatch/u,
	);
});

test("never follows foreign blob redirects or leaks signed location", async () => {
	const f = fixture();
	const mock = registry(f, (url, res) =>
		url.hostname === "ghcr.io" && url.pathname.includes("/blobs/")
			? new Response(null, {
					status: 307,
					headers: {
						location: "https://evil.example/private?token=do-not-log",
					},
				})
			: res,
	);
	await assert.rejects(
		verifyPublicGhcrImage(f.ref, mock.fetcher),
		(error: Error) =>
			/not permitted/u.test(error.message) &&
			!error.message.includes("do-not-log"),
	);
	assert.equal(
		mock.calls.some((c) => c.url.includes("evil.example")),
		false,
	);
});

test("rejects an attestation-only index and ambiguous documents", async () => {
	const f = fixture();
	const root = encoded({
		schemaVersion: 2,
		mediaType: media.index,
		manifests: [f.attChild],
	});
	const d = descriptor(root, media.index);
	f.manifestMap.set(d.digest, root);
	await assert.rejects(
		verifyPublicGhcrImage(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${d.digest}`,
			registry(f).fetcher,
		),
		/no runnable image/u,
	);
	const ambiguous = encoded({
		schemaVersion: 2,
		manifests: [f.child],
		config: descriptor(Buffer.from("{}"), media.config),
		layers: [],
	});
	const a = descriptor(ambiguous, media.index);
	f.manifestMap.set(a.digest, ambiguous);
	await assert.rejects(
		verifyPublicGhcrImage(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${a.digest}`,
			registry(f).fetcher,
		),
		/shape is invalid/u,
	);
});

test("downloads duplicate referenced blobs only once", async () => {
	const f = fixture();
	const imageDoc = JSON.parse(f.image.toString("utf8"));
	imageDoc.layers.push(imageDoc.layers[0]);
	const image = encoded(imageDoc);
	const root = encoded({
		schemaVersion: 2,
		mediaType: media.index,
		manifests: [descriptor(image, media.image)],
	});
	const d = descriptor(root, media.index);
	f.manifestMap.set(descriptor(image, media.image).digest, image);
	f.manifestMap.set(d.digest, root);
	const mock = registry(f);
	const result = await verifyPublicGhcrImage(
		`ghcr.io/hobo-labs/hobo/hobo-sdk@${d.digest}`,
		mock.fetcher,
	);
	assert.equal(result.blobCount, 2);
	assert.equal(
		mock.calls.filter(
			(c) => new URL(c.url).hostname === "pkg-containers.githubusercontent.com",
		).length,
		2,
	);
});

test("checks descriptor sizes and bounded parallelism", async () => {
	const f = fixture();
	const wrong = encoded({
		schemaVersion: 2,
		mediaType: media.index,
		manifests: [{ ...f.child, size: f.child.size + 1 }],
	});
	const d = descriptor(wrong, media.index);
	f.manifestMap.set(d.digest, wrong);
	await assert.rejects(
		verifyPublicGhcrImage(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${d.digest}`,
			registry(f).fetcher,
		),
		/manifest size mismatch/u,
	);

	const valid = fixture();
	const mock = registry(valid);
	let active = 0;
	let peak = 0;
	const delayed: typeof fetch = async (input, options) => {
		if (
			new URL(String(input)).hostname === "pkg-containers.githubusercontent.com"
		) {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active -= 1;
		}
		return mock.fetcher(input, options);
	};
	await verifyPublicGhcrImage(valid.ref, delayed);
	assert.equal(peak, 4);
});

test("rejects corrupted attestation bytes and hides stream failures", async () => {
	const f = fixture();
	const target = [...f.blobMap.keys()].at(-1);
	const bad = registry(f, (url, res) =>
		url.hostname === "pkg-containers.githubusercontent.com" &&
		url.pathname.endsWith(target ?? "")
			? new Response("not-attestA")
			: res,
	);
	await assert.rejects(
		verifyPublicGhcrImage(f.ref, bad.fetcher),
		/blob digest or size mismatch/u,
	);
	const stream = registry(f, (url, res) =>
		url.hostname === "pkg-containers.githubusercontent.com"
			? new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("secret-stream-location"));
						},
					}),
				)
			: res,
	);
	await assert.rejects(
		verifyPublicGhcrImage(f.ref, stream.fetcher),
		(error: Error) =>
			/response read failed/u.test(error.message) &&
			!error.message.includes("secret-stream-location"),
	);
});

test("rejects invalid token JSON without exposing its content", async () => {
	const f = fixture();
	await assert.rejects(
		verifyPublicGhcrImage(
			f.ref,
			async () => new Response('{"token":"secret-value'),
		),
		(error: Error) =>
			/token response is invalid/u.test(error.message) &&
			!error.message.includes("secret-value"),
	);
});

test("recurses through nested indexes and rejects excessive depth", async () => {
	const f = fixture();
	let root = f.root;
	for (let i = 0; i < 2; i += 1) {
		const next = encoded({
			schemaVersion: 2,
			mediaType: media.index,
			manifests: [descriptor(root, media.index)],
		});
		f.manifestMap.set(descriptor(next, media.index).digest, next);
		root = next;
	}
	const d = descriptor(root, media.index);
	const result = await verifyPublicGhcrImage(
		`ghcr.io/hobo-labs/hobo/hobo-sdk@${d.digest}`,
		registry(f).fetcher,
	);
	assert.equal(result.manifestCount, 5);
	for (let i = 0; i < 8; i += 1) {
		const next = encoded({
			schemaVersion: 2,
			mediaType: media.index,
			manifests: [descriptor(root, media.index)],
		});
		f.manifestMap.set(descriptor(next, media.index).digest, next);
		root = next;
	}
	const excessive = descriptor(root, media.index);
	await assert.rejects(
		verifyPublicGhcrImage(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${excessive.digest}`,
			registry(f).fetcher,
		),
		/manifest graph is invalid/u,
	);
});

test("rejects conflicting sizes for the same manifest digest", async () => {
	const f = fixture();
	const root = encoded({
		schemaVersion: 2,
		mediaType: media.index,
		manifests: [f.child, { ...f.child, size: f.child.size + 1 }],
	});
	const d = descriptor(root, media.index);
	f.manifestMap.set(d.digest, root);
	await assert.rejects(
		verifyPublicGhcrImage(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${d.digest}`,
			registry(f).fetcher,
		),
		/manifest size mismatch/u,
	);
});

test("rejects contradictory blob descriptors before downloading blobs", async () => {
	const f = fixture();
	const doc = JSON.parse(f.image.toString("utf8"));
	doc.layers.push({ ...doc.layers[0], size: doc.layers[0].size + 1 });
	const image = encoded(doc);
	const root = encoded({
		schemaVersion: 2,
		mediaType: media.index,
		manifests: [descriptor(image, media.image)],
	});
	const d = descriptor(root, media.index);
	f.manifestMap.set(descriptor(image, media.image).digest, image);
	f.manifestMap.set(d.digest, root);
	const mock = registry(f);
	await assert.rejects(
		verifyPublicGhcrImage(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${d.digest}`,
			mock.fetcher,
		),
		/descriptor conflict/u,
	);
	assert.equal(
		mock.calls.some((call) => call.url.includes("/blobs/")),
		false,
	);
});

test("rejects manifest descriptor media types that disagree with the fetched content", async () => {
	const f = fixture();
	const wrongKind = encoded({
		schemaVersion: 2,
		mediaType: media.index,
		manifests: [{ ...f.child, mediaType: media.index }],
	});
	const d = descriptor(wrongKind, media.index);
	f.manifestMap.set(d.digest, wrongKind);
	await assert.rejects(
		verifyPublicGhcrImage(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${d.digest}`,
			registry(f).fetcher,
		),
		/descriptor media type mismatch/u,
	);

	const wrongRepeat = encoded({
		schemaVersion: 2,
		mediaType: media.index,
		manifests: [
			f.child,
			{
				...f.child,
				mediaType: "application/vnd.docker.distribution.manifest.v2+json",
			},
		],
	});
	const e = descriptor(wrongRepeat, media.index);
	f.manifestMap.set(e.digest, wrongRepeat);
	await assert.rejects(
		verifyPublicGhcrImage(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${e.digest}`,
			registry(f).fetcher,
		),
		/descriptor media type mismatch/u,
	);
});

test("accepts optional body mediaType omission when descriptor and response agree", async () => {
	const f = fixture();
	const image = encoded({
		schemaVersion: 2,
		config: descriptor(Buffer.from("configuration"), media.config),
		layers: [descriptor(Buffer.from("layer-content"), media.layer)],
	});
	const child = descriptor(image, media.image);
	const root = encoded({
		schemaVersion: 2,
		mediaType: media.index,
		manifests: [child],
	});
	const d = descriptor(root, media.index);
	f.manifestMap.set(child.digest, image);
	f.manifestMap.set(d.digest, root);
	const ref = `ghcr.io/hobo-labs/hobo/hobo-sdk@${d.digest}`;
	const noHeaders = registry(f);
	await verifyPublicGhcrImage(ref, noHeaders.fetcher);
	const matching = registry(f, (url, res) =>
		url.pathname.endsWith(child.digest)
			? new Response(new Uint8Array(image), {
					headers: { "content-type": `${media.image}; charset=utf-8` },
				})
			: res,
	);
	await verifyPublicGhcrImage(ref, matching.fetcher);
	const mismatching = registry(f, (url, res) =>
		url.pathname.endsWith(child.digest)
			? new Response(new Uint8Array(image), {
					headers: { "content-type": media.index },
				})
			: res,
	);
	await assert.rejects(
		verifyPublicGhcrImage(ref, mismatching.fetcher),
		/response media type mismatch/u,
	);
});

test("rejects manifests containing invalid UTF-8 bytes", async () => {
	const f = fixture();
	const config = descriptor(Buffer.from("configuration"), media.config);
	const invalid = Buffer.concat([
		Buffer.from('{"schemaVersion":2,"note":"'),
		Buffer.from([0xff]),
		Buffer.from(`","config":${JSON.stringify(config)},"layers":[]}`),
	]);
	const d = descriptor(invalid, media.image);
	f.manifestMap.set(d.digest, invalid);
	await assert.rejects(
		verifyPublicGhcrImage(
			`ghcr.io/hobo-labs/hobo/hobo-sdk@${d.digest}`,
			registry(f).fetcher,
		),
		/manifest JSON is invalid/u,
	);
});
