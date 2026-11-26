import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import * as connectorAcp from "../src/index.js";
import { acpConnector, lowerAcpConnector } from "../src/index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../contracts/connector-acp-boundary.pact.json"),
		"utf8",
	),
);

function binding() {
	return acpConnector("swe-agent", {
		operations: {
			"logs.tail": "logs:tail",
			"deployments.apply": "deployments:apply",
			"deployments.inspect": "deployments:inspect",
		},
	});
}

describe("ACP connector lowering (HOBO-88 seam, HOBO-32 vectors)", () => {
	it("lowers connector(name, { protocol: 'acp' }) to the pact-recorded usage-inferred manifest entry", () => {
		const entry = lowerAcpConnector(binding(), [
			"logs.tail",
			"deployments.apply",
		]);
		const recorded = pact.interactions[0].response.body;
		assert.equal(entry.type, recorded.type);
		assert.equal(entry.protocol, recorded.protocol);
		assert.equal(entry.via, recorded.via);
		assert.equal(entry.onBehalfOf, recorded.onBehalfOf);
		assert.deepEqual([...entry.allow], recorded.allow);
		assert.equal(entry.requestedScopeSource, recorded.requestedScopeSource);
		assert.equal(
			entry.usageExceedsDeclaredAllow,
			recorded.usageExceedsDeclaredAllow,
		);
	});

	it("declared narrowing wins, and observed usage exceeding it is surfaced", () => {
		const narrowed = lowerAcpConnector(binding(), ["logs.tail"], ["logs:tail"]);
		assert.deepEqual([...narrowed.allow], ["logs:tail"]);
		assert.equal(narrowed.requestedScopeSource, "declared-narrowing");
		assert.equal(narrowed.usageExceedsDeclaredAllow, false);

		const exceeded = lowerAcpConnector(
			binding(),
			["logs.tail", "deployments.apply"],
			["logs:tail"],
		);
		assert.equal(exceeded.usageExceedsDeclaredAllow, true);
	});

	it("rejects unadvertised operations instead of inventing scopes", () => {
		assert.throws(() => lowerAcpConnector(binding(), ["secrets.read"]));
		assert.throws(() => binding().call("secrets.read"));
	});

	it("NEGATIVE VECTOR: no public agent() collection/factory is exported", () => {
		const exportNames = Object.keys(connectorAcp);
		assert.equal(exportNames.includes("agent"), false);
		assert.equal(exportNames.includes("createAgent"), false);
		assert.equal(exportNames.includes("agents"), false);
		// The connector declaration is the only protocol entry point.
		assert.equal(
			Object.prototype.toString.call(connectorAcp.acpConnector),
			"[object Function]",
		);
	});
});
