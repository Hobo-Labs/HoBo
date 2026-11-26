import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import {
	type AwsSecretGrant,
	createAwsSecretStore,
	inspectAwsSecretStore,
} from "../src/aws-secret.js";

const secretArn =
	"arn:aws:secretsmanager:us-east-1:000000000000:secret:app-ABC123";
const id = "00000000-0000-4000-8000-000000000001";
const grant: AwsSecretGrant = {
	secretArn,
	resourceEpoch: `sha256:${"a".repeat(64)}`,
	grantEpoch: `sha256:${"b".repeat(64)}`,
	allow: ["put", "access"],
};
function fixture(
	fetch: typeof globalThis.fetch,
	verify: Parameters<typeof createAwsSecretStore>[0]["verify"] = () => true,
	selected: AwsSecretGrant = grant,
) {
	let calls = 0;
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
		Layer.succeed(FetchHttpClient.Fetch, (url, init) => {
			calls++;
			return fetch(url, init);
		}),
	);
	return {
		store: createAwsSecretStore({ grant: selected, verify, layer }),
		calls: () => calls,
	};
}

describe("AWS Secrets Manager runtime", () => {
	it("captures a branded immutable grant and rejects malformed grants", () => {
		const f = fixture(async () => new Response("{}"));
		expect(inspectAwsSecretStore(f.store)).toEqual(grant);
		expect(Object.isFrozen(inspectAwsSecretStore(f.store)?.allow)).toBe(true);
		expect(inspectAwsSecretStore({ ...f.store })).toBeUndefined();
		expect(() =>
			fixture(
				async () => new Response(),
				() => true,
				{ ...grant, secretArn: "secret-name" },
			),
		).toThrow("GRANT_INVALID");
		expect(() =>
			fixture(
				async () => new Response(),
				() => true,
				{ ...grant, allow: ["put", "put"] },
			),
		).toThrow("GRANT_INVALID");
	});
	it("rejects accessors and sparse operation grants without invoking them", () => {
		let invoked = false;
		const allow: ("put" | "access")[] = ["access"];
		Object.defineProperty(allow, "0", {
			enumerable: true,
			get() {
				invoked = true;
				return "access";
			},
		});
		expect(() =>
			fixture(
				async () => new Response(),
				() => true,
				{ ...grant, allow },
			),
		).toThrow("GRANT_INVALID");
		expect(invoked).toBe(false);
		const sparse: ("put" | "access")[] = [];
		sparse.length = 1;
		expect(() =>
			fixture(
				async () => new Response(),
				() => true,
				{ ...grant, allow: sparse },
			),
		).toThrow("GRANT_INVALID");
	});
	it("writes and reads exact binary versions using the full ARN", async () => {
		const requests: { target: string | null; body: string }[] = [];
		const f = fixture(async (_url, init) => {
			const target = new Headers(init?.headers).get("x-amz-target");
			requests.push({ target, body: String(init?.body) });
			if (target?.endsWith("PutSecretValue"))
				return Response.json({ ARN: secretArn, VersionId: id });
			if (target?.endsWith("GetSecretValue"))
				return Response.json({
					ARN: secretArn,
					VersionId: id,
					SecretBinary: "AQI=",
				});
			return Response.json({
				ARN: secretArn,
				Versions: [{ VersionId: id, CreatedDate: 1_700_000_000 }],
			});
		});
		expect(await f.store.put(new Uint8Array([1, 2]), id)).toBe(id);
		expect(await f.store.access()).toEqual({
			versionId: id,
			value: new Uint8Array([1, 2]),
		});
		expect(await f.store.accessVersion(id)).toEqual(new Uint8Array([1, 2]));
		expect(await f.store.listVersions()).toEqual([id]);
		expect(requests).toHaveLength(4);
		for (const request of requests)
			expect(JSON.parse(request.body).SecretId).toBe(secretArn);
		expect(JSON.parse(requests[0]?.body ?? "{}").ClientRequestToken).toBe(id);
		expect(JSON.parse(requests[2]?.body ?? "{}").VersionId).toBe(id);
	});
	it("denies unauthorized or malformed calls before dispatch", async () => {
		const f = fixture(
			async () => new Response("{}"),
			() => true,
			{ ...grant, allow: ["access"] },
		);
		await expect(f.store.put(new Uint8Array([1]), id)).rejects.toMatchObject({
			code: "AWS_SECRET_DENIED",
		});
		await expect(f.store.accessVersion("invalid")).rejects.toMatchObject({
			code: "AWS_SECRET_VERSION_INVALID",
		});
		await expect(f.store.put(new Uint8Array(), id)).rejects.toMatchObject({
			code: "AWS_SECRET_VALUE_INVALID",
		});
		expect(f.calls()).toBe(0);
	});
	it("does not disclose a version after authority changes between awaits", async () => {
		for (const operation of ["access", "access-version"] as const) {
			let authorized = true;
			let checks = 0;
			const f = fixture(
				async () =>
					Response.json({
						ARN: secretArn,
						VersionId: id,
						SecretBinary: "AQI=",
					}),
				() => {
					if (++checks === 3)
						queueMicrotask(() => {
							authorized = false;
						});
					return authorized;
				},
			);
			const result =
				operation === "access" ? f.store.access() : f.store.accessVersion(id);
			await expect(result).rejects.toMatchObject({
				code: "AWS_SECRET_READ_UNAVAILABLE",
			});
		}
	});
	it("reports a committed write as unknown if authorization changes before return", async () => {
		let checks = 0;
		const f = fixture(
			async () => Response.json({ ARN: secretArn, VersionId: id }),
			() => ++checks < 3,
		);
		await expect(f.store.put(new Uint8Array([7]), id)).rejects.toMatchObject({
			code: "AWS_SECRET_MUTATION_OUTCOME_UNKNOWN",
			versionId: id,
		});
	});
	it("returns the persisted version id when a write outcome is unknown", async () => {
		const f = fixture(async () =>
			Response.json(
				{ __type: "InvalidRequestException", message: "failure" },
				{ status: 400 },
			),
		);
		await expect(f.store.put(new Uint8Array([7]), id)).rejects.toMatchObject({
			code: "AWS_SECRET_MUTATION_OUTCOME_UNKNOWN",
			versionId: id,
		});
	});
	it("orders distinct version timestamps and rejects ambiguous ties", async () => {
		const older = "00000000-0000-4000-8000-000000000002";
		let tied = false;
		const f = fixture(async () =>
			Response.json({
				ARN: secretArn,
				Versions: [
					{ VersionId: older, CreatedDate: 1_700_000_000 },
					{ VersionId: id, CreatedDate: tied ? 1_700_000_000 : 1_700_000_001 },
				],
			}),
		);
		expect(await f.store.listVersions()).toEqual([id, older]);
		tied = true;
		await expect(f.store.listVersions()).rejects.toMatchObject({
			code: "AWS_SECRET_READ_UNAVAILABLE",
		});
	});
	it("does not use the current-version label to order tied older versions", async () => {
		const older = "00000000-0000-4000-8000-000000000002";
		const other = "00000000-0000-4000-8000-000000000003";
		const f = fixture(async () =>
			Response.json({
				ARN: secretArn,
				Versions: [
					{
						VersionId: id,
						CreatedDate: 1_700_000_001,
						VersionStages: ["AWSCURRENT"],
					},
					{
						VersionId: older,
						CreatedDate: 1_700_000_000,
						VersionStages: ["AWSPREVIOUS"],
					},
					{ VersionId: other, CreatedDate: 1_700_000_000, VersionStages: [] },
				],
			}),
		);
		await expect(f.store.listVersions()).rejects.toMatchObject({
			code: "AWS_SECRET_READ_UNAVAILABLE",
		});
	});
	it("rejects foreign values and incomplete version lists", async () => {
		const f = fixture(async (_url, init) =>
			new Headers(init?.headers).get("x-amz-target")?.endsWith("GetSecretValue")
				? Response.json({
						ARN: secretArn,
						VersionId: id,
						SecretString: "foreign",
					})
				: Response.json({ ARN: secretArn, Versions: [], NextToken: "more" }),
		);
		await expect(f.store.access()).rejects.toMatchObject({
			code: "AWS_SECRET_READ_UNAVAILABLE",
		});
		await expect(f.store.listVersions()).rejects.toMatchObject({
			code: "AWS_SECRET_READ_UNAVAILABLE",
		});
	});
});
