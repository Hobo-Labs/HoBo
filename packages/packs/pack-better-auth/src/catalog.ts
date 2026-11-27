// public-contract: stable pack identifier for selection and manifests.
export const BETTER_AUTH_PACK_ID = "pack.better-auth/v1" as const;

// public-contract: stable catalog definition identifier.
export const BETTER_AUTH_PACK_DEFINITION_ID =
	"hobo.pack.better-auth/v1" as const;

// public-contract: auth capability port this pack satisfies.
export const BETTER_AUTH_AUTH_PORT = "hobo:auth" as const;

// public-contract: issuer adapter id wired by this pack.
export const BETTER_AUTH_IMPL_ADAPTER_ID = "better-auth" as const;
