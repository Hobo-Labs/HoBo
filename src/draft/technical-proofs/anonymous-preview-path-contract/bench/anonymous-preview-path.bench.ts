import { bench, describe } from "vitest";

import {
	authorizeAnonymousPreviewAccess,
	createAnonymousPreviewPlan,
	expireAnonymousPreview,
} from "../src/anonymous-preview-path.ts";

const request = {
	command: "npx hobo up",
	identity: null,
	camp: null,
	project: {
		name: "snapshop",
		directory: "C:/tmp/snapshop",
		bindleDigest: "sha256:bindle-snapshop",
	},
	hostedCloud: {
		name: "hobo-hosted",
		previewDomain: "preview.hobo.dev",
		autoApproveInferredCamp: true,
	},
	hostedPolicyGate: { status: "approved", policyId: "hosted-anonymous-preview-default" },
	abuseGate: { status: "approved", budgetId: "anonymous-preview-budget" },
};

const options = {
	now: "2026-06-26T10:00:00.000Z",
	idFactory: (prefix: string) => `${prefix}-001`,
	nonceFactory: () => "nonce0123456789abcdef012345",
};

const plan = createAnonymousPreviewPlan(request, options);

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("anonymous preview path hot path", () => {
	bench("createAnonymousPreviewPlan (full gate + provision plan)", () => {
		createAnonymousPreviewPlan(request, options);
	});

	bench("expireAnonymousPreview TTL sweep", () => {
		expireAnonymousPreview(plan.record, { now: "2026-06-27T10:00:01.000Z" });
	});

	bench("authorizeAnonymousPreviewAccess tenant check", () => {
		authorizeAnonymousPreviewAccess(plan.deployment, {
			tenantId: "tenant:acme-prod",
			operation: "write",
		});
	});
});
