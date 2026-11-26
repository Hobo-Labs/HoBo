import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPactInventory,
	createMockProviderFromPact,
	loadPactDirectory,
	verifyPact,
} from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";

import { createConnectivityHostHandler } from "../../src/connectivity-host.js";
import { requirePact } from "../helpers/pact-fetch.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("ConnectivityHost consumer contract (PACT)", () => {
	it("drives host through pact mock and real host satisfies pact", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = requirePact(pacts, "ConnectivityHost");

		// Consumer: mock provider returns contracted responses.
		const mock = createMockProviderFromPact(pact);
		const named = await mock.handle({
			method: "GET",
			path: "/named-endpoints/local?resource=web&app=myapp&env=local",
		});
		expect(named.status).toBe(200);
		expect(named.body).toMatchObject({
			url: "https://web.myapp.local.hobo.localhost",
		});

		// Real host implements the same paths (provider verification path).
		const host = createConnectivityHostHandler();
		const report = await verifyPact(pact, {
			name: host.name,
			handle: (req) => host.handle(req),
		});
		expect(report.ok).toBe(true);
		expect(report.failures).toEqual([]);

		const inventory = await checkPactInventory(contractsDir);
		expect(inventory.ok).toBe(true);
	});

	it("real host produces contracted named endpoints and policy decisions", async () => {
		const host = createConnectivityHostHandler();
		const local = await host.handle({
			method: "GET",
			path: "/named-endpoints/local?resource=web&app=myapp&env=local",
		});
		expect(local.status).toBe(200);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((local.body as { url: string }).url).toBe(
			"https://web.myapp.local.hobo.localhost",
		);

		const overlay = await host.handle({
			method: "GET",
			path: "/named-endpoints/overlay?resource=web&app=myapp&env=prod",
		});
		// SAFETY: assertion required at this I/O or test boundary.
		expect((overlay.body as { url: string }).url).toBe(
			"https://web.myapp.hobo.test",
		);

		const allow = await host.handle({
			method: "POST",
			path: "/policy/evaluate",
			body: {
				engine: "tag-acl",
				action: "junction.join",
				subjectTenant: "acme",
				resourceTenant: "acme",
				subjectTags: ["role:junction", "env:development"],
				resourceTags: ["env:development"],
			},
		});
		// SAFETY: assertion required at this I/O or test boundary.
		expect((allow.body as { effect: string }).effect).toBe("allow");

		const deny = await host.handle({
			method: "POST",
			path: "/policy/evaluate",
			body: {
				engine: "opa",
				action: "read",
				subjectTenant: "acme",
				resourceTenant: "other",
			},
		});
		// SAFETY: assertion required at this I/O or test boundary.
		expect((deny.body as { effect: string }).effect).toBe("deny");

		const dnsOk = await host.handle({
			method: "POST",
			path: "/dns/reconcile",
			body: {
				tenantId: "acme",
				hostname: "web.myapp.hobo.example.com",
				gatewayHostname: "funnel.ts.net",
			},
		});
		expect(dnsOk.status).toBe(200);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((dnsOk.body as { applied: boolean }).applied).toBe(true);

		const dnsBad = await host.handle({
			method: "POST",
			path: "/dns/reconcile",
			body: {
				tenantId: "acme",
				hostname: "web.myapp.hobo.example.com",
				gatewayHostname: "100.64.0.1",
			},
		});
		expect(dnsBad.status).toBe(400);
	});
});
