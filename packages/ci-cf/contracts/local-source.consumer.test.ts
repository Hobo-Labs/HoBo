import { expect, it } from "vitest";
import { localBackupOptions, localSourceAdapter } from "../src/local-source.js";
import pact from "./local-source.pact.json" with { type: "json" };

it("uses image checkout and binding-backed snapshots through the SDK contract", async () => {
	expect(pact.interactions).toHaveLength(1);
	const adapter = localSourceAdapter();
	for (const { request, response } of pact.interactions) {
		expect(adapter.accepts(request)).toBe(true);
		adapter.assertSource(request);
		// No env, account, network or Artifacts binding is required by this provider.
		const provider = adapter.create();
		expect(await provider.getSourceCheckout(request)).toEqual(
			response.checkout,
		);
		expect(await provider.listTreeBlobs(request, ["package.json"])).toBe(
			response.cache,
		);
		expect(
			await provider.startStepNotification({
				source: request,
				instanceId: "local",
				label: "check",
				command: "node --version",
			}),
		).toBe(response.notification);
		await expect(provider.getStepCredentialEnv(request)).rejects.toThrow(
			"credentials",
		);
		await expect(provider.getPushCredentials(request)).rejects.toThrow(
			"does not push",
		);
		expect(adapter.accepts({ ...request, owner: "remote" })).toBe(false);
		expect(() =>
			adapter.assertSource({ ...request, provider: "github" }),
		).toThrow();
		expect(
			localBackupOptions({
				dir: "/workspace",
				localBucket: false,
				multipart: true,
			}),
		).toEqual({ dir: "/workspace", localBucket: true, multipart: true });
	}
});
