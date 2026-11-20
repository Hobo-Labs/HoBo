import { describe, expect, it } from "vitest";

import { credentialLine } from "../../src/hand-off-store.js";
import {
	storeChoiceGuidance,
	storeSignInGuidance,
} from "../../src/owner-store.js";
import type { SecretStoreId } from "../../src/secret-stores.js";

// SPEC: the owner's requirements for connecting a secret store, as tests.
// Implementation works against this file; a requirement that is not met yet
// fails here rather than being discovered in a live run.
//
// R1  Nothing the ceremony shows the owner asks them to provision by hand:
//     no creating identities, tokens, client secrets, OAuth applications,
//     service accounts or Connect servers in a dashboard. The run creates
//     them through the provider's API, SDK or CLI.
// R2  Nothing asks the owner to set environment variables or open a
//     terminal; the ceremony collects what it needs itself.

const STORES: readonly SecretStoreId[] = [
	"infisical",
	"1password",
	"bitwarden",
];

/** Hand-provisioning instructions, in any of the providers' own words. */
const MANUAL_PROVISIONING =
	/\b(create|issue|generate|add)\b[^.]{0,80}\b(identity|identities|token|client secret|oauth app|application|service account|connect server|machine account)\b/iu;
const ENV_OR_TERMINAL =
	/\b(environment variables?|environment's settings|in a terminal|your terminal|export [A-Z_]+=)/iu;

/** Every line a handed-off run can show the owner for one store. */
function ownerFacingText(store: SecretStoreId): string[] {
	const owner = { id: store, egressCredentialHost: undefined };
	return [
		...storeChoiceGuidance(),
		...storeSignInGuidance(store, "cd"),
		...(store === "bitwarden"
			? []
			: [credentialLine(owner, "cd", 15 * 60_000)]),
	];
}

describe("SPEC R1: no manual provisioning", () => {
	for (const store of STORES)
		it(`${store}: the owner is never told to create an identity, token, app or service account`, () => {
			const offending = ownerFacingText(store).filter((line) =>
				MANUAL_PROVISIONING.test(line),
			);
			expect(offending).toEqual([]);
		});
});

describe("SPEC R2: no environment variables, no terminal", () => {
	for (const store of STORES)
		it(`${store}: the owner is never asked to set env vars or use a terminal`, () => {
			const offending = ownerFacingText(store).filter((line) =>
				ENV_OR_TERMINAL.test(line),
			);
			expect(offending).toEqual([]);
		});
});
