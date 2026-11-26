import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePipeline, parsePipeline } from "@hobo/ci";
import { expect, it } from "vitest";
import { z } from "zod";
import { createActionsBackend } from "../src/actions-backend.js";

const Contract = z.object({
	interactions: z.array(
		z.object({
			request: z.object({ contents: z.json() }),
			response: z.array(
				z.object({
					contents: z.object({
						backend: z.string(),
						status: z.string(),
						step: z.object({
							id: z.string(),
							exitCode: z.number(),
							stdout: z.string(),
							stderr: z.string(),
						}),
						artifact: z.object({
							path: z.string(),
							text: z.string(),
							sha256: z.string(),
						}),
					}),
				}),
			),
		}),
	),
});
it("verifies the synchronous Actions backend Pact against real local processes", async () => {
	const pact = Contract.parse(
		JSON.parse(
			readFileSync(
				new URL("./actions-backend.pact.json", import.meta.url),
				"utf8",
			),
		),
	);
	expect(pact.interactions).toHaveLength(1);
	const workspace = mkdtempSync(join(tmpdir(), "hobo-actions-pact-"));
	try {
		for (const interaction of pact.interactions) {
			const expected = interaction.response[0]?.contents;
			if (!expected) throw new Error("missing Pact response");
			const result = await executePipeline(
				createActionsBackend({ workspace }),
				parsePipeline(JSON.stringify(interaction.request.contents)),
			);
			expect(result.backend).toBe(expected.backend);
			expect(result.status).toBe(expected.status);
			expect(result.steps).toHaveLength(1);
			expect(result.steps[0]).toMatchObject(expected.step);
			expect(result.artifacts).toHaveLength(1);
			const artifact = result.artifacts[0];
			expect(artifact?.path).toBe(expected.artifact.path);
			expect(artifact?.sha256).toBe(expected.artifact.sha256);
			expect(Buffer.from(artifact?.data ?? []).toString()).toBe(
				expected.artifact.text,
			);
		}
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
