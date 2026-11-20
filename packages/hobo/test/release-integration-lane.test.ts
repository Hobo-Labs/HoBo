import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ISOLATED_TEST_FILES } from "./support/isolated-test-files.js";
import { RELEASE_INTEGRATION_TEST_FILES } from "./support/release-integration-test-files.js";

type Project = {
	test?: {
		name?: string;
		include?: string[];
		exclude?: string[];
		isolate?: boolean;
	};
};
type VitestConfig = {
	test?: {
		projects?: Project[];
		globalSetup?: unknown[];
		setupFiles?: unknown[];
	};
};

async function loadConfig(path: string): Promise<VitestConfig> {
	const loaded: { default: VitestConfig } = await import(
		new URL(path, import.meta.url).href
	);
	return loaded.default;
}

function projectsOf(config: VitestConfig, name: string) {
	const project = config.test?.projects?.find(
		(entry) => entry.test?.name === name,
	);
	expect(project, `${name} project missing`).toBeDefined();
	return project?.test ?? {};
}

describe("the slow integration lane split", () => {
	it("names suites that exist", () => {
		expect(RELEASE_INTEGRATION_TEST_FILES.length).toBeGreaterThan(0);
		for (const file of RELEASE_INTEGRATION_TEST_FILES)
			expect(
				existsSync(join(import.meta.dirname, "..", file)),
				`${file} does not exist`,
			).toBe(true);
	});

	it("leaves the moved suites out of both default projects", async () => {
		const config = await loadConfig("../vitest.config.ts");
		const isolated = projectsOf(config, "isolated");
		const shared = projectsOf(config, "shared");
		for (const file of RELEASE_INTEGRATION_TEST_FILES) {
			expect(isolated.include, file).not.toContain(file);
			expect(shared.exclude, file).toContain(file);
		}
		for (const file of ISOLATED_TEST_FILES)
			if (!RELEASE_INTEGRATION_TEST_FILES.includes(file))
				expect(isolated.include, file).toContain(file);
	});

	it("includes exactly the moved suites, isolated, in the release lane", async () => {
		const config = await loadConfig("../vitest.release-integration.config.ts");
		expect(config.test?.projects?.length).toBe(1);
		const lane = projectsOf(config, "release-integration");
		expect([...(lane.include ?? [])].sort()).toEqual(
			[...RELEASE_INTEGRATION_TEST_FILES].sort(),
		);
		expect(lane.isolate).toBe(true);
	});

	it("keeps the lane on the root config's setup files", async () => {
		const [lane, root] = await Promise.all([
			loadConfig("../vitest.release-integration.config.ts"),
			loadConfig("../../../vitest.config.ts"),
		]);
		expect(lane.test?.globalSetup).toEqual(root.test?.globalSetup);
		expect(lane.test?.setupFiles).toEqual(root.test?.setupFiles);
	});
});
