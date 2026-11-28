import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vitest";
import {
	type AwsKmsGrant,
	createAwsKmsCryptography,
	inspectAwsKmsCryptography,
} from "../src/aws-cryptography.js";

const keyId = "12345678-1234-1234-1234-123456789012";
const keyArn = `arn:aws:kms:us-east-1:000000000000:key/${keyId}`;
const grant = {
	keyId,
	accountId: "000000000000",
	partition: "aws",
	region: "us-east-1",
	resourceEpoch: `sha256:${"a".repeat(64)}`,
	grantEpoch: `sha256:${"b".repeat(64)}`,
	allow: ["encrypt", "decrypt"] as const,
};
const attemptId = "crypto_attempt_123";
const request = { attemptId, data: new Uint8Array([1, 2, 3]) };
const response = (body: Record<string, string>) =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/x-amz-json-1.1" },
	});
function fixture(
	fetch: typeof globalThis.fetch,
	verify: () => boolean = () => true,
	scopedGrant: AwsKmsGrant = grant,
) {
	const layer = Layer.mergeAll(
		Endpoint.of("http://localhost:4566"),
		Credentials.fromCredentials(
			{
				accessKeyId: Redacted.make("local"),
				secretAccessKey: Redacted.make("local"),
			},
			"us-east-1",
		),
		FetchHttpClient.layer,
		Layer.succeed(FetchHttpClient.Fetch, fetch),
	);
	return createAwsKmsCryptography({ grant: scopedGrant, verify, layer });
}

describe("AWS KMS cryptography", () => {
	it("binds a frozen exact grant to a genuine cryptography port", () => {
		const port = fixture(async () => response({}));
		expect(inspectAwsKmsCryptography(port)).toEqual(grant);
		expect(Object.isFrozen(inspectAwsKmsCryptography(port))).toBe(true);
		expect(inspectAwsKmsCryptography({ ...port })).toBeUndefined();
	});
	it("rejects accessor grants without invoking them", () => {
		let reads = 0;
		const hostile = {
			...grant,
			get keyId() {
				reads++;
				return keyId;
			},
		};
		expect(() =>
			fixture(
				async () => response({}),
				() => true,
				hostile,
			),
		).toThrow("aws_kms.invalid_grant");
		expect(reads).toBe(0);
	});
	it("does not authorize operations omitted from the captured grant", async () => {
		let calls = 0;
		const onlyDecrypt = { ...grant, allow: ["decrypt"] as const };
		const port = fixture(
			async () => {
				calls++;
				return response({});
			},
			() => true,
			onlyDecrypt,
		);
		expect(await port.encrypt(request)).toEqual({
			status: "rejected",
			code: "unauthorized",
		});
		expect(calls).toBe(0);
	});
	it("snapshots mutable inputs before dispatch", async () => {
		let body = "";
		const operations: ("encrypt" | "decrypt")[] = ["encrypt"];
		const port = fixture(
			async (_url, init) => {
				body = String(init?.body);
				return response({ KeyId: keyArn, CiphertextBlob: "BAUG" });
			},
			() => true,
			{ ...grant, allow: operations },
		);
		operations[0] = "decrypt";
		const data = new Uint8Array([1, 2, 3]);
		const pending = port.encrypt({ attemptId, data });
		data.fill(0);
		expect((await pending).status).toBe("completed");
		expect(JSON.parse(body).Plaintext).toBe("AQID");
	});
	it("rejects asynchronous authorization before dispatch", async () => {
		let calls = 0;
		// SAFETY: this invalid verifier exercises the untrusted host boundary.
		const verify = (() => Promise.resolve(true)) as never;
		const port = fixture(async () => {
			calls++;
			return response({});
		}, verify);
		expect(await port.encrypt(request)).toEqual({
			status: "rejected",
			code: "unauthorized",
		});
		expect(calls).toBe(0);
	});
	it("encrypts and decrypts against only the granted key", async () => {
		const bodies: object[] = [];
		const port = fixture(async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return bodies.length === 1
				? response({
						KeyId: keyArn,
						CiphertextBlob: "BAUG",
						EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
					})
				: response({
						KeyId: keyArn,
						Plaintext: "AQID",
						EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
					});
		});
		expect(await port.encrypt(request)).toEqual({
			status: "completed",
			attemptId,
			data: new Uint8Array([4, 5, 6]),
		});
		expect(
			await port.decrypt({ attemptId, data: new Uint8Array([4, 5, 6]) }),
		).toEqual({
			status: "completed",
			attemptId,
			data: new Uint8Array([1, 2, 3]),
		});
		expect(bodies).toEqual([
			{
				KeyId: keyArn,
				Plaintext: "AQID",
				EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
			},
			{
				KeyId: keyArn,
				CiphertextBlob: "BAUG",
				EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
			},
		]);
	});
	it("rejects invalid and unauthorized calls before dispatch", async () => {
		let calls = 0;
		const port = fixture(
			async () => {
				calls++;
				return response({});
			},
			() => false,
		);
		expect(
			await port.encrypt({ attemptId, data: new Uint8Array(4097) }),
		).toEqual({ status: "rejected", code: "invalid-argument" });
		expect(
			await port.decrypt({ attemptId, data: new Uint8Array(6145) }),
		).toEqual({ status: "rejected", code: "invalid-argument" });
		expect(await port.encrypt(request)).toEqual({
			status: "rejected",
			code: "unauthorized",
		});
		expect(calls).toBe(0);
	});
	it("reports unknown on an ambiguous failure without retrying", async () => {
		let calls = 0;
		const port = fixture(async () => {
			calls++;
			return new Response(
				JSON.stringify({ __type: "InternalException", message: "lost" }),
				{
					status: 500,
					headers: { "content-type": "application/x-amz-json-1.1" },
				},
			);
		});
		expect(await port.encrypt(request)).toEqual({
			status: "unknown",
			attemptId,
		});
		expect(calls).toBe(1);
	});
	it("does not disclose output after grant revocation", async () => {
		let valid = true;
		const port = fixture(
			async () => {
				valid = false;
				return response({ KeyId: keyArn, CiphertextBlob: "BAUG" });
			},
			() => valid,
		);
		expect(await port.encrypt(request)).toEqual({
			status: "unknown",
			attemptId,
		});
	});
	it("does not accept output attributed to a different key", async () => {
		const port = fixture(async () =>
			response({ KeyId: `${keyArn}x`, CiphertextBlob: "BAUG" }),
		);
		expect(await port.encrypt(request)).toEqual({
			status: "unknown",
			attemptId,
		});
	});
	it("does not accept a response missing the requested operation's output", async () => {
		const port = fixture(async () =>
			response({ KeyId: keyArn, Plaintext: "AQID" }),
		);
		expect(await port.encrypt(request)).toEqual({
			status: "unknown",
			attemptId,
		});
	});
	it("holds capacity while calls are physically outstanding", async () => {
		let calls = 0;
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const port = fixture(async () => {
			calls++;
			await pending;
			return response({ KeyId: keyArn, CiphertextBlob: "BAUG" });
		});
		const requests = Array.from({ length: 32 }, () => port.encrypt(request));
		await vi.waitFor(() => expect(calls).toBe(32));
		expect(await port.encrypt(request)).toEqual({
			status: "rejected",
			code: "capacity",
		});
		release();
		expect(
			(await Promise.all(requests)).every((r) => r.status === "completed"),
		).toBe(true);
	});
	it("keeps timed-out calls in capacity until their transports settle", {
		timeout: 20_000,
	}, async () => {
		let calls = 0;
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const port = fixture(async () => {
			calls++;
			await pending;
			return response({ KeyId: keyArn, CiphertextBlob: "BAUG" });
		});
		try {
			const requests = Array.from({ length: 32 }, () => port.encrypt(request));
			await vi.waitFor(() => expect(calls).toBe(32));
			expect(
				(await Promise.all(requests)).every((r) => r.status === "unknown"),
			).toBe(true);
			expect(await port.encrypt(request)).toEqual({
				status: "rejected",
				code: "capacity",
			});
			release();
			await vi.waitFor(async () =>
				expect((await port.encrypt(request)).status).toBe("completed"),
			);
		} finally {
			release();
		}
	});
});
