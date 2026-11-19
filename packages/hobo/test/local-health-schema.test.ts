import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindle } from "@hobo/bindles";
import { afterAll, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import { localHttpHealthCheck } from "../src/local-health.js";

const schema = fileURLToPath(
	new URL("../../bindles/data-models/bindles.cue", import.meta.url),
);
const directory = mkdtempSync(join(tmpdir(), "hobo-health-schema-"));
const cueAvailable =
	spawnSync("cue", ["version"], { stdio: "ignore" }).status === 0;
const cases: ReadonlyArray<{ config: JsonObject; valid: boolean }> = [
	{ config: { type: "http", path: "/ready" }, valid: true },
	{
		config: { type: "http", path: "/", intervalMs: 10, timeoutMs: 100 },
		valid: true,
	},
	{ config: { type: "http", path: "ready" }, valid: false },
	{ config: { type: "http", path: "//ready" }, valid: false },
	{ config: { type: "http", path: "/ready", timeoutMs: 100 }, valid: false },
	{
		config: { type: "http", path: "/ready", intervalMs: 300, timeoutMs: 100 },
		valid: false,
	},
	{ config: { type: "tcp", path: "/ready" }, valid: false },
	{ config: { type: "http", path: "/ready", timoutMs: 500 }, valid: false },
];

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe.skipIf(!cueAvailable)("local HTTP health schema", () => {
	it.each(cases)("agrees with the runtime for $config", ({ config, valid }) => {
		const definition = bindle("health-schema", (builder) => ({
			api: builder
				.api(() => () => new Response("ok"))
				.with({
					provider: "hobo",
					option: "health",
					config,
				}),
		}));
		const resource = definition.resources.api;
		if (!resource) throw new Error("api resource missing");
		if (valid) expect(() => localHttpHealthCheck(resource)).not.toThrow();
		else expect(() => localHttpHealthCheck(resource)).toThrow();
		const input = join(directory, "health.json");
		writeFileSync(input, JSON.stringify(config));
		const result = spawnSync(
			"cue",
			["vet", "-c", schema, input, "-d", "#HttpHealthCheck"],
			{
				encoding: "utf8",
			},
		);
		expect(result.status, result.stderr).toBe(valid ? 0 : 1);
	});
});
