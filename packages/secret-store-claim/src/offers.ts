/**
 * The offers that can satisfy `secrets.config-service/v1`, in the order HoBo
 * policy prefers them (ADR-0179 amendment "Secret store chosen at deploy,
 * provisioned by claim"). Facts carry a source and the day they were read;
 * they are ranking and planning input, never billing input.
 *
 * Preference, and why (the owner's direction, 2026-11-12: Infisical with
 * OIDC Auth is the default):
 *
 * 1. `infisical-cloud-attach` — an Infisical Cloud organization the owner
 *    signs up for in the web app; the relay and CI sign in with OIDC Auth
 *    (Vercel and GitHub Actions tokens), so no credential is stored anywhere.
 *    Infisical Cloud offers no agent or delegated way to create an
 *    organization or a machine identity, so the owner creates them in the
 *    dashboard (the `hobo-deploy` skill walks it) and `hobo ci secret-store
 *    connect` records the ids.
 * 2. `infisical-self-hosted` — open-source Infisical on the owner's compute
 *    fleet, bootstrapped by HoBo, handed over through a HoBo sealed claim.
 *    Not the default: the host's availability becomes the relay's.
 * 3. `auth-md` — any store whose protected-resource metadata advertises
 *    anonymous agent registration. On 2026-11-12 none of Infisical, Doppler,
 *    1Password, Bitwarden or Akeyless did.
 * 4. `cloudflare-temporary` — HoBo's config-service Worker on a Cloudflare
 *    temporary account: an experiment, not the relay's store.
 * 5. `1password-attach` and 6. `bitwarden-attach` — the owner's existing
 *    1Password or Bitwarden Secrets Manager account (ADR-0179 amendment
 *    "Secrets manager, not Infisical"). Both are `stored-token` for a
 *    workload (checked 2026-11-12: 1Password service-account tokens, its
 *    workload-identity preview still has the workflow hold an integration
 *    key and does not list Vercel; Bitwarden machine-account access tokens,
 *    no OIDC federation documented), so routing passes over them for the
 *    relay's runtime reads; they serve the owner's side.
 *
 * Secretless first: every offer says how a workload signs in
 * (`runtimeAuth`), and `selectSecretStore` never routes the relay to a
 * `stored-token` offer, `--allow-designed` or not.
 */
import { create } from "@bufbuild/protobuf";
import {
	type SecretStoreOffer,
	SecretStoreOfferSchema,
} from "./_generated/secret_store_claim_pb.js";
import { secretStoreError } from "./errors.js";

// public-contract: the capability id a deploy routes; the Yard's config-service row names it.
export const SECRET_STORE_CAPABILITY = "secrets.config-service/v1";

export const SECRET_STORE_KINDS = [
	"auth-md",
	"cloudflare-temporary",
	"infisical-self-hosted",
	"infisical-cloud-attach",
	"1password-attach",
	"bitwarden-attach",
] as const;

/** The secrets managers behind the offers. */
export const SECRET_STORE_PROVIDERS = [
	"auth-md",
	"cloudflare",
	"infisical",
	"1password",
	"bitwarden",
] as const;
export type SecretStoreProvider = (typeof SECRET_STORE_PROVIDERS)[number];

/** How a workload signs in to the store; routing is secretless first. */
export const RUNTIME_AUTH = ["workload-identity", "stored-token"] as const;
export type RuntimeAuth = (typeof RUNTIME_AUTH)[number];
export type SecretStoreKind = (typeof SECRET_STORE_KINDS)[number];

export const CLAIM_MECHANISMS = [
	"auth-md-claim",
	"provider-claim-url",
	"hobo-sealed-claim",
	"owner-sign-in",
] as const;
export type ClaimMechanism = (typeof CLAIM_MECHANISMS)[number];

/** An offer that passed its parser: the only shape selection accepts. */
export type ParsedSecretStoreOffer = Readonly<{
	kind: SecretStoreKind;
	preference: number;
	claimMechanism: ClaimMechanism;
	claimWindowMinutes: number;
	runtimeBinding: "built" | "designed";
	provider: SecretStoreProvider;
	runtimeAuth: RuntimeAuth;
	cost: string;
	availability: string;
	sourceUrl: string;
	checkedAt: string;
	record: SecretStoreOffer;
}>;

function oneOf<T extends string>(
	values: readonly T[],
	value: string,
): T | undefined {
	return values.find((candidate) => candidate === value);
}

export function parseSecretStoreKind(value: string): SecretStoreKind {
	return (
		oneOf(SECRET_STORE_KINDS, value) ??
		secretStoreError(
			"SECRET_STORE_INVALID",
			"not a secret store kind HoBo routes",
		)
	);
}

/** Parse, don't validate: the CUE constraints of `#SecretStoreOffer`. */
export function parseSecretStoreOffer(
	record: SecretStoreOffer,
): ParsedSecretStoreOffer {
	const kind = parseSecretStoreKind(record.kind);
	const claimMechanism = oneOf(CLAIM_MECHANISMS, record.claimMechanism);
	const runtimeBinding = oneOf(["built", "designed"], record.runtimeBinding);
	const provider = oneOf(SECRET_STORE_PROVIDERS, record.provider);
	const runtimeAuth = oneOf(RUNTIME_AUTH, record.runtimeAuth);
	const ok =
		claimMechanism !== undefined &&
		runtimeBinding !== undefined &&
		provider !== undefined &&
		runtimeAuth !== undefined &&
		record.preference >= 1 &&
		record.preference <= 16 &&
		record.claimWindowMinutes <= 10_080 &&
		(claimMechanism !== "provider-claim-url" ||
			record.claimWindowMinutes > 0) &&
		/^.{1,400}$/u.test(record.cost) &&
		/^.{1,400}$/u.test(record.availability) &&
		/^https:\/\/[A-Za-z0-9.-]+\//u.test(record.sourceUrl) &&
		/^\d{4}-\d{2}-\d{2}$/u.test(record.checkedAt);
	if (
		!ok ||
		claimMechanism === undefined ||
		runtimeBinding === undefined ||
		provider === undefined ||
		runtimeAuth === undefined
	)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			`the ${kind} offer does not meet its constraints`,
		);
	return Object.freeze({
		kind,
		preference: record.preference,
		claimMechanism,
		claimWindowMinutes: record.claimWindowMinutes,
		runtimeBinding,
		provider,
		runtimeAuth,
		cost: record.cost,
		availability: record.availability,
		sourceUrl: record.sourceUrl,
		checkedAt: record.checkedAt,
		record,
	});
}

const READ = "2026-11-12";

/**
 * HoBo's default offers. `runtimeBinding` is the honest gate: the relay's
 * config loader reads Infisical today; the config-service Worker and an
 * auth.md store's workload federation are designed, not built.
 */
export const DEFAULT_SECRET_STORE_OFFERS: readonly ParsedSecretStoreOffer[] =
	Object.freeze(
		[
			{
				kind: "infisical-cloud-attach",
				provider: "infisical",
				runtimeAuth: "workload-identity",
				preference: 1,
				claimMechanism: "owner-sign-in",
				claimWindowMinutes: 0,
				runtimeBinding: "built",
				cost: "Infisical Cloud's free plan; limits checked when the organization is used.",
				availability:
					"Attach-only: the owner signs in once with the Infisical CLI; Infisical Cloud offers no agent or delegated way to create an organization or a machine identity.",
				sourceUrl: "https://app.infisical.com/api/docs/json",
				checkedAt: READ,
			},
			{
				kind: "infisical-self-hosted",
				provider: "infisical",
				runtimeAuth: "workload-identity",
				preference: 2,
				claimMechanism: "hobo-sealed-claim",
				claimWindowMinutes: 0,
				runtimeBinding: "built",
				cost: "No vendor fee (open source); Infisical, PostgreSQL and Redis run on the owner's compute fleet hosts, whose cost is the owner's.",
				availability:
					"The relay reads config only while that host runs: the host's availability becomes the relay's.",
				sourceUrl:
					"https://infisical.com/docs/self-hosting/guides/automated-bootstrapping",
				checkedAt: READ,
			},
			{
				kind: "auth-md",
				provider: "auth-md",
				runtimeAuth: "workload-identity",
				preference: 3,
				claimMechanism: "auth-md-claim",
				claimWindowMinutes: 0,
				runtimeBinding: "designed",
				cost: "Whatever the discovered store charges; read from its offer at deploy time.",
				availability:
					"Any store whose protected-resource metadata advertises anonymous agent registration. No secret manager checked on 2026-11-12 publishes auth.md.",
				sourceUrl: "https://workos.com/auth-md/docs/flows/anonymous",
				checkedAt: READ,
			},
			{
				kind: "cloudflare-temporary",
				provider: "cloudflare",
				runtimeAuth: "workload-identity",
				preference: 4,
				claimMechanism: "provider-claim-url",
				claimWindowMinutes: 60,
				runtimeBinding: "designed",
				cost: "No charge on the temporary account; after the claim, the owner's Cloudflare plan (Workers, KV and Durable Objects free allowances).",
				availability:
					"Account creation is rate-limited; an account not claimed within 60 minutes is deleted with everything in it. Secret bindings are not listed as supported on temporary accounts.",
				sourceUrl:
					"https://developers.cloudflare.com/workers/platform/claim-deployments/",
				checkedAt: READ,
			},
			{
				kind: "1password-attach",
				provider: "1password",
				runtimeAuth: "stored-token",
				preference: 5,
				claimMechanism: "owner-sign-in",
				claimWindowMinutes: 0,
				runtimeBinding: "designed",
				cost: "The owner's 1Password plan; workload identity (preview) needs 1Password Business.",
				availability:
					"A workload signs in with a service-account token; the workload-identity preview federates GitHub Actions and custom OIDC but still needs a stored integration key, and does not list Vercel. Owner side only.",
				sourceUrl: "https://www.1password.dev/brokered-access",
				checkedAt: READ,
			},
			{
				kind: "bitwarden-attach",
				provider: "bitwarden",
				runtimeAuth: "stored-token",
				preference: 6,
				claimMechanism: "owner-sign-in",
				claimWindowMinutes: 0,
				runtimeBinding: "designed",
				cost: "The owner's Bitwarden Secrets Manager plan.",
				availability:
					"Machine accounts sign in with an access token (no expiry by default); no OIDC federation is documented. Owner side only.",
				sourceUrl: "https://bitwarden.com/help/access-tokens/",
				checkedAt: READ,
			},
		].map((fields) =>
			parseSecretStoreOffer(create(SecretStoreOfferSchema, fields)),
		),
	);
