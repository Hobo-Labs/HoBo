import type { Outcome, PublisherPort, Refusal } from "../ports.js";
import { composeReason } from "./errors.js";

export const CD_ENGINE_KIND = Object.freeze({
	GITOPS_PUBLISHER: "gitops-publisher",
} as const);

export type CdEngineKind = (typeof CD_ENGINE_KIND)[keyof typeof CD_ENGINE_KIND];

export const LEGACY_PUBLISHER_TARGET: ReadonlyMap<string, string> = new Map([
	["argo", "argo-cd"],
]);

export type CdEngineRegistration = Readonly<{
	name: string;
	kind: CdEngineKind;
	publisher: PublisherPort;
}>;

export type CdEngineRecord = Readonly<{
	name: string;
	kind: CdEngineKind;
	publisher: PublisherPort;
	target: string;
}>;

export interface CdEngineRegistry {
	get(name: string): Outcome<CdEngineRecord>;
	publisher(name: string): Outcome<PublisherPort>;
	names(): readonly string[];
	kind(name: string): CdEngineKind | undefined;
}

function resolveTargetName(name: string): string {
	return LEGACY_PUBLISHER_TARGET.get(name) ?? name;
}

function engineUnknown(name: string, resolved: string): Refusal {
	return {
		ok: false,
		reasons: [
			composeReason(
				"compose-engine-unknown",
				`no CD engine registered as ${name}${resolved === name ? "" : ` (resolved from legacy alias to ${resolved})`}`,
				name,
			),
		],
	};
}

export function createCdEngineRegistry(
	registrations: readonly CdEngineRegistration[],
): CdEngineRegistry {
	const byName = new Map<string, CdEngineRecord>();
	for (const entry of registrations) {
		const target = entry.publisher.target;
		const record: CdEngineRecord = Object.freeze({
			name: entry.name,
			kind: entry.kind,
			publisher: entry.publisher,
			target,
		});
		byName.set(entry.name, record);
	}
	return Object.freeze({
		get(name: string): Outcome<CdEngineRecord> {
			const resolved = resolveTargetName(name);
			const record = byName.get(resolved);
			if (record) return { ok: true as const, value: record };
			return engineUnknown(name, resolved);
		},
		publisher(name: string): Outcome<PublisherPort> {
			const resolved = resolveTargetName(name);
			const record = byName.get(resolved);
			if (record) return { ok: true as const, value: record.publisher };
			return engineUnknown(name, resolved);
		},
		names() {
			return [...byName.keys()].sort();
		},
		kind(name: string) {
			return byName.get(resolveTargetName(name))?.kind;
		},
	});
}

export function gitopsPublisherRegistration(
	name: string,
	port: PublisherPort,
): CdEngineRegistration {
	return Object.freeze({
		name,
		kind: CD_ENGINE_KIND.GITOPS_PUBLISHER,
		publisher: port,
	});
}

export function registrationsFromPublisherPorts(
	entries: readonly Readonly<{ name: string; port: PublisherPort }>[],
): readonly CdEngineRegistration[] {
	return entries.map((e) => gitopsPublisherRegistration(e.name, e.port));
}
