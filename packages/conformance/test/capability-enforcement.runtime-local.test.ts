import { describe } from "vitest";

import { createCapabilityLinkTable } from "../../runtimes/runtime-local/src/capability/link-table.js";

import { capabilityEnforcementSuite } from "../src/capability-enforcement/suite.js";

describe("@hobo/runtime-local capability enforcement", () => {
	capabilityEnforcementSuite((options) =>
		createCapabilityLinkTable(options ?? {}),
	);
});
