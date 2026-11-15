import { compileProjectManifest } from "@hobo/cli";
import { createRegistryFromProviders, plan } from "@hobo/cloud";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import { describe, expect, it } from "vitest";

import { installableProvidersFor } from "../src/add-command.js";
import "../src/cli.js";
import { toRegistrableProvider } from "../src/compose.js";
import { createSecretStoreProvider } from "../src/secret-store-providers.js";

const CI_PROJECT = new URL("../../hobo-ci/", import.meta.url).pathname;

describe("the secretRef and schedule ports", () => {
	it("every secret store is installable for secretRef", () => {
		expect(installableProvidersFor("secretRef")).toEqual([
			"1password",
			"bitwarden",
			"infisical",
		]);
	});

	it("a secret store realizes references only, for access and put", () => {
		const store = createSecretStoreProvider("bitwarden");
		const port = store.capabilities[0];
		expect(port?.satisfies({ port: "secretRef", features: ["access", "put"] })).toEqual(
			{ kind: "full" },
		);
		expect(port?.satisfies({ port: "secretRef", features: ["rotate"] })).toEqual({
			kind: "partial",
			missing: ["rotate"],
		});
		const manifest = JSON.stringify(store.capabilityManifest());
		expect(manifest).toContain('"realizes":"reference"');
	});

	it("places the CI relay's config on the secret store and its repair schedule on Cron Triggers", async () => {
		const manifest = await compileProjectManifest(CI_PROJECT);
		if (manifest === null) throw new Error("the CI project has no manifest");
		const registry = createRegistryFromProviders([
			toRegistrableProvider(createCloudflareProvider()),
			createSecretStoreProvider("bitwarden"),
		]);
		const result = plan(manifest, { deploymentId: "ci" }, registry);
		const unmet = result.ok
			? []
			: result.remediations.map((r) => `${r.resource}:${r.requiredPort}`);
		// Only the queues remain: no default provider serves them yet.
		expect(unmet.filter((entry) => !entry.endsWith(":queue"))).toEqual([]);
	});
});
