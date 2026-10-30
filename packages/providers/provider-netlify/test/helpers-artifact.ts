import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
export function prebuiltFixture(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-netlify-fixture-"));
	mkdirSync(path.join(dir, "dist"));
	writeFileSync(
		path.join(dir, "dist", "index.html"),
		"approved static fixture",
	);
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
