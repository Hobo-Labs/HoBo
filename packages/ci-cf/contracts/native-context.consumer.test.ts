import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePipeline, parsePipeline } from "@hobo/ci/execution";
import { expect, it } from "vitest";
import { createCloudflareBackend } from "../src/backend.js";
import { NativeContext } from "../test/fixtures/native-context.js";
import pact from "./native-context.pact.json" with { type: "json" };

it("fulfills every native runner consumer interaction without replacing adapter logic", async () => {
	expect(pact.interactions).toHaveLength(1);
	for (const interaction of pact.interactions) {
		const workspace = mkdtempSync(join(tmpdir(), "hobo-ci-cf-pact-"));
		try {
			const request = interaction.request.contents;
			const expected = interaction.response[0]?.contents;
			if (!expected) throw new Error("missing pact response");
			const native = new NativeContext(workspace);
			const result = await executePipeline(
				createCloudflareBackend({
					context: native.context,
					terminate: native.terminate,
					verifyShutdown: native.verifyShutdown,
				}),
				parsePipeline(JSON.stringify(request.pipeline)),
			);
			expect(result).toMatchObject({
				backend: expected.backend,
				status: expected.status,
			});
			expect(result.steps.map((step) => step.exitCode)).toEqual(
				expected.stepExitCodes,
			);
			expect(result.steps.map((step) => step.stdout)).toEqual(
				expected.stepStdout,
			);
			expect(result.artifacts[0]?.path).toBe(expected.artifactPath);
			expect(new TextDecoder().decode(result.artifacts[0]?.data)).toBe(
				expected.artifactText,
			);
			expect(result.artifacts[0]?.sha256).toBe(expected.artifactSha256);
			expect(native.roots).toBe(request.native.contextCalls);
			expect(native.chained).toBe(request.native.snapshotChainCalls);
			expect(native.requests.map((call) => call.name)).toEqual(
				request.native.names,
			);
			for (const call of native.requests) {
				expect(call.cwd).toBe(request.native.cwd);
				expect(call.config?.retries).toEqual(request.native.retries);
				expect(call.config?.commandTimeoutMs).toBeGreaterThan(0);
				expect(call.config?.commandTimeoutMs).toBeLessThanOrEqual(30000);
			}
			expect(native.requests[0]?.env).toEqual(request.native.env);
			expect(native.requests[0]?.command).toContain(request.native.workspace);
			expect(native.requests[0]?.command).toContain("VALUE=artifact");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	}
});
