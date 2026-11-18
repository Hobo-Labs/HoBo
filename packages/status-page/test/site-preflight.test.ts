import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	parseStatusScope,
	toStatusPageModel,
	writeStatusSite,
} from "../src/index.js";

const temporary: string[] = [];
function parentDir(): string {
	const parent = mkdtempSync(join(tmpdir(), "hobo-status-preflight-"));
	temporary.push(parent);
	return parent;
}
afterEach(() => {
	for (const parent of temporary.splice(0))
		rmSync(parent, { recursive: true, force: true });
});
const model = toStatusPageModel(undefined, {
	scope: parseStatusScope({ kind: "project", id: "shop", label: "Shop" }),
	evaluatedAt: "2026-08-17T00:00:00.000Z",
});

it("rejects a later duplicate before creating the site root", () => {
	const root = join(parentDir(), "site");
	expect(() =>
		writeStatusSite({
			rootDir: root,
			pages: [
				{ model, slug: "one" },
				{ model, slug: "two" },
				{ model, slug: "one" },
			],
		}),
	).toThrow(/duplicate/);
	expect(existsSync(root)).toBe(false);
});

it("rejects a later malformed slug without changing an existing root", () => {
	const root = parentDir();
	writeFileSync(join(root, "sentinel.txt"), "original", "utf8");
	expect(() =>
		writeStatusSite({
			rootDir: root,
			pages: [
				{ model, slug: "one" },
				{ model, slug: "INVALID" },
			],
		}),
	).toThrow(/slug/);
	expect(readdirSync(root)).toEqual(["sentinel.txt"]);
	expect(readFileSync(join(root, "sentinel.txt"), "utf8")).toBe("original");
});

it("does not write for generated batches with a duplicate at any position", () => {
	const parent = parentDir();
	for (let size = 2; size <= 8; size++) {
		for (let position = 1; position < size; position++) {
			const pages = Array.from({ length: size }, (_, index) => ({
				model,
				slug: index === position ? "page-0" : `page-${index}`,
			}));
			const root = join(parent, `case-${size}-${position}`);
			expect(() => writeStatusSite({ rootDir: root, pages })).toThrow(
				/duplicate/,
			);
			expect(existsSync(root)).toBe(false);
		}
	}
});
