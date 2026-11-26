import {
	COUNCIL_PERSONAS,
	advanceInvestment,
	aggregateVotes,
	decayForEvidence,
	evaluateMergeEligibility,
	initialInvestment,
} from "../../../../.agents/skills/optimizexp/harness/lib/design-council.mts";
import type { DesignerCouncilWorld } from "./world.ts";

export function activatePersona(world: DesignerCouncilWorld, persona: string): void {
	world.personaId = persona;
}

export function setFeature(world: DesignerCouncilWorld, feature: string): void {
	world.featureId = feature;
}

export function seedRelevantJony(world: DesignerCouncilWorld): void {
	world.currentInvestment = initialInvestment(0.75, 0.75);
	world.investmentHistory = [world.currentInvestment];
}

export function supportConcernWithCurrentEvidence(world: DesignerCouncilWorld): void {
	if (world.currentInvestment <= 0) throw new Error("expected evidence-backed investment");
}

export function advanceSpeakingTurns(world: DesignerCouncilWorld): void {
	const decay = decayForEvidence(0.75);
	world.mayReply = world.currentInvestment > 0;
	while (world.currentInvestment > 0) {
		world.currentInvestment = advanceInvestment(world.currentInvestment, decay);
		world.investmentHistory.push(world.currentInvestment);
	}
	world.preferencesYielded = true;
}

export function assertMayReply(world: DesignerCouncilWorld): void {
	if (!world.mayReply) throw new Error("Jony Ive never had positive investment");
}

export function assertMonotonicDecay(world: DesignerCouncilWorld): void {
	for (let index = 1; index < world.investmentHistory.length; index++) {
		if (world.investmentHistory[index]! > world.investmentHistory[index - 1]!) {
			throw new Error("investment increased");
		}
	}
	if (world.investmentHistory.at(-1) !== 0) throw new Error("investment did not reach zero");
}

export function assertPreferencesYielded(world: DesignerCouncilWorld): void {
	if (!world.preferencesYielded || world.currentInvestment !== 0) {
		throw new Error("subjective preference did not yield at zero");
	}
}

export function fiveYays(world: DesignerCouncilWorld): void {
	world.votes = Object.fromEntries(COUNCIL_PERSONAS.slice(0, 5).map((id) => [id, "yay"]));
}

export function oneBlockerNay(world: DesignerCouncilWorld): void {
	world.votes[COUNCIL_PERSONAS[5]] = "nay";
	world.openHardBlockers = ["HB-shigeru-miyamoto-001"];
}

export function decideCouncil(world: DesignerCouncilWorld): void {
	world.result = aggregateVotes(world.votes, world.openHardBlockers).result;
	if (world.result === "nay") world.busStages.push("rework");
	world.mergeEligible = currentEligibility(world);
}

export function assertNay(world: DesignerCouncilWorld): void {
	if (world.result !== "nay") throw new Error(`expected nay, received ${world.result}`);
}

export function assertReworkAppended(world: DesignerCouncilWorld): void {
	if (!world.busStages.includes("rework")) throw new Error("rework was not appended");
}

export function assertNotMergeEligible(world: DesignerCouncilWorld): void {
	if (world.mergeEligible) throw new Error("nay review was merge eligible");
}

export function sixYays(world: DesignerCouncilWorld): void {
	world.votes = Object.fromEntries(COUNCIL_PERSONAS.map((id) => [id, "yay"]));
}

export function noHardBlocker(world: DesignerCouncilWorld): void {
	world.openHardBlockers = [];
}

export function votesMatchCurrentSubject(world: DesignerCouncilWorld): void {
	world.currentHeadSha = world.reviewedHeadSha;
}

export function assertConsensus(world: DesignerCouncilWorld): void {
	world.result = aggregateVotes(world.votes, world.openHardBlockers).result;
	world.mergeEligible = currentEligibility(world);
	world.assertExitCode = world.result === "yay" && world.mergeEligible ? 0 : 1;
	world.closeoutAllowed = world.assertExitCode === 0;
}

export function assertYayExitZero(world: DesignerCouncilWorld): void {
	if (world.assertExitCode !== 0) throw new Error("assert-yay did not exit zero");
}

export function assertCloseoutAllowed(world: DesignerCouncilWorld): void {
	if (!world.closeoutAllowed) throw new Error("SDLC closeout remained blocked");
}

export function approveOneHead(world: DesignerCouncilWorld): void {
	sixYays(world);
	noHardBlocker(world);
	assertConsensus(world);
}

export function changeHead(world: DesignerCouncilWorld): void {
	world.currentHeadSha = "d".repeat(64);
	world.mergeEligible = currentEligibility(world);
	world.assertExitCode = world.mergeEligible ? 0 : 1;
	world.reconvene = !world.mergeEligible;
}

export function assertYayFails(world: DesignerCouncilWorld): void {
	if (world.assertExitCode === 0) throw new Error("stale assert-yay succeeded");
}

export function assertReconvene(world: DesignerCouncilWorld): void {
	if (!world.reconvene) throw new Error("stale approval did not require reconvening");
}

function currentEligibility(world: DesignerCouncilWorld): boolean {
	return evaluateMergeEligibility({
		required: true,
		independentReviewPassed: true,
		commentsResolved: true,
		checks: [{ name: "focused", status: "pass" }],
		currentHeadSha: world.currentHeadSha,
		currentProposalDigest: world.proposalDigest,
		consensus: {
			result: world.result ?? "yay",
			reviewedHeadSha: world.reviewedHeadSha,
			proposalDigest: world.proposalDigest,
			votes: world.votes,
			openHardBlockers: world.openHardBlockers,
		},
	}).eligible;
}
