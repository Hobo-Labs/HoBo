import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadNpmScopeMap } from "../ci/npm-publish-scope.mts";
import {
	orderedSdkTarballPaths,
	releaseSdkTurboBuildArgv,
	SDK_PACKAGES,
} from "../ci/stage-sdk-artifacts.mts";

describe("stage-sdk-artifacts", () => {
	it("orders tarballs using MANIFEST pack order (core before bindles)", () => {
		const map = loadNpmScopeMap();
		const outDir = mkdtempSync(join(tmpdir(), "hobo-sdk-order-"));
		try {
			const packages = SDK_PACKAGES.map((workspace) => {
				const file = `${map.packages[workspace]!.replace("@", "").replace("/", "-")}-0.0.0-alpha.2.tgz`;
				writeFileSync(join(outDir, file), "fake", "utf8");
				return {
					workspace,
					public: map.packages[workspace]!,
					file,
				};
			});
			writeFileSync(
				join(outDir, "MANIFEST.json"),
				JSON.stringify({ version: "0.0.0-alpha.2", packages }),
			);
			const paths = orderedSdkTarballPaths(outDir);
			expect(paths.map((p) => p.split("/").pop())).toEqual(
				packages.map((p) => p.file),
			);
			const coreIdx = packages.findIndex((p) => p.workspace === "@hobo/core");
			const bindlesIdx = packages.findIndex(
				(p) => p.workspace === "@hobo/bindles",
			);
			expect(coreIdx).toBeLessThan(bindlesIdx);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("passes HOBO_TURBO_CONCURRENCY through the SDK allowlist turbo build", () => {
		expect(releaseSdkTurboBuildArgv({ HOBO_TURBO_CONCURRENCY: "1" })).toContain(
			"--concurrency=1",
		);
		const unset = { ...process.env, HOBO_TURBO_CONCURRENCY: undefined };
		expect(releaseSdkTurboBuildArgv(unset)).toContain("--concurrency=100%");
	});

	it("includes @hobo/policy in the SDK allowlist before contracts", () => {
		expect(SDK_PACKAGES.indexOf("@hobo/policy")).toBeGreaterThan(
			SDK_PACKAGES.indexOf("@hobo/core"),
		);
		expect(SDK_PACKAGES.indexOf("@hobo/policy")).toBeLessThan(
			SDK_PACKAGES.indexOf("@hobo/contracts"),
		);
	});
});
