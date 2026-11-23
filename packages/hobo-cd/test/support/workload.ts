import { createTrustedVault, type TrustedVault } from "@hobo/core";

import type { CdWorkloadDeps } from "../../src/index.js";

export function handedOverInfisicalToken(): TrustedVault {
	const vault = createTrustedVault();
	vault.put("INFISICAL_TOKEN", "fixture-handed-over-token");
	return vault;
}

export function fakeWorkload(): CdWorkloadDeps {
	return {
		teamSlug: async () => "acme",
		enableProjectOidc: async () => "absent",
		admin: () => ({
			createProject: async () => ({ projectId: "unused" }),
			createFolder: async () => ({ folderId: "unused" }),
			createProjectIdentity: async () => ({
				identityId: "00000000-0000-4000-8000-000000000001",
			}),
			attachOidcAuth: async () => {},
			updateOidcAuth: async () => {},
			deleteIdentity: async () => {},
			probeToken: async () => "valid",
		}),
	};
}
