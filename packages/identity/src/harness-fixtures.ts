/**
 * Contract-asserted flag / EvaluationContext fixtures for hobo dev (ADR-0042 / ADR-0070).
 */

import { createDevEvaluationContext } from "./evaluation-context.js";
import { FeatureFlagStore } from "./feature-flag-store.js";
import { createHarness } from "./harness-compose.js";
import { createLocalFeatureClient } from "./openfeature-provider.js";

export type LocalHarnessFixtures = Readonly<{
	store: FeatureFlagStore;
	client: ReturnType<typeof createLocalFeatureClient>;
	harness: ReturnType<typeof createHarness>;
	label: "contract-asserted-harness-fixtures";
	fidelity: "simulated";
}>;

/**
 * Zero-config local harness for hobo dev: store + OpenFeature client + progressive engine.
 */
export function createContractAssertedHarnessFixtures(input?: {
	readonly tenant?: string;
	readonly userId?: string;
	readonly env?: string;
}): LocalHarnessFixtures {
	const store = new FeatureFlagStore();
	// Sample app flag for offline parity
	store.define({
		key: "example-feature",
		state: "ENABLED",
		percentage: 50,
		defaultValue: false,
		variants: { control: false, treatment: true },
		defaultVariant: "control",
		targeting: {
			fractional: {
				key: ["identity.userId"],
				variants: [{ treatment: 50 }, { control: 50 }],
			},
		},
		metadata: { owner: "platform", fixture: "true" },
	});
	const client = createLocalFeatureClient(store, {
		tenant: input?.tenant,
		userId: input?.userId,
		env: input?.env,
	});
	const harness = createHarness({ store });
	// Warm evaluation so fixtures exercise the path
	const ctx = createDevEvaluationContext(input);
	client.getBooleanDetails("example-feature", false, ctx);

	return Object.freeze({
		store,
		client,
		harness,
		label: "contract-asserted-harness-fixtures",
		fidelity: "simulated",
	});
}
