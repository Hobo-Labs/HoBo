import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory } from "@hobo/contract-harness";
import { parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createOpaPolicyEngine } from "../../src/policy/opa-engine.js";
import { createPactFetch, requirePact } from "../helpers/pact-fetch.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("OpaPolicyApi consumer contract", () => {
	it("OPA engine evaluates allow/deny via pact mock HTTP", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = requirePact(pacts, "OpaPolicyApi");
		const fetchImpl = createPactFetch(pact);

		const engine = createOpaPolicyEngine({
			opaUrl: "http://opa.local/v1/data/hobo/authz",
			fetchImpl,
		});

		const allow = await engine.evaluate({
			subject: {
				identity: "j1",
				tenantId: parseTenantId("acme"),
				tags: ["role:junction"],
			},
			action: "junction.join",
			resource: {
				kind: "junction",
				id: "j1",
				tenantId: parseTenantId("acme"),
			},
		});
		expect(allow.effect).toBe("allow");

		const deny = await engine.evaluate({
			subject: {
				identity: "j1",
				tenantId: parseTenantId("acme"),
				tags: [],
			},
			action: "read",
			resource: {
				kind: "endpoint",
				id: "x",
				tenantId: parseTenantId("other"),
			},
		});
		expect(deny.effect).toBe("deny");
	});
});
