import type { OpenedSecretStore } from "./secret-stores.js";

export class ClaimStoreUnavailableError extends Error {
	constructor() {
		super(
			"A durable, owner-scoped store with verified atomic creation or an existing complete journal fleet is required.",
		);
		this.name = "ClaimStoreUnavailableError";
	}
}

export function supportsAtomicOwnerClaim(
	store: OpenedSecretStore,
	allowFixture = false,
): boolean {
	return (
		store.port.createOnly !== undefined &&
		(store.port.kind !== "memory-fixture" || allowFixture)
	);
}

export class OwnerStoreOperationUncertainError extends Error {
	constructor() {
		super(
			"A store operation has an uncertain outcome; reconcile it before retrying.",
		);
		this.name = "OwnerStoreOperationUncertainError";
	}
}
