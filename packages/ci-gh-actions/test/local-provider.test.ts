import { readFileSync } from "node:fs";
import { toJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema, parseConfiguration } from "@hobo/ci";
import { afterEach, describe, expect, it } from "vitest";
import {
	parseCiProjectConfig,
	selectCiEnvironment,
} from "../src/project-config.js";
import { harness, queued, reserve, signed } from "./fixtures.js";

const active: ReturnType<typeof harness>[] = [];
function local() {
	const h = harness();
	active.push(h);
	const account = h.configuration.accounts[0];
	const offer = account?.offers[0];
	if (!account || !offer) throw new Error("missing workstation fixture");
	account.budgetMicros = 0;
	Object.assign(offer, {
		id: "local-dev",
		provider: "local",
		providerAccountId: "owned-dev-machine",
		runsOn: "hobo-local-host",
		backend: "gh-actions",
		freeMinutes: 0,
		priceMicrosPerMinute: 0,
		budgetMicros: 0,
	});
	h.api.hostLabel = "hobo-local-host";
	parseConfiguration(toJsonString(ConfigurationSchema, h.configuration));
	return h;
}
afterEach(() => {
	for (const h of active.splice(0)) {
		h.store.close();
		expect(h.api.violations).toEqual([]);
	}
});

describe("local provider bridge contract", () => {
	it("dispatches the dev host and registers only the reserved ephemeral hobo runner", async () => {
		const h = local();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(1);
		expect(h.store.get(lease.id)).toMatchObject({
			provider: "local",
			state: "dispatched",
			reservedPaidMicros: 0,
			reservedFreeMinutes: 0,
		});
		await expect(h.relay.claim(lease.id, "valid")).resolves.toMatchObject({
			encodedJitConfig: "c2VjcmV0",
		});
		expect(h.api.registrations).toBe(1);
		await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow();
		h.api.host.status = "completed";
		await h.relay.reconcile(lease.id, 22);
		expect(h.api.deletes).toBe(1);
		expect(h.store.get(lease.id)).toMatchObject({
			state: "completed",
			paidMicros: 0,
		});
	});
	it("holds a second job in the journal while the workstation is occupied", async () => {
		const h = local();
		await reserve(h);
		const request = signed(queued(2));
		expect(
			await h.relay.webhook(request.body, request.signature, "workflow_job"),
		).toBe("waiting-for-budget-or-capacity");
		h.store.rebuild();
		expect(h.store.pendingJobs().map((job) => job.id)).toEqual([2]);
		await h.relay.dispatchPending();
		expect(h.api.dispatches).toBe(1);
	});
	it.each([
		"public",
		"fork",
		"pull-request",
	])("preserves trusted-private repository admission for %s demand", async (condition) => {
		const h = local();
		if (condition === "public") h.api.original.repository.private = false;
		if (condition === "fork") h.api.original.head_repository.id = 999;
		if (condition === "pull-request") h.api.original.event = "pull_request";
		const request = signed(queued());
		expect(
			await h.relay.webhook(request.body, request.signature, "workflow_job"),
		).toBe("ignored");
		expect(h.store.all()).toHaveLength(0);
		expect(h.api.registrations).toBe(0);
	});
	it("does not issue JIT credentials to a host with the wrong label", async () => {
		const h = local();
		const lease = await reserve(h);
		await h.relay.dispatchPending();
		h.api.hostLabel = "ubuntu-24.04";
		await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(/provider/);
		expect(h.api.registrations).toBe(0);
	});
	it("accepts a local workstation in repository environment policy", () => {
		const policy = JSON.parse(
			readFileSync(
				new URL(
					"../../ci/data-models/fixtures/valid/desired-policy.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		policy.providers = [
			{
				id: "local-dev",
				kind: "local",
				connectionRef: "owned-dev-machine",
				runsOn: "hobo-local-host",
				enabled: true,
			},
		];
		const config = parseCiProjectConfig(
			JSON.stringify({
				defaultEnvironment: "local",
				environments: {
					local: { relayOrigin: "https://ci.example.test", policy },
				},
			}),
		);
		expect(
			selectCiEnvironment(config, "local").policy.providers[0],
		).toMatchObject({
			kind: "local",
			runsOn: "hobo-local-host",
		});
	});
});
