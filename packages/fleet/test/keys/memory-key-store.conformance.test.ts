import { describe } from "vitest";
import { createMemoryKeyStore } from "../../src/keys/index.js";
import { runKeyStoreConformance } from "../../src/testing/conformance/index.js";

describe("createMemoryKeyStore", () => {
	runKeyStoreConformance(createMemoryKeyStore);
});
