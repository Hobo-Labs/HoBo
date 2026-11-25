import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	isOpenpouchRateLimitMessage,
	readOpenpouchCooldown,
	writeOpenpouchCooldown,
} from "./anon-server-host-chain.mts";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
	dirs.length = 0;
});

describe("anon-server-host-chain cooldown", () => {
	it("detects OpenPouch rate-limit messages", () => {
		expect(isOpenpouchRateLimitMessage("429 Too Many Requests")).toBe(true);
		expect(isOpenpouchRateLimitMessage("rate limit exceeded")).toBe(true);
		expect(isOpenpouchRateLimitMessage("quota exhausted")).toBe(true);
		expect(isOpenpouchRateLimitMessage("ECONNRESET")).toBe(false);
	});

	it("persists and reads active cooldown", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "hobo-op-cd-"));
		dirs.push(dir);
		const file = path.join(dir, "cooldown.json");
		await writeOpenpouchCooldown("429 rate limit", 60_000, file);
		const raw = JSON.parse(await readFile(file, "utf8")) as { until: number };
		expect(raw.until).toBeGreaterThan(Date.now());
		const active = await readOpenpouchCooldown(file);
		expect(active?.reason).toContain("429");
	});
});
