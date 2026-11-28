import * as Schema from "effect/Schema";

export const WorkspaceAuthId = Schema.NonEmptyString.pipe(
	Schema.brand("WorkspaceAuthId"),
);
export type WorkspaceAuthId = typeof WorkspaceAuthId.Type;

export const AuthSessionId = Schema.NonEmptyString.pipe(
	Schema.brand("AuthSessionId"),
);
export type AuthSessionId = typeof AuthSessionId.Type;

export const PrincipalId = Schema.NonEmptyString.pipe(
	Schema.brand("PrincipalId"),
);
export type PrincipalId = typeof PrincipalId.Type;

export const AlchemyProfileName = Schema.NonEmptyString.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
).pipe(Schema.brand("AlchemyProfileName"));
export type AlchemyProfileName = typeof AlchemyProfileName.Type;

export const AlchemyStageName = Schema.NonEmptyString.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
).pipe(Schema.brand("AlchemyStageName"));
export type AlchemyStageName = typeof AlchemyStageName.Type;

export const BoxId = Schema.NonEmptyString.check(
	Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u),
).pipe(Schema.brand("BoxId"));
export type BoxId = typeof BoxId.Type;

export const IssuerOrigin = Schema.NonEmptyString.check(
	Schema.isPattern(/^https?:\/\/[^\s/$.?#].[^\s]*$/u),
).pipe(Schema.brand("IssuerOrigin"));
export type IssuerOrigin = typeof IssuerOrigin.Type;

export const AuthBasePath = Schema.NonEmptyString.check(
	Schema.isPattern(/^\/[a-zA-Z0-9/_-]*$/u),
).pipe(Schema.brand("AuthBasePath"));
export type AuthBasePath = typeof AuthBasePath.Type;

export const OwnerKeyLocator = Schema.NonEmptyString.check(
	Schema.isPattern(/^owner:\/\/[A-Z][A-Z0-9_]{1,127}$/u),
).pipe(Schema.brand("OwnerKeyLocator"));
export type OwnerKeyLocator = typeof OwnerKeyLocator.Type;

export const VaultProviderKind = Schema.Literals([
	"owner-store",
	"infisical",
	"doppler",
]);
export type VaultProviderKind = typeof VaultProviderKind.Type;

export const BetterAuthStorageKind = Schema.Literals([
	"sqlite-local",
	"sqlite-shared",
	"secondary-sqlite",
	"rivet-actor",
]);
export type BetterAuthStorageKind = typeof BetterAuthStorageKind.Type;

export const SessionHandleDigest = Schema.NonEmptyString.check(
	Schema.isPattern(/^sha256:[a-f0-9]{16,64}$/u),
).pipe(Schema.brand("SessionHandleDigest"));
export type SessionHandleDigest = typeof SessionHandleDigest.Type;

export const SigningKeyFingerprint = Schema.NonEmptyString.check(
	Schema.isPattern(/^sha256:[a-f0-9]{16,64}$/u),
).pipe(Schema.brand("SigningKeyFingerprint"));
export type SigningKeyFingerprint = typeof SigningKeyFingerprint.Type;

export const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
	Schema.brand("EpochMs"),
);
export type EpochMs = typeof EpochMs.Type;

export const TtlSeconds = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(60),
	Schema.isLessThanOrEqualTo(31_536_000),
).pipe(Schema.brand("TtlSeconds"));
export type TtlSeconds = typeof TtlSeconds.Type;

export const NonEmptyReason = Schema.NonEmptyString.pipe(
	Schema.brand("NonEmptyReason"),
);
export type NonEmptyReason = typeof NonEmptyReason.Type;

export const UniqueBoxList = Schema.Array(BoxId)
	.check(
		Schema.isMinLength(1),
		Schema.makeFilter((boxes) => new Set(boxes).size === boxes.length, {
			identifier: "UniqueBoxList",
			description: "non-empty list of unique BoxIds",
		}),
	)
	.pipe(Schema.brand("UniqueBoxList"));
export type UniqueBoxList = typeof UniqueBoxList.Type;
