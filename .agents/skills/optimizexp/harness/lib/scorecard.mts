/** Formal metric scorecard helpers for expect / act / outcome. */

export type PrimaryScores = {
	harms: number;
	friction: number;
	uncertainty: number;
	total: number;
	max: number;
};

/** Higher-is-better delight metrics (Phase 2 / survey). */
export type PositiveScores = {
	excitement: number;
	easeOfUse: number;
	perceivedOptimality: number;
	total: number;
	min: number;
	gapTotal: number;
	gapMax: number;
};

/** Lower-is-better cognitive load channels (see cognitive-thresholds.md). */
export type CognitiveKey =
	| "featureSprawl"
	| "visualClutter"
	| "interactiveClutter"
	| "choiceOverload"
	| "informationDensity"
	| "noveltyTax"
	| "contextSwitchTax"
	| "workingMemoryLoad"
	| "interruptionFragility";

export const COGNITIVE_KEYS: CognitiveKey[] = [
	"featureSprawl",
	"visualClutter",
	"interactiveClutter",
	"choiceOverload",
	"informationDensity",
	"noveltyTax",
	"contextSwitchTax",
	"workingMemoryLoad",
	"interruptionFragility",
];

export type CognitiveScores = {
	featureSprawl: number;
	visualClutter: number;
	interactiveClutter: number;
	choiceOverload: number;
	informationDensity: number;
	noveltyTax: number;
	contextSwitchTax: number;
	workingMemoryLoad: number;
	interruptionFragility: number;
	total: number;
	max: number;
	breaches: CognitiveKey[];
};

export type CognitiveThresholds = Partial<Record<CognitiveKey, number>>;

export type HcdKey =
	| "visibilityOfSystemStatus"
	| "matchWithMentalModel"
	| "userControlAndFreedom"
	| "consistencyAndStandards"
	| "errorPrevention"
	| "recognitionOverRecall"
	| "flexibilityAndEfficiency"
	| "aestheticAndMinimalistDesign"
	| "errorRecovery"
	| "helpAndDocumentation"
	| "accessibilityAndInclusion"
	| "trustAndSafety";

export const HCD_KEYS: HcdKey[] = [
	"visibilityOfSystemStatus",
	"matchWithMentalModel",
	"userControlAndFreedom",
	"consistencyAndStandards",
	"errorPrevention",
	"recognitionOverRecall",
	"flexibilityAndEfficiency",
	"aestheticAndMinimalistDesign",
	"errorRecovery",
	"helpAndDocumentation",
	"accessibilityAndInclusion",
	"trustAndSafety",
];

/**
 * Falsifiability rubric: one programmatic check against a captured evidence
 * artifact (a directory containing capture-evidence `meta.json`). At least one
 * assertion field is required per check. Evaluated by lib/evidence-checks.mts.
 */
export type EvidenceCheck = {
	/** Evidence artifact dir (repo-root-relative or absolute) containing meta.json. */
	evidence: string;
	/** Assert meta.json exitCode equals / not-equals this integer. */
	exitCodeEquals?: number;
	exitCodeNotEquals?: number;
	/** Regex asserted against the primary transcript file content. */
	transcriptContains?: string;
	transcriptNotContains?: string;
	/**
	 * Perceptual budgets — asserted against meta.json `timing` / `frameStats`
	 * captured by the drivers. These make responsiveness and flicker claims
	 * falsifiable the same way exit codes are.
	 */
	/** meta.timing.durationMs must be < this. */
	durationUnderMs?: number;
	/** meta.timing.timeToFirstOutputMs must exist and be < this. */
	firstOutputUnderMs?: number;
	/** meta.frameStats.maxSilentGapMs must exist and be < this (TUI recordings). */
	maxSilentGapUnderMs?: number;
	/** meta.frameStats.totalOutputBytes must be < this (repaint-thrash budget). */
	totalOutputBytesUnder?: number;
	/** Optional note: what this check proves. */
	note?: string;
};

export type MetricScorecard = {
	schemaVersion: 1;
	phase: "expect" | "act" | "outcome";
	role: "predicted" | "observed" | "judged";
	persona: string;
	surface: string;
	primary: PrimaryScores;
	/** Phase 2 / survey — optional on Phase 1 harm-only cards. */
	positive?: PositiveScores;
	/** Cognitive load channels — required in delight regime when judging uplift. */
	cognitive?: CognitiveScores;
	hcd?: Partial<Record<HcdKey, number>>;
	hcdTotal?: number;
	hcdMax?: number;
	rationale: {
		harms?: string;
		friction?: string;
		uncertainty?: string;
		excitement?: string;
		easeOfUse?: string;
		perceivedOptimality?: string;
	};
	evidenceRefs: string[];
	/** Optional falsifiability rubric — every check is programmatically evaluated. */
	evidenceChecks?: EvidenceCheck[];
	/** Required when scores intentionally repeat a prior measurement (e.g. baseline carry-over). */
	justification?: string;
	scoredAt: string;
};

export type ScoreDelta = {
	harms: number;
	friction: number;
	uncertainty: number;
	total: number;
	max: number;
};

export type OutcomeComparison = {
	expectId: string;
	actId?: string;
	deltaFromExpect: ScoreDelta;
	deltaFromAct?: ScoreDelta;
	matchedExpectation: boolean;
	expectationMatch: {
		behavior: boolean;
		scoresWithinTol: boolean;
		tolerance: number;
	};
};

function isInt0to5(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 5;
}

export function buildPrimary(
	harms: number,
	friction: number,
	uncertainty: number,
): PrimaryScores {
	return {
		harms,
		friction,
		uncertainty,
		total: harms + friction + uncertainty,
		max: Math.max(harms, friction, uncertainty),
	};
}

export function buildPositive(
	excitement: number,
	easeOfUse: number,
	perceivedOptimality: number,
): PositiveScores {
	const total = excitement + easeOfUse + perceivedOptimality;
	const min = Math.min(excitement, easeOfUse, perceivedOptimality);
	const gapExcitement = 5 - excitement;
	const gapEase = 5 - easeOfUse;
	const gapOptimal = 5 - perceivedOptimality;
	return {
		excitement,
		easeOfUse,
		perceivedOptimality,
		total,
		min,
		gapTotal: gapExcitement + gapEase + gapOptimal,
		gapMax: Math.max(gapExcitement, gapEase, gapOptimal),
	};
}

export function validatePositive(raw: unknown, prefix = "scores.positive"): string[] {
	const problems: string[] = [];
	if (!raw || typeof raw !== "object") {
		return [`${prefix}: missing or not an object`];
	}
	const p = raw as Partial<PositiveScores>;
	for (const k of ["excitement", "easeOfUse", "perceivedOptimality"] as const) {
		if (!isInt0to5(p[k])) problems.push(`${prefix}.${k} must be int 0-5`);
	}
	if (
		isInt0to5(p.excitement) &&
		isInt0to5(p.easeOfUse) &&
		isInt0to5(p.perceivedOptimality)
	) {
		const expected = buildPositive(p.excitement, p.easeOfUse, p.perceivedOptimality);
		if (p.total !== expected.total) {
			problems.push(`${prefix}.total must be ${expected.total}`);
		}
		if (p.min !== expected.min) {
			problems.push(`${prefix}.min must be ${expected.min}`);
		}
		if (p.gapTotal !== expected.gapTotal) {
			problems.push(`${prefix}.gapTotal must be ${expected.gapTotal}`);
		}
		if (p.gapMax !== expected.gapMax) {
			problems.push(`${prefix}.gapMax must be ${expected.gapMax}`);
		}
	}
	return problems;
}

export function cognitiveBreaches(
	measured: Partial<Record<CognitiveKey, number>>,
	thresholds: CognitiveThresholds = {},
): CognitiveKey[] {
	const breaches: CognitiveKey[] = [];
	for (const k of COGNITIVE_KEYS) {
		const m = measured[k];
		if (!isInt0to5(m)) continue;
		const t = thresholds[k];
		const limit = typeof t === "number" ? t : 3;
		if (m > limit) breaches.push(k);
	}
	return breaches;
}

export function buildCognitive(
	channels: Partial<Record<CognitiveKey, number>>,
	thresholds: CognitiveThresholds = {},
): CognitiveScores {
	const full = {} as Record<CognitiveKey, number>;
	let total = 0;
	let max = 0;
	for (const k of COGNITIVE_KEYS) {
		const v = channels[k];
		const n = isInt0to5(v) ? v : 0;
		full[k] = n;
		total += n;
		max = Math.max(max, n);
	}
	return {
		...full,
		total,
		max,
		breaches: cognitiveBreaches(full, thresholds),
	};
}

export function validateCognitive(
	raw: unknown,
	prefix = "scores.cognitive",
): string[] {
	const problems: string[] = [];
	if (!raw || typeof raw !== "object") {
		return [`${prefix}: missing or not an object`];
	}
	const c = raw as Partial<CognitiveScores>;
	for (const k of COGNITIVE_KEYS) {
		if (!isInt0to5(c[k])) problems.push(`${prefix}.${k} must be int 0-5`);
	}
	if (COGNITIVE_KEYS.every((k) => isInt0to5(c[k]))) {
		const expected = buildCognitive(
			Object.fromEntries(COGNITIVE_KEYS.map((k) => [k, c[k]!])) as Record<
				CognitiveKey,
				number
			>,
		);
		// rebuild without thresholds for total/max check
		let total = 0;
		let max = 0;
		for (const k of COGNITIVE_KEYS) {
			total += c[k] as number;
			max = Math.max(max, c[k] as number);
		}
		if (c.total !== total) problems.push(`${prefix}.total must be ${total}`);
		if (c.max !== max) problems.push(`${prefix}.max must be ${max}`);
		if (!Array.isArray(c.breaches)) {
			problems.push(`${prefix}.breaches must be an array`);
		}
		void expected;
	}
	return problems;
}

/** Pareto admissibility: delight improved, harm not worse, no new cognitive breach. */
export function isParetoAdmissible(input: {
	prevHarm: PrimaryScores;
	currHarm: PrimaryScores;
	prevPositive?: PositiveScores;
	currPositive?: PositiveScores;
	cognitiveBreaches?: string[];
}): { ok: boolean; reasons: string[] } {
	const reasons: string[] = [];
	if (input.currHarm.total > input.prevHarm.total) {
		reasons.push("harm total increased");
	}
	if (input.currHarm.max > input.prevHarm.max) {
		reasons.push("harm max increased");
	}
	if (input.cognitiveBreaches && input.cognitiveBreaches.length > 0) {
		reasons.push(`cognitive breaches: ${input.cognitiveBreaches.join(",")}`);
	}
	if (input.prevPositive && input.currPositive) {
		const delightUp =
			input.currPositive.min > input.prevPositive.min ||
			input.currPositive.total > input.prevPositive.total ||
			input.currPositive.gapMax < input.prevPositive.gapMax ||
			input.currPositive.gapTotal < input.prevPositive.gapTotal;
		if (!delightUp) reasons.push("delight did not improve");
	}
	return { ok: reasons.length === 0, reasons };
}

export function deltaPrimary(from: PrimaryScores, to: PrimaryScores): ScoreDelta {
	// positive = worse than baseline
	return {
		harms: to.harms - from.harms,
		friction: to.friction - from.friction,
		uncertainty: to.uncertainty - from.uncertainty,
		total: to.total - from.total,
		max: to.max - from.max,
	};
}

export function scoresWithinTolerance(
	predicted: PrimaryScores,
	judged: PrimaryScores,
	tolerance = 0,
): boolean {
	return (
		Math.abs(judged.harms - predicted.harms) <= tolerance &&
		Math.abs(judged.friction - predicted.friction) <= tolerance &&
		Math.abs(judged.uncertainty - predicted.uncertainty) <= tolerance
	);
}

/** Pure shape validation for the evidenceChecks rubric (no filesystem access). */
export function validateEvidenceChecksShape(raw: unknown): string[] {
	if (!Array.isArray(raw)) return ["scores.evidenceChecks must be an array"];
	const problems: string[] = [];
	raw.forEach((c, i) => {
		const prefix = `scores.evidenceChecks[${i}]`;
		if (!c || typeof c !== "object") {
			problems.push(`${prefix}: must be an object`);
			return;
		}
		const check = c as Partial<EvidenceCheck>;
		if (!check.evidence || typeof check.evidence !== "string") {
			problems.push(`${prefix}.evidence required (string path to evidence dir)`);
		}
		for (const k of ["exitCodeEquals", "exitCodeNotEquals"] as const) {
			const v = check[k];
			if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v))) {
				problems.push(`${prefix}.${k} must be an integer`);
			}
		}
		for (const k of ["transcriptContains", "transcriptNotContains"] as const) {
			const v = check[k];
			if (v !== undefined && typeof v !== "string") {
				problems.push(`${prefix}.${k} must be a string (regex)`);
			}
		}
		for (const k of [
			"durationUnderMs",
			"firstOutputUnderMs",
			"maxSilentGapUnderMs",
			"totalOutputBytesUnder",
		] as const) {
			const v = check[k];
			if (v !== undefined && (typeof v !== "number" || !(v > 0))) {
				problems.push(`${prefix}.${k} must be a positive number (ms/bytes)`);
			}
		}
		if (
			check.exitCodeEquals === undefined &&
			check.exitCodeNotEquals === undefined &&
			check.transcriptContains === undefined &&
			check.transcriptNotContains === undefined &&
			check.durationUnderMs === undefined &&
			check.firstOutputUnderMs === undefined &&
			check.maxSilentGapUnderMs === undefined &&
			check.totalOutputBytesUnder === undefined
		) {
			problems.push(`${prefix}: at least one assertion required`);
		}
	});
	return problems;
}

export function validateScorecard(
	raw: unknown,
	expectedPhase?: MetricScorecard["phase"],
): string[] {
	const problems: string[] = [];
	if (!raw || typeof raw !== "object") {
		return ["scores: missing or not an object"];
	}
	const s = raw as Partial<MetricScorecard>;
	if (s.schemaVersion !== 1) problems.push("scores.schemaVersion must be 1");
	if (expectedPhase && s.phase !== expectedPhase) {
		problems.push(`scores.phase must be ${expectedPhase}`);
	} else if (!["expect", "act", "outcome"].includes(String(s.phase))) {
		problems.push("scores.phase invalid");
	}
	const roleByPhase: Record<string, string> = {
		expect: "predicted",
		act: "observed",
		outcome: "judged",
	};
	if (s.phase && s.role !== roleByPhase[s.phase]) {
		problems.push(
			`scores.role must be ${roleByPhase[s.phase!]} for phase ${s.phase}`,
		);
	}
	if (!s.persona || typeof s.persona !== "string") {
		problems.push("scores.persona required");
	}
	if (!s.surface || typeof s.surface !== "string") {
		problems.push("scores.surface required");
	}
	const p = s.primary;
	if (!p || typeof p !== "object") {
		problems.push("scores.primary required");
	} else {
		for (const k of ["harms", "friction", "uncertainty"] as const) {
			if (!isInt0to5(p[k])) problems.push(`scores.primary.${k} must be int 0-5`);
		}
		if (isInt0to5(p.harms) && isInt0to5(p.friction) && isInt0to5(p.uncertainty)) {
			const total = p.harms + p.friction + p.uncertainty;
			const max = Math.max(p.harms, p.friction, p.uncertainty);
			if (p.total !== total) {
				problems.push(`scores.primary.total must be ${total}`);
			}
			if (p.max !== max) {
				problems.push(`scores.primary.max must be ${max}`);
			}
		}
	}
	if (!s.rationale || typeof s.rationale !== "object") {
		problems.push("scores.rationale required");
	} else if (p && typeof p === "object") {
		for (const k of ["harms", "friction", "uncertainty"] as const) {
			if (isInt0to5(p[k]) && p[k]! >= 1 && !s.rationale[k]) {
				problems.push(`scores.rationale.${k} required when primary.${k} >= 1`);
			}
		}
	}
	if (!Array.isArray(s.evidenceRefs)) {
		problems.push("scores.evidenceRefs must be an array");
	}
	if (s.phase === "act" || s.phase === "outcome") {
		if (Array.isArray(s.evidenceRefs) && s.evidenceRefs.length === 0) {
			problems.push(`scores.evidenceRefs should be non-empty for ${s.phase}`);
		}
	}
	if (!s.scoredAt || typeof s.scoredAt !== "string") {
		problems.push("scores.scoredAt required");
	}
	if (s.hcd && typeof s.hcd === "object") {
		let hcdTotal = 0;
		let hcdMax = 0;
		for (const key of Object.keys(s.hcd)) {
			const v = (s.hcd as Record<string, unknown>)[key];
			if (!isInt0to5(v)) problems.push(`scores.hcd.${key} must be int 0-5`);
			else {
				hcdTotal += v;
				hcdMax = Math.max(hcdMax, v);
			}
		}
		if (s.hcdTotal !== undefined && s.hcdTotal !== hcdTotal) {
			problems.push(`scores.hcdTotal must be ${hcdTotal}`);
		}
		if (s.hcdMax !== undefined && s.hcdMax !== hcdMax) {
			problems.push(`scores.hcdMax must be ${hcdMax}`);
		}
	}
	if (s.positive !== undefined) {
		problems.push(...validatePositive(s.positive));
		if (s.rationale && typeof s.rationale === "object" && s.positive) {
			const pos = s.positive as PositiveScores;
			for (const k of ["excitement", "easeOfUse", "perceivedOptimality"] as const) {
				if (isInt0to5(pos[k]) && pos[k]! <= 3 && !s.rationale[k]) {
					problems.push(
						`scores.rationale.${k} required when positive.${k} <= 3`,
					);
				}
			}
		}
	}
	if (s.cognitive !== undefined) {
		problems.push(...validateCognitive(s.cognitive));
	}
	if (s.evidenceChecks !== undefined) {
		problems.push(...validateEvidenceChecksShape(s.evidenceChecks));
	}
	if (s.justification !== undefined && typeof s.justification !== "string") {
		problems.push("scores.justification must be a string");
	}
	return problems;
}

export function validateComparison(
	raw: unknown,
	expectPrimary?: PrimaryScores,
	actPrimary?: PrimaryScores,
	judged?: PrimaryScores,
): string[] {
	const problems: string[] = [];
	if (!raw || typeof raw !== "object") {
		return ["comparison: missing"];
	}
	const c = raw as Partial<OutcomeComparison>;
	if (!c.expectId) problems.push("comparison.expectId required");
	if (!c.deltaFromExpect || typeof c.deltaFromExpect !== "object") {
		problems.push("comparison.deltaFromExpect required");
	} else if (expectPrimary && judged) {
		const d = deltaPrimary(expectPrimary, judged);
		for (const k of ["harms", "friction", "uncertainty", "total", "max"] as const) {
			if (c.deltaFromExpect[k] !== d[k]) {
				problems.push(
					`comparison.deltaFromExpect.${k} must be ${d[k]} (judged - expect)`,
				);
			}
		}
	}
	if (actPrimary && judged && c.deltaFromAct) {
		const d = deltaPrimary(actPrimary, judged);
		for (const k of ["harms", "friction", "uncertainty", "total", "max"] as const) {
			if (c.deltaFromAct[k] !== d[k]) {
				problems.push(
					`comparison.deltaFromAct.${k} must be ${d[k]} (judged - act)`,
				);
			}
		}
	}
	if (!c.expectationMatch || typeof c.expectationMatch !== "object") {
		problems.push("comparison.expectationMatch required");
	} else {
		if (typeof c.expectationMatch.behavior !== "boolean") {
			problems.push("comparison.expectationMatch.behavior must be boolean");
		}
		if (typeof c.expectationMatch.scoresWithinTol !== "boolean") {
			problems.push("comparison.expectationMatch.scoresWithinTol must be boolean");
		}
		if (
			typeof c.expectationMatch.tolerance !== "number" ||
			c.expectationMatch.tolerance < 0
		) {
			problems.push("comparison.expectationMatch.tolerance must be >= 0");
		}
		if (expectPrimary && judged && typeof c.expectationMatch.tolerance === "number") {
			const within = scoresWithinTolerance(
				expectPrimary,
				judged,
				c.expectationMatch.tolerance,
			);
			if (c.expectationMatch.scoresWithinTol !== within) {
				problems.push(
					`comparison.expectationMatch.scoresWithinTol must be ${within}`,
				);
			}
			const overall =
				Boolean(c.expectationMatch.behavior) &&
				Boolean(c.expectationMatch.scoresWithinTol);
			if (c.matchedExpectation !== overall) {
				problems.push(
					`comparison.matchedExpectation must be ${overall} (behavior && scoresWithinTol)`,
				);
			}
		}
	}
	return problems;
}

export function makeScorecard(input: {
	phase: MetricScorecard["phase"];
	persona: string;
	surface: string;
	harms: number;
	friction: number;
	uncertainty: number;
	excitement?: number;
	easeOfUse?: number;
	perceivedOptimality?: number;
	rationale?: MetricScorecard["rationale"];
	evidenceRefs?: string[];
	hcd?: MetricScorecard["hcd"];
	scoredAt?: string;
}): MetricScorecard {
	const role =
		input.phase === "expect"
			? "predicted"
			: input.phase === "act"
				? "observed"
				: "judged";
	const primary = buildPrimary(input.harms, input.friction, input.uncertainty);
	const card: MetricScorecard = {
		schemaVersion: 1,
		phase: input.phase,
		role,
		persona: input.persona,
		surface: input.surface,
		primary,
		rationale: input.rationale ?? {},
		evidenceRefs: input.evidenceRefs ?? [],
		scoredAt: input.scoredAt ?? new Date().toISOString(),
	};
	if (
		input.excitement !== undefined &&
		input.easeOfUse !== undefined &&
		input.perceivedOptimality !== undefined
	) {
		card.positive = buildPositive(
			input.excitement,
			input.easeOfUse,
			input.perceivedOptimality,
		);
	}
	if (input.hcd) {
		card.hcd = input.hcd;
		let total = 0;
		let max = 0;
		for (const k of Object.keys(input.hcd) as HcdKey[]) {
			const v = input.hcd[k];
			if (typeof v === "number") {
				total += v;
				max = Math.max(max, v);
			}
		}
		card.hcdTotal = total;
		card.hcdMax = max;
	}
	return card;
}

export function makeComparison(input: {
	expectId: string;
	actId?: string;
	expectPrimary: PrimaryScores;
	actPrimary?: PrimaryScores;
	judgedPrimary: PrimaryScores;
	behaviorMatched: boolean;
	tolerance?: number;
}): OutcomeComparison {
	const tolerance = input.tolerance ?? 0;
	const scoresWithinTol = scoresWithinTolerance(
		input.expectPrimary,
		input.judgedPrimary,
		tolerance,
	);
	const comparison: OutcomeComparison = {
		expectId: input.expectId,
		deltaFromExpect: deltaPrimary(input.expectPrimary, input.judgedPrimary),
		matchedExpectation: input.behaviorMatched && scoresWithinTol,
		expectationMatch: {
			behavior: input.behaviorMatched,
			scoresWithinTol,
			tolerance,
		},
	};
	if (input.actId) comparison.actId = input.actId;
	if (input.actPrimary) {
		comparison.deltaFromAct = deltaPrimary(
			input.actPrimary,
			input.judgedPrimary,
		);
	}
	return comparison;
}
