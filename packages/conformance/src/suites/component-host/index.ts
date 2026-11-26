import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../../json.js";
import {
	CapabilityIsolationError,
	ComponentHostPlanningError,
} from "./errors.js";
import {
	CANONICAL_NAN_BITS,
	REFERENCE_CLOCK_REPLAY,
	REFERENCE_FUEL_SCHEDULE,
	REFERENCE_LINK_LATE_BINDING,
	REFERENCE_RESOURCE_LIMIT,
	REFERENCE_WASI_ROUND_TRIP,
} from "./reference.js";

export const COMPONENT_HOST_CONFORMANCE_SCHEMA =
	"@hobo/conformance/component-host/v1";

const NON_COVERED_DIVERGENCES = Object.freeze([
	"wall-clock scheduling jitter",
	"host-specific partial-failure timing",
]);

export type ComponentHostManifest = ReturnType<
	typeof createReferenceComponentHostManifest
>;

export type ComponentHostAdapter = FixtureComponentHost;

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export type ComponentHostConformanceReport = {
	readonly schema: typeof COMPONENT_HOST_CONFORMANCE_SCHEMA;
	readonly status: "pass" | "fail";
	readonly hosts: readonly HostReport[];
	readonly crossHostAssertions: CrossHostAssertions;
	readonly failures: readonly ConformanceFailure[];
	readonly nonCoveredDivergences: readonly string[];
};

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
type HostReport = {
	readonly kind: string;
	readonly version: string;
	readonly boundaryMode: string;
	status: "pass" | "fail";
	checks: Array<{ id: string; status: string; message?: string }>;
};

type CrossHostAssertions = {
	readonly manifestHostCoverage: "pass" | "fail";
	readonly deterministicClockReplay: "pass" | "fail";
	readonly wasiRoundTrip: "pass" | "fail";
	readonly linkLateBinding: "pass" | "fail";
	readonly capabilityHandleIsolation: "pass" | "fail";
	readonly fpNanCanonicalization: "pass" | "fail";
	readonly fuelEpochScheduling: "pass" | "fail";
	readonly resourceLimitSemantics: "pass" | "fail";
};

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
type ConformanceFailure = {
	readonly checkId: string;
	readonly message: string;
	readonly expected?: JsonValue;
	readonly observations?: JsonValue;
	readonly hosts?: JsonValue;
	readonly missingHosts?: JsonValue;
};

export {
	CapabilityIsolationError,
	ComponentHostPlanningError,
} from "./errors.js";
export { parseComponentHostManifest } from "./parse.js";
export {
	CANONICAL_NAN_BITS,
	REFERENCE_CLOCK_REPLAY,
	REFERENCE_FUEL_SCHEDULE,
	REFERENCE_LINK_LATE_BINDING,
	REFERENCE_RESOURCE_LIMIT,
	REFERENCE_WASI_ROUND_TRIP,
} from "./reference.js";

export function createReferenceComponentHostManifest() {
	return deepFreeze({
		schema: "hobo.manifest/v1",
		componentHost: {
			suite: "@hobo/conformance/component-host",
			suiteVersion: "0.1.0",
			certifiedHosts: [
				{ kind: "runtime-local", version: "wasmtime/46.0.1" },
				{ kind: "wasm-in-container", version: "wasmtime-container/46.0.1" },
			],
		},
	});
}

export function createReferenceRuntimeLocalHost(
	options: FixtureHostOptions = {},
): FixtureComponentHost {
	return new FixtureComponentHost({
		kind: "runtime-local",
		version: "wasmtime/46.0.1",
		boundaryMode: "in-process",
		...options,
	});
}

export function createReferenceInContainerHost(
	options: FixtureHostOptions = {},
): FixtureComponentHost {
	return new FixtureComponentHost({
		kind: "wasm-in-container",
		version: "wasmtime-container/46.0.1",
		boundaryMode: "container",
		...options,
	});
}

export function planComponentHost(
	manifest: ComponentHostManifest,
	host: ComponentHostAdapter,
) {
	const pins = normalizeHostPins(manifest);
	const candidate = hostDescriptor(host);
	const exact = pins.find(
		(pin) => pin.kind === candidate.kind && pin.version === candidate.version,
	);
	if (!exact) {
		const expectedVersions = pins
			.filter((pin) => pin.kind === candidate.kind)
			.map((pin) => pin.version);
		throw new ComponentHostPlanningError(
			"component_host.host-version-incompatible",
			{
				hostKind: candidate.kind,
				hostVersion: candidate.version,
				expectedVersions,
				suite: manifest?.componentHost?.suite,
			},
		);
	}

	return deepFreeze({
		status: "pass",
		host: candidate,
		suite: manifest.componentHost.suite,
		suiteVersion: manifest.componentHost.suiteVersion,
	});
}

export async function runComponentHostConformance(input: {
	manifest: ComponentHostManifest;
	hosts: readonly ComponentHostAdapter[];
}): Promise<ComponentHostConformanceReport> {
	const { manifest, hosts } = input;
	if (!Array.isArray(hosts) || hosts.length < 2) {
		throw new TypeError(
			"hosts must include at least two component-host candidates",
		);
	}

	const failures: ConformanceFailure[] = [];
	const hostReports: HostReport[] = [];
	for (const host of hosts) {
		const report: HostReport = {
			...hostDescriptor(host),
			boundaryMode: host.boundaryMode,
			status: "pass",
			checks: [],
		};
		try {
			planComponentHost(manifest, host);
			report.checks.push({ id: "manifest-host-pin", status: "pass" });
		} catch (error) {
			report.status = "fail";
			report.checks.push({
				id: "manifest-host-pin",
				status: "fail",
				message: error instanceof Error ? error.message : String(error),
			});
			failures.push(failure("manifest-host-pin", String(error), [host]));
		}
		hostReports.push(report);
	}

	const crossHostAssertions: CrossHostAssertions = {
		manifestHostCoverage: assertManifestHostCoverage({
			manifest,
			hosts,
			failures,
		}),
		deterministicClockReplay: await assertSameAcrossHosts({
			id: "deterministic-clock-replay",
			hosts,
			failures,
			expected: REFERENCE_CLOCK_REPLAY,
			read: (host) => host.replayDeterministicClockTrace(referenceClockTrace()),
		}),
		wasiRoundTrip: await assertSameAcrossHosts({
			id: "wasi-round-trip",
			hosts,
			failures,
			expected: REFERENCE_WASI_ROUND_TRIP,
			read: (host) => host.roundTripWasiInterface(referenceWasiRequest()),
		}),
		linkLateBinding: await assertSameAcrossHosts({
			id: "link-late-binding",
			hosts,
			failures,
			expected: REFERENCE_LINK_LATE_BINDING,
			read: (host) => host.invokeLinkedImport(referenceLinkCall()),
		}),
		capabilityHandleIsolation: await assertCapabilityIsolation({
			hosts,
			failures,
		}),
		fpNanCanonicalization: await assertSameAcrossHosts({
			id: "fp-nan-canonicalization",
			hosts,
			failures,
			expected: CANONICAL_NAN_BITS,
			read: (host) => host.canonicalizeNan64(),
		}),
		fuelEpochScheduling: await assertSameAcrossHosts({
			id: "fuel-epoch-scheduling",
			hosts,
			failures,
			expected: REFERENCE_FUEL_SCHEDULE,
			read: (host) => host.runFuelEpochSchedule(),
		}),
		resourceLimitSemantics: await assertSameAcrossHosts({
			id: "resource-limit-semantics",
			hosts,
			failures,
			expected: REFERENCE_RESOURCE_LIMIT,
			read: (host) => host.enforceResourceLimit(),
		}),
	};

	return deepFreeze({
		schema: COMPONENT_HOST_CONFORMANCE_SCHEMA,
		status: failures.length === 0 ? "pass" : "fail",
		hosts: hostReports,
		crossHostAssertions,
		failures,
		nonCoveredDivergences: NON_COVERED_DIVERGENCES,
	});
}

type FixtureHostOptions = {
	kind?: string;
	version?: string;
	boundaryMode?: string;
	nanBits?: string;
	fuelSchedule?: typeof REFERENCE_FUEL_SCHEDULE;
	resourceLimit?: typeof REFERENCE_RESOURCE_LIMIT;
	deterministicClockOffsetMs?: number;
	allowAmbientCapability?: boolean;
};

export class FixtureComponentHost {
	readonly kind: string;
	readonly version: string;
	readonly boundaryMode: string;
	readonly nanBits: string;
	readonly fuelSchedule: typeof REFERENCE_FUEL_SCHEDULE;
	readonly resourceLimit: typeof REFERENCE_RESOURCE_LIMIT;
	readonly deterministicClockOffsetMs: number;
	readonly allowAmbientCapability: boolean;

	constructor(
		options: FixtureHostOptions & {
			kind: string;
			version: string;
			boundaryMode: string;
		},
	) {
		this.kind = requireNonEmptyString(options.kind, "host.kind");
		this.version = requireNonEmptyString(options.version, "host.version");
		this.boundaryMode = requireNonEmptyString(
			options.boundaryMode,
			"host.boundaryMode",
		);
		this.nanBits = options.nanBits ?? CANONICAL_NAN_BITS;
		this.fuelSchedule = clone(options.fuelSchedule ?? REFERENCE_FUEL_SCHEDULE);
		this.resourceLimit = clone(
			options.resourceLimit ?? REFERENCE_RESOURCE_LIMIT,
		);
		this.deterministicClockOffsetMs = options.deterministicClockOffsetMs ?? 0;
		this.allowAmbientCapability = options.allowAmbientCapability ?? false;
	}

	replayDeterministicClockTrace(trace: ReturnType<typeof referenceClockTrace>) {
		let counter = 0;
		const ticks: number[] = [];
		for (const step of trace) {
			if (step.type === "clock.tick") {
				ticks.push(step.atMs + this.deterministicClockOffsetMs);
			}
			if (step.type === "state.increment") {
				counter += step.by;
			}
		}
		return {
			componentId: "clocked-worker",
			counter,
			ticks,
			terminalState: `counter:${counter}@${ticks.at(-1)}`,
		};
	}

	roundTripWasiInterface(request: ReturnType<typeof referenceWasiRequest>) {
		return {
			interface: request.interface,
			version: request.version,
			request: clone(request.payload),
			response: {
				ok: true,
				value: `wasi:${request.payload.key}`,
			},
		};
	}

	invokeLinkedImport(call: ReturnType<typeof referenceLinkCall>) {
		return {
			componentId: call.componentId,
			importInterface: call.importInterface,
			providerExport: call.providerExport,
			response: {
				status: 200,
				body: `linked:${call.payload.path}`,
			},
		};
	}

	callUnlinkedCapability(
		call: ReturnType<typeof referenceUnlinkedCapabilityCall>,
	) {
		if (this.allowAmbientCapability) {
			return {
				leaked: true,
				componentId: call.componentId,
				importInterface: call.importInterface,
			};
		}
		throw new CapabilityIsolationError("component_host.capability-not-linked", {
			componentId: call.componentId,
			importInterface: call.importInterface,
		});
	}

	canonicalizeNan64() {
		return this.nanBits;
	}

	runFuelEpochSchedule() {
		return clone(this.fuelSchedule);
	}

	enforceResourceLimit() {
		return clone(this.resourceLimit);
	}
}

async function assertSameAcrossHosts<T>({
	id,
	hosts,
	failures,
	read,
	expected,
}: {
	id: string;
	hosts: readonly FixtureComponentHost[];
	failures: ConformanceFailure[];
	read: (host: FixtureComponentHost) => T | Promise<T>;
	expected?: T;
}) {
	const observations: Array<{
		host: ReturnType<typeof hostDescriptor>;
		value: T;
	}> = [];
	for (const host of hosts) {
		observations.push({
			host: hostDescriptor(host),
			value: await read(host),
		});
	}

	const expectedValue = expected ?? observations[0]?.value;
	if (
		observations.every((observation) =>
			sameValue(observation.value, expectedValue),
		)
	) {
		return "pass" as const;
	}

	const hostsAgree = observations.every((observation) =>
		sameValue(observation.value, observations[0]?.value),
	);
	failures.push({
		checkId: id,
		message: hostsAgree
			? `${id} did not match expected reference semantics`
			: `${id} diverged across component hosts`,
		expected: cloneAsJson(expectedValue ?? null),
		observations: cloneAsJson(observations),
	});
	return "fail" as const;
}

async function assertCapabilityIsolation({
	hosts,
	failures,
}: {
	hosts: readonly FixtureComponentHost[];
	failures: ConformanceFailure[];
}) {
	const observations: Array<JsonObject> = [];
	for (const host of hosts) {
		try {
			const value = await host.callUnlinkedCapability(
				referenceUnlinkedCapabilityCall(),
			);
			observations.push({ host: hostDescriptor(host), status: "fail", value });
		} catch (error) {
			observations.push({
				host: hostDescriptor(host),
				status:
					error instanceof CapabilityIsolationError &&
					error.code === "component_host.capability-not-linked"
						? "pass"
						: "fail",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (observations.every((observation) => observation.status === "pass")) {
		return "pass" as const;
	}
	failures.push({
		checkId: "capability-handle-isolation",
		message: "unlinked capability call must fail closed on every host",
		observations: cloneAsJson(observations),
	});
	return "fail" as const;
}

function assertManifestHostCoverage({
	manifest,
	hosts,
	failures,
}: {
	manifest: ComponentHostManifest;
	hosts: readonly FixtureComponentHost[];
	failures: ConformanceFailure[];
}) {
	const requiredHosts = normalizeHostPins(manifest);
	const presentHosts = hosts.map(hostDescriptor);
	const missingHosts = requiredHosts.filter(
		(required) =>
			!presentHosts.some(
				(present) =>
					present.kind === required.kind &&
					present.version === required.version,
			),
	);

	if (missingHosts.length === 0) {
		return "pass" as const;
	}

	failures.push({
		checkId: "manifest-host-coverage",
		message:
			"all manifest-certified component hosts must run in the conformance report",
		missingHosts: cloneAsJson(missingHosts),
		hosts: cloneAsJson(presentHosts),
	});
	return "fail" as const;
}

function referenceClockTrace() {
	return [
		{ type: "clock.tick" as const, atMs: 0 },
		{ type: "state.increment" as const, by: 1 },
		{ type: "clock.tick" as const, atMs: 25 },
		{ type: "state.increment" as const, by: 2 },
		{ type: "clock.tick" as const, atMs: 50 },
	];
}

function referenceWasiRequest() {
	return {
		interface: "wasi:keyvalue/store",
		version: "0.2.0",
		payload: { key: "todo-1", value: "ship" },
	};
}

function referenceLinkCall() {
	return {
		componentId: "api",
		importInterface: "wasi:http/outgoing-handler@0.2.0",
		providerExport: "wasi:http/outgoing-handler@0.2.0",
		payload: { path: "/healthz" },
	};
}

function referenceUnlinkedCapabilityCall() {
	return {
		componentId: "api",
		importInterface: "wasi:blobstore/blobstore@0.2.0",
	};
}

function normalizeHostPins(manifest: ComponentHostManifest) {
	const pins = manifest?.componentHost?.certifiedHosts;
	if (!Array.isArray(pins) || pins.length === 0) {
		throw new ComponentHostPlanningError(
			"component_host.manifest-host-pins-required",
			{
				suite: manifest?.componentHost?.suite ?? null,
			},
		);
	}
	return pins.map((pin) => hostDescriptor(pin));
}

function hostDescriptor(host: { kind?: string; version?: string }) {
	return {
		kind: requireNonEmptyString(host?.kind, "host.kind"),
		version: requireNonEmptyString(host?.version, "host.version"),
	};
}

function failure(
	checkId: string,
	message: string,
	hosts: readonly FixtureComponentHost[],
) {
	return {
		checkId,
		message,
		hosts: cloneAsJson(hosts.map(hostDescriptor)),
	};
}

function sameValue<T, U>(left: T, right: U) {
	return (
		JSON.stringify(cloneAsJson(left)) === JSON.stringify(cloneAsJson(right))
	);
}

function requireNonEmptyString<T>(value: T, fieldName: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${fieldName} must be a non-empty string`);
	}
	return value;
}

function clone<T>(value: T): T {
	if (value === undefined) {
		return value;
	}
	if (structuredClone instanceof Function) {
		return structuredClone(value);
	}
	const cloned = parseJsonValue(JSON.stringify(value));
	// SAFETY: JSON round-trip preserves T at this clone fallback.
	return cloned as T;
}

function deepFreeze<T>(value: T): T {
	if (!value || !isJsonObject(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}
