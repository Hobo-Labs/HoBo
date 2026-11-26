import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isJsonObject, isJsonString, parseJsonValue } from "../src/json.js";
import { parseCloudflareWorkerSource } from "../src/worker-content.js";

const raw = parseJsonValue(
	readFileSync(
		new URL(
			"../contracts/fixtures/native-worker-content.json",
			import.meta.url,
		),
		"utf8",
	),
);
if (
	!isJsonObject(raw) ||
	!isJsonString(raw.body) ||
	!isJsonString(raw.contentType) ||
	!isJsonString(raw.expectedSource)
)
	throw new Error("native Worker capture fixture is invalid");
const fixture = {
	body: raw.body,
	contentType: raw.contentType,
	expectedSource: raw.expectedSource,
};
describe("native Worker content proof", () => {
	it("parses the actual sanitized anonymous native multipart response byte-faithfully", () => {
		expect(
			parseCloudflareWorkerSource(
				fixture.body,
				fixture.contentType,
				"worker.js",
			),
		).toBe(fixture.expectedSource);
	});
	it("preserves BOM, source whitespace and line endings inside the module", () => {
		const source = "\uFEFFexport default {};\r\n\n";
		const body =
			'--boundary\r\nContent-Disposition: form-data; name="worker.js"\r\n\r\n' +
			source +
			"\r\n--boundary--\r\n";
		expect(
			parseCloudflareWorkerSource(
				body,
				"multipart/form-data; boundary=boundary",
				"worker.js",
			),
		).toBe(source);
	});
	it("accepts native JavaScript media without guessing an envelope", () => {
		expect(
			parseCloudflareWorkerSource(
				"exact source",
				"application/javascript; charset=utf-8",
				"worker.js",
			),
		).toBe("exact source");
	});
	it("refuses another main module, JSON settings, malformed boundaries and extra modules", () => {
		expect(() =>
			parseCloudflareWorkerSource(
				fixture.body,
				fixture.contentType,
				"foreign.js",
			),
		).toThrow(/single-module/);
		expect(() =>
			parseCloudflareWorkerSource(
				'{"success":true}',
				"application/json",
				"worker.js",
			),
		).toThrow(/single-module/);
		expect(() =>
			parseCloudflareWorkerSource(
				fixture.body,
				"multipart/form-data; boundary=wrong",
				"worker.js",
			),
		).toThrow(/single-module/);
		expect(() =>
			parseCloudflareWorkerSource(
				'--b\r\nContent-Disposition: form-data; name="worker.js"\r\n\r\na\r\n--b\r\nContent-Disposition: form-data; name="extra.js"\r\n\r\nb\r\n--b--\r\n',
				"multipart/form-data; boundary=b",
				"worker.js",
			),
		).toThrow(/single-module/);
	});
});
