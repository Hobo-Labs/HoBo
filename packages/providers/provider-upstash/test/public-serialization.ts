import { createClaimableOperationKeyDeriver } from "@hobo/core";
import type { SecretCustodyPort } from "../src/custody.js";
import type { PublicSerializationOptions } from "../src/receipt.js";
import { createStubCustody } from "./fixtures/index.js";

export function publicOptions(
	custody: SecretCustodyPort = createStubCustody(),
): PublicSerializationOptions {
	return {
		custody,
		deriveOperationKey: createClaimableOperationKeyDeriver(
			Uint8Array.from({ length: 32 }, (_, index) => index + 1),
		),
		scope: {
			tenantId: "serializer-tests",
			providerAccountId: "anonymous",
			scopeId: "deployment-v2",
		},
	};
}
