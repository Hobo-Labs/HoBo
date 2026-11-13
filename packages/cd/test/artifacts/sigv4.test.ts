// "SigV4 matches AWS test vectors": the S3 signer the backend uses reproduces
// the published examples from the S3 SigV4 documentation ("Signature
// calculations for the Authorization header: transferring payload in a single
// chunk"), which sign with access key AKIAIOSFODNN7EXAMPLE on 2013-05-24.
import { describe, expect, it } from "vitest";
import { signS3Request } from "../../src/artifacts/index.js";

const credentials = {
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2013-05-24T00:00:00Z");

describe("S3 SigV4 published vectors", () => {
	it("GET Object with a Range header", () => {
		const signed = signS3Request({
			method: "GET",
			url: "https://examplebucket.s3.amazonaws.com/test.txt",
			headers: { Range: "bytes=0-9" },
			region: "us-east-1",
			credentials,
			now,
		});
		expect(signed.signedHeaders).toBe(
			"host;range;x-amz-content-sha256;x-amz-date",
		);
		expect(signed.signature).toBe(
			"f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
		);
	});

	it("PUT Object with a storage class and a body", () => {
		const signed = signS3Request({
			method: "PUT",
			url: "https://examplebucket.s3.amazonaws.com/test$file.text",
			headers: {
				Date: "Fri, 24 May 2013 00:00:00 GMT",
				"x-amz-storage-class": "REDUCED_REDUNDANCY",
			},
			body: "Welcome to Amazon S3.",
			region: "us-east-1",
			credentials,
			now,
		});
		expect(signed.headers["x-amz-content-sha256"]).toBe(
			"44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
		);
		expect(signed.signedHeaders).toBe(
			"date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
		);
		expect(signed.signature).toBe(
			"98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
		);
	});

	it("GET Bucket lifecycle (subresource without a value)", () => {
		const signed = signS3Request({
			method: "GET",
			url: "https://examplebucket.s3.amazonaws.com/?lifecycle",
			headers: {},
			region: "us-east-1",
			credentials,
			now,
		});
		expect(signed.signature).toBe(
			"fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
		);
	});

	it("GET Bucket (list objects) with query parameters", () => {
		const signed = signS3Request({
			method: "GET",
			url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
			headers: {},
			region: "us-east-1",
			credentials,
			now,
		});
		expect(signed.signature).toBe(
			"34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
		);
	});
});
