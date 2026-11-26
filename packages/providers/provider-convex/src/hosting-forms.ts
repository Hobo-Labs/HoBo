/**
 * The three ways HoBo can stand up a Convex backend, as DATA.
 *
 * They are kept structurally distinct on purpose. Conflating them is the
 * failure mode this module exists to prevent:
 *
 * - `convex.local-accountless/v1` is a development deployment that lives and
 *   dies with `npx convex dev`. Putting a tunnel in front of it makes it
 *   *reachable*; it does not make it durable, and it is never a capability
 *   claim.
 * - `convex.selfhosted-oci/v1` is the official container with a persistent
 *   volume (and optionally an external SQL database and S3-compatible object
 *   storage). This is the form a production claim can cite.
 * - `convex.cloud-sponsored-transfer/v1` is a Convex Cloud deployment created
 *   under a named sponsor account and transferred to the user's own team. It
 *   is sponsor-backed, NOT anonymous, and the sponsor's deploy keys are
 *   revoked once the transfer lands.
 *
 * Everything here is deep-frozen data with no behavior and no credential
 * values. Config is referenced by NAME plus a sensitivity marker; the record
 * type has no field that could hold a secret.
 */

import type { VerifiedSourceRef } from "./capability-profile.js";

// public-contract: hosting-form record schema id consumers pin.
export const HOSTING_FORM_SCHEMA = "hobo.provider-hosting-form/v1";

export const CONVEX_HOSTING_FORM_IDS = [
	"convex.local-accountless/v1",
	"convex.selfhosted-oci/v1",
	"convex.cloud-sponsored-transfer/v1",
] as const;

export type ConvexHostingFormId = (typeof CONVEX_HOSTING_FORM_IDS)[number];

/**
 * Config/env inputs by name only. There is deliberately no `value` field:
 * plaintext secrets are unrepresentable in this type.
 */
export interface ConfigRef {
	readonly name: string;
	readonly sensitivity: "non-sensitive" | "secret-ref";
	readonly required: boolean;
	readonly purpose: string;
}

export interface PortSpec {
	readonly name: string;
	readonly port: number;
	readonly surface: "client-api" | "http-actions" | "dashboard";
	readonly public: boolean;
}

export interface HttpProbeSpec {
	readonly kind: "http-get";
	readonly port: number;
	readonly path: string;
	readonly intervalSeconds: number;
	readonly initialDelaySeconds: number;
}

interface HostingFormBase {
	readonly schema: typeof HOSTING_FORM_SCHEMA;
	readonly id: ConvexHostingFormId;
	readonly summary: string;
	/** Whether this form may back a production durability claim. */
	readonly productionDurability: boolean;
	readonly sourceRefs: readonly VerifiedSourceRef[];
}

function deepFreeze<T>(value: T): T {
	if (Array.isArray(value)) {
		for (const child of value) {
			deepFreeze(child);
		}
		Object.freeze(value);
		return value;
	}
	if (
		value === null ||
		value === undefined ||
		Object.prototype.toString.call(value) !== "[object Object]"
	) {
		return value;
	}
	// SAFETY: object-tag values are enumerable property bags at this freeze boundary.
	for (const child of Object.values(value as { [key: string]: T })) {
		deepFreeze(child);
	}
	Object.freeze(value);
	return value;
}

// ---------------------------------------------------------------------------
// Ports (verified 2026-08-08 against the official self-hosted docker-compose)
// ---------------------------------------------------------------------------

/** Client/CLI API. `CONVEX_SELF_HOSTED_URL` points here. */
export const CONVEX_BACKEND_MAIN_PORT = 3210;
/** HTTP actions ("site proxy") — a SECOND public surface, not an alias. */
export const CONVEX_HTTP_ACTIONS_PORT = 3211;
/** Self-hosted dashboard; a separate image, never required by the app. */
export const CONVEX_DASHBOARD_PORT = 6791;

// ---------------------------------------------------------------------------
// Image pins
//
// Resolved 2026-08-08 from the GHCR registry manifest API for the `:latest`
// tag that the official `self-hosted/docker/docker-compose.yml` ships with:
//   GET https://ghcr.io/v2/get-convex/convex-backend/manifests/latest
// `latest` is a MUTABLE tag: these digests are a dated snapshot of what it
// pointed at, which is precisely why a deployment should pin the digest and
// not the tag. Upstream also supports pinning a `:${REV}` release tag; this
// package does not resolve a release-tag digest, so no such constant is
// invented here.
// ---------------------------------------------------------------------------

// public-contract: canonical OCI repository for the backend image.
export const CONVEX_BACKEND_IMAGE_REPOSITORY =
	"ghcr.io/get-convex/convex-backend";
// public-contract: documented tag from which pinned digests were resolved.
export const CONVEX_BACKEND_IMAGE_TAG = "latest";
// public-contract: canonical OCI repository for the dashboard image.
export const CONVEX_DASHBOARD_IMAGE_REPOSITORY =
	"ghcr.io/get-convex/convex-dashboard";

/** UTC date the digests below were resolved from the registry. */
// public-contract: dates the OCI digest evidence snapshot.
export const CONVEX_IMAGE_DIGESTS_VERIFIED_ON = "2026-08-08";

/** OCI image index (multi-arch) digest for convex-backend:latest. */
// public-contract: pinned multi-platform backend image digest.
export const CONVEX_BACKEND_IMAGE_INDEX_DIGEST =
	"sha256:240a2e9115dab3c13145b96532d1cc8bc63c5e2d112d95f80e592a75242bfa75";
// public-contract: pinned amd64 backend image digest.
export const CONVEX_BACKEND_IMAGE_DIGEST_LINUX_AMD64 =
	"sha256:86e2a6d0156159cf3432b9376de1793f0b3d323437544aebfeebba760b51d2c1";
// public-contract: pinned arm64 backend image digest.
export const CONVEX_BACKEND_IMAGE_DIGEST_LINUX_ARM64 =
	"sha256:21ead6e5cf245aa99f8a1ca8d4f0a8025aa9e844284410239cfe8d8d3e33bf7b";
/** Dashboard image index digest (optional component). */
// public-contract: pinned dashboard image digest.
export const CONVEX_DASHBOARD_IMAGE_INDEX_DIGEST =
	"sha256:cd9a57079de2e49dfc786510b70ebf7cc254dda71807176edc4955ccc13915ca";

export const CONVEX_BACKEND_SUPPORTED_ARCHITECTURES = [
	"linux/amd64",
	"linux/arm64",
] as const;

export type ConvexBackendArchitecture =
	(typeof CONVEX_BACKEND_SUPPORTED_ARCHITECTURES)[number];

export interface PlatformDigest {
	readonly platform: ConvexBackendArchitecture;
	readonly digest: string;
}

export interface PinnedImage {
	readonly repository: string;
	readonly tag: string;
	readonly tagIsMutable: boolean;
	readonly indexDigest: string;
	readonly platformDigests: readonly PlatformDigest[];
	readonly digestsVerifiedOn: string;
	readonly digestVerificationMethod: string;
}

// ---------------------------------------------------------------------------
// Form 1 — local, accountless, development only
// ---------------------------------------------------------------------------

/**
 * A tunnel (ngrok, Cloudflare Tunnel, an overlay node) is a Connector: it
 * changes reachability and nothing else. It never upgrades a development
 * deployment into a durable one, and it is never evidence for a claim.
 */
export interface TunnelPolicy {
	readonly classification: "connector";
	readonly isCapabilityClaim: false;
	readonly grantsDurability: false;
	readonly rationale: string;
}

export interface LocalAccountlessHostingForm extends HostingFormBase {
	readonly id: "convex.local-accountless/v1";
	readonly kind: "local-accountless";
	readonly developmentOnly: true;
	/** Explicit, not inferred: this form CANNOT hold production data. */
	readonly noProductionDurability: true;
	readonly productionDurability: false;
	readonly requiresAccount: false;
	readonly stateOwner: "local-process";
	readonly stateLocations: readonly string[];
	readonly lifetime: string;
	readonly publicIngress: "none";
	readonly tunnel: TunnelPolicy;
	readonly authority: {
		readonly kind: "admin-key";
		readonly revocable: false;
		readonly storedAt: string;
		readonly note: string;
	};
}

export const CONVEX_LOCAL_ACCOUNTLESS_FORM: LocalAccountlessHostingForm =
	deepFreeze({
		schema: HOSTING_FORM_SCHEMA,
		id: "convex.local-accountless/v1",
		kind: "local-accountless",
		summary:
			"Anonymous local deployment run as a subprocess of `npx convex dev`; no Convex account, no public URL, state on the developer's disk.",
		developmentOnly: true,
		noProductionDurability: true,
		productionDurability: false,
		requiresAccount: false,
		stateOwner: "local-process",
		stateLocations: [".convex/", "~/.convex/anonymous-convex-backend-state/"],
		lifetime:
			"bound to the `npx convex dev` process; logs are cleared on restart",
		publicIngress: "none",
		tunnel: {
			classification: "connector",
			isCapabilityClaim: false,
			grantsDurability: false,
			rationale:
				"a proxy such as ngrok only makes the loopback listener reachable; the deployment is still a dev deployment that ships full stack traces to connected clients and dies with its parent process",
		},
		authority: {
			kind: "admin-key",
			revocable: false,
			storedAt: "~/.convex/anonymous-convex-backend-state/",
			note: "an admin key is an irrevocable secret baked into the deployment at creation — it cannot be rotated, only replaced along with the deployment (see strong-claim.ts)",
		},
		sourceRefs: [
			{
				url: "https://docs.convex.dev/cli/local-deployments",
				checkedOn: "2026-08-08",
				note: "local backend runs as a subprocess of `npx convex dev`; state in `.convex`; anonymous development; no public URL — 'set up a proxy like ngrok'; not recommended for production",
			},
			{
				url: "https://docs.convex.dev/cli/deploy-key-types",
				checkedOn: "2026-08-08",
				note: "anonymous backend admin key stored in ~/.convex/anonymous-convex-backend-state/; an admin key is an irrevocable secret baked into the deployment",
			},
		],
	} satisfies LocalAccountlessHostingForm);

// ---------------------------------------------------------------------------
// Form 2 — self-hosted OCI
// ---------------------------------------------------------------------------

export interface SelfHostedOciHostingForm extends HostingFormBase {
	readonly id: "convex.selfhosted-oci/v1";
	readonly kind: "selfhosted-oci";
	readonly productionDurability: true;
	readonly image: PinnedImage;
	readonly dashboardImage: {
		readonly repository: string;
		readonly tag: string;
		readonly indexDigest: string;
		readonly required: false;
	};
	readonly architectures: readonly ConvexBackendArchitecture[];
	readonly ports: readonly PortSpec[];
	readonly persistentVolume: {
		readonly required: true;
		readonly containerPath: string;
		readonly rationale: string;
	};
	readonly externalSql: {
		readonly required: false;
		readonly categories: readonly string[];
		readonly configRefs: readonly ConfigRef[];
	};
	readonly objectStorage: {
		readonly required: false;
		readonly category: "s3-compatible";
		readonly bucketRoles: readonly string[];
		readonly configRefs: readonly ConfigRef[];
	};
	readonly configRefs: readonly ConfigRef[];
	readonly probes: {
		readonly readiness: HttpProbeSpec;
		readonly liveness: HttpProbeSpec;
	};
}

const SELF_HOSTED_BASE_CONFIG = [
	{
		name: "CONVEX_CLOUD_ORIGIN",
		sensitivity: "non-sensitive",
		required: true,
		purpose: `public origin clients use for the :${CONVEX_BACKEND_MAIN_PORT} API surface`,
	},
	{
		name: "CONVEX_SITE_ORIGIN",
		sensitivity: "non-sensitive",
		required: true,
		purpose: `public origin for HTTP actions on :${CONVEX_HTTP_ACTIONS_PORT}`,
	},
	{
		name: "INSTANCE_NAME",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "deployment instance name; must stay stable across recreation",
	},
	{
		name: "INSTANCE_SECRET",
		sensitivity: "secret-ref",
		required: false,
		purpose:
			"instance secret the admin key is derived against; brokered reference only, never a literal",
	},
	{
		name: "DISABLE_BEACON",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "opt out of the upstream telemetry beacon",
	},
	{
		name: "REDACT_LOGS_TO_CLIENT",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "stop shipping full stack traces to connected clients",
	},
	{
		name: "DOCUMENT_RETENTION_DELAY",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "document retention window in seconds",
	},
] satisfies readonly ConfigRef[];

const SELF_HOSTED_SQL_CONFIG = [
	{
		name: "POSTGRES_URL",
		sensitivity: "secret-ref",
		required: false,
		purpose: "external Postgres storage engine (brokered reference)",
	},
	{
		name: "MYSQL_URL",
		sensitivity: "secret-ref",
		required: false,
		purpose: "external MySQL storage engine (brokered reference)",
	},
	{
		name: "DATABASE_URL",
		sensitivity: "secret-ref",
		required: false,
		purpose: "generic external database URL (brokered reference)",
	},
	{
		name: "DO_NOT_REQUIRE_SSL",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "relax the SSL requirement to the external database",
	},
] satisfies readonly ConfigRef[];

const SELF_HOSTED_S3_CONFIG = [
	{
		name: "S3_ENDPOINT_URL",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "S3-compatible endpoint (MinIO, R2, Ceph, AWS)",
	},
	{
		name: "AWS_REGION",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "region for the S3-compatible endpoint",
	},
	{
		name: "AWS_ACCESS_KEY_ID",
		sensitivity: "secret-ref",
		required: false,
		purpose: "object-storage access key (brokered reference)",
	},
	{
		name: "AWS_SECRET_ACCESS_KEY",
		sensitivity: "secret-ref",
		required: false,
		purpose: "object-storage secret key (brokered reference)",
	},
	{
		name: "AWS_SESSION_TOKEN",
		sensitivity: "secret-ref",
		required: false,
		purpose: "short-lived object-storage session token (brokered reference)",
	},
	{
		name: "S3_STORAGE_EXPORTS_BUCKET",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "bucket for exports",
	},
	{
		name: "S3_STORAGE_FILES_BUCKET",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "bucket for user file storage",
	},
	{
		name: "S3_STORAGE_MODULES_BUCKET",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "bucket for deployed function modules",
	},
	{
		name: "S3_STORAGE_SEARCH_BUCKET",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "bucket for search index segments",
	},
	{
		name: "S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET",
		sensitivity: "non-sensitive",
		required: false,
		purpose: "bucket for snapshot imports",
	},
] satisfies readonly ConfigRef[];

const CONVEX_VERSION_PROBE = {
	kind: "http-get",
	port: CONVEX_BACKEND_MAIN_PORT,
	path: "/version",
	intervalSeconds: 5,
	initialDelaySeconds: 10,
} satisfies HttpProbeSpec;

export const CONVEX_SELFHOSTED_OCI_FORM: SelfHostedOciHostingForm = deepFreeze({
	schema: HOSTING_FORM_SCHEMA,
	id: "convex.selfhosted-oci/v1",
	kind: "selfhosted-oci",
	summary:
		"Official convex-backend container on infrastructure the operator owns: persistent volume required, external SQL and S3-compatible object storage optional, two public HTTP surfaces.",
	productionDurability: true,
	image: {
		repository: CONVEX_BACKEND_IMAGE_REPOSITORY,
		tag: CONVEX_BACKEND_IMAGE_TAG,
		tagIsMutable: true,
		indexDigest: CONVEX_BACKEND_IMAGE_INDEX_DIGEST,
		platformDigests: [
			{
				platform: "linux/amd64",
				digest: CONVEX_BACKEND_IMAGE_DIGEST_LINUX_AMD64,
			},
			{
				platform: "linux/arm64",
				digest: CONVEX_BACKEND_IMAGE_DIGEST_LINUX_ARM64,
			},
		],
		digestsVerifiedOn: CONVEX_IMAGE_DIGESTS_VERIFIED_ON,
		digestVerificationMethod:
			"GHCR registry manifest API (anonymous pull token) against the :latest tag",
	},
	dashboardImage: {
		repository: CONVEX_DASHBOARD_IMAGE_REPOSITORY,
		tag: "latest",
		indexDigest: CONVEX_DASHBOARD_IMAGE_INDEX_DIGEST,
		required: false,
	},
	architectures: CONVEX_BACKEND_SUPPORTED_ARCHITECTURES,
	ports: [
		{
			name: "backend",
			port: CONVEX_BACKEND_MAIN_PORT,
			surface: "client-api",
			public: true,
		},
		{
			name: "site-proxy",
			port: CONVEX_HTTP_ACTIONS_PORT,
			surface: "http-actions",
			public: true,
		},
		{
			name: "dashboard",
			port: CONVEX_DASHBOARD_PORT,
			surface: "dashboard",
			public: false,
		},
	],
	persistentVolume: {
		required: true,
		containerPath: "/convex/data",
		rationale:
			"with the default SQLite engine every document, module, index, and stored file lives under this path; an ephemeral container filesystem loses the deployment on recreation",
	},
	externalSql: {
		required: false,
		categories: ["postgres", "mysql"],
		configRefs: SELF_HOSTED_SQL_CONFIG,
	},
	objectStorage: {
		required: false,
		category: "s3-compatible",
		bucketRoles: ["exports", "files", "modules", "search", "snapshot-imports"],
		configRefs: SELF_HOSTED_S3_CONFIG,
	},
	configRefs: SELF_HOSTED_BASE_CONFIG,
	probes: {
		readiness: CONVEX_VERSION_PROBE,
		liveness: CONVEX_VERSION_PROBE,
	},
	sourceRefs: [
		{
			url: "https://docs.convex.dev/self-hosting",
			checkedOn: "2026-08-08",
			note: "points at the self-hosting guide in get-convex/convex-backend; the self-hosted backend is the same code as the cloud service",
		},
		{
			url: "https://github.com/get-convex/convex-backend/tree/main/self-hosted",
			checkedOn: "2026-08-08",
			note: "README: backend http://127.0.0.1:3210, HTTP actions http://127.0.0.1:3211, dashboard :6791, SQLite state by default, Docker-managed volume, optional Postgres/MySQL and S3 storage",
		},
		{
			url: "https://github.com/get-convex/convex-backend/blob/main/self-hosted/docker/docker-compose.yml",
			checkedOn: "2026-08-08",
			note: "3210/3211 port mapping, volume data:/convex/data, healthcheck `curl -f http://localhost:3210/version` (interval 5s, start_period 10s), POSTGRES_URL/MYSQL_URL and S3_STORAGE_* env names",
		},
	],
} satisfies SelfHostedOciHostingForm);

// ---------------------------------------------------------------------------
// Form 3 — cloud, sponsor-backed, transferred to the user's team
// ---------------------------------------------------------------------------

export interface DeployKeyKind {
	readonly kind: string;
	readonly scope: string;
	readonly revocable: boolean;
}

export interface CloudSponsoredTransferHostingForm extends HostingFormBase {
	readonly id: "convex.cloud-sponsored-transfer/v1";
	readonly kind: "cloud-sponsored-transfer";
	readonly productionDurability: true;
	/** Explicit: a sponsor account is an identified party, not anonymity. */
	readonly anonymous: false;
	readonly sponsorBacked: true;
	readonly requiresDestinationTeam: true;
	readonly sponsorDeployKeysRevokedAfterTransfer: true;
	readonly transferSteps: readonly string[];
	readonly deployKeyKinds: readonly DeployKeyKind[];
	readonly prohibited: readonly string[];
}

export const CONVEX_CLOUD_SPONSORED_TRANSFER_FORM: CloudSponsoredTransferHostingForm =
	deepFreeze({
		schema: HOSTING_FORM_SCHEMA,
		id: "convex.cloud-sponsored-transfer/v1",
		kind: "cloud-sponsored-transfer",
		summary:
			"A Convex Cloud deployment created under a named sponsor account and handed to the user's own Convex team; the sponsor's deploy keys are revoked once the destination team owns it.",
		productionDurability: true,
		anonymous: false,
		sponsorBacked: true,
		requiresDestinationTeam: true,
		sponsorDeployKeysRevokedAfterTransfer: true,
		transferSteps: [
			"destination Convex team identified and confirmed before any provisioning",
			"sponsor creates the project/deployment under the sponsor account",
			"sponsor mints a deployment-scoped deploy key held by the Yard broker",
			"code, config, and data land on the sponsored deployment",
			"ownership moves to the destination team",
			"sponsor deploy keys deleted (`npx convex deployment token delete`) and the broker grant is withdrawn",
			"post-transfer probe asserts the sponsor key no longer authorizes anything",
		],
		deployKeyKinds: [
			{
				kind: "production deploy key",
				scope: "one production deployment; deploy permission",
				revocable: true,
			},
			{
				kind: "preview deploy key",
				scope: "team + project; creates preview deployments",
				revocable: true,
			},
			{
				kind: "dev deploy key",
				scope: "one development deployment (agent blast-radius limit)",
				revocable: true,
			},
			{
				kind: "project token",
				scope: "whole project, on behalf of the granting user (Convex OAuth)",
				revocable: true,
			},
			{
				kind: "admin key",
				scope:
					"complete control of one deployment, usable without a network round trip; NOT revocable",
				revocable: false,
			},
		],
		prohibited: [
			"presenting this form as anonymous",
			"provisioning before a destination team exists",
			"retaining sponsor deploy keys after transfer",
			"rotating sponsor accounts to reset a free tier (ADR-0129 provider-terms invariants)",
		],
		sourceRefs: [
			{
				url: "https://docs.convex.dev/cli/deploy-key-types",
				checkedOn: "2026-08-08",
				note: "deploy key kinds (prod / preview / dev / project token / admin key), dashboard and `npx convex deployment token create|delete`; admin keys are irrevocable secrets baked into the deployment",
			},
			{
				url: "https://docs.convex.dev/database/backup-restore",
				checkedOn: "2026-08-08",
				note: "cross-deployment restore works between deployments on the same team — which is why the destination team must exist before the transfer",
			},
		],
	} satisfies CloudSponsoredTransferHostingForm);

export type ConvexHostingForm =
	| LocalAccountlessHostingForm
	| SelfHostedOciHostingForm
	| CloudSponsoredTransferHostingForm;

export const CONVEX_HOSTING_FORMS: readonly ConvexHostingForm[] = Object.freeze(
	[
		CONVEX_LOCAL_ACCOUNTLESS_FORM,
		CONVEX_SELFHOSTED_OCI_FORM,
		CONVEX_CLOUD_SPONSORED_TRANSFER_FORM,
	],
);

export function convexHostingFormById(
	id: ConvexHostingFormId,
): ConvexHostingForm {
	const form = CONVEX_HOSTING_FORMS.find((candidate) => candidate.id === id);
	if (!form) {
		throw new Error(`unknown Convex hosting form: ${id}`);
	}
	return form;
}

/** Hosting forms a production durability claim may cite. */
export function productionDurableHostingForms(): readonly ConvexHostingForm[] {
	return CONVEX_HOSTING_FORMS.filter((form) => form.productionDurability);
}

/** Every config name the self-hosted form may ask a Camp/broker to resolve. */
export function selfHostedConfigRefs(): readonly ConfigRef[] {
	return Object.freeze([
		...CONVEX_SELFHOSTED_OCI_FORM.configRefs,
		...CONVEX_SELFHOSTED_OCI_FORM.externalSql.configRefs,
		...CONVEX_SELFHOSTED_OCI_FORM.objectStorage.configRefs,
	]);
}
