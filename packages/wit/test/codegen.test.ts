import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATED_SDK = join(PACKAGE_ROOT, "src", "generated", "sdk", "sdk.d.ts");
const GENERATED_EVIDENCE_GUEST = join(
	PACKAGE_ROOT,
	"src",
	"generated",
	"evidence-guest",
	"evidence-guest.d.ts",
);
const GENERATED_EVIDENCE_PROVIDER = join(
	PACKAGE_ROOT,
	"src",
	"generated",
	"evidence-provider",
	"evidence-provider.d.ts",
);

describe("generated hobo:sdk bindings", () => {
	it("checks in jco output for the sdk world", () => {
		expect(existsSync(GENERATED_SDK)).toBe(true);
	});

	it("checks in guest and provider bindings for the evidence port", () => {
		expect(existsSync(GENERATED_EVIDENCE_GUEST)).toBe(true);
		expect(existsSync(GENERATED_EVIDENCE_PROVIDER)).toBe(true);
	});
});
