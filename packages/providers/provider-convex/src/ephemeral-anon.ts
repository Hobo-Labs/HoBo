/**
 * Anonymous Temporary self-host for official Convex backend OCI/binary.
 *
 * Constraint: Examples Temporary must use **zero project API keys**
 * (no E2B_API_KEY, INSTANODE_TOKEN, permanent CF tokens, OPENPOUCH_API_KEY).
 *
 * Live probe matrix — all rejected for that constraint:
 * - Cloudflare Temporary Containers → apply 403 (Workers Paid / unsupported)
 * - Instanode → vendor: no anonymous container deployments
 * - OpenPouch anon → works for small Node; cgroup memory.max=256MiB;
 *   official `convex-local-backend` ~205MB uncompressed → extract/OOM kill
 * - ttl.sh → registry only (does not run)
 * - E2B / SnapDeploy / APPISH → credentials or login required
 * - Clawdship → OpenPouch-class competitor (zero signup, Docker); try via
 *   `HOBO_CONVEX_OCI_HOST=clawdship` (site adapter) — not yet matrix-proven for Convex RAM
 * - ZeroDeploy / SSHGrid → static-only (not OCI runners)
 *
 * Mock path returns a Temporary-shaped URL for CI/Examples console.
 * Live path fails closed with this matrix (no credential fallback).
 *
 * The rejection matrix below is unchanged and stays fail-closed. What is new
 * is that the failure now names the three real hosting forms
 * (`src/hosting-forms.ts`) instead of leaving the caller with nothing: a
 * local accountless dev deployment, a self-hosted OCI backend, or a
 * sponsor-backed cloud deployment transferred to the user's own team. None of
 * them is "anonymous Temporary", which is exactly why none of them weakens
 * the matrix.
 */
import { randomBytes } from "node:crypto";

import {
	CONVEX_BACKEND_IMAGE_REPOSITORY,
	CONVEX_BACKEND_IMAGE_TAG,
	CONVEX_BACKEND_MAIN_PORT,
	CONVEX_CLOUD_SPONSORED_TRANSFER_FORM,
	CONVEX_LOCAL_ACCOUNTLESS_FORM,
	CONVEX_SELFHOSTED_OCI_FORM,
	type ConvexHostingFormId,
} from "./hosting-forms.js";

// public-contract: digest-pinned backend image disclosed in deployment plans.
export const CONVEX_BACKEND_OCI_IMAGE =
	`${CONVEX_BACKEND_IMAGE_REPOSITORY}:${CONVEX_BACKEND_IMAGE_TAG}` as const;

export const CONVEX_API_PORT = CONVEX_BACKEND_MAIN_PORT;

export const CONVEX_LOCAL_BACKEND_LINUX_X64_ZIP_BYTES = 62_065_779;
export const CONVEX_LOCAL_BACKEND_LINUX_X64_BIN_BYTES = 204_967_064;
export const OPENPOUCH_ANON_MEMORY_MAX_BYTES = 268_435_456;

export type AnonBackendRejection = {
	readonly host: string;
	readonly verdict: "rejected";
	readonly reason: string;
};

/** Runtime-proven rejections for zero-key Temporary Convex self-host. */
export const ANON_CONVEX_BACKEND_REJECTIONS: readonly AnonBackendRejection[] = [
	{
		host: "cloudflare-temporary-containers",
		verdict: "rejected",
		reason: "Containers apply returns 403 on Temporary Accounts",
	},
	{
		host: "instanode",
		verdict: "rejected",
		reason: "Vendor confirmed: no anonymous container deployments",
	},
	{
		host: "openpouch-anon",
		verdict: "rejected",
		reason:
			`Anon cgroup memory.max=${OPENPOUCH_ANON_MEMORY_MAX_BYTES} bytes; ` +
			`official convex-local-backend uncompressed≈${CONVEX_LOCAL_BACKEND_LINUX_X64_BIN_BYTES} bytes ` +
			`(zip≈${CONVEX_LOCAL_BACKEND_LINUX_X64_ZIP_BYTES}); download OK, extract OOM-kills container`,
	},
	{
		host: "ttl.sh",
		verdict: "rejected",
		reason: "Ephemeral registry only — does not run containers",
	},
	{
		host: "e2b",
		verdict: "rejected",
		reason: "Requires E2B_API_KEY (credentialed — forbidden)",
	},
	{
		host: "snapdeploy",
		verdict: "rejected",
		reason: "Requires account/signup (credentialed — forbidden)",
	},
	{
		host: "appish",
		verdict: "rejected",
		reason: "Free slots gate on login; anon push invalid",
	},
	{
		host: "zerodeploy",
		verdict: "rejected",
		reason: "Drop API is static/tar.gz only — not an OCI/Docker runner",
	},
	{
		host: "clawdship",
		verdict: "rejected",
		reason:
			"Competitor adapter implemented (site/scripts/anon-container-hosts); " +
			"default matrix still fail-closed until live Convex OCI RAM proven — " +
			"opt-in HOBO_CONVEX_OCI_HOST=clawdship",
	},
] as const;

/**
 * What a caller should reach for once the anonymous matrix has refused. These
 * are alternatives, not fallbacks: nothing here is attempted automatically,
 * and none of them satisfies the zero-key anonymous constraint.
 */
export type AnonConvexAlternative = {
	readonly hostingFormId: ConvexHostingFormId;
	readonly summary: string;
	readonly anonymous: boolean;
	readonly productionDurability: boolean;
	readonly requires: string;
};

export const CONVEX_ANON_ALTERNATIVE_HOSTING_FORMS: readonly AnonConvexAlternative[] =
	Object.freeze([
		Object.freeze({
			hostingFormId: CONVEX_LOCAL_ACCOUNTLESS_FORM.id,
			summary: CONVEX_LOCAL_ACCOUNTLESS_FORM.summary,
			anonymous: true,
			productionDurability: false,
			requires:
				"a developer machine running `npx convex dev`; a tunnel in front of it is a Connector, never a durability claim",
		}),
		Object.freeze({
			hostingFormId: CONVEX_SELFHOSTED_OCI_FORM.id,
			summary: CONVEX_SELFHOSTED_OCI_FORM.summary,
			anonymous: false,
			productionDurability: true,
			requires:
				"an OCI host the operator owns, with a persistent volume for /convex/data",
		}),
		Object.freeze({
			hostingFormId: CONVEX_CLOUD_SPONSORED_TRANSFER_FORM.id,
			summary: CONVEX_CLOUD_SPONSORED_TRANSFER_FORM.summary,
			anonymous: false,
			productionDurability: true,
			requires: "a named sponsor account and a destination Convex team",
		}),
	]);

export type ProvisionConvexBackendAnonymousInput = {
	readonly image?: string;
	readonly mock?: boolean;
	/** Force live fail-closed even when mock env is set (tests). */
	readonly forceLive?: boolean;
};

export type ProvisionConvexBackendAnonymousResult = {
	readonly ok: true;
	readonly backendUrl: string;
	readonly adminKey: string;
	readonly image: string;
	readonly mocked: boolean;
	readonly mode: "anon-mock-temporary";
	readonly anonymous: true;
	readonly temporary: true;
	readonly claimUrl: string;
	readonly unavailableLive: true;
};

export class ConvexAnonBackendError extends Error {
	readonly rejections: readonly AnonBackendRejection[];

	constructor(
		message: string,
		rejections: readonly AnonBackendRejection[] = ANON_CONVEX_BACKEND_REJECTIONS,
	) {
		super(message);
		this.name = "ConvexAnonBackendError";
		this.rejections = rejections;
	}
}

/** @deprecated Alias — Instanode path removed after vendor confirmed no anon containers. */
export class ConvexInstanodeAnonError extends ConvexAnonBackendError {
	constructor(message: string) {
		super(message);
		this.name = "ConvexInstanodeAnonError";
	}
}

export function formatAnonConvexBackendUnavailableMessage(): string {
	const lines = ANON_CONVEX_BACKEND_REJECTIONS.map(
		(r) => `- ${r.host}: ${r.reason}`,
	);
	const alternatives = CONVEX_ANON_ALTERNATIVE_HOSTING_FORMS.map(
		(alternative) =>
			`- ${alternative.hostingFormId} (${alternative.anonymous ? "anonymous" : "identified"}, ` +
			`${alternative.productionDurability ? "production-durable" : "development-only"}): ${alternative.requires}`,
	);
	return (
		"No anonymous Temporary host can run official Convex self-host " +
		"(OCI/binary) under zero project API keys. Rejected:\n" +
		`${lines.join("\n")}\n` +
		"Use HOBO_CONVEX_SWAGHAUS_MOCK=1 for Examples mock, " +
		"HOBO_CONVEX_OCI_HOST=cloudflare (often 403), " +
		"or HOBO_CONVEX_ALLOW_CLOUD=1 (Convex Cloud deploy key — not anon).\n" +
		"Supported hosting forms (none of them anonymous-and-durable):\n" +
		`${alternatives.join("\n")}`
	);
}

export async function provisionConvexBackendAnonymous(
	input: ProvisionConvexBackendAnonymousInput = {},
): Promise<ProvisionConvexBackendAnonymousResult> {
	const image = input.image?.trim() || CONVEX_BACKEND_OCI_IMAGE;
	const mock = Boolean(input.mock) && !input.forceLive;

	if (!mock) {
		const message = formatAnonConvexBackendUnavailableMessage();
		throw new ConvexAnonBackendError(message);
	}

	const slug = `mock-${randomBytes(4).toString("hex")}`;
	const backendUrl = `https://backend-${slug}.anon.hobo.test`;
	const result: ProvisionConvexBackendAnonymousResult = {
		ok: true,
		backendUrl,
		adminKey: `hobo-anon-mock|${randomBytes(16).toString("hex")}`,
		image,
		mocked: true,
		mode: "anon-mock-temporary",
		anonymous: true,
		temporary: true,
		claimUrl: `https://anon.hobo.test/claim?backend=${slug}`,
		unavailableLive: true,
	};

	return result;
}
