import type { Vote } from "../../../../.agents/skills/optimizexp/harness/lib/design-council.mts";

export type DesignerCouncilWorld = {
	featureId: string;
	personaId: string | null;
	currentInvestment: number;
	investmentHistory: number[];
	mayReply: boolean;
	preferencesYielded: boolean;
	votes: Record<string, Vote>;
	openHardBlockers: string[];
	result: Vote | null;
	busStages: string[];
	mergeEligible: boolean;
	assertExitCode: number | null;
	reconvene: boolean;
	closeoutAllowed: boolean;
	reviewedHeadSha: string;
	currentHeadSha: string;
	proposalDigest: string;
};

export function createWorld(): DesignerCouncilWorld {
	return {
		featureId: "designer-council-consensus",
		personaId: null,
		currentInvestment: 0,
		investmentHistory: [],
		mayReply: false,
		preferencesYielded: false,
		votes: {},
		openHardBlockers: [],
		result: null,
		busStages: [],
		mergeEligible: false,
		assertExitCode: null,
		reconvene: false,
		closeoutAllowed: false,
		reviewedHeadSha: "b".repeat(64),
		currentHeadSha: "b".repeat(64),
		proposalDigest: "c".repeat(64),
	};
}
