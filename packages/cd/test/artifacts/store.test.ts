// WP3 artifact store: content addressing, verify-on-read, atomic writes,
// journal and telemetry across the memory, filesystem and S3 backends.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactKind } from "../../src/_generated/cd_pb.js";
import {
	createFilesystemBackend,
	NODE_FILESYSTEM_IO,
} from "../../src/artifacts/filesystem.js";
import { createArtifactStore } from "../../src/artifacts/index.js";
import { createMemoryBackend } from "../../src/artifacts/memory.js";
import {
	ARTIFACT_REASON,
	ArtifactStoreError,
} from "../../src/artifacts/reasons.js";
import { createStoreOver } from "../../src/artifacts/store.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type { ArtifactStore, Digest } from "../../src/ports.js";
import { FakeS3 } from "./fake-s3.js";
import {
	bytesOf,
	context,
	MemoryEventStore,
	RecordingTelemetry,
	StaticCredentials,
	T0,
	TENANT,
} from "./fakes.js";

const META = {
	name: "api.wasm",
	kind: ArtifactKind.WASM_COMPONENT,
	mediaType: "application/wasm",
} as const;
const SECRET_KEY = "s3cr3t-AKIA-never-logged-0123456789";

type Harness = {
	store: ArtifactStore;
	events: MemoryEventStore;
	telemetry: RecordingTelemetry;
	corrupt(digest: Digest): void;
};

function memoryHarness(): Harness {
	const events = new MemoryEventStore();
	const telemetry = new RecordingTelemetry();
	const backend = createMemoryBackend();
	const store = createStoreOver(backend, {
		store: events,
		tenant: TENANT,
		now: () => T0,
		telemetry,
	});
	return {
		store,
		events,
		telemetry,
		corrupt: (digest) => {
			const bytes = backend.blobs.get(digest);
			if (bytes) bytes[0] = (bytes[0] ?? 0) ^ 0xff;
		},
	};
}

function filesystemHarness(): Harness & { root: string } {
	const root = mkdtempSync(join(tmpdir(), "hobo-cd-artifacts-"));
	const events = new MemoryEventStore();
	const telemetry = new RecordingTelemetry();
	const store = createArtifactStore(
		{ backend: "filesystem", root },
		{ store: events, tenant: TENANT, now: () => T0, telemetry },
	);
	return {
		root,
		store,
		events,
		telemetry,
		corrupt: (digest) => {
			const hex = digest.slice(7);
			const file = join(root, "blobs", "sha256", hex.slice(0, 2), hex);
			const bytes = readFileSync(file);
			bytes[0] = (bytes[0] ?? 0) ^ 0xff;
			writeFileSync(file, bytes);
		},
	};
}

function s3Harness(): Harness & { s3: FakeS3; credentials: StaticCredentials } {
	const s3 = new FakeS3(
		"https://objects.example.test",
		"hobo-artifacts",
		"AKIDEXAMPLE",
	);
	const credentials = new StaticCredentials({
		accessKeyId: "AKIDEXAMPLE",
		secretAccessKey: SECRET_KEY,
		sessionToken: "session-token-never-logged",
	});
	const events = new MemoryEventStore();
	const telemetry = new RecordingTelemetry();
	const store = createArtifactStore(
		{
			backend: "s3-compatible",
			endpoint: s3.endpoint,
			bucket: s3.bucket,
			region: "us-east-1",
			credentialRef: "vault://cd/artifacts",
			credentials,
			http: s3.http,
		},
		{ store: events, tenant: TENANT, now: () => T0, telemetry },
	);
	return {
		s3,
		credentials,
		store,
		events,
		telemetry,
		corrupt: (digest) => {
			const object = s3.objects.get(`blobs/sha256/${digest.slice(7)}`);
			if (object)
				object.body = Buffer.from("tampered at rest").toString("base64");
		},
	};
}

async function collect(store: ArtifactStore): Promise<Digest[]> {
	const out: Digest[] = [];
	for await (const digest of store.list(new AbortController().signal))
		out.push(digest);
	return out;
}

async function rejection(
	promise: Promise<unknown>,
): Promise<ArtifactStoreError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ArtifactStoreError) return error;
		throw error;
	}
	throw new Error("expected an ArtifactStoreError");
}

describe.each([
	["memory", memoryHarness],
	["filesystem", filesystemHarness],
	["s3-compatible", s3Harness],
] as const)("artifact store (%s backend)", (backend, harness) => {
	it("addresses bytes by their sha256 digest and returns them intact", async () => {
		const h = harness();
		const bytes = bytesOf("component bytes v1");
		const ref = await h.store.put(bytes, META, context());
		expect(ref.digest).toBe(
			`sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		);
		expect(ref.coordinate).toBe(`store://${backend}/${ref.digest}`);
		expect(ref.ecosystem).toBe("store");
		expect(ref.sizeBytes).toBe(BigInt(bytes.byteLength));
		expect(ref.kind).toBe(ArtifactKind.WASM_COMPONENT);
		const digest = ref.digest as Digest;
		expect(await h.store.get(digest)).toEqual(bytes);
		expect(await h.store.has(digest)).toBe(true);
		expect(await collect(h.store)).toEqual([digest]);
		expect(h.store.backend).toBe(backend);
	});

	it("journals artifact.Stored once per digest however often it is put", async () => {
		const h = harness();
		const first = await h.store.put(bytesOf("same"), META, context());
		await h.store.put(bytesOf("same"), META, context());
		const events = h.events.events(CD_STREAMS.artifact(first.digest));
		expect(events.map((event) => event.type)).toEqual([
			CD_EVENTS.ArtifactStored,
		]);
		expect(events[0]?.data).toMatchObject({
			artifact: { digest: first.digest, ecosystem: "store" },
			backend,
			storedAt: new Date(T0).toISOString(),
		});
		expect(h.telemetry.count("hobo.cd.artifact.stored", { backend })).toBe(1);
	});

	it("Corruption is detected on read", async () => {
		const h = harness();
		const ref = await h.store.put(bytesOf("pristine"), META, context());
		const digest = ref.digest as Digest;
		h.corrupt(digest);
		const error = await rejection(h.store.get(digest));
		expect(error.code).toBe(ARTIFACT_REASON.corrupt);
		expect(error.subject).toBe(digest);
		expect(error.remediation).not.toBe("");
		expect(h.telemetry.count("hobo.cd.artifact.corrupt", { backend })).toBe(1);
	});

	it("repairs a corrupt blob when the true bytes are put again", async () => {
		const h = harness();
		const bytes = bytesOf("repairable");
		const ref = await h.store.put(bytes, META, context());
		h.corrupt(ref.digest as Digest);
		await h.store.put(bytes, META, context());
		expect(await h.store.get(ref.digest as Digest)).toEqual(bytes);
	});

	it("deletes with a recorded reason, once", async () => {
		const h = harness();
		const ref = await h.store.put(bytesOf("short-lived"), META, context());
		const digest = ref.digest as Digest;
		await h.store.delete(
			digest,
			"retention: unreferenced past blob grace",
			context(),
		);
		await h.store.delete(
			digest,
			"retention: unreferenced past blob grace",
			context(),
		);
		expect(await h.store.has(digest)).toBe(false);
		expect(await h.store.get(digest)).toBeUndefined();
		expect(await collect(h.store)).toEqual([]);
		const types = h.events
			.events(CD_STREAMS.artifact(digest))
			.map((event) => event.type);
		expect(types).toEqual([
			CD_EVENTS.ArtifactStored,
			CD_EVENTS.ArtifactDeleted,
		]);
		expect(h.events.events(CD_STREAMS.artifact(digest))[1]?.data).toMatchObject(
			{
				digest,
				backend,
				reason: "retention: unreferenced past blob grace",
			},
		);
		expect(h.telemetry.count("hobo.cd.artifact.deleted")).toBe(1);
		await h.store.put(bytesOf("short-lived"), META, context());
		expect(
			h.events.events(CD_STREAMS.artifact(digest)).map((event) => event.type),
		).toEqual([
			CD_EVENTS.ArtifactStored,
			CD_EVENTS.ArtifactDeleted,
			CD_EVENTS.ArtifactStored,
		]);
	});

	it("refuses a delete without a reason and an unparsed digest", async () => {
		const h = harness();
		const ref = await h.store.put(bytesOf("x"), META, context());
		expect(
			(await rejection(h.store.delete(ref.digest as Digest, " ", context())))
				.code,
		).toBe(ARTIFACT_REASON.configInvalid);
		expect((await rejection(h.store.get("sha256:XYZ" as Digest))).code).toBe(
			ARTIFACT_REASON.digestInvalid,
		);
	});

	it("refuses an artifact without a declared kind", async () => {
		const h = harness();
		const error = await rejection(
			h.store.put(
				bytesOf("x"),
				{ ...META, kind: ArtifactKind.UNSPECIFIED },
				context(),
			),
		);
		expect(error.code).toBe(ARTIFACT_REASON.configInvalid);
	});
});

describe("filesystem backend", () => {
	it("Partial uploads are never visible: a write that fails before rename leaves nothing behind", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-cd-artifacts-"));
		const events = new MemoryEventStore();
		const failing = createFilesystemBackend(root, {
			...NODE_FILESYSTEM_IO,
			rename: async () => {
				throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			},
		});
		const store = createStoreOver(failing, {
			store: events,
			tenant: TENANT,
			now: () => T0,
		});
		const error = await rejection(
			store.put(bytesOf("never half-written"), META, context()),
		);
		expect(error.code).toBe(ARTIFACT_REASON.backendUnavailable);
		expect(error.message).toContain("ENOSPC");
		const reader = createStoreOver(createFilesystemBackend(root), {
			store: events,
			tenant: TENANT,
			now: () => T0,
		});
		expect(await collect(reader)).toEqual([]);
		expect(readdirSync(join(root, "tmp"))).toEqual([]);
		expect(events.allEvents()).toEqual([]);
	});

	it("never lists or reads a stray partial file left by a crash", async () => {
		const h = filesystemHarness();
		const ref = await h.store.put(bytesOf("whole"), META, context());
		writeFileSync(join(h.root, "tmp", `${"a".repeat(64)}.1.1.partial`), "half");
		expect(await collect(h.store)).toEqual([ref.digest]);
		expect(await h.store.has(`sha256:${"a".repeat(64)}` as Digest)).toBe(false);
	});

	it("lays blobs out content-addressed under blobs/sha256/<hh>/<hex>", async () => {
		const h = filesystemHarness();
		const ref = await h.store.put(bytesOf("layout"), META, context());
		const hex = ref.digest.slice(7);
		expect(
			readFileSync(
				join(h.root, "blobs", "sha256", hex.slice(0, 2), hex),
				"utf8",
			),
		).toBe("layout");
	});
});

describe("s3-compatible backend", () => {
	it("creates conditionally and treats a lost race as the existing blob", async () => {
		const h = s3Harness();
		const ref = await h.store.put(bytesOf("racy"), META, context());
		const put = h.s3.requests.find((request) => request.method === "PUT");
		expect(put?.headers["if-none-match"]).toBe("*");
		expect(put?.headers["x-amz-meta-hobo-encoding"]).toBe("base64");
		expect(put?.headers.host).toBeUndefined();
		const again = await h.store.put(bytesOf("racy"), META, context());
		expect(again.digest).toBe(ref.digest);
		expect(
			h.s3.requests.filter((request) => request.method === "PUT"),
		).toHaveLength(2);
	});

	it("resolves credentials per call and scopes them to the bucket", async () => {
		const h = s3Harness();
		const ref = await h.store.put(bytesOf("scoped"), META, context());
		await h.store.get(ref.digest as Digest);
		expect(h.credentials.calls.length).toBe(h.s3.requests.length);
		expect(
			new Set(h.credentials.calls.map((call) => `${call.ref} ${call.scope}`)),
		).toEqual(
			new Set(["vault://cd/artifacts artifact-store:s3:hobo-artifacts"]),
		);
	});

	it("No credential appears in an event or error", async () => {
		const h = s3Harness();
		const ref = await h.store.put(bytesOf("audited"), META, context());
		await h.store.delete(ref.digest as Digest, "operator cleanup", context());
		h.s3.failNext = {
			when: (request) => request.method === "PUT",
			status: 403,
		};
		const refused = await rejection(
			h.store.put(bytesOf("refused"), META, context()),
		);
		h.s3.throwNext = { when: () => true };
		const unknown = await rejection(h.store.get(ref.digest as Digest));
		const recorded = JSON.stringify([h.events.allEvents(), h.telemetry.points]);
		const errors = JSON.stringify([
			refused.message,
			refused.remediation,
			unknown.message,
			unknown.remediation,
		]);
		for (const secret of [SECRET_KEY, "session-token-never-logged"]) {
			expect(recorded).not.toContain(secret);
			expect(errors).not.toContain(secret);
		}
		expect(refused.code).toBe(ARTIFACT_REASON.backendRejected);
		expect(unknown.code).toBe(ARTIFACT_REASON.backendUnavailable);
	});

	it("uploads above the multipart threshold in parts and exposes the object only on completion", async () => {
		const s3 = new FakeS3(
			"https://objects.example.test",
			"hobo-artifacts",
			"AKIDEXAMPLE",
		);
		const events = new MemoryEventStore();
		const { createS3Backend } = await import("../../src/artifacts/s3.js");
		const backend = createS3Backend(
			{
				backend: "s3-compatible",
				endpoint: s3.endpoint,
				bucket: s3.bucket,
				region: "us-east-1",
				credentialRef: "vault://cd/artifacts",
				credentials: new StaticCredentials({
					accessKeyId: "AKIDEXAMPLE",
					secretAccessKey: SECRET_KEY,
				}),
				http: s3.http,
			},
			() => T0,
			{ multipartThresholdBytes: 16, partSizeChars: 8, maxBlobBytes: 1024 },
		);
		const store = createStoreOver(backend, {
			store: events,
			tenant: TENANT,
			now: () => T0,
		});
		const bytes = bytesOf("a payload larger than sixteen bytes");
		const ref = await store.put(bytes, META, context());
		const parts = s3.requests.filter((request) =>
			request.url.includes("partNumber="),
		);
		expect(parts.length).toBeGreaterThan(1);
		expect(
			s3.requests.some(
				(request) =>
					request.method === "POST" && request.url.endsWith("?uploads="),
			),
		).toBe(true);
		const complete = s3.requests.find(
			(request) =>
				request.method === "POST" && request.url.includes("uploadId="),
		);
		expect(complete?.headers["if-none-match"]).toBe("*");
		expect(await store.get(ref.digest as Digest)).toEqual(bytes);

		s3.failNext = {
			when: (request) => request.url.includes("partNumber=2"),
			status: 500,
		};
		const error = await rejection(
			store.put(bytesOf("another payload over sixteen bytes"), META, context()),
		);
		expect(error.code).toBe(ARTIFACT_REASON.backendUnavailable);
		expect(s3.uploads.size).toBe(0);
		expect(s3.visibleKeys()).toEqual([`blobs/sha256/${ref.digest.slice(7)}`]);
		expect(s3.requests.at(-1)?.method).toBe("DELETE");
	});

	it("multipart starts above 64 MiB and the backend caps blobs at 256 MiB", async () => {
		const {
			ARTIFACT_MULTIPART_THRESHOLD_BYTES,
			ARTIFACT_S3_MAX_BLOB_BYTES,
			createS3Backend,
		} = await import("../../src/artifacts/s3.js");
		expect(ARTIFACT_MULTIPART_THRESHOLD_BYTES).toBe(64 * 1024 * 1024);
		const s3 = new FakeS3(
			"https://objects.example.test",
			"hobo-artifacts",
			"AKIDEXAMPLE",
		);
		const backend = createS3Backend(
			{
				backend: "s3-compatible",
				endpoint: s3.endpoint,
				bucket: s3.bucket,
				region: "us-east-1",
				credentialRef: "vault://cd/artifacts",
				credentials: new StaticCredentials({
					accessKeyId: "AKIDEXAMPLE",
					secretAccessKey: SECRET_KEY,
				}),
				http: s3.http,
			},
			() => T0,
			{
				multipartThresholdBytes: ARTIFACT_MULTIPART_THRESHOLD_BYTES,
				partSizeChars: 8,
				maxBlobBytes: 64,
			},
		);
		const store = createStoreOver(backend, {
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => T0,
		});
		expect(
			(await rejection(store.put(new Uint8Array(65), META, context()))).code,
		).toBe(ARTIFACT_REASON.tooLarge);
		expect(ARTIFACT_S3_MAX_BLOB_BYTES).toBe(256 * 1024 * 1024);
	});

	it("lists every page of a truncated listing", async () => {
		const h = s3Harness();
		const digests: string[] = [];
		for (const text of ["one", "two", "three", "four", "five"])
			digests.push((await h.store.put(bytesOf(text), META, context())).digest);
		expect(await collect(h.store)).toEqual([...digests].sort());
	});

	it("refuses a plain-http endpoint or one carrying credentials, without echoing them", () => {
		const s3 = new FakeS3(
			"https://objects.example.test",
			"hobo-artifacts",
			"AKIDEXAMPLE",
		);
		const base = {
			backend: "s3-compatible" as const,
			bucket: "hobo-artifacts",
			region: "us-east-1",
			credentialRef: "vault://cd/artifacts",
			credentials: new StaticCredentials({}),
			http: s3.http,
		};
		const deps = {
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => T0,
		};
		expect(() =>
			createArtifactStore(
				{ ...base, endpoint: "http://objects.example.test" },
				deps,
			),
		).toThrow(/https/);
		let message = "";
		try {
			createArtifactStore(
				{ ...base, endpoint: "https://user:hunter2@objects.example.test" },
				deps,
			);
		} catch (error) {
			message = error instanceof Error ? error.message : "";
		}
		expect(message).toContain(ARTIFACT_REASON.configInvalid);
		expect(message).not.toContain("hunter2");
	});

	it("reports an unresolvable credentialRef as a typed failure", async () => {
		const s3 = new FakeS3(
			"https://objects.example.test",
			"hobo-artifacts",
			"AKIDEXAMPLE",
		);
		const store = createArtifactStore(
			{
				backend: "s3-compatible",
				endpoint: s3.endpoint,
				bucket: "hobo-artifacts",
				region: "us-east-1",
				credentialRef: "vault://cd/missing",
				credentials: new StaticCredentials({}),
				http: s3.http,
			},
			{ store: new MemoryEventStore(), tenant: TENANT, now: () => T0 },
		);
		expect(
			(await rejection(store.has(`sha256:${"0".repeat(64)}` as Digest))).code,
		).toBe(ARTIFACT_REASON.credentialUnavailable);
		expect(s3.requests).toEqual([]);
	});
});
