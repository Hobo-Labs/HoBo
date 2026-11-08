/**
 * Narrow progressive ramp port used by TrailRunner.
 * Wraps Harness FeatureFlagStore internally so public .d.ts never names identity types.
 */
import { FeatureFlagStore } from "@hobo/identity";

/** Trails-owned progressive flag port (no foreign package types). */
export type ProgressiveFlagPort = {
	define(input: {
		readonly key: string;
		readonly percentage: number;
		readonly enabled?: boolean;
		readonly defaultValue?: boolean;
		readonly metadata?: Readonly<Record<string, string>>;
	}): void;
};

/**
 * Create an internal progressive flag store backed by Harness FeatureFlagStore.
 * Return type is Trails-owned so declarations stay sealed.
 */
export function createProgressiveFlagPort(
	now: () => string,
): ProgressiveFlagPort {
	const store = new FeatureFlagStore({ now });
	return {
		define(input) {
			store.define({
				key: input.key,
				percentage: input.percentage,
				enabled: input.enabled !== false,
				state: "ENABLED",
				defaultValue: input.defaultValue ?? false,
				...(input.metadata !== undefined
					? { metadata: input.metadata }
					: undefined),
			});
		},
	};
}
