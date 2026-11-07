import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDesignScorecardEvidence } from "./support/design-scorecard-evidence.mts";

describe("checkDesignScorecardEvidence", () => {
	const evidenceFile = "packages/example/test/example.test.ts";
	let repoRoot: string;

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "pricing-scorecard-evidence-"));
	});

	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
	});

	function writeEvidence(source: string, testScript = "vitest run"): void {
		mkdirSync(join(repoRoot, "packages/example/test"), { recursive: true });
		writeFileSync(
			join(repoRoot, "packages/example/package.json"),
			JSON.stringify({ scripts: { test: testScript } }),
		);
		writeFileSync(join(repoRoot, evidenceFile), source);
	}

	function check(evidenceTest = "rates usage", file = evidenceFile) {
		return checkDesignScorecardEvidence(repoRoot, {
			id: "§1.1",
			status: "pass",
			evidenceFile: file,
			evidenceTest,
		});
	}

	it("accepts an enabled test selected by its owning package", () => {
		writeEvidence(
			'describe("pricing", () => { it("rates usage", () => {}); });',
		);

		expect(check()).toEqual({ ok: true });
	});

	it("rejects a missing evidence file", () => {
		expect(check()).toMatchObject({
			ok: false,
			reason: expect.stringContaining("does not exist"),
		});
	});

	it("rejects a skipped test and tests inside skipped suites", () => {
		writeEvidence(`
			it.skip("rates usage", () => {});
			test.todo("rates usage");
			describe.skip("pricing", () => { it("rates usage", () => {}); });
		`);

		expect(check()).toMatchObject({
			ok: false,
			reason: expect.stringContaining("no enabled test"),
		});
	});

	it("rejects a renamed test", () => {
		writeEvidence('it("rates overages", () => {});');

		expect(check()).toMatchObject({
			ok: false,
			reason: expect.stringContaining("no enabled test"),
		});
	});

	it("rejects a file outside its package test and contracts directories", () => {
		const sourceFile = "packages/example/src/example.test.ts";
		mkdirSync(join(repoRoot, "packages/example/src"), { recursive: true });
		writeFileSync(
			join(repoRoot, "packages/example/package.json"),
			JSON.stringify({ scripts: { test: "vitest run" } }),
		);
		writeFileSync(join(repoRoot, sourceFile), 'it("rates usage", () => {});');

		expect(check("rates usage", sourceFile)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("outside"),
		});
	});

	it("rejects a helper file excluded by Vitest's default includes", () => {
		const helperFile = "packages/example/test/example.ts";
		writeEvidence('it("rates usage", () => {});');
		writeFileSync(join(repoRoot, helperFile), 'it("rates usage", () => {});');

		expect(check("rates usage", helperFile)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("default includes"),
		});
	});

	it("rejects a package whose test script does not run Vitest", () => {
		writeEvidence('it("rates usage", () => {});', "node --test");

		expect(check()).toMatchObject({
			ok: false,
			reason: expect.stringContaining("does not run Vitest"),
		});
	});

	it("recognizes concurrent and each declarations", () => {
		writeEvidence(`
			it.concurrent("rates usage", () => {});
			test.each([1])("rates additional usage %s", () => {});
		`);

		expect(check()).toEqual({ ok: true });
		expect(check("rates additional usage")).toEqual({ ok: true });
	});

	it("applies Vitest only selection to tests and enclosing suites", () => {
		writeEvidence(`
			it("rates usage", () => {});
			it.only("rates another provider", () => {});
		`);
		expect(check()).toMatchObject({
			ok: false,
			reason: expect.stringContaining("no enabled test"),
		});

		writeEvidence(
			'describe.only("pricing", () => { it("rates usage", () => {}); });',
		);
		expect(check("pricing rates usage")).toEqual({ ok: true });
	});

	it("matches evidence patterns against full test names as regular expressions", () => {
		writeEvidence(
			'describe("pricing", () => { it("rates usage", () => {}); });',
		);

		expect(check("pricing (rates|bills) usage")).toEqual({ ok: true });
	});

	it("matches literal names containing regular expression characters", () => {
		writeEvidence(
			'it("consumes a $100 commitment with 90 + 20 units", () => {});',
		);

		expect(check("consumes a $100 commitment with 90 + 20 units")).toEqual({
			ok: true,
		});
	});
});
