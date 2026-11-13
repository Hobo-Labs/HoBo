// The in-memory KeyStore of @hobo/fleet/keys run through the shared KeyStore
// conformance suite of @hobo/fleet/testing (L29). Wired at the wave-1 merge,
// once both lanes had landed (L01 cascade delta; design §11.3 rule 6).
import { describe } from "vitest";
import { createMemoryKeyStore } from "../../src/keys/index.js";
import { runKeyStoreConformance } from "../../src/testing/conformance/index.js";

describe("createMemoryKeyStore", () => {
	runKeyStoreConformance(createMemoryKeyStore);
});
