import {
	type CdEngineRegistry,
	createCdEngineRegistry,
	gitopsPublisherRegistration,
	type CdEngineRegistration,
} from "@hobo/cd/compose";
import type { PublisherPort } from "@hobo/cd";
import type { PublisherRegistry } from "./publisher.js";

export function cdEngineRegistrations(
	publishers: readonly Readonly<{ name: string; port: PublisherPort }>[],
): readonly CdEngineRegistration[] {
	return publishers.map((p) => gitopsPublisherRegistration(p.name, p.port));
}

export function createCdEngineRegistryFromGitops(
	publishers: readonly Readonly<{ name: string; port: PublisherPort }>[],
): CdEngineRegistry {
	return createCdEngineRegistry(cdEngineRegistrations(publishers));
}

export function mergePublisherRegistryIntoCdEngines(
	registry: PublisherRegistry,
): CdEngineRegistry {
	const names = registry.names();
	const registrations: CdEngineRegistration[] = [];
	for (const name of names) {
		const resolved = registry.get(name);
		if (!resolved.ok) continue;
		registrations.push(gitopsPublisherRegistration(name, resolved.value));
	}
	return createCdEngineRegistry(registrations);
}