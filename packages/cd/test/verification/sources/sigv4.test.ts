// Golden signatures computed by botocore 1.44.1 `SigV4Auth(credentials,
// "monitoring", "eu-west-1").add_auth(...)` for the same request at
// 2026-11-12T04:29:17Z, using AWS's documented example key pair.
import { describe, expect, it } from "vitest";
import { signV4 } from "../../../src/verification/sources/sigv4.js";

const request = {
	method: "POST",
	url: "https://monitoring.eu-west-1.amazonaws.com/",
	headers: {
		"content-type": "application/x-amz-json-1.0",
		"x-amz-target": "GraniteServiceVersion20100801.GetMetricData",
	},
	body: '{"MetricDataQueries":[{"Id":"q0"}]}',
	region: "eu-west-1",
	service: "monitoring",
	atMs: Date.UTC(2026, 10, 12, 4, 29, 17),
};
const KEYS = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("SigV4 (CloudWatch)", () => {
	it("matches botocore without a session token", () => {
		const headers = signV4({ ...request, credentials: KEYS });
		expect(headers["x-amz-date"]).toBe("20261112T042917Z");
		expect(headers.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261112/eu-west-1/monitoring/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=5ca78dbcdbe91e81dd7b31f8322ad84a94cb94c8ab933295371f8970fae0dd3c",
		);
		expect(headers.host).toBeUndefined();
	});

	it("matches botocore with a session token", () => {
		const headers = signV4({
			...request,
			credentials: { ...KEYS, sessionToken: "SESSIONTOKEN" },
		});
		expect(headers["x-amz-security-token"]).toBe("SESSIONTOKEN");
		expect(headers.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261112/eu-west-1/monitoring/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=2152f6ea80012950d0a430f48130cc1d7969eb5aad82434087f701cae280dfcb",
		);
	});
});
