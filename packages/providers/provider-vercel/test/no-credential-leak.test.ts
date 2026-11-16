/**
 * One scan over everything this package serializes.
 *
 * The interesting failures are not "did we log the token" — nobody writes that
 * on purpose. They are the accidental ones: a transfer code interpolated into an
 * error message, a connection string echoed from a provider body, a claim URL
 * that reached an event payload because it looked like ordinary metadata.
 */
import { parseSecretRef, SecretValue } from "@hobo/bindings";
import { attachBundle, initialState, reduce } from "@hobo/claims";
import { describe, expect, it } from "vitest";

import {
	buildClaimAction,
	createSponsoredProjectTransferBundle,
	createSponsoredProjectTransferLease,
	PROJECT_TRANSFER_CODE_TTL_MS,
	providerErrorForStatus,
	redactProviderText,
	rotateAssociatedResourceBinding,
	runSponsoredProjectTransferClaim,
	SPONSORED_PROJECT_TRANSFER_BOOTSTRAP,
	type SponsoredClaimOutcome,
	sponsoredProjectTransferBootstrapCommands,
	VERCEL_DROP_CLASSIFICATION,
	VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE,
} from "../src/index.js";

const FAKE_TRANSFER_CODE = "FAKE-00000000-0000-4000-8000-000000000000";
const FAKE_TOKEN = "FAKE-sponsor-token-000000000000";
const FAKE_CONNECTION_STRING =
	"postgres://appuser:FAKE-password-0000@db.example.invalid:5432/app?sslmode=require";
const FAKE_PRISMA_URL =
	"prisma+postgres://accelerate.example.invalid/?api_key=FAKE-api-key-000000";

/** Shapes that must never appear in anything this package serializes. */
const FORBIDDEN: readonly {
	readonly label: string;
	readonly pattern: RegExp;
}[] = [
	{ label: "postgres connection string", pattern: /postgres(?:ql)?:\/\//iu },
	{ label: "prisma accelerate url", pattern: /prisma\+postgres:\/\//iu },
	{ label: "bearer token", pattern: /Bearer\s+\S+/iu },
	{ label: "api key assignment", pattern: /api[_-]?key\s*[=:]\s*[^"\s]+/iu },
	{ label: "password assignment", pattern: /password\s*[=:]\s*[^"\s]+/iu },
	{ label: "sponsoring token", pattern: /FAKE-sponsor-token/u },
	{ label: "transfer code", pattern: /FAKE-00000000-0000-4000-8000/u },
	{ label: "claim url with code", pattern: /claim-deployment\?code=/u },
];

function assertNoCredentials(label: string, serialized: string): void {
	for (const forbidden of FORBIDDEN) {
		expect(
			forbidden.pattern.test(serialized),
			`${label} leaked a ${forbidden.label}`,
		).toBe(false);
	}
}

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const FENCE = "fence-1";
const DEADLINE = NOW + PROJECT_TRANSFER_CODE_TTL_MS;
const PROJECT_SUBJECT = "hobo://camp/vercel/prj_FAKEsponsoredproject000000";
const RESOURCE_SUBJECT = "hobo://resource/prisma-postgres/FAKEresource000000";

describe("nothing this package serializes carries credential material", () => {
	it("scans the static definition surface", () => {
		assertNoCredentials(
			"bootstrap disclosure",
			JSON.stringify(SPONSORED_PROJECT_TRANSFER_BOOTSTRAP),
		);
		assertNoCredentials(
			"candidate",
			JSON.stringify(VERCEL_SPONSORED_PROJECT_TRANSFER_CANDIDATE),
		);
		assertNoCredentials(
			"drop classification",
			JSON.stringify(VERCEL_DROP_CLASSIFICATION),
		);
	});

	it("scans the lease, bundle, commands, events, and report of a full claim", () => {
		const lease = createSponsoredProjectTransferLease({
			leaseId: "lease-1",
			subjectRef: PROJECT_SUBJECT,
			createdAt: NOW,
			transferCodeExpiresAt: DEADLINE,
			fencingToken: FENCE,
		});
		const bundle = createSponsoredProjectTransferBundle({
			bundleId: "bundle-1",
			deploymentRef: "deployment-1",
			projectSubjectRef: PROJECT_SUBJECT,
			resourceSubjectRef: RESOURCE_SUBJECT,
			transferCodeExpiresAt: DEADLINE,
			oneTimeActionRef: "ota-1",
		});
		const commands = sponsoredProjectTransferBootstrapCommands({
			deploymentRef: "deployment-1",
			offerId: "offer-1",
			offerDigest: "sha256:offer",
			acceptedAt: NOW,
			lease,
			projectSubjectRef: PROJECT_SUBJECT,
			resourceSubjectRef: RESOURCE_SUBJECT,
			idempotencyKey: "attempt-1",
		});

		let state = initialState("deployment-1", FENCE);
		for (const command of commands) {
			state = reduce(state, command, { fencingToken: FENCE }).state;
		}
		state = attachBundle(state, bundle);

		const outcome: SponsoredClaimOutcome = {
			at: NOW + 60_000,
			bundleId: "bundle-1",
			project: {
				observed: "claimed",
				verified: true,
				evidenceRef: "evidence://vercel/project/FAKE",
				revocationEvidenceRef: "evidence://vercel/revocation/FAKE",
			},
			associatedResource: {
				observed: "claimed",
				verified: true,
				evidenceRef: "evidence://prisma-postgres/ownership/FAKE",
				rotatedBindingId: "binding-rotated-1",
				revocationEvidenceRef: "evidence://prisma-postgres/revocation/FAKE",
			},
		};
		const result = runSponsoredProjectTransferClaim(state, outcome, {
			fencingToken: FENCE,
		});

		assertNoCredentials("lease", JSON.stringify(lease));
		assertNoCredentials("bundle", JSON.stringify(bundle));
		assertNoCredentials("bootstrap commands", JSON.stringify(commands));
		assertNoCredentials("claim events", JSON.stringify(result.events));
		assertNoCredentials("claim report", JSON.stringify(result.report));
		assertNoCredentials("coordinator state", JSON.stringify(result.state));
	});

	it("scans a rotated binding, which holds a locator and no value", () => {
		const rotated = rotateAssociatedResourceBinding({
			bindingId: "binding-rotated-1",
			resourceRef: RESOURCE_SUBJECT,
			rotatedCredentialRef: "hobo-secret://prisma/postgres/rotated-example",
			host: "db.example.invalid",
			port: 5432,
			producerEvidenceRef: "evidence://prisma-postgres/rotation/FAKE",
			rotatedAtMs: NOW,
		});
		assertNoCredentials("rotated binding", JSON.stringify(rotated));
	});

	it("scans errors built from hostile provider bodies", () => {
		const hostileBody = JSON.stringify({
			error: {
				message: `provisioning failed for ${FAKE_CONNECTION_STRING} using ${FAKE_PRISMA_URL} with Bearer ${FAKE_TOKEN} and code=${FAKE_TRANSFER_CODE}`,
			},
		});
		for (const status of [400, 401, 410, 429, 500, 503]) {
			const error = providerErrorForStatus(status, {
				method: "POST",
				operation: "createProjectTransferRequest",
				body: hostileBody,
			});
			assertNoCredentials(`error ${status} message`, error.message);
			assertNoCredentials(
				`error ${status} json`,
				JSON.stringify(error.toJSON()),
			);
		}
		// Log forging via control characters is flattened too.
		expect(
			redactProviderText("line one\n\rFAKE injected log record"),
		).not.toMatch(/[\n\r]/u);
	});

	it("keeps the claim URL out of every projection except an explicit expose()", () => {
		const code = new SecretValue(
			parseSecretRef("hobo-token://vercel/project-transfer/example"),
			FAKE_TRANSFER_CODE,
		);
		const action = buildClaimAction({
			transferCode: code,
			projectId: "prj_FAKEsponsoredproject000000",
			returnUrl: "https://example.invalid/done",
		});
		assertNoCredentials("claim action toString", String(action));
		assertNoCredentials("claim action toJSON", JSON.stringify(action));
		assertNoCredentials("claim action in a template", `action: ${action}`);
		assertNoCredentials("claim action inspected", `${action.ref}`);
		// The one deliberate exit, which the one-time action store consumes.
		expect(action.expose()).toContain("claim-deployment?code=");
	});
});
