import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	FINDINGS_INDEX_END,
	FINDINGS_INDEX_START,
	updateFindingsIndex,
} from "../docs-findings-index.mts";

const scratch: string[] = [];
after(() => {
	for (const directory of scratch)
		rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hobo-findings-index-"));
	scratch.push(root);
	mkdirSync(join(root, "docs/ci/findings"), { recursive: true });
	writeFileSync(
		join(root, "docs/ci/performance.md"),
		`# CI performance\n\n${FINDINGS_INDEX_START}\n${FINDINGS_INDEX_END}\n`,
	);
	return root;
}

function finding(
	root: string,
	number: number,
	title: string,
	fileName?: string,
) {
	const padded = String(number).padStart(4, "0");
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
	writeFileSync(
		join(root, "docs/ci/findings", fileName ?? `${padded}-${slug}.md`),
		`---\ntype: CI Performance Finding\n---\n\n# Finding ${number}: ${title}\n\nBody.\n`,
	);
}

describe("docs findings index", () => {
	it("writes and checks an index whose links resolve", () => {
		const root = fixture();
		finding(root, 1, "First finding");
		finding(root, 3, "Third finding");

		assert.deepEqual(updateFindingsIndex(root, false), {
			errors: [],
			notices: [],
			indexed: 2,
			total: 2,
		});
		const performance = readFileSync(
			join(root, "docs/ci/performance.md"),
			"utf8",
		);
		assert.match(
			performance,
			/Finding 1: First finding.*0001-first-finding\.md/u,
		);
		assert.match(
			performance,
			/Finding 3: Third finding.*0003-third-finding\.md/u,
		);
		assert.deepEqual(updateFindingsIndex(root, true), {
			errors: [],
			notices: [],
			indexed: 2,
			total: 2,
		});
	});

	it("passes with a notice when a new finding is not indexed yet", () => {
		const root = fixture();
		finding(root, 1, "First finding");
		updateFindingsIndex(root, false);
		finding(root, 2, "New unindexed finding");

		const report = updateFindingsIndex(root, true);
		assert.deepEqual(report.errors, []);
		assert.equal(report.indexed, 1);
		assert.equal(report.total, 2);
		assert.match(report.notices[0] ?? "", /0002.*not indexed yet/u);
	});

	it("rejects filename and heading number mismatches", () => {
		const root = fixture();
		finding(root, 2, "Wrong number", "0001-wrong-number.md");

		const report = updateFindingsIndex(root, true);
		assert.ok(
			report.errors.some((error) => error.includes("heading number 2")),
		);
	});

	it("rejects duplicate numbers and unresolved index links", () => {
		const root = fixture();
		finding(root, 1, "First finding");
		finding(root, 1, "First finding", "0001-first-finding-copy.md");
		writeFileSync(
			join(root, "docs/ci/performance.md"),
			`# CI performance\n\n${FINDINGS_INDEX_START}\n- [Finding 9: Missing](./findings/0009-missing.md)\n${FINDINGS_INDEX_END}\n`,
		);

		const report = updateFindingsIndex(root, true);
		assert.ok(report.errors.some((error) => error.includes("also used by")));
		assert.ok(
			report.errors.some((error) => error.includes("does not resolve")),
		);
	});
});
