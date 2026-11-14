// Accept: "The realizers pass the Realizer conformance suite."
import { karmadaRealizer, ocmRealizer } from "../src/index.js";
import { FakeKarmada, FakeOcmHub } from "./fake-hub.js";
import { credentials, karmadaConfig, ocmConfig } from "./fixtures.js";
import { describeRealizerConformance } from "./realizer-conformance.js";

describeRealizerConformance("ocmRealizer", () => {
	const hub = new FakeOcmHub();
	return {
		hub,
		realizer: (sink) =>
			ocmRealizer({
				config: ocmConfig({ "camp-a": "cluster-a" }),
				http: hub.transport,
				credentials: credentials(),
				...(sink !== undefined ? { telemetry: sink } : undefined),
			}),
		settle: () => hub.agent(),
	};
});

describeRealizerConformance("karmadaRealizer", () => {
	const hub = new FakeKarmada();
	return {
		hub,
		realizer: (sink) =>
			karmadaRealizer({
				config: karmadaConfig({ "camp-a": "member-a" }),
				http: hub.transport,
				credentials: credentials(),
				...(sink !== undefined ? { telemetry: sink } : undefined),
			}),
		settle: () => hub.schedule(),
	};
});
