import {
	type InterfacePin,
	type NegotiatedWire,
	type WireVersion,
	WireVersionIncompatibleError,
} from "@hobo/core";
import { first } from "@hobo/core/total-access";

function compareVersions(left: WireVersion, right: WireVersion): number {
	for (const key of ["major", "minor", "patch"] as const) {
		if (left[key] !== right[key]) {
			return left[key] > right[key] ? 1 : -1;
		}
	}
	return 0;
}

function sharedMinorCandidates(
	callerVersions: WireVersion[],
	providerVersions: WireVersion[],
) {
	const candidates: Array<{ version: WireVersion }> = [];
	for (const callerVersion of callerVersions) {
		for (const providerVersion of providerVersions) {
			if (
				callerVersion.major !== providerVersion.major ||
				callerVersion.minor !== providerVersion.minor
			) {
				continue;
			}
			candidates.push({
				version:
					compareVersions(callerVersion, providerVersion) <= 0
						? callerVersion
						: providerVersion,
			});
		}
	}
	const byRaw = new Map<string, { version: WireVersion }>();
	for (const candidate of candidates) {
		byRaw.set(candidate.version.raw, candidate);
	}
	return [...byRaw.values()];
}

export function negotiateWireVersion(args: {
	caller: InterfacePin;
	provider: InterfacePin;
	floor: WireVersion;
	componentId: string;
	providerId: string;
}): NegotiatedWire {
	const shared = sharedMinorCandidates(
		args.caller.versions,
		args.provider.versions,
	).sort((left, right) => compareVersions(right.version, left.version));
	const usable = shared.filter(
		(candidate) => compareVersions(candidate.version, args.floor) >= 0,
	);

	if (usable.length > 0) {
		const selected = first(usable).version;
		return Object.freeze({
			interfaceId: args.caller.interfaceId,
			version: selected.raw,
			minor: `${selected.major}.${selected.minor}`,
			stability: args.caller.stability,
			floor: args.floor.raw,
		});
	}

	throw new WireVersionIncompatibleError({
		reason:
			shared.length === 0 ? "no-shared-minor" : "shared-minor-below-floor",
		componentId: args.componentId,
		providerId: args.providerId,
		interfaceId: args.caller.interfaceId,
		floor: args.floor.raw,
		callerVersions: args.caller.versions.map((version) => version.raw),
		providerVersions: args.provider.versions.map((version) => version.raw),
		sharedVersions: shared.map((candidate) => candidate.version.raw),
	});
}
