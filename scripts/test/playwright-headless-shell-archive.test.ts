import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	cachedArchivePath,
	ensurePlaywrightHeadlessShellArchive,
	headlessShellArchiveSpec,
} from "../lib/playwright-headless-shell-archive.mts";

describe("playwright headless-shell archive", () => {
	it("reuses a verified cache file without downloading", () => {
		const spec = headlessShellArchiveSpec("amd64");
		const cacheDir = mkdtempSync(join(tmpdir(), "pw-cache-"));
		const dest = cachedArchivePath(cacheDir, spec);
		writeFileSync(dest, "not-a-real-zip");
		// Wrong digest should throw on ensure without skip — seed correct digest with tiny file
		const prior = process.env.HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD;
		process.env.HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD = "1";
		assert.throws(() =>
			ensurePlaywrightHeadlessShellArchive({ cacheDir, arch: "amd64" }),
		);
		process.env.HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD = prior;
	});

	it("pins amd64 URL and digest from contract", () => {
		const spec = headlessShellArchiveSpec("amd64");
		assert.match(spec.url, /cdn\.playwright\.dev\/builds\/cft\//);
		assert.equal(spec.digest.length, 64);
		assert.match(spec.cacheName, /^chromium-headless-shell-amd64-/);
	});

	it("fails fast when skip-download is set and cache is missing", () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "pw-cache-"));
		const prev = process.env.HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD;
		process.env.HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD = "1";
		try {
			assert.throws(
				() => ensurePlaywrightHeadlessShellArchive({ cacheDir, arch: "amd64" }),
				/missing/,
			);
		} finally {
			if (prev === undefined)
				delete process.env.HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD;
			else process.env.HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD = prev;
		}
	});
});
