import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cue = fileURLToPath(
	new URL("../../../../.tools/cue/v0.14.0/cue", import.meta.url),
);
const schema = fileURLToPath(
	new URL("../data-models/provider_webernetes.cue", import.meta.url),
);

describe("actual CUE local endpoint constraints", () => {
	for (const [name, host, url, locality] of [
		["loopback", "localhost", "http://localhost:4321/stations/", "loopback"],
		["IPv6 loopback", "[::1]", "http://[::1]:4321/stations/", "loopback"],
		[
			"private address",
			"172.16.1.1",
			"http://172.16.1.1:4321/",
			"private-network",
		],
		["overlay", "station.hobo.test", "https://station.hobo.test/", "overlay"],
	]) {
		it(`accepts ${name}`, () => {
			const directory = mkdtempSync(join(tmpdir(), "webernetes-cue-"));
			try {
				const fixture = join(directory, "endpoint.json");
				writeFileSync(
					fixture,
					JSON.stringify({
						host,
						url,
						locality,
						scheme: url?.startsWith("https") ? "https" : "http",
					}),
				);
				const result = spawnSync(
					cue,
					["vet", "-d", "#WebernetesLocalEndpoint", schema, fixture],
					{ encoding: "utf8" },
				);
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
	for (const [name, host, url, locality] of [
		[
			"public host labelled private",
			"public.example",
			"https://public.example/",
			"private-network",
		],
		[
			"public URL labelled loopback",
			"localhost",
			"https://public.example/",
			"loopback",
		],
		[
			"outside private range",
			"172.32.1.1",
			"https://172.32.1.1/",
			"private-network",
		],
		["invalid IPv4 octet", "127.999.1.1", "https://127.999.1.1/", "loopback"],
	]) {
		it(`rejects ${name}`, () => {
			const directory = mkdtempSync(join(tmpdir(), "webernetes-cue-"));
			try {
				const fixture = join(directory, "endpoint.json");
				writeFileSync(
					fixture,
					JSON.stringify({ host, url, locality, scheme: "https" }),
				);
				const result = spawnSync(
					cue,
					["vet", "-d", "#WebernetesLocalEndpoint", schema, fixture],
					{ encoding: "utf8" },
				);
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).not.toBe(0);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
});
