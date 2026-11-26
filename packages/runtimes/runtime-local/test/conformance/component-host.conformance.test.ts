import {
	createReferenceComponentHostManifest,
	createReferenceInContainerHost,
	createReferenceRuntimeLocalHost,
	runComponentHostConformance,
} from "@hobo/conformance/component-host";
import { describe, expect, it } from "vitest";

describe("@hobo/runtime-local component-host conformance gate", () => {
	it("passes the component-host portability suite for certified fixture hosts", async () => {
		const report = await runComponentHostConformance({
			manifest: createReferenceComponentHostManifest(),
			hosts: [
				createReferenceRuntimeLocalHost(),
				createReferenceInContainerHost(),
			],
		});

		expect(report.status).toBe("pass");
		expect(report.crossHostAssertions.manifestHostCoverage).toBe("pass");
		expect(report.crossHostAssertions.capabilityHandleIsolation).toBe("pass");
	});
});
