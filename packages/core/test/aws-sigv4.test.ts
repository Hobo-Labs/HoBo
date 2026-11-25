// AWS SigV4, pinned against the official `aws-sig-v4-test-suite` vectors.
//
// This is the highest-value test in the AWS deploy path. A SigV4 signer that
// is subtly wrong — locale ordering instead of code-unit ordering, a header
// name folded after collection instead of before, `encodeURIComponent` where
// RFC 3986 was meant — produces a perfectly plausible `Authorization` header
// that only the live API rejects, and this repo cannot reach the live API. The
// published canonical-request / string-to-sign / Authorization triples are
// therefore the only real proof available, so each case below asserts all
// three rather than just the final signature: when a signature is wrong, the
// canonical request says *why*.
//
// Every vector shares the suite's fixed inputs: access key `AKIDEXAMPLE`,
// the published example secret, region `us-east-1`, service `service`, and
// the signing instant 2015-08-30T12:36:00Z. The suite's requests do not carry
// `x-amz-content-sha256`, so they sign with `contentSha256Header: false`; the
// header is on by default because S3 requires it.
import { describe, expect, it } from "vitest";

import {
	AWS_SIGV4_ALGORITHM,
	type AwsCredentials,
	hmac,
	sha256Hex,
	signAwsRequest,
} from "../src/ports/aws-sigv4.js";

/** The suite's published example credentials. Not a real key pair. */
const SUITE_CREDENTIALS: AwsCredentials = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

/** The instant every vector in the suite is signed at. */
const SUITE_INSTANT = new Date("2015-08-30T12:36:00.000Z");

interface SigV4Vector {
	readonly name: string;
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string | readonly string[]>>;
	readonly body?: string;
	readonly canonicalRequest: string;
	readonly stringToSign: string;
	readonly authorization: string;
}

/**
 * Verbatim from the suite. A header given as an array is one the request sends
 * more than once, which is what `get-header-key-duplicate` and
 * `get-header-value-order` exist to pin.
 */
const VECTORS: readonly SigV4Vector[] = [
	{
		name: "get-vanilla",
		method: "GET",
		url: "https://example.amazonaws.com/",
		headers: {},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
	},
	{
		name: "get-vanilla-query-order-key-case",
		method: "GET",
		url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
		headers: {},
		canonicalRequest:
			"GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
	},
	{
		name: "get-header-key-duplicate",
		method: "GET",
		url: "https://example.amazonaws.com/",
		headers: {
			"My-Header1": ["value2", "value2", "value1"],
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value2,value2,value1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\ndc7f04a3abfde8d472b0ab1a418b741b7c67174dad1551b4117b15527fbe966c",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;my-header1;x-amz-date, Signature=c9d5ea9f3f72853aea855b47ea873832890dbdd183b4468f858259531a5138ea",
	},
	{
		name: "get-header-value-order",
		method: "GET",
		url: "https://example.amazonaws.com/",
		headers: {
			"My-Header1": ["value4", "value1", "value3", "value2"],
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value4,value1,value3,value2\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n31ce73cd3f3d9f66977ad3dd957dc47af14df92fcd8509f59b349e9137c58b86",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;my-header1;x-amz-date, Signature=08c7e5a9acfcfeb3ab6b2185e75ce8b1deb5e634ec47601a50643f830c755c01",
	},
	{
		name: "get-header-value-trim",
		method: "GET",
		url: "https://example.amazonaws.com/",
		headers: {
			"My-Header1": " value1",
			"My-Header2": ' "a   b   c"',
		},
		canonicalRequest:
			'GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nmy-header2:"a b c"\nx-amz-date:20150830T123600Z\n\nhost;my-header1;my-header2;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\na726db9b0df21c14f559d0a978e563112acb1b9e05476f0a6a1c7d68f28605c7",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;my-header1;my-header2;x-amz-date, Signature=acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
	},
	{
		name: "get-unreserved",
		method: "GET",
		url: "https://example.amazonaws.com/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
		headers: {},
		canonicalRequest:
			"GET\n/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n6a968768eefaa713e2a6b16b589a8ea192661f098f37349f4e2c0082757446f9",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f",
	},
	{
		name: "get-utf8",
		method: "GET",
		url: "https://example.amazonaws.com/ሴ",
		headers: {},
		canonicalRequest:
			"GET\n/%E1%88%B4\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n2a0a97d02205e45ce2e994789806b19270cfbbb0921b278ccf58f5249ac42102",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85",
	},
	{
		name: "post-header-key-sort",
		method: "POST",
		url: "https://example.amazonaws.com/",
		headers: {
			"My-Header1": "value1",
		},
		canonicalRequest:
			"POST\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n9368318c2967cf6de74404b30c65a91e8f6253e0a8659d6d5319f1a812f87d65",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;my-header1;x-amz-date, Signature=c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c",
	},
	{
		name: "post-x-www-form-urlencoded",
		method: "POST",
		url: "https://example.amazonaws.com/",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "Param1=value1",
		canonicalRequest:
			"POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-type;host;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n42a5e5bb34198acb3e84da4f085bb7927f2bc277ca766e6d19c73c2154021281",
		authorization:
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
	},
];

describe("signAwsRequest against the official SigV4 vectors", () => {
	for (const vector of VECTORS) {
		it(`matches the published canonical request, string to sign, and Authorization for ${vector.name}`, () => {
			const signed = signAwsRequest({
				method: vector.method,
				url: vector.url,
				headers: vector.headers,
				...(vector.body === undefined ? undefined : { body: vector.body }),
				region: "us-east-1",
				service: "service",
				credentials: SUITE_CREDENTIALS,
				now: SUITE_INSTANT,
				contentSha256Header: false,
			});

			expect(signed.canonicalRequest).toBe(vector.canonicalRequest);
			expect(signed.stringToSign).toBe(vector.stringToSign);
			expect(signed.authorization).toBe(vector.authorization);
		});
	}
});

describe("signAwsRequest determinism and header handling", () => {
	it("is byte-stable across calls when the signing instant is injected", () => {
		const call = () =>
			signAwsRequest({
				method: "POST",
				url: "https://dynamodb.us-east-1.amazonaws.com/",
				headers: { "content-type": "application/x-amz-json-1.0" },
				body: '{"TableName":"orders"}',
				region: "us-east-1",
				service: "dynamodb",
				credentials: SUITE_CREDENTIALS,
				now: SUITE_INSTANT,
			});

		expect(call()).toEqual(call());
	});

	it("folds a header name before collection, so Host and host are one canonical line", () => {
		const signed = signAwsRequest({
			method: "GET",
			url: "https://example.amazonaws.com/",
			headers: { Host: "example.amazonaws.com" },
			region: "us-east-1",
			service: "service",
			credentials: SUITE_CREDENTIALS,
			now: SUITE_INSTANT,
			contentSha256Header: false,
		});

		expect(signed.signedHeaders).toBe("host;x-amz-date");
		expect(signed.canonicalRequest).toContain("host:example.amazonaws.com\n");
		expect(signed.canonicalRequest).not.toContain("host;host");
	});

	it("signs the session token when temporary credentials are used", () => {
		const signed = signAwsRequest({
			method: "GET",
			url: "https://example.amazonaws.com/",
			headers: {},
			region: "us-east-1",
			service: "service",
			credentials: { ...SUITE_CREDENTIALS, sessionToken: "session-token-abc" },
			now: SUITE_INSTANT,
			contentSha256Header: false,
		});

		expect(signed.signedHeaders).toBe("host;x-amz-date;x-amz-security-token");
		expect(signed.headers["x-amz-security-token"]).toBe("session-token-abc");
	});

	it("adds x-amz-content-sha256 by default, because S3 requires it", () => {
		const signed = signAwsRequest({
			method: "PUT",
			url: "https://s3.us-east-1.amazonaws.com/hobo-bucket",
			headers: {},
			region: "us-east-1",
			service: "s3",
			credentials: SUITE_CREDENTIALS,
			now: SUITE_INSTANT,
		});

		expect(signed.headers["x-amz-content-sha256"]).toBe(sha256Hex(""));
		expect(signed.signedHeaders).toBe("host;x-amz-content-sha256;x-amz-date");
	});

	it("escapes the RFC 3986 characters encodeURIComponent leaves alone", () => {
		const signed = signAwsRequest({
			method: "GET",
			url: "https://example.amazonaws.com/?key=a!b'c(d)e*f",
			headers: {},
			region: "us-east-1",
			service: "service",
			credentials: SUITE_CREDENTIALS,
			now: SUITE_INSTANT,
			contentSha256Header: false,
		});

		expect(signed.canonicalRequest.split("\n")[2]).toBe(
			"key=a%21b%27c%28d%29e%2Af",
		);
	});

	it("orders query parameters by code unit rather than by locale", () => {
		const signed = signAwsRequest({
			method: "GET",
			url: "https://example.amazonaws.com/?b=2&A=1&a=3",
			headers: {},
			region: "us-east-1",
			service: "service",
			credentials: SUITE_CREDENTIALS,
			now: SUITE_INSTANT,
			contentSha256Header: false,
		});

		// Code-unit ordering puts every upper-case name before every lower-case
		// one; a locale-aware comparison interleaves them.
		expect(signed.canonicalRequest.split("\n")[2]).toBe("A=1&a=3&b=2");
	});

	it("derives the signing key by the documented four-step chain", () => {
		const dateKey = hmac(
			`AWS4${SUITE_CREDENTIALS.secretAccessKey}`,
			"20150830",
		);
		const signingKey = hmac(
			hmac(hmac(dateKey, "us-east-1"), "service"),
			"aws4_request",
		);
		const vector = VECTORS[0];
		if (vector === undefined) throw new Error("no vectors are declared");

		expect(hmac(signingKey, vector.stringToSign).toString("hex")).toBe(
			vector.authorization.split("Signature=")[1],
		);
		expect(vector.stringToSign.startsWith(AWS_SIGV4_ALGORITHM)).toBe(true);
	});
});
