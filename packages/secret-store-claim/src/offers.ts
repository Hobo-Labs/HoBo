/**
 * The offers that can satisfy `secrets.config-service/v1`, in the order HoBo
 * policy prefers them (ADR-0179 amendment "Secret store chosen at deploy,
 * provisioned by claim"). Facts carry a source and the day they were read;
 * they are ranking and planning input, never billing input.
 *
 * Preference, and why:
 *
 * 1. `auth-md` — any store whose protected-resource metadata advertises
 *    anonymous agent registration. The agent registers, the owner approves
 *    through the store's own claim page. Generic: discovery picks up a secret
 *    manager the day it publishes auth.md. On 2026-11-12 none of Infisical,
 *    Doppler, 1Password, Bitwarden or Akeyless did.
 * 2. `cloudflare-temporary` — a Cloudflare temporary account, optionally
 *    holding HoBo's config-service Worker: agent-created, claimed by the
 *    owner through Cloudflare's claim URL within 60 minutes. An experiment
 *    that proves the claim link (ADR-0179 amendment): its runtime binding
 *    stays "designed", so routing passes it over unless named.
 * 3. `infisical-self-hosted` — open-source Infisical on the owner's compute
 *    fleet, bootstrapped by HoBo, handed over through a HoBo sealed claim.
 * 4. `infisical-cloud-attach` — an Infisical Cloud organization the owner
 *    already has: attach-only, because Infisical Cloud offers no agent or
 *    delegated way to create an organization or a machine identity.
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
] as const;
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
	const ok =
		claimMechanism !== undefined &&
		runtimeBinding !== undefined &&
		record.preference >= 1 &&
		record.preference <= 16 &&
		record.claimWindowMinutes <= 10_080 &&
		(claimMechanism !== "provider-claim-url" ||
			record.claimWindowMinutes > 0) &&
		/^.{1,400}$/u.test(record.cost) &&
		/^.{1,400}$/u.test(record.availability) &&
		/^https:\/\/[A-Za-z0-9.-]+\//u.test(record.sourceUrl) &&
		/^\d{4}-\d{2}-\d{2}$/u.test(record.checkedAt);
	if (!ok || claimMechanism === undefined || runtimeBinding === undefined)
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
				kind: "auth-md",
				preference: 1,
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
				preference: 2,
				claimMechanism: "provider-claim-url",
				claimWindowMinutes: 60,
				runtimeBinding: "designed",
				cost: "No charge on the temporary account; after the claim, the owner's Cloudflare plan (Workers, KV and Durable Objects free allowances).",
				availability:
					"An experiment, opt-in only (--offer cloudflare-temporary): proves HoBo can obtain a valid claim link, not the relay's store. Account creation is rate-limited; an account not claimed within 60 minutes is deleted with everything in it.",
				sourceUrl:
					"https://developers.cloudflare.com/workers/platform/claim-deployments/",
				checkedAt: READ,
			},
			{
				kind: "infisical-self-hosted",
				preference: 3,
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
				kind: "infisical-cloud-attach",
				preference: 4,
				claimMechanism: "owner-sign-in",
				claimWindowMinutes: 0,
				runtimeBinding: "built",
				cost: "Infisical Cloud's free plan; limits checked when the organization is used.",
				availability:
					"Attach-only: the owner signs in once with the Infisical CLI; Infisical Cloud offers no agent or delegated way to create an organization or a machine identity.",
				sourceUrl: "https://app.infisical.com/api/docs/json",
				checkedAt: READ,
			},
		].map((fields) =>
			parseSecretStoreOffer(create(SecretStoreOfferSchema, fields)),
		),
	);
