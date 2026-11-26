/**
 * The first-party recipe catalog.
 *
 * These are data. A provider package ships more recipes by parsing its own
 * descriptors — nothing here is a switch statement anyone has to edit. Product
 * definition ids are referenced as strings; the adapters that back them live
 * in the provider packages and the catalog that describes them is
 * `@hobo/cloud`'s, not this package's.
 */
import {
	parseSolutionRecipe,
	type SolutionRecipe,
	type SolutionRecipeInput,
} from "./recipe.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CLAIM_CONSENTS = [
	"claim.deadline-understood",
	"claim.ownership-transfer",
] as const;

const claimableWebhookInbox: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.cloudflare.claimable-webhook-inbox/v1",
	displayName: "Claimable webhook inbox",
	description:
		"One Cloudflare Yard, one Camp, one account claim. The KV log rides the same account claim rather than adding a second ownership boundary.",
	yards: [
		{
			yardId: "edge",
			providerId: "cloudflare",
			resourceOnly: false,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "delete",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
	],
	placements: [
		{
			placementId: "inbox",
			yardId: "edge",
			campId: "app",
			primitive: "webhook",
			capabilityRef: "inbox",
			satisfiesProfileId: "webhook.inbound-http/v1",
			productDefinitionId: "cloudflare.temporary-workers-api/v1",
			runtimeModel: "serverless_faas",
			claim: {
				mode: "account-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["revoke-bootstrap-authority", "rotate-binding"],
			},
		},
		{
			placementId: "log",
			yardId: "edge",
			campId: "app",
			primitive: "kv",
			capabilityRef: "log",
			satisfiesProfileId: "kv.key-value/v1",
			productDefinitionId: "cloudflare.temporary-kv/v1",
			claim: {
				mode: "none",
				atomicity: "single-resource",
				actionCount: 0,
				creatorAuthorityAfterClaim: "absent",
			},
		},
	],
	delivers: {
		claimCount: 1,
		claimKind: "provider-native",
		persistence: "persistent",
		realtime: "none",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: [...CLAIM_CONSENTS],
		offerTtlMs: 15 * MINUTE,
	},
};

const claimableIssueTracker: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.vercel-prisma.claimable-issue-tracker/v1",
	displayName: "Claimable issue tracker",
	description:
		"A sponsored Vercel Yard for the app and a resource-only Prisma Yard for the database. No empty Camp is invented to host the managed Postgres. Each provider bundles its own claim, but the deployment spans two of them, so the offer summarises atomicity as a best-effort saga rather than one bundled claim.",
	yards: [
		{
			yardId: "app",
			providerId: "vercel",
			resourceOnly: false,
			sponsored: true,
			lease: {
				bootstrapClass: "sponsor",
				cleanupPolicy: "transfer",
				renewable: false,
				claimByMsFromStart: 2 * DAY,
			},
		},
		{
			yardId: "data",
			providerId: "prisma",
			resourceOnly: true,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "retain-until-provider-expiry",
				renewable: false,
				claimByMsFromStart: 2 * DAY,
			},
		},
	],
	placements: [
		{
			placementId: "web",
			yardId: "app",
			campId: "app",
			primitive: "api",
			capabilityRef: "api",
			satisfiesProfileId: "api.http/v1",
			productDefinitionId: "vercel.sponsored-api/v1",
			runtimeModel: "serverless_faas",
			claim: {
				mode: "project-transfer",
				atomicity: "provider-bundled",
				actionCount: 1,
				deadlineMsFromStart: 2 * DAY,
				creatorAuthorityAfterClaim: "reauthorization-required",
				postClaimActions: ["reauthorize-agent", "rotate-binding"],
			},
		},
		{
			placementId: "db",
			yardId: "data",
			primitive: "data",
			capabilityRef: "db",
			satisfiesProfileId: "data.postgres/v1",
			productDefinitionId: "prisma.claimable-postgres/v1",
			claim: {
				mode: "resource-claim",
				atomicity: "provider-bundled",
				actionCount: 1,
				deadlineMsFromStart: 2 * DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["rotate-binding"],
			},
		},
	],
	edges: [
		{
			edgeId: "web-db",
			fromPlacementId: "web",
			toPlacementId: "db",
			primary: {
				connectivityImplementationId: "vercel.postgres.environment-ref/v1",
				bindingProfileRef: "binding.postgresql/v1",
			},
		},
	],
	delivers: {
		claimCount: 2,
		claimKind: "provider-native",
		persistence: "persistent",
		realtime: "none",
		credentialCustody: "secret-ref",
		bootstrap: "sponsored",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 500,
		sourceDisclosure: "public-source",
		requiredConsents: [...CLAIM_CONSENTS, "sponsor.cost-cap"],
		offerTtlMs: 15 * MINUTE,
	},
};

const portableSqlApi: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.cloudflare-neon.portable-sql-api/v1",
	displayName: "Portable SQL API",
	description:
		"A Cloudflare Worker in front of a resource-only Neon Yard. Hyperdrive is the preferred connectivity implementation with the Neon serverless driver as a tested fallback.",
	yards: [
		{
			yardId: "edge",
			providerId: "cloudflare",
			resourceOnly: false,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "delete",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
		{
			yardId: "data",
			providerId: "neon",
			resourceOnly: true,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "retain-until-provider-expiry",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
	],
	placements: [
		{
			placementId: "api",
			yardId: "edge",
			campId: "app",
			primitive: "api",
			capabilityRef: "api",
			satisfiesProfileId: "api.http/v1",
			productDefinitionId: "cloudflare.temporary-workers-api/v1",
			runtimeModel: "serverless_faas",
			claim: {
				mode: "account-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["revoke-bootstrap-authority", "rotate-binding"],
			},
		},
		{
			placementId: "db",
			yardId: "data",
			primitive: "data",
			capabilityRef: "db",
			satisfiesProfileId: "data.postgres/v1",
			productDefinitionId: "neon.claimable-postgres/v1",
			claim: {
				mode: "resource-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["rotate-binding"],
			},
		},
	],
	edges: [
		{
			edgeId: "api-db",
			fromPlacementId: "api",
			toPlacementId: "db",
			primary: {
				connectivityImplementationId: "cloudflare.postgres.hyperdrive/v1",
				bindingProfileRef: "binding.postgresql/v1",
			},
			fallbacks: [
				{
					connectivityImplementationId:
						"cloudflare.postgres.neon-serverless/v1",
					bindingProfileRef: "binding.neon-serverless/v1",
				},
			],
		},
	],
	delivers: {
		claimCount: 2,
		claimKind: "provider-native",
		persistence: "persistent",
		realtime: "none",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: [...CLAIM_CONSENTS],
		offerTtlMs: 15 * MINUTE,
	},
};

const liveLeaderboard: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.cloudflare-upstash.live-leaderboard/v1",
	displayName: "Live leaderboard",
	description:
		"A Cloudflare Worker with an Upstash Redis leaderboard reached over the REST transport. Client updates are polled, not pushed.",
	yards: [
		{
			yardId: "edge",
			providerId: "cloudflare",
			resourceOnly: false,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "delete",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
		{
			yardId: "cache",
			providerId: "upstash",
			resourceOnly: true,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "retain-until-provider-expiry",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
	],
	placements: [
		{
			placementId: "api",
			yardId: "edge",
			campId: "app",
			primitive: "api",
			capabilityRef: "api",
			satisfiesProfileId: "api.http/v1",
			productDefinitionId: "cloudflare.temporary-workers-api/v1",
			runtimeModel: "serverless_faas",
			claim: {
				mode: "account-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["revoke-bootstrap-authority", "rotate-binding"],
			},
		},
		{
			placementId: "board",
			yardId: "cache",
			primitive: "kv",
			capabilityRef: "board",
			satisfiesProfileId: "kv.redis-compatible/v1",
			productDefinitionId: "upstash.temporary-redis/v1",
			claim: {
				mode: "resource-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["rotate-binding"],
			},
		},
	],
	edges: [
		{
			edgeId: "api-board",
			fromPlacementId: "api",
			toPlacementId: "board",
			primary: {
				connectivityImplementationId: "cloudflare.redis.upstash-rest/v1",
				bindingProfileRef: "binding.redis-rest/v1",
			},
		},
	],
	delivers: {
		claimCount: 2,
		claimKind: "provider-native",
		persistence: "persistent",
		realtime: "polling",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: [...CLAIM_CONSENTS],
		offerTtlMs: 15 * MINUTE,
	},
};

const netlifyGeneratedReport: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.netlify.claimable-generated-report/v1",
	displayName: "Claimable generated report (Netlify)",
	description:
		"A static generated report on Netlify with a one-hour claim deadline. Nothing is stored beyond the published assets.",
	yards: [
		{
			yardId: "site",
			providerId: "netlify",
			resourceOnly: false,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "delete",
				renewable: false,
				claimByMsFromStart: HOUR,
			},
		},
	],
	placements: [
		{
			placementId: "report",
			yardId: "site",
			campId: "web",
			primitive: "web",
			capabilityRef: "site",
			satisfiesProfileId: "web.static/v1",
			productDefinitionId: "netlify.anonymous-static-site/v1",
			// The anonymous Netlify surface publishes static assets; it is not a
			// function runtime, and the product declares `paas` accordingly.
			runtimeModel: "paas",
			claim: {
				mode: "site-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: HOUR,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["revoke-bootstrap-authority"],
			},
		},
	],
	delivers: {
		claimCount: 1,
		claimKind: "provider-native",
		persistence: "ephemeral",
		realtime: "none",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: [...CLAIM_CONSENTS],
		offerTtlMs: 15 * MINUTE,
	},
};

const cloudflareGeneratedReport: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.cloudflare.claimable-generated-report/v1",
	displayName: "Claimable generated report (Cloudflare)",
	description:
		"The same provider-neutral static report resolved onto Cloudflare Pages. Identical semantics, different provider boundary.",
	yards: [
		{
			yardId: "site",
			providerId: "cloudflare",
			resourceOnly: false,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "delete",
				renewable: false,
				claimByMsFromStart: HOUR,
			},
		},
	],
	placements: [
		{
			placementId: "report",
			yardId: "site",
			campId: "web",
			primitive: "web",
			capabilityRef: "site",
			satisfiesProfileId: "web.static/v1",
			productDefinitionId: "cloudflare.temporary-workers-web/v1",
			runtimeModel: "serverless_faas",
			claim: {
				mode: "account-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: HOUR,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["revoke-bootstrap-authority"],
			},
		},
	],
	delivers: {
		claimCount: 1,
		claimKind: "provider-native",
		persistence: "ephemeral",
		realtime: "none",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: [...CLAIM_CONSENTS],
		offerTtlMs: 15 * MINUTE,
	},
};

const sqlSandbox = (
	id: string,
	displayName: string,
	providerId: string,
	productDefinitionId: string,
): SolutionRecipeInput => ({
	schemaVersion: "hobo.solution-recipe/v1",
	id,
	displayName,
	description: `A single resource-only ${providerId} Yard holding one claimable Postgres database. Same provider-neutral requirement as its sibling recipe, different product.`,
	yards: [
		{
			yardId: "data",
			providerId,
			resourceOnly: true,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "retain-until-provider-expiry",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
	],
	placements: [
		{
			placementId: "sandbox",
			yardId: "data",
			primitive: "data",
			capabilityRef: "db",
			satisfiesProfileId: "data.postgres/v1",
			productDefinitionId,
			claim: {
				mode: "resource-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["rotate-binding"],
			},
		},
	],
	delivers: {
		claimCount: 1,
		claimKind: "provider-native",
		persistence: "persistent",
		realtime: "none",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "not-applicable",
		requiredConsents: [...CLAIM_CONSENTS],
		offerTtlMs: 15 * MINUTE,
	},
});

const polyglotSaas: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.cloudflare-neon-upstash.polyglot-saas/v1",
	displayName: "Polyglot SaaS",
	description:
		"Three providers, three claims. Advanced on purpose: it must never outrank a single-provider recipe that already satisfies the request.",
	yards: [
		{
			yardId: "edge",
			providerId: "cloudflare",
			resourceOnly: false,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "delete",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
		{
			yardId: "data",
			providerId: "neon",
			resourceOnly: true,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "retain-until-provider-expiry",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
		{
			yardId: "cache",
			providerId: "upstash",
			resourceOnly: true,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "retain-until-provider-expiry",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
	],
	placements: [
		{
			placementId: "api",
			yardId: "edge",
			campId: "app",
			primitive: "api",
			capabilityRef: "api",
			satisfiesProfileId: "api.http/v1",
			productDefinitionId: "cloudflare.temporary-workers-api/v1",
			runtimeModel: "serverless_faas",
			claim: {
				mode: "account-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["revoke-bootstrap-authority", "rotate-binding"],
			},
		},
		{
			placementId: "db",
			yardId: "data",
			primitive: "data",
			capabilityRef: "db",
			satisfiesProfileId: "data.postgres/v1",
			productDefinitionId: "neon.claimable-postgres/v1",
			claim: {
				mode: "resource-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["rotate-binding"],
			},
		},
		{
			placementId: "board",
			yardId: "cache",
			primitive: "kv",
			capabilityRef: "board",
			satisfiesProfileId: "kv.redis-compatible/v1",
			productDefinitionId: "upstash.temporary-redis/v1",
			claim: {
				mode: "resource-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
				postClaimActions: ["rotate-binding"],
			},
		},
	],
	edges: [
		{
			edgeId: "api-board",
			fromPlacementId: "api",
			toPlacementId: "board",
			primary: {
				connectivityImplementationId: "cloudflare.redis.upstash-rest/v1",
				bindingProfileRef: "binding.redis-rest/v1",
			},
		},
		{
			edgeId: "api-db",
			fromPlacementId: "api",
			toPlacementId: "db",
			primary: {
				connectivityImplementationId: "cloudflare.postgres.hyperdrive/v1",
				bindingProfileRef: "binding.postgresql/v1",
			},
			fallbacks: [
				{
					connectivityImplementationId:
						"cloudflare.postgres.neon-serverless/v1",
					bindingProfileRef: "binding.neon-serverless/v1",
				},
			],
		},
	],
	delivers: {
		claimCount: 3,
		claimKind: "provider-native",
		persistence: "persistent",
		realtime: "polling",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: [...CLAIM_CONSENTS],
		offerTtlMs: 15 * MINUTE,
	},
};

const convexLocalPreview: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.convex.local-accountless-preview/v1",
	displayName: "Convex local accountless preview",
	description:
		"A local Convex backend with no account and therefore no claim. State is ephemeral by construction; nothing survives the preview.",
	yards: [
		{
			yardId: "local",
			providerId: "convex",
			resourceOnly: false,
			sponsored: false,
			lease: {
				bootstrapClass: "local",
				cleanupPolicy: "delete",
				renewable: true,
				claimByMsFromStart: DAY,
			},
		},
	],
	placements: [
		{
			placementId: "backend",
			yardId: "local",
			campId: "app",
			primitive: "data",
			capabilityRef: "backend",
			satisfiesProfileId: "data.convex/v1",
			productDefinitionId: "convex.local-accountless/v1",
			runtimeModel: "oci",
			claim: {
				mode: "none",
				atomicity: "single-resource",
				actionCount: 0,
				creatorAuthorityAfterClaim: "absent",
			},
		},
	],
	delivers: {
		claimCount: 0,
		claimKind: "provider-native",
		persistence: "ephemeral",
		realtime: "websocket",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: [],
		offerTtlMs: 15 * MINUTE,
	},
};

const convexSelfhostedStrongClaim: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.convex.selfhosted-strong-claim/v1",
	displayName: "Convex self-hosted strong claim",
	description:
		"A self-hosted Convex backend handed over by credential exchange. The creator retains no authority afterwards, which is what makes the claim strong.",
	yards: [
		{
			yardId: "self",
			providerId: "convex",
			resourceOnly: false,
			sponsored: false,
			lease: {
				bootstrapClass: "self-hosted-hobo",
				cleanupPolicy: "transfer",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
	],
	placements: [
		{
			placementId: "backend",
			yardId: "self",
			campId: "app",
			primitive: "data",
			capabilityRef: "backend",
			satisfiesProfileId: "data.convex/v1",
			productDefinitionId: "convex.selfhosted-oci/v1",
			runtimeModel: "oci",
			claim: {
				mode: "credential-exchange",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "absent",
				postClaimActions: ["revoke-bootstrap-authority", "rotate-binding"],
			},
		},
	],
	delivers: {
		claimCount: 1,
		claimKind: "provider-native",
		persistence: "persistent",
		realtime: "websocket",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: [...CLAIM_CONSENTS],
		offerTtlMs: 15 * MINUTE,
	},
};

const convexCloudSponsoredTransfer: SolutionRecipeInput = {
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.convex-cloud.sponsored-transfer/v1",
	displayName: "Convex Cloud sponsored transfer",
	description:
		"Convex Cloud provisioned inside a sponsored account and transferred afterwards. The sponsor step is a disclosed migration, never an invisible one.",
	yards: [
		{
			yardId: "cloud",
			providerId: "convex",
			resourceOnly: false,
			sponsored: true,
			lease: {
				bootstrapClass: "sponsor",
				cleanupPolicy: "transfer",
				renewable: false,
				claimByMsFromStart: 3 * DAY,
			},
		},
	],
	placements: [
		{
			placementId: "backend",
			yardId: "cloud",
			campId: "app",
			primitive: "data",
			capabilityRef: "backend",
			satisfiesProfileId: "data.convex/v1",
			productDefinitionId: "convex.cloud-sponsored-transfer/v1",
			runtimeModel: "serverless_faas",
			claim: {
				mode: "project-transfer",
				atomicity: "provider-bundled",
				actionCount: 2,
				deadlineMsFromStart: 3 * DAY,
				creatorAuthorityAfterClaim: "reauthorization-required",
				postClaimActions: ["reauthorize-agent", "rotate-binding"],
			},
		},
	],
	delivers: {
		claimCount: 1,
		claimKind: "sponsor-migration",
		persistence: "persistent",
		realtime: "websocket",
		credentialCustody: "secret-ref",
		bootstrap: "sponsored",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 1000,
		sourceDisclosure: "public-source",
		requiredConsents: [
			...CLAIM_CONSENTS,
			"sponsor.cost-cap",
			"sponsor.migration",
		],
		offerTtlMs: 15 * MINUTE,
	},
};

const SEEDS: readonly SolutionRecipeInput[] = [
	claimableWebhookInbox,
	claimableIssueTracker,
	portableSqlApi,
	liveLeaderboard,
	netlifyGeneratedReport,
	cloudflareGeneratedReport,
	sqlSandbox(
		"recipe.neon.claimable-sql-sandbox/v1",
		"Claimable SQL sandbox (Neon)",
		"neon",
		"neon.claimable-postgres/v1",
	),
	sqlSandbox(
		"recipe.prisma.claimable-sql-sandbox/v1",
		"Claimable SQL sandbox (Prisma)",
		"prisma",
		"prisma.claimable-postgres/v1",
	),
	polyglotSaas,
	convexLocalPreview,
	convexSelfhostedStrongClaim,
	convexCloudSponsoredTransfer,
];

export const STANDARD_SOLUTION_RECIPE_INPUTS: readonly SolutionRecipeInput[] =
	SEEDS;

/** The parsed first-party recipes, ordered by id. */
export const STANDARD_SOLUTION_RECIPES: readonly SolutionRecipe[] = SEEDS.map(
	parseSolutionRecipe,
).sort((a, b) => a.id.localeCompare(b.id));

export function findStandardRecipe(id: string): SolutionRecipe | undefined {
	return STANDARD_SOLUTION_RECIPES.find((recipe) => recipe.id === id);
}
