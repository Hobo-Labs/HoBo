import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	HOBO_CLI_DIST,
	releaseReportPath,
	siteTreeIndex,
} from "../ci/create-github-release.mts";
import { qualifySiteRelease } from "../deploy-site.mts";

function site(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-site-dist-"));
	writeFileSync(join(dir, "index.html"), "<h1>HoBo</h1>");
	writeFileSync(join(dir, ".nojekyll"), "");
	return dir;
}

describe("deploy-site release Freight", () => {
	it("indexes the published tree without the staging clone's .git", () => {
		const dir = site();
		const before = siteTreeIndex(dir).digest;
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/gh-pages");
		expect(siteTreeIndex(dir).digest).toBe(before);
	});

	it.skipIf(!existsSync(HOBO_CLI_DIST))(
		"records the Pages bundle and promotes it candidate -> stable before publishing",
		{ timeout: 60_000 },
		async () => {
			const home = mkdtempSync(join(tmpdir(), "hobo-release-cd-"));
			await qualifySiteRelease({
				dist: site(),
				home,
				env: {
					HOBO_RELEASE_REVISION: "0123456789abcdef0123456789abcdef01234567",
				},
			});
			const report = JSON.parse(
				readFileSync(releaseReportPath(home, "pages"), "utf8"),
			);
			expect(report.channels.candidate.outcome).toBe("gap");
			expect(report.channels.stable.outcome).toBe("gap");
			expect(report.channels.stable.lineage).toBe("candidate-journaled");
		},
	);
});
