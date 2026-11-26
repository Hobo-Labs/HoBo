import type {
	AdapterRegistry,
	ConformanceAdapter,
	ConformanceSuiteDescriptor,
	ConformanceSuiteRegistry,
} from "./types.js";

export function createAdapterRegistry(): AdapterRegistry {
	const adapters = new Map<string, ConformanceAdapter>();

	return {
		register(adapter: ConformanceAdapter): void {
			if (adapters.has(adapter.id)) {
				throw new TypeError(`adapter id already registered: ${adapter.id}`);
			}
			adapters.set(adapter.id, adapter);
		},
		get(id: string): ConformanceAdapter | undefined {
			return adapters.get(id);
		},
		list(): ConformanceAdapter[] {
			return [...adapters.values()];
		},
	};
}

/**
 * Registry of suite descriptions, keyed by suite id.
 *
 * Listing is sorted rather than insertion-ordered: a catalog digest that
 * changed because two suites were registered in a different order would make a
 * receipt lie about what changed.
 */
export function createConformanceSuiteRegistry(
	descriptors: readonly ConformanceSuiteDescriptor[] = [],
): ConformanceSuiteRegistry {
	const suites = new Map<string, ConformanceSuiteDescriptor>();

	const registry: ConformanceSuiteRegistry = {
		register(descriptor: ConformanceSuiteDescriptor): void {
			if (!descriptor?.suiteId) {
				throw new TypeError("conformance suite descriptor needs a suiteId");
			}
			if (descriptor.checks.length === 0) {
				throw new TypeError(
					`conformance suite ${descriptor.suiteId} declares no checks`,
				);
			}
			if (suites.has(descriptor.suiteId)) {
				throw new TypeError(
					`conformance suite already registered: ${descriptor.suiteId}`,
				);
			}
			suites.set(descriptor.suiteId, Object.freeze({ ...descriptor }));
		},
		get(suiteId: string): ConformanceSuiteDescriptor | undefined {
			return suites.get(suiteId);
		},
		list(): readonly ConformanceSuiteDescriptor[] {
			return [...suites.values()].sort((a, b) =>
				a.suiteId.localeCompare(b.suiteId),
			);
		},
		checks(): readonly string[] {
			return [
				...new Set(
					[...suites.values()].flatMap((descriptor) => descriptor.checks),
				),
			].sort();
		},
	};

	for (const descriptor of descriptors) {
		registry.register(descriptor);
	}

	return registry;
}
