import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseEventEnvelope } from "../src/index.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"core-contract-boundary.pact.json",
);

describe("CoreContractBoundary pact", () => {
	it("loads consumer/provider names and envelope parse satisfies the boundary contract", () => {
		const pact = JSON.parse(readFileSync(pactPath, "utf8"));

		expect(pact.consumer.name).toBe("@hobo/runtime");
		expect(pact.provider.name).toBe("CoreContractBoundary");
		expect(pact.metadata.pactSpecification.version).toBe("3.0.0");
		expect(pact.interactions[0]?.response.body.ok).toBe(true);

		const envelope = parseEventEnvelope({
			id: "evt-pact",
			type: "deployment.Planned",
			v: 1,
			streamId: "deployment:01H",
			seq: 0,
			ts: "2026-07-01T00:00:00.000Z",
			actor: { kind: "system", id: "system:boundary" },
			tenant: "tenant-demo",
			data: {},
		});
		expect(envelope.type).toBe("deployment.Planned");
	});
});
