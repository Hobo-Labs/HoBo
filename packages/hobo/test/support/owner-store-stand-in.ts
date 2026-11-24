import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SECRET_STORE_BINDING_ENTRY } from "@hobo/secret-store-claim";

import {
	ownerSecretStoreBindingStore,
	type SecretStoreBindingStore,
} from "../../src/ci-secret-store.js";
import type { OwnerStoreEntries } from "../../src/owner-store-session.js";

export const OWNER_STORE_BINDING = path.join(
	"owner-store",
	SECRET_STORE_BINDING_ENTRY,
);

export function ownerStoreEntries(dir: string): OwnerStoreEntries {
	const file = (name: string) => path.join(dir, "owner-store", name);
	return {
		async read(name) {
			return existsSync(file(name))
				? readFileSync(file(name), "utf8")
				: undefined;
		},
		async write(name, value) {
			mkdirSync(path.dirname(file(name)), { recursive: true });
			writeFileSync(file(name), value);
		},
	};
}

export function ownerStoreStandIn(dir: string): SecretStoreBindingStore {
	return ownerSecretStoreBindingStore(ownerStoreEntries(dir));
}

export function keepInOwnerStore(dir: string, text: string): void {
	mkdirSync(path.join(dir, "owner-store"), { recursive: true });
	writeFileSync(path.join(dir, OWNER_STORE_BINDING), text);
}

const LEGACY_RELAY_BINDING = {
	kind: "infisical-cloud-attach",
	endpoint: "https://app.infisical.com",
	projectId: "00000000-0000-0000-0000-000000000001",
	environment: "prod",
	secretPath: "/hobo-ci-relay",
	relayIdentityId: "00000000-0000-0000-0000-000000000002",
	deployIdentityId: "00000000-0000-0000-0000-000000000003",
	vercelTeamId: "team_hobo",
	claimBundleId: "secret-store:hobo-ci-relay:connect-1",
	claimState: "claimed",
};

export function syntheticRelayBinding(
	deployCredential: "legacy" | "deploy-credential" = "deploy-credential",
): string {
	return `${JSON.stringify(
		deployCredential === "legacy"
			? LEGACY_RELAY_BINDING
			: {
					...LEGACY_RELAY_BINDING,
					deployProjectId: "ci-deploy-project",
					deployCredentialIdentityId: "ci-deploy-reader-identity",
					deployOidcSubject:
						"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
				},
		null,
		"\t",
	)}\n`;
}
