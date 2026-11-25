import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpTransport } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { runCdDeploySubcommand } from "../src/cd-deploy.js";
import { openCdRuntime } from "../src/cd-runtime.js";

function recordingTransport(urls: string[]): HttpTransport {
	return async (request) => {
		urls.push(request.url);
		return { status: 200, headers: {}, body: "{}" };
	};
}

describe("CD runtime telemetry", () => {
	it("sends nothing when no OTLP endpoint is configured", async () => {
		const home = await mkdtemp(join(tmpdir(), "cd-telemetry-"));
		const urls: string[] = [];
		try {
			const opened = await openCdRuntime({
				env: {},
				home,
				cwd: home,
				simulate: true,
				http: recordingTransport(urls),
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			await runCdDeploySubcommand(opened.value.host, ["reconcile"], {
				camp: "edge/prod",
			});
			await runCdDeploySubcommand(opened.value.host, ["camp", "list"], {});
			await opened.value.close();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(urls.filter((u) => u.includes("/v1/"))).toEqual([]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("exports to the configured OTLP endpoint", async () => {
		const home = await mkdtemp(join(tmpdir(), "cd-telemetry-"));
		const urls: string[] = [];
		try {
			const opened = await openCdRuntime({
				env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test:4318" },
				home,
				cwd: home,
				simulate: true,
				http: recordingTransport(urls),
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			expect(opened.value.config.telemetryEndpoint).toBe(
				"http://collector.test:4318",
			);
			await opened.value.close();
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
