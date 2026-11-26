import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initRoot, RIFT_DIR } from "../src/workspace.js";

const bin = fileURLToPath(new URL("../dist/bin/hobo-rift.js", import.meta.url));
const roots: string[] = [];
function root(): string {
	const path = mkdtempSync(join(tmpdir(), "hobo-rift-recovery-cli-"));
	roots.push(path);
	initRoot(path);
	return path;
}
function run(path: string, command: string) {
	return spawnSync(process.execPath, [bin, command, "--root", path], {
		encoding: "utf8",
	});
}
afterEach(() => {
	for (const path of roots.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("registry recovery CLI", () => {
	it("reports a damaged snapshot and leaves it untouched", () => {
		const path = root();
		const snapshot = join(path, RIFT_DIR, "registry.json");
		writeFileSync(snapshot, "{broken");
		const result = run(path, "repair");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("invalid workspace snapshot");
		expect(readFileSync(snapshot, "utf8")).toBe("{broken");
	});
	it("reports a missing journal before listing workspaces", () => {
		const path = root();
		rmSync(join(path, RIFT_DIR, "events.jsonl"));
		const result = run(path, "list");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("run hobo-rift repair");
	});
	it("returns failure when a legacy snapshot cannot be resolved", () => {
		const path = root();
		const snapshot = join(path, RIFT_DIR, "registry.json");
		const body = JSON.stringify({
			root: path,
			workspaces: [
				{
					name: "old",
					path: join(path, "old"),
					tier: "copy",
					source: path,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		writeFileSync(join(path, RIFT_DIR, "events.jsonl"), "");
		writeFileSync(snapshot, body);
		const result = run(path, "repair");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("left untouched");
		expect(readFileSync(snapshot, "utf8")).toBe(body);
	});
});
