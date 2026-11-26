/**
 * Executable step definitions for identity-auth-secrets-cross-app-access-xaa.feature.
 *
 * Drives the epic's real reference simulation
 * (services/identity-reference-architecture.ts) over its committed
 * identity-xaa-scenarios fixture and asserts the credentials, denials, and
 * OCSF evidence it produces. Providers, IdPs, STS, and SIEM stay mocked.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
	loadIdentityScenarioFixture,
	runIdentityReferenceSimulation,
} from "../../services/identity-reference-architecture.js";

type Simulation = Awaited<ReturnType<typeof runIdentityReferenceSimulation>>;
type Fixture = Awaited<ReturnType<typeof loadIdentityScenarioFixture>>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
	simulationPromise ??= runIdentityReferenceSimulation();
	return simulationPromise;
}

let fixturePromise: Promise<Fixture> | undefined;
function fixture(): Promise<Fixture> {
	fixturePromise ??= loadIdentityScenarioFixture();
	return fixturePromise;
}

// --- Scenario: Exchange an attested workload SVID for a provider token -----

let workload: Simulation["workloadCredential"] | undefined;

Given(
	"a host-signed workload attestation with least-privilege XAA scope",
	async () => {
		workload = (await simulation()).workloadCredential;
		assert.equal(workload.attestation.verdict, "attested");
		assert.equal(workload.attestation.tenantSource, "host-signed-measurement");
	},
);

When(
	"Identity issues a JWT-SVID and the XAA broker exchanges it through OIDC federation",
	() => {
		assert.equal(workload?.status, "issued");
		assert.equal(workload?.providerCredential.flow, "oidc-federation");
	},
);

Then(
	"the brokered provider token is short-lived and narrowed to the requested action",
	async () => {
		const fx = await fixture();
		assert.ok(workload);
		assert.ok(
			workload.providerCredential.expiresInSeconds <= workload.svid.ttlSeconds,
			"provider token must not outlive the SVID",
		);
		assert.equal(workload.providerCredential.narrowed, true);
		assert.deepEqual(
			workload.providerCredential.scope,
			fx.workload.requestedScope,
			"granted scope equals the requested least-privilege scope",
		);
	},
);

Then("SVID renewal outside the signed grace window is denied", () => {
	assert.equal(workload?.rotation.partitionGraceRenewal.ok, true);
	assert.equal(workload?.rotation.graceExpiredRenewal.ok, false);
	assert.equal(
		workload?.rotation.graceExpiredRenewal.reason,
		"renewal-grace-expired",
	);
	assert.equal(workload?.denials.unattested.ok, false);
	assert.equal(workload?.staticKeyFallback.ok, false);
});

// --- Scenario: Verify ctx.user and resolve secretless configuration --------

let authSlice: Simulation["auth"] | undefined;
let secretlessSlice: Simulation["secretless"] | undefined;

Given(
	"a hobo:auth consumer contract with trusted JWKS and Camp config references",
	async () => {
		const sim = await simulation();
		authSlice = sim.auth;
		secretlessSlice = sim.secretless;
	},
);

When(
	"an identity request verifies a token and resolves config through the secretless ladder",
	() => {
		assert.equal(authSlice?.verified.ok, true);
		assert.ok(
			secretlessSlice?.resolved.databaseUrl,
			"secretless ladder must resolve the database url",
		);
	},
);

Then(
	"ctx.user resolves the delegated principal without plaintext persistence",
	async () => {
		const fx = await fixture();
		assert.equal(authSlice?.verified.ctx.user.id, fx.auth.user.id);
		assert.deepEqual(authSlice?.verified.ctx.user.roles, fx.auth.user.roles);
		assert.equal(secretlessSlice?.noPlaintextLeaks, true);
		assert.equal(
			secretlessSlice?.resolved.databaseUrl.ref,
			fx.secretless.databaseUrlRef,
		);
		assert.equal(secretlessSlice?.secretAccessedEvent.type, "secret.Accessed");
	},
);

Then("wrong-issuer tokens and revoked identity sessions fail closed", () => {
	assert.equal(authSlice?.denials.wrongIssuer.ok, false);
	assert.equal(authSlice?.denials.wrongIssuer.reason, "issuer-not-trusted");
	assert.equal(authSlice?.denials.tamperedToken.ok, false);
	assert.equal(authSlice?.sessionRevocation.nextRequest.ok, false);
	assert.equal(
		authSlice?.sessionRevocation.nextRequest.reason,
		"session-revoked",
	);
});

// --- Scenario: Mint outbound and verify inbound XAA credentials ------------

let xaaSlice: Simulation["xaa"] | undefined;

Given(
	"a verified delegated user and an inferred XAA connector scope",
	async () => {
		xaaSlice = (await simulation()).xaa;
	},
);

When(
	"the XAA broker mints an audience-bound ID-JAG and the target redeems it",
	() => {
		assert.equal(xaaSlice?.outbound.status, "granted");
		assert.equal(xaaSlice?.inbound.status, "accepted");
	},
);

Then(
	"the ID-JAG carries only the delegated user-to-agent-to-app chain",
	async () => {
		const fx = await fixture();
		const inferredScope = fx.xaa.operationScopeMap[fx.xaa.operation];
		assert.ok(xaaSlice);
		assert.equal(xaaSlice.outbound.idJag.audience, fx.xaa.target);
		assert.equal(xaaSlice.outbound.idJag.subject, fx.xaa.agent.id);
		assert.equal(xaaSlice.outbound.idJag.delegatedBy, fx.xaa.delegatedBy.id);
		assert.deepEqual(xaaSlice.outbound.idJag.scope, [inferredScope]);
		assert.equal(
			xaaSlice.auditChain,
			`${fx.xaa.delegatedBy.id}->${fx.xaa.agent.id}->${fx.xaa.target}`,
		);
	},
);

Then("XAA replay and confused-deputy attempts are rejected", () => {
	assert.equal(xaaSlice?.denials.replay.ok, false);
	assert.equal(
		xaaSlice?.denials.replay.reason,
		"id-jag-nonce-already-consumed",
	);
	assert.equal(xaaSlice?.denials.confusedDeputy.ok, false);
	assert.equal(xaaSlice?.denials.scopeWidening.ok, false);
	assert.equal(xaaSlice?.denials.wrongAudience.ok, false);
});

// --- Scenario: Keep identity control planes available ----------------------

let governanceSlice: Simulation["governance"] | undefined;

Given(
	"a genesis issuer with an offline break-glass key and OCSF exporter",
	async () => {
		governanceSlice = (await simulation()).governance;
	},
);

When("identity recovery paths rotate, fail over, or override", () => {
	assert.equal(
		governanceSlice?.breakGlass.status,
		"audited-emergency-override",
	);
	assert.equal(governanceSlice?.relayAttach.status, "accepted");
});

Then("every identity override is audited and bounded by signed trust", () => {
	assert.equal(governanceSlice?.genesis.seedSigningAfterHandoff.ok, false);
	assert.equal(governanceSlice?.breakGlass.normalTokenSelfGrant.ok, false);
	assert.equal(governanceSlice?.mtls.crossTenantPeer.ok, false);
	assert.equal(governanceSlice?.mtls.peerAuthenticated, true);
});

Then("SIEM receives redacted OCSF identity evidence", () => {
	assert.ok(governanceSlice);
	assert.equal(governanceSlice.ocsf.containsPlaintextSecrets, false);
	assert.equal(governanceSlice.ocsf.exportMode, "one-way-redacted");
	assert.ok(
		governanceSlice.ocsf.records.some(
			(record: { event: string }) => record.event === "policy.Decided",
		),
		"break-glass decision is exported as OCSF evidence",
	);
});
