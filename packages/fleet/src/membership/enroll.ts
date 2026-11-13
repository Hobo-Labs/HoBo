/**
 * Bootstrap tokens, device enrollment and sponsored declaration (§6.5; L02
 * private). Enrollment accepts exactly three proofs: a bootstrap token, a
 * person token whose DPoP binding is the request's identity key, or a
 * platform OIDC assertion. Proof of possession of the identity key is its
 * signature on the key bundle. Every path ends in the same state machine.
 *
 * Order of appends, each a compare-and-set, so a retry after any crash is
 * idempotent: bind the thumbprint, consume the token, open the member stream.
 */
import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { EventInput, JsonObject, PrincipalRef } from "@hobo/core";
import {
	ApprovalMode,
	AttestationTier,
	BootstrapTokenRecordSchema,
	type DeclareRequest,
	DeviceClass,
	type EnrollmentRequest,
	type EnrollmentResponse,
	type FleetRecord,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	MembershipSchema,
	PlatformSchema,
	type Role,
	type TokenCreateRequest,
	type TokenCreateResponse,
	TokenCreateResponseSchema,
	type TokenList,
	TokenListSchema,
} from "../_generated/fleet_pb.js";
import {
	type FleetId,
	type MemberId,
	type MemberName,
	parseFleetId,
	parseMemberName,
} from "../ids.js";
import {
	jwkThumbprint,
	memberIdFromJwk,
	parsePublicJwk,
	sponsoredMemberId,
} from "../keys/index.js";
import type { Outcome, PublicJwk, VerifiedToken } from "../ports.js";
import { verifyBundle } from "./bundle.js";
import {
	actorOf,
	asPerson,
	type Ctx,
	type Person,
	personSubject,
	principalKey,
	refuse,
	sha256Hex,
	withRetry,
} from "./context.js";
import {
	type MembershipIndex,
	memberEvent,
	memberStream,
	streamFact,
	thumbprintStream,
	tokenIssued,
	tokenStream,
} from "./journal.js";
import {
	checkAgentVersion,
	checkClass,
	checkKind,
	checkResidency,
	checkRoles,
	checkTier,
	matchOidcRule,
} from "./policy.js";
import { enrollmentResponse, nextRecord } from "./records.js";

const TOKEN_PREFIX = "hft_";
const TOKEN_BYTES = 32;
const TOKEN_TTL_MIN_S = 600;
const TOKEN_TTL_MAX_S = 1_800;
const TOKEN_TTL_DEFAULT_S = 900;
/** How long an enrollment OIDC assertion's id is remembered. */
const ASSERTION_MEMORY_MS = 24 * 60 * 60 * 1_000;

/** Members that no longer hold their name or count against a quota. */
function terminal(state: MemberState): boolean {
	return state === MemberState.REVOKED || state === MemberState.REJECTED;
}

/** `name-taken` when another live member already has this name in the fleet (§6.2). */
export function nameTaken(
	index: MembershipIndex,
	fleet: string,
	name: string,
	self: string,
): boolean {
	for (const [id, state] of index.members) {
		if (id === self || terminal(state.record.state)) continue;
		if (
			state.record.memberships.some(
				(membership) => membership.fleet === fleet && membership.name === name,
			)
		)
			return true;
	}
	return false;
}

function quotaReached(
	index: MembershipIndex,
	fleet: FleetRecord,
	principal: string,
	self: string,
): boolean {
	const quota = fleet.policy?.memberQuotaPerPrincipal ?? 0;
	if (quota === 0) return false;
	let held = 0;
	for (const [id, state] of index.members) {
		if (id === self || terminal(state.record.state)) continue;
		if (
			state.record.owner === principal &&
			state.record.memberships.some(
				(membership) => membership.fleet === fleet.fleetId,
			)
		)
			held += 1;
	}
	return held >= quota;
}

/** The events that open a member stream, and the record after them. */
type Opening = Readonly<{
	events: EventInput<JsonObject>[];
	record: MemberRecord;
}>;

/** The events that open a member stream: requested, then, when approval is automatic, approved, accepted and activated. */
function openingEvents(
	ctx: Ctx,
	first: MemberRecord,
	opening: "fleet.EnrollmentRequested" | "fleet.MemberDeclared",
	approver: string | undefined,
	extra: Readonly<Record<string, string>>,
): Opening {
	const now = ctx.nowIso();
	const events = [memberEvent(opening, first, extra)];
	let record = first;
	if (approver !== undefined) {
		record = nextRecord(record, { keyApprovedBy: approver }, now);
		events.push(memberEvent("fleet.KeyApproved", record));
		record = nextRecord(record, { acceptedBy: approver }, now);
		events.push(memberEvent("fleet.EnrollmentAccepted", record));
		record = nextRecord(
			record,
			{ state: MemberState.ACTIVE, stateReason: "auto-approved" },
			now,
		);
		events.push(memberEvent("fleet.MemberActivated", record));
	}
	return { events, record };
}

async function aliasesOf(
	ctx: Ctx,
	principal: PrincipalRef,
): Promise<readonly string[]> {
	try {
		const tenants = await ctx.deps.directory.tenantsOf(principal, {});
		return (
			tenants.find((entry) => entry.tenant === ctx.deps.tenant)?.aliases ?? []
		);
	} catch {
		return [];
	}
}

// ── Tokens ─────────────────────────────────────────────────────────────────

export async function issueToken(
	ctx: Ctx,
	request: TokenCreateRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<TokenCreateResponse>> {
	const person = asPerson(ctx.deps, caller);
	if (!person.ok) return person;
	const fleet = await ctx.fleet(request.fleet);
	if (!fleet.ok) return fleet;
	let name: MemberName;
	try {
		name = parseMemberName(request.name);
	} catch {
		return refuse("invalid-request", "name must be a short lower-case token");
	}
	const ttl =
		request.ttlSeconds === 0 ? TOKEN_TTL_DEFAULT_S : request.ttlSeconds;
	if (ttl < TOKEN_TTL_MIN_S || ttl > TOKEN_TTL_MAX_S)
		return refuse("invalid-request", "ttl_seconds must be 600 to 1800");
	const policy = fleet.value.policy;
	if (policy !== undefined) {
		for (const check of [
			checkKind(policy, MemberKind.DEVICE),
			checkRoles(policy, request.roles),
			checkClass(policy, request.deviceClass),
		])
			if (!check.ok) return check;
	}
	const index = await ctx.catchUp();
	if (nameTaken(index, fleet.value.fleetId, name, ""))
		return refuse("name-taken", `${name} is taken in ${fleet.value.fleetId}`);
	const decision = await ctx.governed(
		personSubject(person.value),
		"fleet.member.invite",
		{ kind: "fleet", id: fleet.value.fleetId, fleet: fleet.value.fleetId },
	);
	if (!decision.ok) return decision;

	const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
	const hash = sha256Hex(token);
	const expiresAt = new Date(ctx.deps.now() + ttl * 1_000).toISOString();
	const record = create(BootstrapTokenRecordSchema, {
		tokenHash: hash,
		fleet: fleet.value.fleetId,
		name,
		deviceClass: request.deviceClass,
		roles: [...request.roles],
		issuedBy: principalKey(person.value.principal),
		expiresAt,
	});
	const event = tokenIssued(
		record,
		await aliasesOf(ctx, person.value.principal),
	);
	const appended = await ctx.append(
		tokenStream(hash),
		0,
		[event],
		person.value.principal,
	);
	if (appended === "conflict")
		return refuse("conflict", "a token with this hash already exists");
	ctx.logEvents([event], hash);
	return {
		ok: true,
		value: create(TokenCreateResponseSchema, {
			token,
			tokenHash: hash,
			expiresAt,
		}),
	};
}

function liveTokens(ctx: Ctx, index: MembershipIndex): TokenList {
	const tokens = [...index.tokens.values()]
		.filter((token) => !token.revoked)
		.map((token) => token.record)
		.sort((a, b) => a.tokenHash.localeCompare(b.tokenHash));
	void ctx;
	return create(TokenListSchema, { tokens });
}

export async function listTokens(
	ctx: Ctx,
	caller: VerifiedToken | undefined,
): Promise<Outcome<TokenList>> {
	const person = asPerson(ctx.deps, caller);
	if (!person.ok) return person;
	return { ok: true, value: liveTokens(ctx, await ctx.catchUp()) };
}

export async function revokeToken(
	ctx: Ctx,
	tokenHash: string,
	caller: VerifiedToken | undefined,
): Promise<Outcome<TokenList>> {
	const person = asPerson(ctx.deps, caller);
	if (!person.ok) return person;
	const found = (await ctx.catchUp()).tokens.get(tokenHash);
	if (found === undefined) return refuse("token-invalid", "no such token");
	const decision = await ctx.governed(
		personSubject(person.value),
		"fleet.member.invite",
		{ kind: "token", id: tokenHash, fleet: found.record.fleet },
	);
	if (!decision.ok) return decision;
	return withRetry(ctx, async (index) => {
		const token = index.tokens.get(tokenHash);
		if (token !== undefined && !token.revoked) {
			const event = streamFact("fleet.TokenRevoked", tokenStream(tokenHash), {
				tokenHash,
				by: principalKey(person.value.principal),
			});
			const appended = await ctx.append(
				tokenStream(tokenHash),
				token.seq,
				[event],
				person.value.principal,
			);
			if (appended === "conflict") return "conflict";
			ctx.logEvents([event], tokenHash);
		}
		return { ok: true, value: liveTokens(ctx, await ctx.catchUp()) };
	});
}

// ── Enrollment ─────────────────────────────────────────────────────────────

/** What a proof establishes about the enrollment. */
type Admission = Readonly<{
	owner: PrincipalRef;
	ownerAliases: readonly string[];
	invitedBy: string;
	roles: readonly Role[];
	deviceClass: DeviceClass;
	fleet: string;
	name: string;
	/** Set when policy approves at once; who counts as approver. */
	approver: string | undefined;
	tier: AttestationTier | undefined;
	digest: string;
	token: Readonly<{ hash: string; seq: number; expiresAt: string }> | undefined;
	/** Runs once every other check has passed (single-use assertions, governed decisions). */
	finally: (() => Promise<Outcome<true>>) | undefined;
}>;

type Subject = Readonly<{
	request: EnrollmentRequest;
	jwk: PublicJwk;
	thumbprint: string;
	memberId: MemberId;
}>;

export async function enroll(
	ctx: Ctx,
	request: EnrollmentRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<EnrollmentResponse>> {
	if (request.tenant.length > 0 && request.tenant !== ctx.deps.tenant)
		return refuse("invalid-request", "the request names another tenant");
	const jwk = parsePublicJwk(request.identityJwk);
	if (!jwk.ok) return refuse("invalid-request", jwk.error.message);
	const thumbprint = jwkThumbprint(jwk.value);
	const subject: Subject = {
		request,
		jwk: jwk.value,
		thumbprint,
		memberId: memberIdFromJwk(jwk.value),
	};

	// A single-use check (an OIDC assertion id, a governed decision) runs once per call, not once per retry.
	let checked: Outcome<true> | undefined;
	return withRetry(ctx, async (index) => {
		const existing = index.members.get(subject.memberId);
		const bound = index.thumbprints.get(thumbprint);
		if (bound !== undefined && bound.memberId !== subject.memberId)
			return refuse("key-known", "this identity key belongs to another member");
		if (existing !== undefined) {
			if (terminal(existing.record.state))
				return refuse("key-known", "this identity key was revoked or rejected");
			// The same key enrolling again: idempotent, whatever proof it carries.
			if (
				existing.record.memberships.some(
					(m) => m.fleet === request.fleet || request.fleet === "",
				)
			)
				return {
					ok: true,
					value: await enrollmentResponse(ctx, existing.record),
				};
			return refuse(
				"key-known",
				"this identity key is enrolled in another fleet",
			);
		}
		const admission = await admit(ctx, index, subject, caller);
		if (!admission.ok) return admission;
		const once = admission.value.finally;
		return openDevice(ctx, index, subject, {
			...admission.value,
			finally:
				once === undefined
					? undefined
					: async () => {
							checked ??= await once();
							return checked;
						},
		});
	});
}

async function admit(
	ctx: Ctx,
	index: MembershipIndex,
	subject: Subject,
	caller: VerifiedToken | undefined,
): Promise<Outcome<Admission>> {
	const { request } = subject;
	switch (request.proof.case) {
		case "bootstrapToken":
			return admitToken(ctx, index, subject, request.proof.value);
		case "personToken":
			return admitPerson(ctx, subject, request.proof.value, caller);
		case "oidcAssertion":
			return admitWorkload(ctx, subject, request.proof.value);
		default:
			return refuse(
				"unauthenticated",
				"enrollment needs a bootstrap token, a person token or an OIDC assertion",
			);
	}
}

function admitToken(
	ctx: Ctx,
	index: MembershipIndex,
	subject: Subject,
	token: string,
): Outcome<Admission> {
	if (!token.startsWith(TOKEN_PREFIX))
		return refuse("token-invalid", "not a bootstrap token");
	const hash = sha256Hex(token);
	const found = index.tokens.get(hash);
	if (found === undefined || found.revoked)
		return refuse("token-invalid", "the bootstrap token is unknown or revoked");
	if (found.record.consumedBy.length > 0)
		return refuse("token-used", "the bootstrap token was used");
	if (Date.parse(found.record.expiresAt) <= ctx.deps.now())
		return refuse("token-expired", "the bootstrap token has expired");
	const { request } = subject;
	if (
		(request.fleet.length > 0 && request.fleet !== found.record.fleet) ||
		(request.name.length > 0 && request.name !== found.record.name)
	)
		return refuse(
			"invalid-request",
			"the bootstrap token is for another fleet or name",
		);
	const roles =
		request.requestedRoles.length > 0
			? request.requestedRoles
			: found.record.roles;
	if (
		found.record.roles.length > 0 &&
		roles.some((role) => !found.record.roles.includes(role))
	)
		return refuse("forbidden", "a requested role is not on the token");
	const [kind, ...rest] = found.record.issuedBy.split(":");
	const owner: PrincipalRef | undefined = principalOf(
		kind ?? "",
		rest.join(":"),
	);
	if (owner === undefined)
		return refuse("token-invalid", "the token names no inviting principal");
	return {
		ok: true,
		value: {
			owner,
			ownerAliases: found.ownerAliases,
			invitedBy: found.record.issuedBy,
			roles,
			deviceClass:
				found.record.deviceClass === DeviceClass.UNSPECIFIED
					? request.deviceClass
					: found.record.deviceClass,
			fleet: found.record.fleet,
			name: found.record.name,
			approver: undefined,
			tier: undefined,
			digest: "",
			token: {
				hash,
				seq: found.seq,
				expiresAt: found.record.expiresAt,
			},
			finally: undefined,
		},
	};
}

async function admitPerson(
	ctx: Ctx,
	subject: Subject,
	token: string,
	caller: VerifiedToken | undefined,
): Promise<Outcome<Admission>> {
	const verified = ctx.deps.issuer.verify(
		token,
		ctx.deps.discovery.issuer,
		ctx.deps.now(),
	);
	if (!verified.ok || verified.value.kind !== "person")
		return refuse("unauthenticated", "the person token does not verify");
	const person: Person = verified.value;
	if (person.tenant !== ctx.deps.tenant)
		return refuse("forbidden", "the person token is for another tenant");
	// The token, the fingerprint the person approved and the proof name one key (§6.5).
	if (
		person.jkt !== subject.thumbprint ||
		(caller !== undefined &&
			caller.kind === "person" &&
			caller.jkt !== subject.thumbprint)
	)
		return refuse(
			"proof-invalid",
			"the person token is bound to another key than the identity key",
		);
	const { request } = subject;
	const owner = principalKey(person.principal);
	return {
		ok: true,
		value: {
			owner: person.principal,
			ownerAliases: await aliasesOf(ctx, person.principal),
			invitedBy: owner,
			roles: request.requestedRoles,
			deviceClass:
				request.deviceClass === DeviceClass.UNSPECIFIED
					? DeviceClass.PERSONAL
					: request.deviceClass,
			fleet: request.fleet,
			name: request.name,
			approver: undefined,
			tier: undefined,
			digest: "",
			token: undefined,
			finally: async () => {
				const decision = await ctx.governed(
					personSubject(person),
					"fleet.member.invite",
					{ kind: "fleet", id: request.fleet, fleet: request.fleet },
				);
				return decision.ok ? { ok: true, value: true } : decision;
			},
		},
	};
}

async function admitWorkload(
	ctx: Ctx,
	subject: Subject,
	assertion: string,
): Promise<Outcome<Admission>> {
	const audience = `${ctx.deps.discovery.issuer}#${subject.thumbprint}`;
	let verified: Awaited<ReturnType<Ctx["deps"]["assertions"]["verifyOidc"]>>;
	try {
		verified = await ctx.deps.assertions.verifyOidc(assertion, audience);
	} catch {
		return refuse("unavailable", "the OIDC issuer could not be checked");
	}
	if (!verified.ok) return verified;
	const fleet = await ctx.fleet(subject.request.fleet);
	if (!fleet.ok) return fleet;
	const rule =
		fleet.value.policy === undefined
			? undefined
			: matchOidcRule(fleet.value.policy, verified.value, false);
	if (rule === undefined)
		return refuse("fleet-policy", "no oidc_trust rule of the fleet matches", {
			rule: "oidc-trust",
		});
	const owner: PrincipalRef = {
		kind: "service",
		id: `${verified.value.issuer}#${verified.value.subject}`,
	};
	const tokenId = verified.value.tokenId;
	return {
		ok: true,
		value: {
			owner,
			ownerAliases: [],
			invitedBy: principalKey(owner),
			roles: rule.roles,
			deviceClass: DeviceClass.EPHEMERAL,
			fleet: subject.request.fleet,
			name: subject.request.name,
			approver: principalKey(owner),
			tier: AttestationTier.T3_PLATFORM_IDENTITY,
			digest: `sha256:${sha256Hex(assertion)}`,
			token: undefined,
			finally: async () => {
				const first = await ctx.deps.bus.replay.firstUse(
					"oidc-enrollment",
					tokenId,
					ctx.deps.now() + ASSERTION_MEMORY_MS,
				);
				return first
					? { ok: true, value: true }
					: refuse("proof-replayed", "the OIDC assertion was used before");
			},
		},
	};
}

function principalOf(kind: string, id: string): PrincipalRef | undefined {
	if (id.length === 0) return undefined;
	return kind === "user" ||
		kind === "agent" ||
		kind === "service" ||
		kind === "system"
		? { kind, id }
		: undefined;
}

async function openDevice(
	ctx: Ctx,
	index: MembershipIndex,
	subject: Subject,
	admission: Admission,
): Promise<Outcome<EnrollmentResponse> | "conflict"> {
	const { request, memberId, thumbprint } = subject;
	const fleet = await ctx.fleet(admission.fleet);
	if (!fleet.ok) return fleet;
	let fleetId: FleetId;
	let name: MemberName;
	try {
		fleetId = parseFleetId(admission.fleet);
		name = parseMemberName(admission.name);
	} catch {
		return refuse("invalid-request", "fleet and name must be short tokens");
	}
	const policy = fleet.value.policy;
	if (policy === undefined)
		return refuse("fleet-policy", "the fleet has no policy", {
			rule: "policy",
		});
	const bundle = verifyBundle(request.keyBundle, subject.jwk, memberId, {
		policy,
		nowMs: ctx.deps.now(),
		after: 0,
	});
	if (!bundle.ok) return bundle;

	let tier = admission.tier;
	let digest = admission.digest;
	if (tier === undefined) {
		if (request.certificateChainPem.length > 0) {
			const chain = ctx.deps.assertions.verifyCertificateChain({
				chainPem: request.certificateChainPem,
				identityJwk: request.identityJwk,
				rootsPem: policy.deviceCaRootsPem,
				nowMs: ctx.deps.now(),
			});
			if (!chain.ok)
				return refuse("attestation-insufficient", chain.error.message);
			tier = AttestationTier.T2_ORG_CERTIFIED;
			digest = chain.value.digest;
		} else
			tier = request.heldKey
				? AttestationTier.T1_HELD_KEY
				: AttestationTier.T0_SOFTWARE_KEY;
	}
	for (const check of [
		checkKind(policy, MemberKind.DEVICE),
		checkRoles(policy, admission.roles),
		checkClass(policy, admission.deviceClass),
		checkTier(policy, tier),
		checkAgentVersion(
			policy,
			ctx.deps.discovery.minAgentVersion,
			request.agentVersion,
		),
		checkResidency(policy, request.region),
	])
		if (!check.ok) return check;
	const owner = principalKey(admission.owner);
	if (nameTaken(index, fleetId, name, memberId))
		return refuse("name-taken", `${name} is taken in ${fleetId}`);
	if (quotaReached(index, fleet.value, owner, memberId))
		return refuse("quota-exceeded", "the principal's member quota is reached");
	if (admission.finally !== undefined) {
		const last = await admission.finally();
		if (!last.ok) return last;
	}

	const actor = admission.owner;
	if (index.thumbprints.get(thumbprint) === undefined) {
		const bind = await ctx.append(
			thumbprintStream(thumbprint),
			0,
			[
				streamFact("fleet.ThumbprintBound", thumbprintStream(thumbprint), {
					thumbprint,
					memberId,
				}),
			],
			actor,
		);
		if (bind === "conflict") return "conflict";
	}
	if (admission.token !== undefined) {
		const consumed = await ctx.append(
			tokenStream(admission.token.hash),
			admission.token.seq,
			[
				streamFact("fleet.TokenConsumed", tokenStream(admission.token.hash), {
					tokenHash: admission.token.hash,
					memberId,
					thumbprint,
				}),
			],
			actor,
		);
		if (consumed === "conflict") return "conflict";
	}

	const now = ctx.nowIso();
	const autoOwner =
		policy.approval === ApprovalMode.AUTO_OWNER && fleet.value.owner === owner;
	const approver =
		admission.approver ?? (autoOwner ? admission.invitedBy : undefined);
	const first = create(MemberRecordSchema, {
		memberId,
		tenant: ctx.deps.tenant,
		kind: MemberKind.DEVICE,
		displayName: request.displayName || name,
		state: MemberState.PENDING,
		memberships: [
			create(MembershipSchema, {
				fleet: fleetId,
				name,
				roles: [...admission.roles],
				joinedAt: now,
			}),
		],
		deviceClass: admission.deviceClass,
		attestationTier: tier,
		attestationDigest: digest,
		identityJwk: JSON.stringify(subject.jwk),
		identityThumbprint: thumbprint,
		keyBundle: request.keyBundle,
		platform: request.platform ?? create(PlatformSchema, {}),
		region: request.region,
		agentVersion: request.agentVersion,
		owner,
		ownerAliases: [...admission.ownerAliases],
		invitedBy: admission.invitedBy,
		enrolledAt: now,
		stateChangedAt: now,
		stateReason: "enrollment requested",
		recordSequence: 1,
	});
	const opened = openingEvents(
		ctx,
		first,
		"fleet.EnrollmentRequested",
		approver,
		admission.token === undefined
			? {}
			: {
					tokenHash: admission.token.hash,
					tokenExpiresAt: admission.token.expiresAt,
				},
	);
	const appended = await ctx.append(
		memberStream(memberId),
		0,
		opened.events,
		actor,
	);
	if (appended === "conflict") return "conflict";
	ctx.logEvents(opened.events, memberId);
	await ctx.publish(opened.record);
	return { ok: true, value: await enrollmentResponse(ctx, opened.record) };
}

// ── Declaration ────────────────────────────────────────────────────────────

/** Who is declaring, and whether its declaration is approved at once. */
type Sponsor = Readonly<{
	actor: PrincipalRef;
	sponsor: string;
	owner: string;
	approver: string | undefined;
}>;

export async function declare(
	ctx: Ctx,
	request: DeclareRequest,
	caller: VerifiedToken | undefined,
): Promise<Outcome<EnrollmentResponse>> {
	if (request.tenant.length > 0 && request.tenant !== ctx.deps.tenant)
		return refuse("invalid-request", "the request names another tenant");
	if (request.kind !== MemberKind.BACKEND && request.kind !== MemberKind.TARGET)
		return refuse("invalid-request", "only BACKEND and TARGET are declared");
	let fleetId: FleetId;
	let name: MemberName;
	try {
		fleetId = parseFleetId(request.fleet);
		name = parseMemberName(request.name);
	} catch {
		return refuse("invalid-request", "fleet and name must be short tokens");
	}
	if (
		request.endpointDigest.length > 0 &&
		!/^sha256:[0-9a-f]{64}$/u.test(request.endpointDigest)
	)
		return refuse("invalid-request", "endpoint_digest must be sha256:<hex>");
	const fleet = await ctx.fleet(fleetId);
	if (!fleet.ok) return fleet;
	const policy = fleet.value.policy;
	if (policy === undefined)
		return refuse("fleet-policy", "the fleet has no policy", {
			rule: "policy",
		});
	for (const check of [
		checkKind(policy, request.kind),
		checkResidency(policy, request.region),
	])
		if (!check.ok) return check;
	const sponsor = await sponsorOf(ctx, fleet.value, caller);
	if (!sponsor.ok) return sponsor;
	const memberId = sponsoredMemberId(
		ctx.deps.tenant,
		request.kind,
		fleetId,
		name,
	);

	return withRetry(ctx, async (index) => {
		const existing = index.members.get(memberId);
		if (existing !== undefined) {
			if (
				!terminal(existing.record.state) &&
				existing.record.sponsor === sponsor.value.sponsor
			)
				return {
					ok: true,
					value: await enrollmentResponse(ctx, existing.record),
				};
			return refuse("name-taken", `${name} is taken in ${fleetId}`);
		}
		if (nameTaken(index, fleetId, name, memberId))
			return refuse("name-taken", `${name} is taken in ${fleetId}`);
		if (quotaReached(index, fleet.value, sponsor.value.owner, memberId))
			return refuse(
				"quota-exceeded",
				"the principal's member quota is reached",
			);
		const now = ctx.nowIso();
		const first = create(MemberRecordSchema, {
			memberId,
			tenant: ctx.deps.tenant,
			kind: request.kind,
			displayName: request.displayName || name,
			state: MemberState.PENDING,
			memberships: [
				create(MembershipSchema, {
					fleet: fleetId,
					name,
					roles: [],
					joinedAt: now,
				}),
			],
			deviceClass: DeviceClass.UNSPECIFIED,
			attestationTier: AttestationTier.UNSPECIFIED,
			region: request.region,
			owner: sponsor.value.owner,
			sponsor: sponsor.value.sponsor,
			credentialRef: request.credentialRef,
			endpointDigest: request.endpointDigest,
			invitedBy: sponsor.value.sponsor,
			enrolledAt: now,
			stateChangedAt: now,
			stateReason: "declared",
			recordSequence: 1,
		});
		const opened = openingEvents(
			ctx,
			first,
			"fleet.MemberDeclared",
			sponsor.value.approver,
			{},
		);
		const appended = await ctx.append(
			memberStream(memberId),
			0,
			opened.events,
			sponsor.value.actor,
		);
		if (appended === "conflict") return "conflict";
		ctx.logEvents(opened.events, memberId);
		await ctx.publish(opened.record);
		return { ok: true, value: await enrollmentResponse(ctx, opened.record) };
	});
}

async function sponsorOf(
	ctx: Ctx,
	fleet: FleetRecord,
	caller: VerifiedToken | undefined,
): Promise<Outcome<Sponsor>> {
	const policy = fleet.policy;
	const auto = policy?.approval === ApprovalMode.AUTO_OWNER;
	const resource = { kind: "fleet", id: fleet.fleetId, fleet: fleet.fleetId };
	if (caller === undefined)
		return refuse("unauthenticated", "declaring needs a credential");
	if (caller.tenant !== ctx.deps.tenant)
		return refuse("forbidden", "the credential is for another tenant");
	if (caller.kind === "person") {
		const decision = await ctx.governed(
			personSubject(caller),
			"fleet.member.declare",
			resource,
		);
		if (!decision.ok) return decision;
		const key = principalKey(caller.principal);
		return {
			ok: true,
			value: {
				actor: caller.principal,
				sponsor: key,
				owner: key,
				approver: auto && fleet.owner === key ? key : undefined,
			},
		};
	}
	if (caller.kind === "member") {
		const device = (await ctx.catchUp()).members.get(caller.memberId);
		if (device === undefined || device.record.kind !== MemberKind.DEVICE)
			return refuse("member-unknown", "the sponsoring device is unknown");
		if (device.record.state !== MemberState.ACTIVE)
			return refuse("forbidden", "the sponsoring device is not active");
		const roles = device.record.memberships.flatMap((membership) =>
			membership.roles.map((role) => `role:${role}`),
		);
		const decision = await ctx.governed(
			{ identity: caller.memberId, tags: roles },
			"fleet.member.declare",
			resource,
		);
		if (!decision.ok) return decision;
		return {
			ok: true,
			value: {
				actor: actorOf(caller),
				sponsor: caller.memberId,
				owner: device.record.owner,
				approver:
					auto && fleet.owner === device.record.owner
						? device.record.owner
						: undefined,
			},
		};
	}
	if (caller.kind === "workload") {
		const rule =
			policy === undefined
				? undefined
				: matchOidcRule(
						policy,
						{ issuer: caller.issuer, subject: caller.subject, claims: {} },
						true,
					);
		if (rule === undefined)
			return refuse("fleet-policy", "no oidc_trust rule with sponsor matches", {
				rule: "oidc-trust",
			});
		const actor = actorOf(caller);
		const key = principalKey(actor);
		return {
			ok: true,
			value: { actor, sponsor: key, owner: key, approver: key },
		};
	}
	return refuse("forbidden", "an account credential cannot declare members");
}
