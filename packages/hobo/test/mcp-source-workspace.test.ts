import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
	prepareSourceWorkspace,
	SOURCE_WORKSPACE_BUILD_ARGS,
	sourceWorkspaceRoot,
	type WorkspaceBuild,
} from "../src/mcp-source-workspace.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE_ENTRY = new URL("../src/bin/hobo-mcp.ts", import.meta.url).href;
const BUILT_ENTRY = new URL("../dist/bin/hobo-mcp.js", import.meta.url).href;

function recordingBuild(code: number) {
	const calls: { root: string; args: readonly string[] }[] = [];
	const build: WorkspaceBuild = async (root, args) => {
		calls.push({ root, args });
		return code;
	};
	return { build, calls };
}

describe("hobo-mcp from a source checkout builds what @hobo/hobo imports first", () => {
	it("finds the workspace root of the source entry point", () => {
		expect(sourceWorkspaceRoot(SOURCE_ENTRY)).toBe(REPO.replace(/\/$/u, ""));
	});

	it("leaves a built install alone", async () => {
		expect(sourceWorkspaceRoot(BUILT_ENTRY)).toBeUndefined();
		const { build, calls } = recordingBuild(0);
		await prepareSourceWorkspace(
			BUILT_ENTRY,
			new AbortController().signal,
			build,
		);
		expect(calls).toEqual([]);
	});

	it("builds the dependency closure of @hobo/hobo at the workspace root", async () => {
		const { build, calls } = recordingBuild(0);
		await prepareSourceWorkspace(
			SOURCE_ENTRY,
			new AbortController().signal,
			build,
		);
		expect(calls).toEqual([
			{ root: REPO.replace(/\/$/u, ""), args: SOURCE_WORKSPACE_BUILD_ARGS },
		]);
		expect(SOURCE_WORKSPACE_BUILD_ARGS).toContain("--filter=@hobo/hobo^...");
	});

	it("says which build failed and how to run it, instead of a missing dist module", async () => {
		const { build } = recordingBuild(2);
		await expect(
			prepareSourceWorkspace(SOURCE_ENTRY, new AbortController().signal, build),
		).rejects.toThrow(
			/turbo exit 2.*pnpm exec turbo run build --filter=@hobo\/hobo\^\.\.\./u,
		);
	});

	it("stops when the host goes away mid-build", async () => {
		const host = new AbortController();
		const build: WorkspaceBuild = async (_root, _args, signal) => {
			host.abort();
			return signal.aborted ? 143 : 0;
		};
		await expect(
			prepareSourceWorkspace(SOURCE_ENTRY, host.signal, build),
		).rejects.toThrow(/host closed the connection/u);
	});

	it("Claude Code waits long enough for a cold build before it lists the tools", () => {
		const settings = z
			.object({ env: z.object({ MCP_TIMEOUT: z.string() }) })
			.parse(JSON.parse(readFileSync(`${REPO}.claude/settings.json`, "utf8")));
		expect(Number(settings.env.MCP_TIMEOUT)).toBeGreaterThanOrEqual(600_000);
	});

	it("the registered server is the source entry point this guards", () => {
		const config = z
			.object({
				mcpServers: z.object({
					hobo: z.object({ command: z.string(), args: z.array(z.string()) }),
				}),
			})
			.parse(JSON.parse(readFileSync(`${REPO}.mcp.json`, "utf8")));
		expect(config.mcpServers.hobo.args).toContain(
			"packages/hobo/src/bin/hobo-mcp.ts",
		);
		expect(pathToFileURL(`${REPO}packages/hobo/src/bin/hobo-mcp.ts`).href).toBe(
			SOURCE_ENTRY,
		);
	});
});
