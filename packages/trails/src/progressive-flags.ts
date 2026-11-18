import { FeatureFlagStore } from "@hobo/identity";

export type ProgressiveFlagPort = {
	define(input: {
		readonly key: string;
		readonly percentage: number;
		readonly enabled?: boolean;
		readonly defaultValue?: boolean;
		readonly metadata?: Readonly<Record<string, string>>;
	}): void;
};

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
