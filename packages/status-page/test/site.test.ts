import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	parseStatusScope,
	toStatusPageModel,
	writeStatusSite,
} from "../src/index.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-status-site-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function modelFor(kind: "project" | "bindle", id: string) {
	return toStatusPageModel(undefined, {
		scope: parseStatusScope({ kind, id, label: `${id} status` }),
		evaluatedAt: "2026-08-17T00:00:00.000Z",
	});
}

describe("writeStatusSite", () => {
	it("writes html + statuspage-v2 json per page plus a portfolio index", () => {
		const root = tempDir();
		const written = writeStatusSite({
			rootDir: root,
			pages: [
				{ model: modelFor("bindle", "shop") },
				{ model: modelFor("project", "storefront") },
			],
			baseUrl: "https://status.example.com",
		});
		expect(written).toHaveLength(2);
		const shopHtml = readFileSync(
			join(root, "bindle-shop", "index.html"),
			"utf8",
		);
		expect(shopHtml).toContain("shop status");
		const summary = JSON.parse(
			readFileSync(
				join(root, "bindle-shop", "api", "v2", "summary.json"),
				"utf8",
			),
		) as { page: { url: string } };
		expect(summary.page.url).toBe("https://status.example.com/bindle-shop/");
		expect(
			existsSync(join(root, "bindle-shop", "api", "v2", "status.json")),
		).toBe(true);
		const index = readFileSync(join(root, "index.html"), "utf8");
		expect(index).toContain(`href="./bindle-shop/"`);
		expect(index).toContain(`href="./project-storefront/"`);
	});

	it("rejects traversal and malformed slugs", () => {
		const root = tempDir();
		expect(() =>
			writeStatusSite({
				rootDir: root,
				pages: [{ model: modelFor("bindle", "shop"), slug: "../escape" }],
			}),
		).toThrow(/slug/);
		expect(() =>
			writeStatusSite({
				rootDir: root,
				pages: [{ model: modelFor("bindle", "shop"), slug: "UPPER/Case" }],
			}),
		).toThrow(/slug/);
	});

	it("rejects duplicate slugs", () => {
		const root = tempDir();
		expect(() =>
			writeStatusSite({
				rootDir: root,
				pages: [
					{ model: modelFor("bindle", "shop") },
					{ model: modelFor("bindle", "shop") },
				],
			}),
		).toThrow(/duplicate/);
	});

	it("writes nothing but the root for an empty page list", () => {
		const root = tempDir();
		const written = writeStatusSite({ rootDir: root, pages: [] });
		expect(written).toHaveLength(0);
		expect(existsSync(join(root, "index.html"))).toBe(false);
	});
});
