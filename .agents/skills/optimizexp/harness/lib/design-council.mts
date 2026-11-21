import { createHash } from "node:crypto";

export const COUNCIL_PERSONAS = [
	"steve-jobs",
	"jony-ive",
	"walt-disney",
	"hayao-miyazaki",
	"naoto-fukasawa",
	"shigeru-miyamoto",
] as const;

export type CouncilPersona = (typeof COUNCIL_PERSONAS)[number];
export type Vote = "yay" | "nay";
export const COUNCIL_PROTOCOL_SCHEMA_VERSION = 1 as const;

export class CouncilProtocolError extends Error {
	readonly invariant: string;

	constructor(
		invariant: string,
		message: string,
	) {
		super(`${invariant}: ${message}`);
		this.name = "CouncilProtocolError";
		this.invariant = invariant;
	}
}

export function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

export function round4(value: number): number {
	return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function initialInvestment(relevance: number, evidenceStrength: number): number {
	return round4(clamp01(relevance * (0.65 + 0.35 * evidenceStrength)));
}

export function decayForEvidence(evidenceStrength: number): number {
	return round4(Math.min(0.4, Math.max(0.12, 0.34 - 0.18 * evidenceStrength)));
}

export function advanceInvestment(before: number, decay: number): number {
	return round4(Math.max(0, before - decay));
}

export function carryInvestment(previous: number, candidate: number): number {
	return round4(Math.min(previous, candidate));
}

export type EvidenceSignals = {
	evidenceTypes: string[];
	currentHead?: boolean;
	acceptanceMapped?: boolean;
};

const EVIDENCE_TIERS: Readonly<Record<string, number>> = {
	prose: 0.25,
	"unverified-mock": 0.25,
	"code-path": 0.5,
	"static-artifact": 0.5,
	"executable-test": 0.75,
	screenshot: 0.75,
	transcript: 0.75,
	"captured-scenario": 0.75,
};

export function evidenceStrengthFromSignals(signals: EvidenceSignals): number {
	const types = [...new Set(signals.evidenceTypes)];
	if (types.length === 0) return 0;
	const best = Math.max(...types.map((type) => EVIDENCE_TIERS[type] ?? 0));
	if (
		types.filter((type) => (EVIDENCE_TIERS[type] ?? 0) >= 0.5).length >= 2 &&
		signals.currentHead === true &&
		signals.acceptanceMapped === true
	) {
		return 1;
	}
	return best;
}

export type RelevanceSignals = {
	categories?: string[];
	acceptanceTags?: string[];
	featureTags?: string[];
	keywords?: string[];
};

const PERSONA_RELEVANCE: Readonly<Record<CouncilPersona, readonly string[]>> = {
	"steve-jobs": ["product-thesis", "public-api", "positioning", "onboarding", "provider-portability", "cross-surface", "roadmap"],
	"jony-ive": ["api-naming", "cli-sdk-symmetry", "config", "provider-seam", "install", "upgrade", "errors", "visual", "design-token"],
	"walt-disney": ["journey", "onboarding", "deployment", "recovery", "tutorial", "progress", "waiting", "empty-state", "success-state", "failure-state"],
	"hayao-miyazaki": ["animation", "ambient-feedback", "long-running", "failure", "recovery", "automation", "copy", "sustainability", "alerts"],
	"naoto-fukasawa": ["cli-command", "defaults", "sdk-method", "first-action", "context-config", "manual-transition", "affordance"],
	"shigeru-miyamoto": ["core-loop", "tutorial", "cli-feedback", "tui-feedback", "live-preview", "deploy-observe-edit", "recovery", "progressive-disclosure", "playful"],
};

export function relevanceFromSignals(persona: CouncilPersona, signals: RelevanceSignals): number {
	const explicit = new Set([
		...(signals.categories ?? []),
		...(signals.acceptanceTags ?? []),
		...(signals.featureTags ?? []),
	]);
	const matches = PERSONA_RELEVANCE[persona].filter((cue) => explicit.has(cue)).length;
	if (matches >= 2) return 1;
	if (matches === 1) return 0.75;
	if ([...explicit].some((tag) => ["ux", "dx", "ax", "design", "accessibility", "interaction", "journey", "brand"].includes(tag))) return 0.5;
	const text = (signals.keywords ?? []).join(" ").toLowerCase();
	if (text && PERSONA_RELEVANCE[persona].some((cue) => text.includes(cue.replaceAll("-", " ")))) return 0.25;
	return 0;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonicalize(item)]),
		);
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function sha256(value: unknown): string {
	return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export type ProposalDigestInput = {
	subject: ProposalManifest["subject"];
	baseSha: string;
	headSha: string;
	changedPaths: string[];
	normalizedDiffHash: string;
	acceptanceDigest: string;
	evidenceDigest: string;
	relevanceSignals: RelevanceSignals;
	evidenceSignals: EvidenceSignals;
	council: readonly string[];
	protocolSchemaVersion: number;
};

export function computeProposalDigest(input: ProposalDigestInput): string {
	return sha256({
		subject: input.subject,
		baseSha: input.baseSha,
		headSha: input.headSha,
		changedPaths: [...new Set(input.changedPaths)].sort(),
		normalizedDiffHash: input.normalizedDiffHash,
		acceptanceDigest: input.acceptanceDigest,
		evidenceDigest: input.evidenceDigest,
		relevanceSignals: input.relevanceSignals,
		evidenceSignals: input.evidenceSignals,
		council: [...input.council],
		protocolSchemaVersion: input.protocolSchemaVersion,
	});
}

export function validateCouncilMembership(ids: readonly string[]): string[] {
	const problems: string[] = [];
	if (ids.length !== COUNCIL_PERSONAS.length) problems.push(`membership must contain exactly ${COUNCIL_PERSONAS.length} personas`);
	if (new Set(ids).size !== ids.length) problems.push("membership contains duplicate personas");
	for (const id of COUNCIL_PERSONAS) if (!ids.includes(id)) problems.push(`membership missing ${id}`);
	for (const id of ids) if (!(COUNCIL_PERSONAS as readonly string[]).includes(id)) problems.push(`membership contains unknown persona ${id}`);
	ids.forEach((id, index) => {
		if (id !== COUNCIL_PERSONAS[index]) problems.push(`speaking order ${index + 1} must be ${COUNCIL_PERSONAS[index]}`);
	});
	return [...new Set(problems)];
}

function assertMembership(ids: readonly string[]): asserts ids is readonly CouncilPersona[] {
	const problems = validateCouncilMembership(ids);
	if (problems.length) throw new CouncilProtocolError("exact-six-membership", problems.join("; "));
}

export function aggregateVotes(
	votes: Record<string, unknown>,
	openHardBlockers: readonly string[],
): { result: Vote; nayPersonas: CouncilPersona[] } {
	const keys = Object.keys(votes);
	if (keys.length !== COUNCIL_PERSONAS.length || new Set(keys).size !== keys.length || COUNCIL_PERSONAS.some((persona) => !keys.includes(persona)) || keys.some((persona) => !(COUNCIL_PERSONAS as readonly string[]).includes(persona))) {
		throw new CouncilProtocolError("exact-six-membership", "vote map must contain exactly the six canonical personas");
	}
	for (const [persona, vote] of Object.entries(votes)) {
		if (vote !== "yay" && vote !== "nay") throw new CouncilProtocolError("binary-vote", `${persona} vote must be yay or nay`);
	}
	const nayPersonas = COUNCIL_PERSONAS.filter((persona) => votes[persona] === "nay");
	return { result: nayPersonas.length === 0 && openHardBlockers.length === 0 ? "yay" : "nay", nayPersonas };
}

const DESIGN_PATH = /(^|\/)(site|apps?|web|ui|tui|cli|docs?|sdk|api|config|onboarding|examples?|brand|motion|components?|design-tokens|contracts?|data-models)(\/|$)|(^|\/)\.optimizexp\/features\/|(^|\/)(README|DESIGN)\.md$|(^|\/)(public-api|api|errors?)\.[cm]?[jt]sx?$|\.(tsx|css|mdx|proto|cue|wit)$/i;
const DESIGN_TAGS = new Set(["ux", "dx", "design", "brand", "accessibility", "journey", "interaction"]);

export type DesignRelevanceInput = {
	changedPaths: string[];
	acceptanceTags?: string[];
	explicitlyRequested?: boolean;
	priorCouncilCycle?: boolean;
	exemption?: { code: "internal-no-public-behavior"; justification: string };
};

export function evaluateDesignRelevance(input: DesignRelevanceInput): {
	required: boolean;
	reasons: string[];
	exemptionAccepted: boolean;
} {
	const reasons: string[] = [];
	if (input.changedPaths.some((file) => DESIGN_PATH.test(file))) reasons.push("design-relevant-path");
	if ((input.acceptanceTags ?? []).some((tag) => DESIGN_TAGS.has(tag.toLowerCase()))) reasons.push("design-relevant-acceptance-tag");
	if (input.explicitlyRequested) reasons.push("explicit-designer-review");
	if (input.priorCouncilCycle) reasons.push("prior-council-cycle");
	const exemptionAccepted = reasons.length === 0 && input.exemption?.code === "internal-no-public-behavior" && input.exemption.justification.trim().length >= 20;
	return { required: reasons.length > 0 || !exemptionAccepted, reasons, exemptionAccepted };
}

export function deriveRelevanceCategories(changedPaths: readonly string[]): string[] {
	return changedPaths.some((file) => DESIGN_PATH.test(file)) ? ["design"] : [];
}

export type MergeEligibilityInput = {
	required: boolean;
	independentReviewPassed: boolean;
	commentsResolved: boolean;
	checks: Array<{ name: string; status: "pass" | "billing-red" | "fail" }>;
	currentHeadSha: string;
	currentProposalDigest: string;
	consensus?: {
		result: Vote;
		reviewedHeadSha: string;
		proposalDigest: string;
		votes: Record<string, unknown>;
		openHardBlockers: string[];
	};
};

export function evaluateMergeEligibility(input: MergeEligibilityInput): { eligible: boolean; reasons: string[] } {
	const reasons: string[] = [];
	if (!input.independentReviewPassed) reasons.push("independent-review-missing");
	if (!input.commentsResolved) reasons.push("comments-unresolved");
	for (const check of input.checks) if (check.status === "fail") reasons.push(`check-failed:${check.name}`);
	if (input.required) {
		if (!input.consensus) reasons.push("designer-consensus-missing");
		else {
			try {
				const aggregate = aggregateVotes(input.consensus.votes, input.consensus.openHardBlockers);
				if (aggregate.result !== "yay" || input.consensus.result !== "yay") reasons.push("designer-consensus-not-unanimous");
			} catch (error) {
				reasons.push(error instanceof CouncilProtocolError ? error.invariant : "designer-consensus-invalid");
			}
			if (input.consensus.reviewedHeadSha !== input.currentHeadSha) reasons.push("designer-consensus-stale-head");
			if (input.consensus.proposalDigest !== input.currentProposalDigest) reasons.push("designer-consensus-stale-proposal");
		}
	}
	return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export type HardBlocker = {
	id: string;
	claim: string;
	rule: string;
	evidenceRefs: string[];
	requestedResolution: string;
	status: "open" | "resolved" | "withdrawn" | "overridden";
};

export type CouncilArgument = {
	id: string;
	claim: string;
	kind: "preference" | "hard-blocker";
	respondsTo: string[];
	evidenceRefs: string[];
	requestedChange: string;
};

export type PersonaState = {
	relevance: number;
	evidenceStrength: number;
	initialInvestment: number;
	currentInvestment: number;
	decayPerTurn: number;
	turnsParticipated: number;
	stance: Vote | null;
	hardBlockers: HardBlocker[];
	preferences: CouncilArgument[];
	lastEntryId: string | null;
	submitted: boolean;
};

export type CouncilSubject = {
	kind: "pull-request" | "surface";
	number?: number;
	surface?: string;
	baseSha: string;
	headSha: string;
	proposalDigest: string;
	changedPaths: string[];
	normalizedDiffHash: string;
	acceptanceDigest: string;
	evidenceDigest: string;
};

export type CouncilStatus = "open" | "discussing" | "voting" | "rework-required" | "approved" | "stale" | "blocked" | "closed";

export type SupersedingReview = {
	runId: string;
	reviewId: string;
	cycle: number;
	headSha: string;
	proposalDigest: string;
	openingEntryId: string;
};

export type CouncilState = {
	schemaVersion: 1;
	protocolSchemaVersion: 1;
	runId: string;
	reviewId: string;
	subject: CouncilSubject;
	council: CouncilPersona[];
	cycle: number;
	turn: number;
	status: CouncilStatus;
	personas: Record<CouncilPersona, PersonaState>;
	latestConsensusEntryId: string | null;
	maxTurns: number | null;
	blockedReason: string | null;
	closedResult: "yay" | "blocked" | "user" | "safety" | "superseded" | null;
	supersededBy?: SupersedingReview;
	closedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type ProposalManifest = {
	schemaVersion: 1;
	subject: { kind: "pull-request"; number: number } | { kind: "surface"; surface: string };
	changedPaths: string[];
	normalizedDiffHash: string;
	acceptanceDigest: string;
	evidenceDigest: string;
	relevanceSignals: RelevanceSignals;
	evidenceSignals: EvidenceSignals;
};

function object(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CouncilProtocolError("invalid-json-shape", `${label} must be an object`);
	return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new CouncilProtocolError("unknown-field", `${label} contains ${unknown.join(", ")}`);
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) throw new CouncilProtocolError("invalid-json-shape", `${label} must be an array of non-empty strings`);
	return value as string[];
}

function finite01(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new CouncilProtocolError("normalized-investment", `${label} must be finite in [0,1]`);
	return value;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new CouncilProtocolError("invalid-json-shape", `${label} must be a non-empty string`);
	return value;
}

function sha(value: unknown, label: string, exact64 = false): string {
	const result = text(value, label);
	const pattern = exact64 ? /^[a-f0-9]{64}$/i : /^[a-f0-9]{7,64}$/i;
	if (!pattern.test(result)) throw new CouncilProtocolError("invalid-digest", `${label} must be ${exact64 ? "a SHA-256" : "a git SHA"}`);
	return result.toLowerCase();
}

export function parseProposalManifest(value: unknown): ProposalManifest {
	const root = object(value, "proposal");
	onlyKeys(root, ["schemaVersion", "subject", "changedPaths", "normalizedDiffHash", "acceptanceDigest", "evidenceDigest", "relevanceSignals", "evidenceSignals"], "proposal");
	if (root.schemaVersion !== 1) throw new CouncilProtocolError("schema-version", "proposal.schemaVersion must be 1");
	const subject = object(root.subject, "proposal.subject");
	onlyKeys(subject, ["kind", "number", "surface"], "proposal.subject");
	let parsedSubject: ProposalManifest["subject"];
	if (subject.kind === "pull-request") {
		if (!Number.isInteger(subject.number) || Number(subject.number) < 1) throw new CouncilProtocolError("invalid-subject", "pull-request number must be a positive integer");
		parsedSubject = { kind: "pull-request", number: Number(subject.number) };
	} else if (subject.kind === "surface") parsedSubject = { kind: "surface", surface: text(subject.surface, "proposal.subject.surface") };
	else throw new CouncilProtocolError("invalid-subject", "subject.kind must be pull-request or surface");
	const relevance = object(root.relevanceSignals, "proposal.relevanceSignals");
	onlyKeys(relevance, ["categories", "acceptanceTags", "featureTags", "keywords"], "proposal.relevanceSignals");
	const evidence = object(root.evidenceSignals, "proposal.evidenceSignals");
	onlyKeys(evidence, ["evidenceTypes", "currentHead", "acceptanceMapped"], "proposal.evidenceSignals");
	if (evidence.currentHead !== undefined && typeof evidence.currentHead !== "boolean") throw new CouncilProtocolError("invalid-json-shape", "evidenceSignals.currentHead must be boolean");
	if (evidence.acceptanceMapped !== undefined && typeof evidence.acceptanceMapped !== "boolean") throw new CouncilProtocolError("invalid-json-shape", "evidenceSignals.acceptanceMapped must be boolean");
	const changedPaths = [...new Set(strings(root.changedPaths, "proposal.changedPaths"))].sort();
	const suppliedCategories = relevance.categories === undefined ? [] : strings(relevance.categories, "relevanceSignals.categories");
	return {
		schemaVersion: 1,
		subject: parsedSubject,
		changedPaths,
		normalizedDiffHash: sha(root.normalizedDiffHash, "proposal.normalizedDiffHash", true),
		acceptanceDigest: sha(root.acceptanceDigest, "proposal.acceptanceDigest", true),
		evidenceDigest: sha(root.evidenceDigest, "proposal.evidenceDigest", true),
		relevanceSignals: {
			categories: [...new Set([...suppliedCategories, ...deriveRelevanceCategories(changedPaths)])].sort(),
			acceptanceTags: relevance.acceptanceTags === undefined ? [] : strings(relevance.acceptanceTags, "relevanceSignals.acceptanceTags"),
			featureTags: relevance.featureTags === undefined ? [] : strings(relevance.featureTags, "relevanceSignals.featureTags"),
			keywords: relevance.keywords === undefined ? [] : strings(relevance.keywords, "relevanceSignals.keywords"),
		},
		evidenceSignals: {
			evidenceTypes: strings(evidence.evidenceTypes, "evidenceSignals.evidenceTypes"),
			...(typeof evidence.currentHead === "boolean" ? { currentHead: evidence.currentHead } : {}),
			...(typeof evidence.acceptanceMapped === "boolean" ? { acceptanceMapped: evidence.acceptanceMapped } : {}),
		},
	};
}

export function createCouncilState(input: {
	runId: string;
	reviewId: string;
	baseSha: string;
	headSha: string;
	proposal: ProposalManifest;
	createdAt: string;
	maxTurns?: number | null;
}): CouncilState {
	const evidenceStrength = evidenceStrengthFromSignals(input.proposal.evidenceSignals);
	const proposalDigest = computeProposalDigest({
		subject: input.proposal.subject,
		baseSha: input.baseSha,
		headSha: input.headSha,
		changedPaths: input.proposal.changedPaths,
		normalizedDiffHash: input.proposal.normalizedDiffHash,
		acceptanceDigest: input.proposal.acceptanceDigest,
		evidenceDigest: input.proposal.evidenceDigest,
		relevanceSignals: input.proposal.relevanceSignals,
		evidenceSignals: input.proposal.evidenceSignals,
		council: COUNCIL_PERSONAS,
		protocolSchemaVersion: COUNCIL_PROTOCOL_SCHEMA_VERSION,
	});
	const buildPersona = (persona: CouncilPersona): PersonaState => {
		const relevance = relevanceFromSignals(persona, input.proposal.relevanceSignals);
		const initial = initialInvestment(relevance, evidenceStrength);
		return {
			relevance,
			evidenceStrength,
			initialInvestment: initial,
			currentInvestment: initial,
			decayPerTurn: decayForEvidence(evidenceStrength),
			turnsParticipated: 0,
			stance: null,
			hardBlockers: [],
			preferences: [],
			lastEntryId: null,
			submitted: false,
		};
	};
	const personas: Record<CouncilPersona, PersonaState> = {
		"steve-jobs": buildPersona("steve-jobs"),
		"jony-ive": buildPersona("jony-ive"),
		"walt-disney": buildPersona("walt-disney"),
		"hayao-miyazaki": buildPersona("hayao-miyazaki"),
		"naoto-fukasawa": buildPersona("naoto-fukasawa"),
		"shigeru-miyamoto": buildPersona("shigeru-miyamoto"),
	};
	return {
		schemaVersion: 1,
		protocolSchemaVersion: 1,
		runId: text(input.runId, "runId"),
		reviewId: text(input.reviewId, "reviewId"),
		subject: {
			...input.proposal.subject,
			baseSha: sha(input.baseSha, "baseSha"),
			headSha: sha(input.headSha, "headSha"),
			proposalDigest,
			changedPaths: input.proposal.changedPaths,
			normalizedDiffHash: input.proposal.normalizedDiffHash,
			acceptanceDigest: input.proposal.acceptanceDigest,
			evidenceDigest: input.proposal.evidenceDigest,
		},
		council: [...COUNCIL_PERSONAS],
		cycle: 0,
		turn: 0,
		status: "open",
		personas,
		latestConsensusEntryId: null,
		maxTurns: input.maxTurns ?? null,
		blockedReason: null,
		closedResult: null,
		closedAt: null,
		createdAt: input.createdAt,
		updatedAt: input.createdAt,
	};
}

export function stateDigest(state: CouncilState): string {
	const { createdAt: _createdAt, updatedAt: _updatedAt, ...stable } = state;
	return sha256(stable);
}

export function validateCouncilState(state: CouncilState): string[] {
	const problems = validateCouncilMembership(state.council);
	if (state.schemaVersion !== 1 || state.protocolSchemaVersion !== 1) problems.push("state schema version must be 1");
	if (!Number.isInteger(state.cycle) || state.cycle < 0) problems.push("cycle must be a non-negative integer");
	if (!Number.isInteger(state.turn) || state.turn < 0) problems.push("turn must be a non-negative integer");
	if (state.maxTurns !== null && (!Number.isInteger(state.maxTurns) || state.maxTurns < 1)) problems.push("maxTurns must be null or a positive integer");
	const keys = Object.keys(state.personas);
	for (const problem of validateCouncilMembership(keys)) problems.push(`personas: ${problem}`);
	for (const persona of COUNCIL_PERSONAS) {
		const item = state.personas[persona];
		for (const [key, value] of Object.entries({ relevance: item.relevance, evidenceStrength: item.evidenceStrength, initialInvestment: item.initialInvestment, currentInvestment: item.currentInvestment, decayPerTurn: item.decayPerTurn })) {
			if (!Number.isFinite(value) || value < 0 || value > 1) problems.push(`${persona}.${key} must be finite in [0,1]`);
		}
		if (item.initialInvestment !== initialInvestment(item.relevance, item.evidenceStrength)) problems.push(`${persona}.initialInvestment seed mismatch`);
		if (item.decayPerTurn !== decayForEvidence(item.evidenceStrength)) problems.push(`${persona}.decayPerTurn mismatch`);
		if (item.currentInvestment === 0 && item.preferences.some((preference) => preference.kind === "preference") && item.stance === "nay" && item.hardBlockers.every((blocker) => blocker.status !== "open")) problems.push(`${persona} cannot retain preference-only nay at zero investment`);
	}
	return [...new Set(problems)];
}

export function nextCycleState(previous: CouncilState, fresh: CouncilState): CouncilState {
	if (!["rework-required", "approved", "stale"].includes(previous.status)) throw new CouncilProtocolError("illegal-transition", `${previous.status} cannot start another cycle`);
	const next = structuredClone(fresh);
	next.createdAt = previous.createdAt;
	next.cycle = previous.cycle + 1;
	for (const persona of COUNCIL_PERSONAS) {
		const old = previous.personas[persona];
		const candidate = next.personas[persona];
		candidate.currentInvestment = carryInvestment(old.currentInvestment, candidate.initialInvestment);
		candidate.turnsParticipated = old.turnsParticipated;
		candidate.hardBlockers = old.hardBlockers.filter((blocker) => blocker.status === "open");
		candidate.preferences = [];
	}
	return next;
}

export type InvestmentTransition = {
	relevance: number;
	evidenceStrength: number;
	before: number;
	decay: number;
	after: number;
	submitted: boolean;
};

export function expectedInvestmentTransition(persona: PersonaState): InvestmentTransition {
	return {
		relevance: persona.relevance,
		evidenceStrength: persona.evidenceStrength,
		before: persona.currentInvestment,
		decay: persona.decayPerTurn,
		after: advanceInvestment(persona.currentInvestment, persona.decayPerTurn),
		submitted: false,
	};
}

export function assertInvestmentTransition(persona: PersonaState, transition: InvestmentTransition, consumesTurn: boolean): void {
	for (const [key, value] of Object.entries(transition)) if (key !== "submitted") finite01(value, `investment.${key}`);
	if (transition.relevance !== persona.relevance || transition.evidenceStrength !== persona.evidenceStrength) throw new CouncilProtocolError("investment-metadata", "relevance/evidenceStrength do not match state");
	if (transition.before !== persona.currentInvestment) throw new CouncilProtocolError("investment-increase", "investment.before must equal current state");
	const expectedDecay = consumesTurn ? persona.decayPerTurn : 0;
	const expectedAfter = consumesTurn ? advanceInvestment(transition.before, expectedDecay) : transition.before;
	if (transition.decay !== expectedDecay || transition.after !== expectedAfter) throw new CouncilProtocolError("investment-decay", `expected before ${transition.before}, decay ${expectedDecay}, after ${expectedAfter}`);
	if (transition.after > transition.before) throw new CouncilProtocolError("investment-increase", "investment may never increase");
}
