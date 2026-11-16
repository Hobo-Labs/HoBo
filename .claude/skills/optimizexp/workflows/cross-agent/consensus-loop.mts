#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	COUNCIL_PERSONAS,
	CouncilProtocolError,
	aggregateVotes,
	assertInvestmentTransition,
	canonicalJson,
	computeProposalDigest,
	createCouncilState,
	evaluateDesignRelevance,
	expectedInvestmentTransition,
	nextCycleState,
	parseProposalManifest,
	sha256,
	stateDigest,
	validateCouncilMembership,
	validateCouncilState,
	type CouncilArgument,
	type CouncilPersona,
	type CouncilState,
	type HardBlocker,
	type InvestmentTransition,
	type Vote,
} from "../../harness/lib/design-council.mts";

type Json = Record<string, unknown>;
type CouncilEntry = Json & {
	kind: "council";
	schemaVersion: 1;
	id: string;
	runId: string;
	reviewId: string;
	cycle: number;
	turn: number;
	stage: "open" | "position" | "reply" | "vote" | "submitted" | "consensus" | "rework" | "blocker-resolution" | "closed";
	subject: { headSha: string; proposalDigest: string };
	createdAt: string;
	persona?: CouncilPersona;
	respondsTo?: string[];
	investment?: InvestmentTransition;
	stance?: Vote | null;
	arguments?: CouncilArgument[];
	hardBlockers?: HardBlocker[];
	preferences?: unknown[];
	evidenceRefs?: string[];
	requestedChanges?: string[];
	stateDigest?: string;
	supersedes?: string;
	voteEntryId?: string;
	blindSpotCheck?: string;
};

const PERSONA_STAGES = new Set(["position", "reply", "vote", "submitted"]);
const COORDINATOR_STAGES = new Set(["open", "consensus", "rework", "closed"]);
const ENTRY_KEYS = [
	"kind", "schemaVersion", "id", "runId", "reviewId", "cycle", "turn", "stage", "subject", "createdAt",
	"persona", "respondsTo", "investment", "stance", "arguments", "hardBlockers", "preferences", "evidenceRefs", "requestedChanges",
	"stateDigest", "supersedes", "voteEntryId", "blindSpotCheck", "council", "speakingOrder", "statePath", "protocolVersion",
	"initialPersonas", "acceptanceDigest", "evidenceDigest", "votes", "result", "nayPersonas", "openHardBlockers", "blockingFeedback",
	"nextAction", "priorConsensusEntryId", "priorReworkEntryId", "nextCycle", "acceptanceToRerun", "evidenceToRefresh",
	"implementationWorkItems", "blockerId", "originatingPersona", "resolutionType", "implementationEvidenceRefs", "resolver",
	"originAcknowledged", "resultingStatus", "reason", "maxTurns", "author",
	"authorizationRef", "initialState", "baseSha",
] as const;

function parseArgs(argv: string[]): Record<string, string> {
	const result: Record<string, string> = { mode: "help" };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--help" || arg === "-h") result.mode = "help";
		else if (arg.startsWith("--")) {
			const key = arg.slice(2).replaceAll(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new CouncilProtocolError("cli-argument", `${arg} requires a value`);
			result[key] = value;
			index++;
		} else throw new CouncilProtocolError("cli-argument", `unexpected argument ${arg}`);
	}
	return result;
}

function repoRoot(explicit?: string): string {
	if (explicit) return path.resolve(explicit);
	let current = process.cwd();
	for (;;) {
		if (existsSync(path.join(current, ".git")) || existsSync(path.join(current, ".optimizexp"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return process.cwd();
		current = parent;
	}
}

function required(value: string | undefined, flag: string): string {
	if (!value) throw new CouncilProtocolError("cli-argument", `--${flag} is required`);
	return value;
}

function readJson(file: string): unknown {
	try { return JSON.parse(readFileSync(file, "utf8")); }
	catch (error) { throw new CouncilProtocolError("invalid-json", `${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function inspectGitReviewSubject(root: string, baseSha: string, headSha: string, baseRef = "origin/main") {
	const env = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) delete env[key];
	const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
	const output = (...args: string[]) => {
		const result = git(...args);
		return result.status === 0 ? result.stdout.trim() : null;
	};
	const marker = path.join(root, ".git");
	let linkedWorktree = false;
	try { linkedWorktree = readFileSync(marker, "utf8").trim().startsWith("gitdir:"); }
	catch { /* A normal checkout uses a .git directory. */ }
	const checkout = existsSync(path.join(marker, "HEAD")) || linkedWorktree;
	const currentHeadSha = output("rev-parse", "HEAD");
	if (!currentHeadSha) return { available: false, problems: checkout ? ["git_unavailable"] : [], changedPaths: [], normalizedDiffHash: null };
	if (currentHeadSha !== headSha) return { available: true, problems: ["stale_head"], changedPaths: [], normalizedDiffHash: null };
	if (!output("rev-parse", "--verify", baseRef)) return { available: true, problems: ["base_ref_invalid"], changedPaths: [], normalizedDiffHash: null };
	const currentBaseSha = output("merge-base", baseRef, "HEAD");
	if (!currentBaseSha) return { available: true, problems: ["base_ref_invalid"], changedPaths: [], normalizedDiffHash: null };
	if (currentBaseSha !== baseSha) return { available: true, problems: ["stale_base"], changedPaths: [], normalizedDiffHash: null };
	const paths = output("diff", "--name-only", "--diff-filter=ACDMRTUXB", baseSha, headSha, "--");
	const diff = git("diff", "--no-ext-diff", "--binary", "--full-index", baseSha, headSha, "--");
	if (paths === null || diff.status !== 0) return { available: true, problems: ["git_unavailable"], changedPaths: [], normalizedDiffHash: null };
	return {
		available: true,
		problems: [],
		changedPaths: paths === "" ? [] : [...new Set(paths.split("\n").filter(Boolean))].sort(),
		normalizedDiffHash: sha256(diff.stdout.replaceAll("\r\n", "\n")),
	};
}

function atomicWrite(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	renameSync(temporary, file);
}

function withLock<T>(file: string, action: () => T): T {
	mkdirSync(path.dirname(file), { recursive: true });
	let descriptor: number;
	try { descriptor = openSync(file, "wx"); }
	catch { throw new CouncilProtocolError("concurrent-writer", `lock already held: ${file}`); }
	try { return action(); }
	finally { closeSync(descriptor); rmSync(file, { force: true }); }
}

function reviewDir(root: string, runId: string, reviewId: string): string {
	if (!/^[a-zA-Z0-9._-]+$/.test(runId) || !/^[a-zA-Z0-9._-]+$/.test(reviewId)) throw new CouncilProtocolError("unsafe-id", "runId/reviewId may contain only letters, numbers, dot, underscore, and hyphen");
	return path.join(root, ".optimizexp", "runs", runId, "consensus", reviewId);
}

function statePath(root: string, runId: string, reviewId: string): string {
	return path.join(reviewDir(root, runId, reviewId), "state.json");
}

function loadState(root: string, runId: string, reviewId: string): CouncilState {
	const file = statePath(root, runId, reviewId);
	if (!existsSync(file)) throw new CouncilProtocolError("state-missing", `no council state for ${runId}/${reviewId}`);
	const state = readJson(file) as CouncilState;
	if (state.runId !== runId || state.reviewId !== reviewId) throw new CouncilProtocolError("review-binding", `state identity ${state.runId}/${state.reviewId} does not match requested ${runId}/${reviewId}`);
	const problems = validateCouncilState(state);
	if (problems.length) throw new CouncilProtocolError("state-invalid", problems.join("; "));
	return state;
}

function busDir(root: string): string {
	return path.join(root, ".optimizexp", "bus", "entries");
}

function safeFilePart(value: string): string {
	return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

function entryFile(root: string, entry: CouncilEntry): string {
	return path.join(busDir(root), `${safeFilePart(entry.runId)}-${safeFilePart(entry.reviewId)}-c${entry.cycle}-t${String(entry.turn).padStart(4, "0")}-${entry.stage}-${safeFilePart(entry.id)}.json`);
}

function allBusEntries(root: string): Array<{ file: string; body: Json }> {
	const dir = busDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((file) => file.endsWith(".json")).sort().map((file) => ({ file, body: readJson(path.join(dir, file)) as Json }));
}

function reviewEntries(root: string, runId: string, reviewId: string): CouncilEntry[] {
	return allBusEntries(root)
		.map(({ body }) => body)
		.filter((body) => body.kind === "council" && body.runId === runId && body.reviewId === reviewId)
		.sort((left, right) => Number(left.cycle) - Number(right.cycle) || Number(left.turn) - Number(right.turn)) as CouncilEntry[];
}

function appendBus(root: string, entry: CouncilEntry): void {
	atomicWrite(entryFile(root, entry), entry);
}

function object(value: unknown, label: string): Json {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CouncilProtocolError("invalid-json-shape", `${label} must be an object`);
	return value as Json;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new CouncilProtocolError("invalid-json-shape", `${label} must be a non-empty string`);
	return value;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) throw new CouncilProtocolError("invalid-json-shape", `${label} must be an array of non-empty strings`);
	return value as string[];
}

function number01(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new CouncilProtocolError("normalized-investment", `${label} must be finite in [0,1]`);
	return value;
}

function parseArgument(value: unknown, label: string): CouncilArgument {
	const item = object(value, label);
	const unknown = Object.keys(item).filter((key) => !["id", "claim", "kind", "respondsTo", "evidenceRefs", "requestedChange"].includes(key));
	if (unknown.length) throw new CouncilProtocolError("unknown-field", `${label}: ${unknown.join(", ")}`);
	if (item.kind !== "preference" && item.kind !== "hard-blocker") throw new CouncilProtocolError("argument-kind", `${label}.kind must be preference or hard-blocker`);
	return { id: text(item.id, `${label}.id`), claim: text(item.claim, `${label}.claim`), kind: item.kind, respondsTo: stringArray(item.respondsTo, `${label}.respondsTo`), evidenceRefs: stringArray(item.evidenceRefs, `${label}.evidenceRefs`), requestedChange: text(item.requestedChange, `${label}.requestedChange`) };
}

function parseBlocker(value: unknown, label: string): HardBlocker {
	const item = object(value, label);
	const unknown = Object.keys(item).filter((key) => !["id", "claim", "rule", "evidenceRefs", "requestedResolution", "status"].includes(key));
	if (unknown.length) throw new CouncilProtocolError("unknown-field", `${label}: ${unknown.join(", ")}`);
	if (!(["open", "resolved", "withdrawn", "overridden"] as unknown[]).includes(item.status)) throw new CouncilProtocolError("blocker-status", `${label}.status invalid`);
	const refs = stringArray(item.evidenceRefs, `${label}.evidenceRefs`);
	if (refs.length === 0) throw new CouncilProtocolError("hard-blocker-evidence", `${label} requires evidenceRefs`);
	return { id: text(item.id, `${label}.id`), claim: text(item.claim, `${label}.claim`), rule: text(item.rule, `${label}.rule`), evidenceRefs: refs, requestedResolution: text(item.requestedResolution, `${label}.requestedResolution`), status: item.status as HardBlocker["status"] };
}

function parseInvestment(value: unknown): InvestmentTransition {
	const item = object(value, "investment");
	const unknown = Object.keys(item).filter((key) => !["relevance", "evidenceStrength", "before", "decay", "after", "submitted"].includes(key));
	if (unknown.length) throw new CouncilProtocolError("unknown-field", `investment: ${unknown.join(", ")}`);
	if (typeof item.submitted !== "boolean") throw new CouncilProtocolError("invalid-json-shape", "investment.submitted must be boolean");
	return { relevance: number01(item.relevance, "investment.relevance"), evidenceStrength: number01(item.evidenceStrength, "investment.evidenceStrength"), before: number01(item.before, "investment.before"), decay: number01(item.decay, "investment.decay"), after: number01(item.after, "investment.after"), submitted: item.submitted };
}

function parseExternalEntry(value: unknown): CouncilEntry {
	const item = object(value, "entry");
	const unknown = Object.keys(item).filter((key) => !(ENTRY_KEYS as readonly string[]).includes(key));
	if (unknown.length) throw new CouncilProtocolError("unknown-field", `entry contains ${unknown.join(", ")}`);
	if (item.kind !== "council" || item.schemaVersion !== 1) throw new CouncilProtocolError("schema-version", "entry must be kind council, schemaVersion 1");
	const stage = text(item.stage, "entry.stage") as CouncilEntry["stage"];
	if (COORDINATOR_STAGES.has(stage)) throw new CouncilProtocolError("coordinator-only-stage", `${stage} can only be emitted by consensus-loop`);
	if (!PERSONA_STAGES.has(stage) && stage !== "blocker-resolution") throw new CouncilProtocolError("stage-enum", `${stage} is not a council stage`);
	const subject = object(item.subject, "entry.subject");
	const subjectUnknown = Object.keys(subject).filter((key) => !["headSha", "proposalDigest"].includes(key));
	if (subjectUnknown.length) throw new CouncilProtocolError("unknown-field", `entry.subject contains ${subjectUnknown.join(", ")}`);
	if (!Number.isInteger(item.cycle) || Number(item.cycle) < 0 || !Number.isInteger(item.turn) || Number(item.turn) < 1) throw new CouncilProtocolError("monotonic-turn", "cycle/turn must be non-negative integers and turn >= 1");
	const createdAt = text(item.createdAt, "entry.createdAt");
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(createdAt) || Number.isNaN(Date.parse(createdAt))) throw new CouncilProtocolError("utc-timestamp", "createdAt must be ISO-8601 UTC");
	const base: CouncilEntry = {
		...item,
		kind: "council", schemaVersion: 1, id: text(item.id, "entry.id"), runId: text(item.runId, "entry.runId"), reviewId: text(item.reviewId, "entry.reviewId"),
		cycle: Number(item.cycle), turn: Number(item.turn), stage, subject: { headSha: text(subject.headSha, "entry.subject.headSha"), proposalDigest: text(subject.proposalDigest, "entry.subject.proposalDigest") }, createdAt,
	};
	if (stage === "blocker-resolution") return base;
	const persona = text(item.persona, "entry.persona");
	if (!(COUNCIL_PERSONAS as readonly string[]).includes(persona)) throw new CouncilProtocolError("exact-six-membership", `unknown persona ${persona}`);
	base.persona = persona as CouncilPersona;
	base.respondsTo = stringArray(item.respondsTo, "entry.respondsTo");
	base.investment = parseInvestment(item.investment);
	if (item.stance !== null && item.stance !== "yay" && item.stance !== "nay") throw new CouncilProtocolError("binary-vote", "stance must be yay, nay, or null");
	base.stance = item.stance as Vote | null;
	if (!Array.isArray(item.arguments) || !Array.isArray(item.hardBlockers) || !Array.isArray(item.preferences)) throw new CouncilProtocolError("invalid-json-shape", "arguments, hardBlockers, and preferences must be arrays");
	base.arguments = item.arguments.map((argument, index) => parseArgument(argument, `arguments[${index}]`));
	base.hardBlockers = item.hardBlockers.map((blocker, index) => parseBlocker(blocker, `hardBlockers[${index}]`));
	base.preferences = item.preferences;
	base.evidenceRefs = stringArray(item.evidenceRefs, "entry.evidenceRefs");
	base.requestedChanges = stringArray(item.requestedChanges, "entry.requestedChanges");
	if (item.supersedes !== undefined) base.supersedes = text(item.supersedes, "entry.supersedes");
	if (item.voteEntryId !== undefined) base.voteEntryId = text(item.voteEntryId, "entry.voteEntryId");
	if (item.blindSpotCheck !== undefined) base.blindSpotCheck = text(item.blindSpotCheck, "entry.blindSpotCheck");
	return base;
}

function validateEntryAgainstState(entry: CouncilEntry, state: CouncilState, history: CouncilEntry[]): void {
	const allowed = entry.stage === "blocker-resolution"
		? ["discussing", "voting", "rework-required"]
		: ["open", "discussing", "voting"];
	if (!allowed.includes(state.status)) throw new CouncilProtocolError("terminal-state", `${state.status} rejects ${entry.stage}`);
	if (entry.runId !== state.runId || entry.reviewId !== state.reviewId) throw new CouncilProtocolError("review-binding", "entry runId/reviewId do not match state");
	if (entry.cycle !== state.cycle || entry.turn !== state.turn + 1) throw new CouncilProtocolError("monotonic-turn", `expected cycle ${state.cycle}, turn ${state.turn + 1}`);
	if (entry.subject.headSha !== state.subject.headSha) throw new CouncilProtocolError("stale-head", "entry head SHA does not match current review");
	if (entry.subject.proposalDigest !== state.subject.proposalDigest) throw new CouncilProtocolError("stale-proposal", "entry proposal digest does not match current review");
	if (entry.stage === "blocker-resolution") return validateResolution(entry, state);
	const persona = state.personas[entry.persona!];
	if (persona.submitted) throw new CouncilProtocolError("persona-submitted", `${entry.persona} already submitted`);
	const consumesTurn = entry.stage === "position" || entry.stage === "reply";
	assertInvestmentTransition(persona, entry.investment!, consumesTurn);
	if (entry.investment!.submitted !== (entry.stage === "submitted")) throw new CouncilProtocolError("submitted-transition", "investment.submitted must match submitted stage");
	const cycleHistory = history.filter((item) => item.cycle === state.cycle);
	const positions = cycleHistory.filter((item) => item.persona === entry.persona && item.stage === "position");
	const opened = new Set(cycleHistory.filter((item) => item.stage === "position" || item.stage === "submitted").map((item) => item.persona));
	const expectedOpening = COUNCIL_PERSONAS.find((candidate) => !opened.has(candidate));
	const isOpening = entry.stage === "position" || (entry.stage === "submitted" && positions.length === 0);
	if (isOpening && entry.persona !== expectedOpening) throw new CouncilProtocolError("deterministic-speaking-order", `expected ${expectedOpening ?? "opening round complete"}, got ${entry.persona}`);
	if (!isOpening && expectedOpening !== undefined) throw new CouncilProtocolError("opening-round-incomplete", `${expectedOpening} must open before ${entry.stage}`);
	if ((entry.stage === "reply" || entry.stage === "vote") && positions.length === 0) throw new CouncilProtocolError("opening-position-required", `${entry.persona} must append a position before ${entry.stage}`);
	if (entry.stage === "vote" && persona.currentInvestment === 0) throw new CouncilProtocolError("zero-investment-submission-required", "zero-investment persona must append submitted, not vote");
	if (entry.stage === "position" && positions.length > 0) throw new CouncilProtocolError("duplicate-position", `${entry.persona} already positioned this cycle`);
	if (entry.stage === "reply") {
		if (entry.respondsTo!.length === 0) throw new CouncilProtocolError("reply-target", "reply respondsTo must be non-empty");
		const targets = new Set(cycleHistory.flatMap((item) => [item.id, ...(item.arguments ?? []).map((argument) => argument.id)]));
		for (const target of entry.respondsTo!) if (!targets.has(target)) throw new CouncilProtocolError("reply-target", `unknown reply target ${target}`);
	}
	const priorArguments = history.flatMap((item) => item.arguments ?? []);
	for (const argument of entry.arguments ?? []) {
		if (priorArguments.some((prior) => prior.id === argument.id)) throw new CouncilProtocolError("duplicate-argument", `argument id ${argument.id} already exists`);
		if (priorArguments.some((prior) => prior.claim.trim().toLowerCase() === argument.claim.trim().toLowerCase())) throw new CouncilProtocolError("duplicate-argument", `claim repeats ${argument.claim}`);
	}
	const hardArguments = (entry.arguments ?? []).filter((argument) => argument.kind === "hard-blocker");
	const matches = (argument: CouncilArgument, blocker: HardBlocker) => blocker.evidenceRefs.some((ref) => argument.evidenceRefs.includes(ref));
	if (
		entry.hardBlockers!.length !== hardArguments.length ||
		hardArguments.some((argument) => entry.hardBlockers!.filter((blocker) => matches(argument, blocker)).length !== 1) ||
		entry.hardBlockers!.some((blocker) => hardArguments.filter((argument) => matches(argument, blocker)).length !== 1)
	) {
		throw new CouncilProtocolError("hard-blocker-classification", "each hard-blocker argument requires one matching structured hardBlocker with shared evidence");
	}
	for (const blocker of entry.hardBlockers ?? []) {
		if (blocker.status !== "open") throw new CouncilProtocolError("hard-blocker-resolution", "new hard blockers must start open");
		if (history.some((item) => (item.hardBlockers ?? []).some((prior) => prior.id === blocker.id))) throw new CouncilProtocolError("duplicate-blocker", `blocker ${blocker.id} already exists`);
	}
	if (persona.currentInvestment === 0 && (entry.arguments ?? []).some((argument) => argument.kind === "preference")) throw new CouncilProtocolError("zero-investment-preference", "zero-investment persona cannot introduce a preference");
	if ((entry.stage === "vote" || entry.stage === "submitted") && !entry.blindSpotCheck) throw new CouncilProtocolError("blind-spot-check", "final vote requires blindSpotCheck");
	if (entry.stage === "vote" || entry.stage === "submitted") {
		if (entry.stance !== "yay" && entry.stance !== "nay") throw new CouncilProtocolError("binary-vote", "final vote must be yay or nay");
		if ((entry.arguments?.length ?? 0) > 0 || (entry.hardBlockers?.length ?? 0) > 0 || (entry.preferences?.length ?? 0) > 0) throw new CouncilProtocolError("vote-is-not-turn", "vote/submitted cannot introduce substantive arguments");
		const priorVotes = activeVotes(history, state.cycle);
		const prior = priorVotes.entries[entry.persona!];
		if (prior && (entry.supersedes !== prior.id || !entry.respondsTo!.includes(prior.id))) throw new CouncilProtocolError("duplicate-vote", "vote correction must supersede and respond to prior active vote");
		const openBlockers = persona.hardBlockers.filter((blocker) => blocker.status === "open");
		if (entry.stance === "yay" && openBlockers.length) throw new CouncilProtocolError("hard-blocker-precedence", "yay forbidden while persona has an open hard blocker");
		if (entry.stance === "nay" && persona.currentInvestment === 0 && openBlockers.length === 0) throw new CouncilProtocolError("zero-investment-preference", "zero-investment nay requires an open hard blocker");
		if (entry.stance === "nay" && persona.currentInvestment > 0 && openBlockers.length === 0 && persona.preferences.length === 0) throw new CouncilProtocolError("nay-without-argument", "nay requires an unresolved blocker or non-yielded preference");
	}
	if (entry.stage === "submitted") {
		if (persona.currentInvestment !== 0 || entry.investment!.after !== 0) throw new CouncilProtocolError("submitted-transition", "submitted requires zero investment");
	}
}

function validateResolution(entry: CouncilEntry, state: CouncilState): void {
	validateResolutionShape(entry);
	const blockerId = text(entry.blockerId, "entry.blockerId");
	const origin = text(entry.originatingPersona, "entry.originatingPersona") as CouncilPersona;
	if (!(COUNCIL_PERSONAS as readonly string[]).includes(origin)) throw new CouncilProtocolError("exact-six-membership", `unknown originating persona ${origin}`);
	const blocker = state.personas[origin].hardBlockers.find((item) => item.id === blockerId && item.status === "open");
	if (!blocker) throw new CouncilProtocolError("hard-blocker-resolution", `no open blocker ${blockerId} for ${origin}`);
}

function validateResolutionShape(entry: CouncilEntry): void {
	const origin = text(entry.originatingPersona, "entry.originatingPersona");
	if (!(COUNCIL_PERSONAS as readonly string[]).includes(origin)) throw new CouncilProtocolError("exact-six-membership", `unknown originating persona ${origin}`);
	const type = entry.resolutionType;
	const status = entry.resultingStatus;
	const resolver = text(entry.resolver, "entry.resolver");
	const refs = stringArray(entry.implementationEvidenceRefs, "entry.implementationEvidenceRefs");
	if (refs.length === 0) throw new CouncilProtocolError("hard-blocker-resolution", "resolution requires implementation/evidence refs");
	if (typeof entry.originAcknowledged !== "boolean") throw new CouncilProtocolError("hard-blocker-resolution", "originAcknowledged must be boolean");
	if (type === "fixed" && status !== "resolved") throw new CouncilProtocolError("hard-blocker-resolution", "fixed resolution must result in resolved");
	if (type === "withdrawn" && (status !== "withdrawn" || entry.originAcknowledged !== true || resolver !== origin)) throw new CouncilProtocolError("hard-blocker-resolution", "withdrawal must be acknowledged and authored by the originating persona");
	if (type === "policy-override") {
		if (status !== "overridden") throw new CouncilProtocolError("hard-blocker-resolution", "policy override must result in overridden");
		text(entry.authorizationRef, "entry.authorizationRef");
	}
	if (!["fixed", "withdrawn", "policy-override"].includes(String(type))) throw new CouncilProtocolError("hard-blocker-resolution", "resolutionType must be fixed, withdrawn, or policy-override");
}

function activeVotes(history: CouncilEntry[], cycle: number): { votes: Record<string, Vote>; entries: Record<string, CouncilEntry> } {
	const entries: Record<string, CouncilEntry> = {};
	for (const entry of history.filter((item) => item.cycle === cycle && (item.stage === "vote" || item.stage === "submitted"))) {
		if (!entry.persona || (entry.stance !== "yay" && entry.stance !== "nay")) throw new CouncilProtocolError("vote-proof", `invalid final vote entry ${entry.id}`);
		const prior = entries[entry.persona];
		if (prior && (entry.supersedes !== prior.id || !(entry.respondsTo ?? []).includes(prior.id))) throw new CouncilProtocolError("duplicate-vote", `${entry.id} does not legally supersede ${prior.id}`);
		if (!prior && entry.supersedes !== undefined) throw new CouncilProtocolError("duplicate-vote", `${entry.id} supersedes no active vote`);
		entries[entry.persona] = entry;
	}
	return { votes: Object.fromEntries(Object.entries(entries).map(([persona, entry]) => [persona, entry.stance])) as Record<string, Vote>, entries };
}

function proveCurrentVotes(state: CouncilState, history: CouncilEntry[], consensus: CouncilEntry): Record<string, Vote> {
	const active = activeVotes(history, state.cycle);
	aggregateVotes(active.votes, []); // exact-six and binary proof
	for (const persona of COUNCIL_PERSONAS) {
		const entry = active.entries[persona];
		if (!entry) throw new CouncilProtocolError("vote-proof", `missing persona-authored final vote for ${persona}`);
		if (entry.subject.headSha !== state.subject.headSha || entry.subject.proposalDigest !== state.subject.proposalDigest) throw new CouncilProtocolError("stale-vote", `${persona} vote is not bound to the current subject`);
		if (state.personas[persona].stance !== entry.stance) throw new CouncilProtocolError("state-vote-mismatch", `${persona} state stance differs from append-only vote`);
	}
	const embedded = object(consensus.votes, "consensus.votes");
	if (canonicalJson(embedded) !== canonicalJson(active.votes)) throw new CouncilProtocolError("consensus-vote-mismatch", "coordinator vote map differs from persona-authored final votes");
	return active.votes;
}

function applyEntry(state: CouncilState, entry: CouncilEntry): CouncilState {
	const next = structuredClone(state);
	next.turn = entry.turn;
	next.updatedAt = entry.createdAt;
	if (entry.stage === "blocker-resolution") {
		const origin = entry.originatingPersona as CouncilPersona;
		const blocker = next.personas[origin].hardBlockers.find((item) => item.id === entry.blockerId)!;
		blocker.status = entry.resultingStatus as HardBlocker["status"];
		return next;
	}
	const persona = next.personas[entry.persona!];
	persona.currentInvestment = entry.investment!.after;
	persona.lastEntryId = entry.id;
	if (entry.stage === "position" || entry.stage === "reply") {
		persona.turnsParticipated++;
		persona.preferences.push(...(entry.arguments ?? []).filter((argument) => argument.kind === "preference"));
		persona.hardBlockers.push(...(entry.hardBlockers ?? []));
		next.status = "discussing";
	}
	if (entry.stage === "vote" || entry.stage === "submitted") {
		persona.stance = entry.stance!;
		persona.submitted = entry.stage === "submitted";
		next.status = "voting";
	}
	return next;
}

function enrichAndPersist(root: string, previous: CouncilState, entry: CouncilEntry): CouncilState {
	const next = applyEntry(previous, entry);
	entry.stateDigest = stateDigest(next);
	appendBus(root, entry);
	atomicWrite(statePath(root, next.runId, next.reviewId), next);
	return next;
}

function openingEntry(state: CouncilState, stateFile: string, priorReworkEntryId?: string): CouncilEntry {
	return {
		kind: "council", schemaVersion: 1, id: `${state.reviewId}-cycle-${state.cycle}-open`, runId: state.runId, reviewId: state.reviewId,
		cycle: state.cycle, turn: 0, stage: "open", subject: { headSha: state.subject.headSha, proposalDigest: state.subject.proposalDigest },
		createdAt: state.updatedAt, council: [...COUNCIL_PERSONAS], speakingOrder: [...COUNCIL_PERSONAS], statePath: stateFile,
		protocolVersion: 1, baseSha: state.subject.baseSha, initialPersonas: state.personas, acceptanceDigest: state.subject.acceptanceDigest, evidenceDigest: state.subject.evidenceDigest,
		priorReworkEntryId: priorReworkEntryId ?? null, initialState: structuredClone(state), stateDigest: stateDigest(state), author: "coordinator",
	};
}

function modeInit(args: Record<string, string>, root: string): Json {
	const runId = required(args.run, "run");
	const reviewId = required(args.review, "review");
	const baseSha = required(args.baseSha, "base-sha");
	const headSha = required(args.headSha, "head-sha");
	const proposal = parseProposalManifest(readJson(required(args.proposal, "proposal")));
	const file = statePath(root, runId, reviewId);
	return withLock(path.join(reviewDir(root, runId, reviewId), ".lock"), () => {
		const now = new Date().toISOString();
		const maxTurns = args.maxTurns === undefined ? null : Number(args.maxTurns);
		if (maxTurns !== null && (!Number.isInteger(maxTurns) || maxTurns < 1)) throw new CouncilProtocolError("max-turns", "--max-turns must be a positive integer");
		const candidate = createCouncilState({ runId, reviewId, baseSha, headSha, proposal, createdAt: now, maxTurns });
		let state = candidate;
		let priorReworkEntryId: string | undefined;
		if (existsSync(file)) {
			const previous = loadState(root, runId, reviewId);
			const history = reviewEntries(root, runId, reviewId);
			replayCouncilHistory(root, previous, history);
			if (canonicalJson(previous.subject) === canonicalJson(candidate.subject)) return { ok: true, idempotent: true, state: previous };
			if (previous.status === "rework-required") {
				priorReworkEntryId = requiredReworkEntry(history, previous).id;
				if (candidate.subject.evidenceDigest === previous.subject.evidenceDigest) throw new CouncilProtocolError("rework-evidence-stale", "rework cycle requires a refreshed evidence digest");
			}
			state = nextCycleState(previous, candidate);
		}
		atomicWrite(path.join(reviewDir(root, runId, reviewId), `proposal-cycle-${state.cycle}.json`), proposal);
		atomicWrite(file, state);
		appendBus(root, openingEntry(state, path.relative(root, file), priorReworkEntryId));
		return { ok: true, idempotent: false, state };
	});
}

function modeAppend(args: Record<string, string>, root: string): Json {
	const runId = required(args.run, "run");
	const reviewId = required(args.review, "review");
	const raw = readJson(required(args.entry, "entry"));
	const inputDigest = sha256(raw);
	return withLock(path.join(reviewDir(root, runId, reviewId), ".lock"), () => {
		const existing = allBusEntries(root).find(({ body }) => body.kind === "council" && body.id === (raw as Json).id);
		if (existing) {
			const { stateDigest: _digest, ...withoutDigest } = existing.body;
			if (sha256(withoutDigest) === inputDigest) return { ok: true, idempotent: true, entry: existing.body, state: loadState(root, runId, reviewId) };
			throw new CouncilProtocolError("duplicate-entry-id", `entry id ${(raw as Json).id} already exists with different content`);
		}
		const state = loadState(root, runId, reviewId);
		const history = reviewEntries(root, runId, reviewId);
		replayCouncilHistory(root, state, history);
		const entry = parseExternalEntry(raw);
		const allowed = entry.stage === "blocker-resolution"
			? ["discussing", "voting", "rework-required"]
			: ["open", "discussing", "voting"];
		if (!allowed.includes(state.status)) throw new CouncilProtocolError("terminal-state", `${state.status} rejects ${entry.stage}`);
		if (state.maxTurns !== null && entry.stage !== "blocker-resolution" && entry.turn > state.maxTurns) {
			state.turn++;
			state.status = "blocked";
			state.blockedReason = `diagnostic maximum of ${state.maxTurns} speaking turns reached`;
			state.updatedAt = new Date().toISOString();
			const closed: CouncilEntry = {
				kind: "council", schemaVersion: 1, id: `${reviewId}-cycle-${state.cycle}-max-turns-blocked`, runId, reviewId,
				cycle: state.cycle, turn: state.turn, stage: "closed", subject: { headSha: state.subject.headSha, proposalDigest: state.subject.proposalDigest },
				createdAt: state.updatedAt, result: "blocked", reason: state.blockedReason, openHardBlockers: openBlockers(state), author: "coordinator",
			};
			closed.stateDigest = stateDigest(state);
			appendBus(root, closed);
			atomicWrite(statePath(root, runId, reviewId), state);
			return { ok: false, blocked: true, invariant: "max-turns-blocked", state, entry: closed };
		}
		validateEntryAgainstState(entry, state, history);
		const next = enrichAndPersist(root, state, entry);
		return { ok: true, idempotent: false, entry, state: next };
	});
}

function modeAdvance(args: Record<string, string>, root: string): Json {
	const state = loadState(root, required(args.run, "run"), required(args.review, "review"));
	replayCouncilHistory(root, state, reviewEntries(root, state.runId, state.reviewId));
	const persona = required(args.persona, "persona") as CouncilPersona;
	if (!(COUNCIL_PERSONAS as readonly string[]).includes(persona)) throw new CouncilProtocolError("exact-six-membership", `unknown persona ${persona}`);
	return { ok: true, readOnly: true, persona, transition: expectedInvestmentTransition(state.personas[persona]), guidance: "Include this transition in the next position/reply append; append atomically persists it." };
}

function modeStatus(args: Record<string, string>, root: string): Json {
	const state = loadState(root, required(args.run, "run"), required(args.review, "review"));
	const entries = reviewEntries(root, state.runId, state.reviewId);
	replayCouncilHistory(root, state, entries);
	return { ok: true, state, entries };
}

function openBlockers(state: CouncilState): Array<HardBlocker & { persona: CouncilPersona }> {
	return COUNCIL_PERSONAS.flatMap((persona) => state.personas[persona].hardBlockers.filter((blocker) => blocker.status === "open").map((blocker) => ({ ...blocker, persona })));
}

function reworkObligations(state: CouncilState, nayPersonas: CouncilPersona[]) {
	const blockers = openBlockers(state);
	const preferences = nayPersonas.flatMap((persona) =>
		state.personas[persona].currentInvestment > 0
			? state.personas[persona].preferences.map((preference) => ({ ...preference, persona }))
			: [],
	);
	return {
		openHardBlockers: blockers,
		blockingFeedback: [
			...blockers.map((blocker) => ({ persona: blocker.persona, blockerId: blocker.id, claim: blocker.claim })),
			...preferences.map((preference) => ({ persona: preference.persona, argumentId: preference.id, claim: preference.claim })),
		],
		requestedChanges: [...new Set([...blockers.map((blocker) => blocker.requestedResolution), ...preferences.map((preference) => preference.requestedChange)])],
		implementationWorkItems: [
			...blockers.map((blocker) => ({ kind: "hard-blocker", persona: blocker.persona, blockerId: blocker.id, requestedChange: blocker.requestedResolution })),
			...preferences.map((preference) => ({ kind: "preference", persona: preference.persona, argumentId: preference.id, requestedChange: preference.requestedChange })),
		],
	};
}

function requiredReworkEntry(history: CouncilEntry[], state: CouncilState): CouncilEntry {
	const entries = history.filter((entry) => entry.cycle === state.cycle && entry.stage === "rework" && entry.nextAction === "implementation");
	if (entries.length !== 1) throw new CouncilProtocolError("rework-packet", `cycle ${state.cycle} requires exactly one implementation rework entry`);
	const entry = entries[0]!;
	if (entry.priorConsensusEntryId !== state.latestConsensusEntryId || entry.nextCycle !== state.cycle + 1) throw new CouncilProtocolError("rework-packet", `${entry.id} is not linked to the prior nay consensus`);
	return entry;
}

function assertEntryDigest(entry: CouncilEntry, replayed: CouncilState): void {
	if (entry.stateDigest !== stateDigest(replayed)) throw new CouncilProtocolError("history-replay-digest", `${entry.id} stateDigest does not match replayed state`);
}

function assertCommonHistoryEntry(entry: CouncilEntry): void {
	if (entry.kind !== "council" || entry.schemaVersion !== 1) throw new CouncilProtocolError("schema-version", "replayed entry must be kind council, schemaVersion 1");
	text(entry.id, "entry.id");
	text(entry.runId, "entry.runId");
	text(entry.reviewId, "entry.reviewId");
	if (!Number.isInteger(entry.cycle) || entry.cycle < 0 || !Number.isInteger(entry.turn) || entry.turn < 0) throw new CouncilProtocolError("monotonic-turn", `${entry.id} cycle/turn are invalid`);
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(entry.createdAt) || Number.isNaN(Date.parse(entry.createdAt))) throw new CouncilProtocolError("utc-timestamp", `${entry.id} createdAt must be ISO-8601 UTC`);
	text(entry.subject?.headSha, `${entry.id}.subject.headSha`);
	text(entry.subject?.proposalDigest, `${entry.id}.subject.proposalDigest`);
}

function assertCoordinatorEnvelope(entry: CouncilEntry, replayed: CouncilState): void {
	if (entry.author !== "coordinator" || entry.persona !== undefined) throw new CouncilProtocolError("coordinator-only-stage", `${entry.id} must be coordinator-authored`);
	if (entry.runId !== replayed.runId || entry.reviewId !== replayed.reviewId || entry.cycle !== replayed.cycle) throw new CouncilProtocolError("review-binding", `${entry.id} does not match replayed review/cycle`);
	if (entry.turn !== replayed.turn + 1) throw new CouncilProtocolError("monotonic-turn", `${entry.id} expected turn ${replayed.turn + 1}`);
	if (entry.subject.headSha !== replayed.subject.headSha || entry.subject.proposalDigest !== replayed.subject.proposalDigest) throw new CouncilProtocolError("stale-proposal", `${entry.id} is not bound to the replayed subject`);
}

function replayCouncilHistory(root: string, state: CouncilState, history: CouncilEntry[]): CouncilState {
	let replayed: CouncilState | null = null;
	const processed: CouncilEntry[] = [];
	for (const entry of history) {
		assertCommonHistoryEntry(entry);
		if (entry.stage === "open") {
			const previousCycle = replayed;
			if (entry.author !== "coordinator" || entry.persona !== undefined || entry.turn !== 0) throw new CouncilProtocolError("history-replay-open", `${entry.id} is not a legal coordinator opening`);
			const initial = structuredClone(object(entry.initialState, `${entry.id}.initialState`)) as CouncilState;
			const problems = validateCouncilState(initial);
			if (problems.length) throw new CouncilProtocolError("history-replay-open", `${entry.id}: ${problems.join("; ")}`);
			if (initial.runId !== entry.runId || initial.reviewId !== entry.reviewId || initial.cycle !== entry.cycle || initial.turn !== 0 || initial.status !== "open") throw new CouncilProtocolError("history-replay-open", `${entry.id} initial state identity/status is invalid`);
			if (entry.subject.headSha !== initial.subject.headSha || entry.subject.proposalDigest !== initial.subject.proposalDigest) throw new CouncilProtocolError("history-replay-open", `${entry.id} subject differs from initial state`);
			const membership = validateCouncilMembership(entry.council as string[]);
			if (membership.length) throw new CouncilProtocolError("exact-six-membership", membership.join("; "));
			const proposalFile = path.join(reviewDir(root, entry.runId, entry.reviewId), `proposal-cycle-${entry.cycle}.json`);
			if (!existsSync(proposalFile)) throw new CouncilProtocolError("history-replay-open", `${entry.id} proposal snapshot is missing`);
			const proposal = parseProposalManifest(readJson(proposalFile));
			const candidate = createCouncilState({
				runId: entry.runId,
				reviewId: entry.reviewId,
				baseSha: text(entry.baseSha, `${entry.id}.baseSha`),
				headSha: entry.subject.headSha,
				proposal,
				createdAt: initial.createdAt,
				maxTurns: initial.maxTurns,
			});
			const expected = previousCycle ? nextCycleState(previousCycle, candidate) : candidate;
			if (stateDigest(initial) !== stateDigest(expected)) throw new CouncilProtocolError("history-replay-open", `${entry.id} initial state does not match deterministic proposal seed/carryover`);
			if (canonicalJson(entry.initialPersonas) !== canonicalJson(expected.personas)) throw new CouncilProtocolError("history-replay-open", `${entry.id} initialPersonas do not match deterministic proposal seed/carryover`);
			if (entry.stateDigest !== stateDigest(initial)) throw new CouncilProtocolError("history-replay-digest", `${entry.id} opening digest mismatch`);
			if (previousCycle) {
				if (previousCycle.status === "rework-required") {
					const priorRework = requiredReworkEntry(processed, previousCycle);
					if (entry.priorReworkEntryId !== priorRework.id) throw new CouncilProtocolError("rework-packet", `${entry.id} does not link the prior rework packet`);
					if (initial.subject.evidenceDigest === previousCycle.subject.evidenceDigest) throw new CouncilProtocolError("rework-evidence-stale", "replayed rework cycle did not refresh evidence");
				} else if (entry.priorReworkEntryId !== null) throw new CouncilProtocolError("rework-packet", `${entry.id} has an unexpected prior rework link`);
			}
			replayed = initial;
			processed.push(entry);
			continue;
		}
		if (!replayed) throw new CouncilProtocolError("history-replay-open", `${entry.id} appears before an opening entry`);
		const current: CouncilState = replayed;
		if (PERSONA_STAGES.has(entry.stage) || entry.stage === "blocker-resolution") {
			const parsed = parseExternalEntry(entry);
			validateEntryAgainstState(parsed, current, processed);
			const applied = applyEntry(current, parsed);
			replayed = applied;
			assertEntryDigest(entry, applied);
			processed.push(entry);
			continue;
		}
		assertCoordinatorEnvelope(entry, current);
		const next: CouncilState = structuredClone(current);
		next.turn = entry.turn;
		next.updatedAt = entry.createdAt;
		if (entry.stage === "consensus") {
			if (!["discussing", "voting"].includes(current.status)) throw new CouncilProtocolError("illegal-transition", `${current.status} cannot emit consensus`);
			if (processed.some((item) => item.cycle === current.cycle && item.stage === "consensus")) throw new CouncilProtocolError("duplicate-consensus", `cycle ${current.cycle} has multiple consensus entries`);
			const active = activeVotes(processed, current.cycle);
			const blockers = openBlockers(current);
			const aggregate = aggregateVotes(active.votes, blockers.map((blocker) => blocker.id));
			if (canonicalJson(object(entry.votes, `${entry.id}.votes`)) !== canonicalJson(active.votes) || entry.result !== aggregate.result) throw new CouncilProtocolError("consensus-vote-mismatch", `${entry.id} does not match replayed votes/blockers`);
			if (canonicalJson(entry.nayPersonas) !== canonicalJson(aggregate.nayPersonas)) throw new CouncilProtocolError("consensus-vote-mismatch", `${entry.id} nayPersonas do not match replayed votes`);
			const replayedBlockerIds = blockers.map((blocker) => blocker.id).sort();
			const recordedBlockerIds = Array.isArray(entry.openHardBlockers) ? entry.openHardBlockers.map((blocker) => text(object(blocker, `${entry.id}.openHardBlockers`).id, "blocker.id")).sort() : [];
			if (canonicalJson(recordedBlockerIds) !== canonicalJson(replayedBlockerIds)) throw new CouncilProtocolError("consensus-blocker-mismatch", `${entry.id} open blockers do not match replayed state`);
			if (entry.nextAction !== (aggregate.result === "yay" ? "merge-eligible" : "rework")) throw new CouncilProtocolError("consensus-next-action", `${entry.id} nextAction does not match result`);
			next.latestConsensusEntryId = entry.id;
			next.status = aggregate.result === "yay" ? "approved" : "rework-required";
		} else if (entry.stage === "rework" && entry.result === "blocked") {
			const blockers = openBlockers(current);
			if (!["discussing", "voting", "rework-required"].includes(current.status) || blockers.length === 0) throw new CouncilProtocolError("blocked-evidence", `${entry.id} lacks an unresolved blocker context`);
			const recorded = Array.isArray(entry.openHardBlockers) ? entry.openHardBlockers.map((blocker) => text(object(blocker, `${entry.id}.openHardBlockers`).id, "blocker.id")).sort() : [];
			if (canonicalJson(recorded) !== canonicalJson(blockers.map((blocker) => blocker.id).sort()) || entry.nextAction !== "blocked") throw new CouncilProtocolError("blocked-evidence", `${entry.id} blocker packet does not match replayed state`);
			next.status = "blocked";
			next.blockedReason = text(entry.reason, `${entry.id}.reason`);
		} else if (entry.stage === "rework") {
			if (current.status !== "rework-required" || entry.priorConsensusEntryId !== current.latestConsensusEntryId) throw new CouncilProtocolError("illegal-transition", `${entry.id} is not linked to a nay consensus`);
			if (entry.nextCycle !== current.cycle + 1 || entry.nextAction !== "implementation") throw new CouncilProtocolError("rework-packet", `${entry.id} next cycle/action is invalid`);
			if (!stringArray(entry.acceptanceToRerun, `${entry.id}.acceptanceToRerun`).includes(current.subject.acceptanceDigest)) throw new CouncilProtocolError("rework-packet", `${entry.id} omits acceptance refresh`);
			if (!stringArray(entry.evidenceToRefresh, `${entry.id}.evidenceToRefresh`).includes(current.subject.evidenceDigest)) throw new CouncilProtocolError("rework-packet", `${entry.id} omits evidence refresh`);
			const consensus = processed.find((item) => item.id === current.latestConsensusEntryId && item.stage === "consensus");
			if (!consensus || canonicalJson(entry.nayPersonas) !== canonicalJson(consensus.nayPersonas)) throw new CouncilProtocolError("rework-packet", `${entry.id} nay personas differ from consensus`);
			const obligations = reworkObligations(current, consensus.nayPersonas as CouncilPersona[]);
			for (const key of ["openHardBlockers", "blockingFeedback", "requestedChanges", "implementationWorkItems"] as const) {
				if (canonicalJson(entry[key]) !== canonicalJson(obligations[key])) throw new CouncilProtocolError("rework-packet", `${entry.id} ${key} differs from replayed obligations`);
			}
		} else if (entry.stage === "closed") {
			const result = entry.result;
			const maxTurnBlock = result === "blocked" && current.maxTurns !== null && entry.id.includes("max-turns-blocked") && current.turn >= current.maxTurns;
			if (maxTurnBlock) {
				next.status = "blocked";
				next.blockedReason = text(entry.reason, `${entry.id}.reason`);
			} else {
				if (result === "yay" && current.status !== "approved") throw new CouncilProtocolError("illegal-transition", `${current.status} cannot close yay`);
				if (result === "blocked" && current.status !== "blocked") throw new CouncilProtocolError("illegal-transition", `${current.status} cannot close blocked`);
				if (!["yay", "blocked", "user", "safety"].includes(String(result))) throw new CouncilProtocolError("close-result", `${entry.id} has invalid close result`);
				next.status = "closed";
				next.closedResult = result as CouncilState["closedResult"];
				next.closedAt = entry.createdAt;
			}
			const recorded = Array.isArray(entry.openHardBlockers) ? entry.openHardBlockers.map((blocker) => text(object(blocker, `${entry.id}.openHardBlockers`).id, "blocker.id")).sort() : [];
			if (canonicalJson(recorded) !== canonicalJson(openBlockers(current).map((blocker) => blocker.id).sort())) throw new CouncilProtocolError("closed-blocker-mismatch", `${entry.id} blockers differ from replayed state`);
		} else throw new CouncilProtocolError("stage-enum", `${entry.stage} cannot be replayed`);
		replayed = next;
		assertEntryDigest(entry, next);
		processed.push(entry);
	}
	if (!replayed) throw new CouncilProtocolError("council-bus-missing", "review has no opening entry");
	if (stateDigest(replayed) !== stateDigest(state)) throw new CouncilProtocolError("state-history-mismatch", "persisted state does not match replayed append-only history");
	return replayed;
}

function modeDecide(args: Record<string, string>, root: string): Json {
	const runId = required(args.run, "run");
	const reviewId = required(args.review, "review");
	return withLock(path.join(reviewDir(root, runId, reviewId), ".lock"), () => {
		let state = loadState(root, runId, reviewId);
		if (!["discussing", "voting"].includes(state.status)) throw new CouncilProtocolError("illegal-transition", `${state.status} cannot decide`);
		const history = reviewEntries(root, runId, reviewId);
		replayCouncilHistory(root, state, history);
		if (history.some((entry) => entry.cycle === state.cycle && entry.stage === "consensus")) throw new CouncilProtocolError("duplicate-consensus", `cycle ${state.cycle} already has a consensus entry`);
		const active = activeVotes(history, state.cycle);
		const blockers = openBlockers(state);
		const aggregate = aggregateVotes(active.votes, blockers.map((blocker) => blocker.id));
		const obligations = reworkObligations(state, aggregate.nayPersonas);
		const now = new Date().toISOString();
		const consensusId = `${reviewId}-cycle-${state.cycle}-consensus`;
		state.turn++;
		state.latestConsensusEntryId = consensusId;
		state.status = aggregate.result === "yay" ? "approved" : "rework-required";
		state.updatedAt = now;
		const consensus: CouncilEntry = {
			kind: "council", schemaVersion: 1, id: consensusId, runId, reviewId, cycle: state.cycle, turn: state.turn, stage: "consensus",
			subject: { headSha: state.subject.headSha, proposalDigest: state.subject.proposalDigest }, createdAt: now,
			votes: active.votes, result: aggregate.result, nayPersonas: aggregate.nayPersonas, openHardBlockers: blockers,
			blockingFeedback: blockers.map((blocker) => ({ persona: blocker.persona, blockerId: blocker.id, claim: blocker.claim, requestedResolution: blocker.requestedResolution })),
			nextAction: aggregate.result === "yay" ? "merge-eligible" : "rework", author: "coordinator",
		};
		if (aggregate.result === "yay") {
			consensus.stateDigest = stateDigest(state);
			appendBus(root, consensus);
			atomicWrite(statePath(root, runId, reviewId), state);
			return { ok: true, decision: consensus, state };
		}
		consensus.stateDigest = stateDigest(state);
		appendBus(root, consensus);
		state.turn++;
		const rework: CouncilEntry = {
			kind: "council", schemaVersion: 1, id: `${reviewId}-cycle-${state.cycle}-rework`, runId, reviewId, cycle: state.cycle, turn: state.turn,
			stage: "rework", subject: { headSha: state.subject.headSha, proposalDigest: state.subject.proposalDigest }, createdAt: now,
			nayPersonas: aggregate.nayPersonas, openHardBlockers: obligations.openHardBlockers,
			blockingFeedback: obligations.blockingFeedback,
			requestedChanges: obligations.requestedChanges,
			acceptanceToRerun: [state.subject.acceptanceDigest], evidenceToRefresh: [state.subject.evidenceDigest],
			implementationWorkItems: obligations.implementationWorkItems,
			priorConsensusEntryId: consensusId, nextCycle: state.cycle + 1, nextAction: "implementation", author: "coordinator",
		};
		rework.stateDigest = stateDigest(state);
		appendBus(root, rework);
		atomicWrite(statePath(root, runId, reviewId), state);
		return { ok: true, decision: consensus, rework, state };
	});
}

function modeAssertYay(args: Record<string, string>, root: string): Json {
	const state = loadState(root, required(args.run, "run"), required(args.review, "review"));
	const baseSha = required(args.baseSha, "base-sha");
	const headSha = required(args.headSha, "head-sha");
	const proposal = parseProposalManifest(readJson(required(args.proposal, "proposal")));
	const gitSubject = inspectGitReviewSubject(root, baseSha, headSha, args.baseRef ?? "origin/main");
	if (gitSubject.problems.length) throw new CouncilProtocolError(gitSubject.problems[0]!, `Git review subject failed: ${gitSubject.problems.join(", ")}`);
	if (gitSubject.available) {
		if (canonicalJson(proposal.changedPaths) !== canonicalJson(gitSubject.changedPaths)) throw new CouncilProtocolError("proposal_paths_mismatch", "proposal changedPaths differ from the effective Git diff");
		if (proposal.normalizedDiffHash !== gitSubject.normalizedDiffHash) throw new CouncilProtocolError("proposal_diff_mismatch", "proposal normalizedDiffHash differs from the effective Git diff");
	}
	const proposalDigest = computeProposalDigest({
		subject: proposal.subject,
		baseSha,
		headSha,
		changedPaths: proposal.changedPaths,
		normalizedDiffHash: proposal.normalizedDiffHash,
		acceptanceDigest: proposal.acceptanceDigest,
		evidenceDigest: proposal.evidenceDigest,
		relevanceSignals: proposal.relevanceSignals,
		evidenceSignals: proposal.evidenceSignals,
		council: COUNCIL_PERSONAS,
		protocolSchemaVersion: 1,
	});
	if (state.subject.baseSha !== baseSha) throw new CouncilProtocolError("stale-base", `approved ${state.subject.baseSha}, current ${baseSha}`);
	if (args.proposalDigest && args.proposalDigest !== proposalDigest) throw new CouncilProtocolError("proposal-digest-mismatch", "caller digest does not match recomputed proposal manifest");
	if (state.subject.headSha !== headSha) throw new CouncilProtocolError("stale-head", `approved ${state.subject.headSha}, current ${headSha}`);
	if (state.subject.proposalDigest !== proposalDigest) throw new CouncilProtocolError("stale-proposal", `approved ${state.subject.proposalDigest}, current ${proposalDigest}`);
	const history = reviewEntries(root, state.runId, state.reviewId);
	replayCouncilHistory(root, state, history);
	const closedYay = state.status === "closed" && state.closedResult === "yay";
	if (state.closedResult && state.closedResult !== "yay") throw new CouncilProtocolError("not-approved", `review closed as ${state.closedResult}`);
	if (state.status !== "approved" && !closedYay) throw new CouncilProtocolError("not-approved", `state is ${state.status}${state.closedResult ? ` (${state.closedResult})` : ""}`);
	const consensus = history.find((entry) => entry.id === state.latestConsensusEntryId && entry.stage === "consensus");
	if (!consensus) throw new CouncilProtocolError("consensus-missing", "latest consensus entry missing");
	const blockers = openBlockers(state);
	const personaVotes = proveCurrentVotes(state, history, consensus);
	const result = aggregateVotes(personaVotes, blockers.map((blocker) => blocker.id));
	if (result.result !== "yay" || consensus.result !== "yay") throw new CouncilProtocolError("not-unanimous", "exact-six unanimous yay not proven");
	if (consensus.subject.headSha !== headSha || consensus.subject.proposalDigest !== proposalDigest) throw new CouncilProtocolError("stale-consensus-entry", "consensus subject differs from current assertion");
	let closedEntryId: string | null = null;
	if (closedYay) {
		const closed = [...history].reverse().find((entry) => entry.stage === "closed" && entry.result === "yay");
		if (!closed || closed.turn <= consensus.turn) throw new CouncilProtocolError("closed-yay-missing", "closed-yay entry after consensus is missing");
		if (closed.subject.headSha !== headSha || closed.subject.proposalDigest !== proposalDigest) throw new CouncilProtocolError("stale-closed-entry", "closed-yay subject differs from current assertion");
		if (closed.stateDigest !== stateDigest(state)) throw new CouncilProtocolError("state-bus-mismatch", "closed-yay digest does not match final state");
		closedEntryId = closed.id;
	} else if (consensus.stateDigest !== stateDigest(state)) {
		throw new CouncilProtocolError("state-bus-mismatch", "consensus digest does not match state");
	}
	return { ok: true, result: "yay", runId: state.runId, reviewId: state.reviewId, cycle: state.cycle, consensusEntryId: consensus.id, closedEntryId, baseSha, headSha, proposalDigest };
}

function modeBlock(args: Record<string, string>, root: string): Json {
	const runId = required(args.run, "run");
	const reviewId = required(args.review, "review");
	const reason = required(args.reason, "reason").trim();
	if (reason.length < 20) throw new CouncilProtocolError("blocked-evidence", "blocked reason must explain the external impediment");
	return withLock(path.join(reviewDir(root, runId, reviewId), ".lock"), () => {
		const state = loadState(root, runId, reviewId);
		replayCouncilHistory(root, state, reviewEntries(root, runId, reviewId));
		if (!["discussing", "voting", "rework-required"].includes(state.status)) throw new CouncilProtocolError("illegal-transition", `${state.status} cannot transition to blocked`);
		const blockers = openBlockers(state);
		if (blockers.length === 0 || blockers.some((blocker) => blocker.evidenceRefs.length === 0)) throw new CouncilProtocolError("blocked-evidence", "blocking requires at least one unresolved evidence-backed hard blocker");
		const now = new Date().toISOString();
		state.turn++;
		state.status = "blocked";
		state.blockedReason = reason;
		state.updatedAt = now;
		const entry: CouncilEntry = {
			kind: "council", schemaVersion: 1, id: `${reviewId}-cycle-${state.cycle}-blocked`, runId, reviewId,
			cycle: state.cycle, turn: state.turn, stage: "rework", subject: { headSha: state.subject.headSha, proposalDigest: state.subject.proposalDigest },
			createdAt: now, result: "blocked", reason, openHardBlockers: blockers, evidenceRefs: blockers.flatMap((blocker) => blocker.evidenceRefs),
			nextAction: "blocked", author: "coordinator",
		};
		entry.stateDigest = stateDigest(state);
		appendBus(root, entry);
		atomicWrite(statePath(root, runId, reviewId), state);
		return { ok: true, blocked: true, entry, state };
	});
}

function modeClose(args: Record<string, string>, root: string): Json {
	const runId = required(args.run, "run");
	const reviewId = required(args.review, "review");
	const closeResult = required(args.result, "result");
	if (!["approved", "blocked", "user", "safety"].includes(closeResult)) throw new CouncilProtocolError("close-result", "--result must be approved, blocked, user, or safety");
	return withLock(path.join(reviewDir(root, runId, reviewId), ".lock"), () => {
		let state = loadState(root, runId, reviewId);
		replayCouncilHistory(root, state, reviewEntries(root, runId, reviewId));
		if (state.status === "closed") throw new CouncilProtocolError("illegal-transition", "review is already closed");
		let storedResult: "yay" | "blocked" | "user" | "safety";
		let assertion: Json | null = null;
		if (closeResult === "approved") {
			assertion = modeAssertYay(args, root);
			state = loadState(root, runId, reviewId);
			storedResult = "yay";
		} else if (closeResult === "blocked") {
			if (state.status !== "blocked") throw new CouncilProtocolError("illegal-transition", `${state.status} cannot close as blocked`);
			storedResult = "blocked";
		} else {
			storedResult = closeResult as "user" | "safety";
		}
		const now = new Date().toISOString();
		state.turn++;
		state.status = "closed";
		state.closedResult = storedResult;
		state.closedAt = now;
		state.updatedAt = now;
		const entry: CouncilEntry = {
			kind: "council", schemaVersion: 1, id: `${reviewId}-cycle-${state.cycle}-closed-${storedResult}`, runId, reviewId,
			cycle: state.cycle, turn: state.turn, stage: "closed", subject: { headSha: state.subject.headSha, proposalDigest: state.subject.proposalDigest },
			createdAt: now, result: storedResult, reason: args.reason ?? (storedResult === "yay" ? "approved-current-head-yay" : storedResult),
			openHardBlockers: openBlockers(state), author: "coordinator",
		};
		entry.stateDigest = stateDigest(state);
		appendBus(root, entry);
		atomicWrite(statePath(root, runId, reviewId), state);
		return { ok: true, result: storedResult, assertion, entry, state };
	});
}

function listStateFiles(root: string): string[] {
	const runs = path.join(root, ".optimizexp", "runs");
	if (!existsSync(runs)) return [];
	return readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((run) => {
		const consensus = path.join(runs, run.name, "consensus");
		if (!existsSync(consensus)) return [];
		return readdirSync(consensus, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(path.join(consensus, entry.name, "state.json"))).map((entry) => path.join(consensus, entry.name, "state.json"));
	});
}

function validateOne(root: string, state: CouncilState): string[] {
	const problems = validateCouncilState(state);
	const history = reviewEntries(root, state.runId, state.reviewId);
	let historyVerified = false;
	try { replayCouncilHistory(root, state, history); historyVerified = true; }
	catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
	const ids = new Set<string>();
	let lastCycle = -1;
	let lastTurn = -1;
	for (const entry of history) {
		if (ids.has(entry.id)) problems.push(`duplicate-entry-id:${entry.id}`);
		ids.add(entry.id);
		if (entry.cycle < lastCycle || (entry.cycle === lastCycle && entry.turn <= lastTurn)) problems.push(`non-monotonic-entry:${entry.id}`);
		if (entry.cycle !== lastCycle) { lastCycle = entry.cycle; lastTurn = -1; }
		lastTurn = entry.turn;
	}
	const latest = history.at(-1);
	if (!latest) problems.push("council-bus-missing");
	else {
		if (latest.cycle !== state.cycle || latest.turn !== state.turn) problems.push("state-bus-turn-mismatch");
		if (latest.stateDigest !== stateDigest(state)) problems.push("state-bus-digest-mismatch");
	}
	const introducedEntries = history.flatMap((entry) => (entry.hardBlockers ?? []).map((blocker) => ({ blocker, persona: entry.persona })));
	const introduced = introducedEntries.map(({ blocker }) => blocker.id);
	const resolutionEntries = history.filter((entry) => entry.stage === "blocker-resolution");
	const resolutions = new Set(resolutionEntries.map((entry) => String(entry.blockerId)));
	const persisted = new Set(COUNCIL_PERSONAS.flatMap((persona) => state.personas[persona].hardBlockers.map((blocker) => blocker.id)));
	for (const blocker of introduced) if (!persisted.has(blocker) && !resolutions.has(blocker)) problems.push(`blocker-silently-deleted:${blocker}`);
	for (const resolution of resolutionEntries) {
		const original = introducedEntries.find(({ blocker }) => blocker.id === resolution.blockerId);
		if (!original || original.persona !== resolution.originatingPersona) problems.push(`blocker-resolution-origin-mismatch:${String(resolution.blockerId)}`);
		const persona = resolution.originatingPersona as CouncilPersona;
		const stored = (COUNCIL_PERSONAS as readonly string[]).includes(persona)
			? state.personas[persona].hardBlockers.find((blocker) => blocker.id === resolution.blockerId)
			: undefined;
		// Verified cycle transitions retain only open blockers; historical resolutions remain in the bus.
		const retired = !stored && resolution.cycle < state.cycle && historyVerified;
		if (!retired && (!stored || stored.status !== resolution.resultingStatus)) problems.push(`blocker-resolution-state-mismatch:${String(resolution.blockerId)}`);
	}
	for (const persona of COUNCIL_PERSONAS) {
		for (const blocker of state.personas[persona].hardBlockers) {
			if (blocker.status !== "open" && !resolutions.has(blocker.id)) problems.push(`blocker-resolution-missing:${blocker.id}`);
		}
	}
	if (state.latestConsensusEntryId) {
		const consensus = history.find((entry) => entry.id === state.latestConsensusEntryId && entry.stage === "consensus");
		if (!consensus) problems.push("consensus-missing");
		else {
			try { proveCurrentVotes(state, history, consensus); }
			catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
		}
	}
	return [...new Set(problems)];
}

function modeValidate(args: Record<string, string>, root: string): Json {
	const stateFiles = args.run && args.review ? [statePath(root, args.run, args.review)] : listStateFiles(root);
	const problems: string[] = [];
	const stateKeys = new Set<string>();
	for (const file of stateFiles) {
		if (!existsSync(file)) { problems.push(`state-missing:${file}`); continue; }
		try {
			const state = readJson(file) as CouncilState;
			const relative = path.relative(path.join(root, ".optimizexp", "runs"), file).split(path.sep);
			const expectedRun = relative[0];
			const expectedReview = relative[2];
			if (state.runId !== expectedRun || state.reviewId !== expectedReview) throw new CouncilProtocolError("review-binding", `state ${state.runId}/${state.reviewId} is stored at ${expectedRun}/${expectedReview}`);
			stateKeys.add(`${state.runId}\0${state.reviewId}`);
			problems.push(...validateOne(root, state).map((problem) => `${path.relative(root, file)}:${problem}`));
		} catch (error) { problems.push(`${path.relative(root, file)}:${error instanceof Error ? error.message : String(error)}`); }
	}
	const seen = new Set<string>();
	for (const { file, body } of allBusEntries(root)) {
		if (body.kind !== "council") continue; // Existing expect/act/outcome/survey remain owned by review-loop validation.
		if (args.run && args.review && (body.runId !== args.run || body.reviewId !== args.review)) continue;
		if (typeof body.id !== "string") problems.push(`${file}:missing-id`);
		else if (seen.has(body.id)) problems.push(`${file}:duplicate-entry-id:${body.id}`);
		else seen.add(body.id);
		if (body.schemaVersion !== 1) problems.push(`${file}:schema-version`);
		if (!stateKeys.has(`${String(body.runId)}\0${String(body.reviewId)}`)) problems.push(`${file}:orphan-council-entry`);
		try {
			const stage = String(body.stage);
			if (PERSONA_STAGES.has(stage) || stage === "blocker-resolution") {
				const parsed = parseExternalEntry(body);
				if (stage === "blocker-resolution") validateResolutionShape(parsed);
			}
			else {
				if (!COORDINATOR_STAGES.has(stage)) throw new CouncilProtocolError("stage-enum", `${stage} is invalid`);
				if (body.author !== "coordinator" || body.persona !== undefined) throw new CouncilProtocolError("coordinator-only-stage", `${stage} must be coordinator-authored`);
				if (typeof body.stateDigest !== "string") throw new CouncilProtocolError("state-digest", `${stage} missing stateDigest`);
				if (stage === "open") {
					const membership = validateCouncilMembership(body.council as string[]);
					if (membership.length) throw new CouncilProtocolError("exact-six-membership", membership.join("; "));
				}
				if (stage === "consensus") {
					const aggregation = aggregateVotes(object(body.votes, "consensus.votes"), Array.isArray(body.openHardBlockers) ? body.openHardBlockers.map((blocker) => String((blocker as Json).id)) : []);
					if (aggregation.result !== body.result) throw new CouncilProtocolError("consensus-aggregation", "stored result does not match votes/blockers");
				}
			}
		} catch (error) { problems.push(`${file}:${error instanceof Error ? error.message : String(error)}`); }
	}
	return { ok: problems.length === 0, states: stateFiles.length, councilEntries: seen.size, problems };
}

function modeRelevance(args: Record<string, string>): Json {
	const input = object(readJson(required(args.input, "input")), "relevance input");
	const unknown = Object.keys(input).filter((key) => !["changedPaths", "acceptanceTags", "explicitlyRequested", "priorCouncilCycle", "exemption"].includes(key));
	if (unknown.length) throw new CouncilProtocolError("unknown-field", `relevance input contains ${unknown.join(", ")}`);
	return evaluateDesignRelevance(input as Parameters<typeof evaluateDesignRelevance>[0]);
}

function help(): Json {
	return {
		ok: true,
		usage: [
			"--mode init --run ID --review ID --base-sha SHA --head-sha SHA --proposal FILE [--max-turns N]",
			"--mode append --run ID --review ID --entry FILE",
			"--mode advance --run ID --review ID --persona ID",
			"--mode status --run ID --review ID",
			"--mode decide --run ID --review ID",
			"--mode validate [--run ID --review ID]",
			"--mode assert-yay --run ID --review ID --base-sha SHA --head-sha SHA --proposal FILE [--proposal-digest SHA256] [--base-ref REF]",
			"--mode block --run ID --review ID --reason TEXT",
			"--mode close --run ID --review ID --result approved|blocked|user|safety [--base-sha SHA --head-sha SHA --proposal FILE] [--reason TEXT]",
			"--mode relevance --input FILE",
		],
		note: "Synthetic investment is an auditable orchestration variable, not emotion or sentience. Maximum-turn protection must terminate blocked, never approved.",
	};
}

export function runConsensusCommand(argv: string[]): { exitCode: number; output: Json } {
	try {
		const args = parseArgs(argv);
		const root = repoRoot(args.root);
		let output: Json;
		switch (args.mode) {
			case "help": output = help(); break;
			case "init": output = modeInit(args, root); break;
			case "append": output = modeAppend(args, root); break;
			case "advance": output = modeAdvance(args, root); break;
			case "status": output = modeStatus(args, root); break;
			case "decide": output = modeDecide(args, root); break;
			case "validate": output = modeValidate(args, root); break;
			case "assert-yay": output = modeAssertYay(args, root); break;
			case "block": output = modeBlock(args, root); break;
			case "close": output = modeClose(args, root); break;
			case "relevance": output = modeRelevance(args); break;
			default: throw new CouncilProtocolError("cli-mode", `unknown mode ${args.mode}`);
		}
		return { exitCode: output.ok === false ? 1 : 0, output };
	} catch (error) {
		const protocol = error instanceof CouncilProtocolError ? error : new CouncilProtocolError("unexpected", error instanceof Error ? error.message : String(error));
		return { exitCode: 2, output: { ok: false, invariant: protocol.invariant, error: protocol.message } };
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const result = runConsensusCommand(process.argv.slice(2));
	console.log(JSON.stringify(result.output, null, 2));
	process.exitCode = result.exitCode;
}
