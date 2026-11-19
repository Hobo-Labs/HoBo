import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { afterEach, test } from "vitest";
import {
	applyTrainingArtifact,
	COMPONENT_METADATA,
	component,
	getAppliedArtifact,
	getTrainable,
	isTrainable,
	lintUseTrainingSource,
	listTrainables,
	operation,
	param,
	resetTrainables,
	resolveTrainable,
	stub,
	TRAINABLE_METADATA,
	TrainingArtifactError,
	TrainingGroundingError,
	TrainingResolutionError,
	trainable,
	training,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

afterEach(() => {
	resetTrainables();
});

interface DecoratorBag {
	readonly kind: string;
}

function decoratorContext<T>(bag: DecoratorBag): T {
	return bag as never;
}

interface Ticket {
	readonly subject: string;
}
interface Classification {
	readonly category: string;
}

const CONTRACT = {
	ref: "contract://support/classification@1.0.0",
	invariants: ["output.category in KnownCategories"],
	forbiddenOutputs: ["rationale contains PII"],
	examples: [
		{
			input: { subject: "cannot reset password" },
			output: { category: "access" },
		},
		{
			input: { subject: "site is down" },
			output: { category: "outage" },
		},
	],
} as const;

const OPTIONS = {
	intent: "Route tickets; critical only for security/outage/prod impact.",
	contract: CONTRACT,
	rubric: { categoryCorrect: 0.92, piiSafe: 1.0 },
	params: { ticket: { description: "Support ticket, PII-redacted" } },
	output: { category: { description: "One of the known categories" } },
} as const;

function artifactFor(methodRef: string) {
	return {
		engineId: "hobo.training-engine/built-in-opto@0.1.0",
		engineVersion: "1.0.0",
		methodRef,
		programJson: JSON.stringify({
			instructions: "Classify the ticket into a known category.",
			demos: [
				{
					inputJson: JSON.stringify({ subject: "billing question" }),
					outputJson: JSON.stringify({ category: "billing" }),
				},
			],
		}),
	};
}

test("training(fn, opts) wraps a body baseline and records calls", async () => {
	const classify = training(
		async (t: Ticket): Promise<Classification> => ({
			category: t.subject.includes("down") ? "outage" : "other",
		}),
		{ ...OPTIONS, methodRef: "classifyTicket" },
	);

	assert.ok(isTrainable(classify));
	const result = await classify({ subject: "site is down" });
	assert.equal(result.category, "outage");

	const recorded = getTrainable("classifyTicket");
	assert.ok(recorded);
	assert.equal(recorded.calls.length, 1);
	assert.equal(recorded.calls[0]?.served, "body");
	assert.equal(recorded.fact.baseline, "body");
});

test("grounding is required at construction (ADR-0025 lint)", () => {
	assert.throws(
		() =>
			training(async (t: Ticket) => t, {
				intent: "",
				contract: CONTRACT,
				rubric: {},
				methodRef: "ungrounded",
			}),
		TrainingGroundingError,
	);
});

test("training.define serves the contract-derived stub baseline", async () => {
	const classify = training.define<Ticket, Classification>({
		...OPTIONS,
		methodRef: "defineClassify",
	});

	const matched = await classify({ subject: "cannot reset password" });
	assert.equal(matched.category, "access");

	const canned = await classify({ subject: "something unseen" });
	assert.equal(canned.category, "access");

	const recorded = getTrainable("defineClassify");
	assert.ok(recorded);
	assert.equal(recorded.fact.baseline, "stub");
	assert.deepEqual(
		recorded.calls.map((call) => call.served),
		["matched-example", "canned"],
	);
});

test("training.define requires examples for a servable empty implementation", () => {
	assert.throws(
		() =>
			training.define({
				...OPTIONS,
				contract: { ref: CONTRACT.ref },
				methodRef: "noExamples",
			}),
		TrainingGroundingError,
	);
});

test("training(stub(), opts) is the explicit-stub spelling of define", async () => {
	const classify = training(stub<Ticket, Classification>(), {
		...OPTIONS,
		methodRef: "stubClassify",
	});
	const result = await classify({ subject: "site is down" });
	assert.equal(result.category, "outage");
	assert.equal(getTrainable("stubClassify")?.fact.baseline, "stub");
});

test("applyTrainingArtifact attaches demos the stub serves (apply-at-load)", async () => {
	const classify = training.define<Ticket, Classification>({
		...OPTIONS,
		methodRef: "artifactClassify",
	});

	const before = await classify({ subject: "billing question" });
	assert.equal(before.category, "access");

	applyTrainingArtifact(classify, artifactFor("artifactClassify"));
	assert.ok(getAppliedArtifact("artifactClassify"));

	const after = await classify({ subject: "billing question" });
	assert.equal(after.category, "billing");

	applyTrainingArtifact(classify, null);
	const reverted = await classify({ subject: "billing question" });
	assert.equal(reverted.category, "access");
});

test("applyTrainingArtifact accepts JSON strings and rejects mismatched methods", () => {
	training.define<Ticket, Classification>({
		...OPTIONS,
		methodRef: "target",
	});
	assert.throws(
		() => applyTrainingArtifact("target", artifactFor("someOtherMethod")),
		TrainingArtifactError,
	);
	const parsed = applyTrainingArtifact(
		"target",
		JSON.stringify(artifactFor("target")),
	);
	assert.equal(parsed?.methodRef, "target");
});

test("@trainable decorator lowers to identical manifest facts (ADR-0125 equivalence)", async () => {
	const wrapperForm = training(
		async (t: Ticket): Promise<Classification> => ({
			category: t.subject,
		}),
		{ ...OPTIONS, methodRef: "equivalent" },
	);
	await wrapperForm({ subject: "a" });
	const wrapperFact = getTrainable("equivalent")?.fact;
	resetTrainables();

	class Support {
		async classify(t: Ticket): Promise<Classification> {
			return { category: t.subject };
		}
	}
	const metadata: Record<PropertyKey, JsonValue> = {};
	const context = {
		kind: "method",
		name: "classify",
		static: false,
		private: false,
		metadata,
		access: {
			get: (instance: Support) => instance.classify,
			has: () => true,
		},
		addInitializer: () => {},
	} as ClassMethodDecoratorContext<
		Support,
		(this: Support, input: Ticket) => Promise<Classification>
	>;
	const decorated = trainable<Support, Ticket, Classification>({
		...OPTIONS,
		methodRef: "equivalent",
	})(Support.prototype.classify, context);
	Support.prototype.classify = decorated;

	const support = new Support();
	const result = await support.classify({ subject: "a" });
	assert.equal(result.category, "a");
	const decoratorFact = getTrainable("equivalent")?.fact;

	assert.deepEqual(
		JSON.parse(JSON.stringify(decoratorFact)),
		JSON.parse(JSON.stringify(wrapperFact)),
	);
	assert.deepEqual(metadata[TRAINABLE_METADATA], ["equivalent"]);
});

test("listTrainables exposes manifest facts for collection", () => {
	training.define<Ticket, Classification>({
		...OPTIONS,
		methodRef: "listed",
	});
	const facts = listTrainables();
	assert.equal(facts.length, 1);
	assert.equal(facts[0]?.methodRef, "listed");
	assert.equal(facts[0]?.contractRef, CONTRACT.ref);
	assert.deepEqual(facts[0]?.rubric, OPTIONS.rubric);
});

test("lintUseTrainingSource reports bare markers as inferred, not errors", () => {
	const bare = lintUseTrainingSource(
		'export async function f() { "use training"; return 1; }',
	);
	assert.equal(bare.ok, true);
	assert.equal(bare.inferred, true);
	assert.deepEqual(
		bare.findings.map((f) => f.kind),
		["intent", "contract", "rubric"],
	);
	assert.ok(bare.findings.every((f) => f.severity === "info"));

	const grounded = lintUseTrainingSource(
		`/** @intent classify */ export const f = training(async () => 1, { intent: "x", contract: C, rubric: { a: 1 } }); // "use training"`,
	);
	assert.equal(grounded.ok, true);
	assert.notEqual(grounded.inferred, true);
	assert.equal(grounded.findings.length, 0);
});

test("DI form: @trainable registers eagerly at construction and resolves by token", async () => {
	const ClassifyToken = Symbol("token-classify");

	class Desk {
		async classify(t: Ticket): Promise<Classification> {
			return { category: t.subject };
		}
	}
	const initializers: Array<(this: Desk) => void> = [];
	const context = decoratorContext<
		ClassMethodDecoratorContext<
			Desk,
			(this: Desk, input: Ticket) => Promise<Classification>
		>
	>({
		kind: "method",
		name: "classify",
		static: false,
		private: false,
		metadata: {},
		access: { get: (instance: Desk) => instance.classify, has: () => true },
		addInitializer: (fn: (this: Desk) => void) => initializers.push(fn),
	});
	Desk.prototype.classify = trainable<Desk, Ticket, Classification>({
		...OPTIONS,
		token: ClassifyToken,
	})(Desk.prototype.classify, context);

	const desk = new Desk();
	for (const init of initializers) init.call(desk);

	const fact = getTrainable("token-classify")?.fact;
	assert.equal(fact?.methodRef, "token-classify");
	assert.equal(getTrainable(ClassifyToken)?.calls.length, 0);

	const resolved = resolveTrainable<Ticket, Classification>(ClassifyToken);
	for (const example of CONTRACT.examples) {
		const output = await resolved(example.input);
		assert.equal(output.category, example.input.subject);
	}
	assert.equal(getTrainable(ClassifyToken)?.calls.length, 2);

	applyTrainingArtifact(ClassifyToken, artifactFor("token-classify"));
	assert.ok(getAppliedArtifact(ClassifyToken));
	applyTrainingArtifact(ClassifyToken, null);
	assert.equal(getAppliedArtifact(ClassifyToken), null);
});

test("DI form: second construction resolves the registered singleton", async () => {
	class Desk {
		async classify(t: Ticket): Promise<Classification> {
			return { category: t.subject };
		}
	}
	const initializers: Array<(this: Desk) => void> = [];
	const context = decoratorContext<
		ClassMethodDecoratorContext<
			Desk,
			(this: Desk, input: Ticket) => Promise<Classification>
		>
	>({
		kind: "method",
		name: "singleton",
		static: false,
		private: false,
		metadata: {},
		access: { get: (instance: Desk) => instance.classify, has: () => true },
		addInitializer: (fn: (this: Desk) => void) => initializers.push(fn),
	});
	Desk.prototype.classify = trainable<Desk, Ticket, Classification>({
		...OPTIONS,
		methodRef: "singleton",
	})(Desk.prototype.classify, context);

	for (const instance of [new Desk(), new Desk()]) {
		for (const init of initializers) init.call(instance);
	}
	assert.equal(
		listTrainables().filter((f) => f.methodRef === "singleton").length,
		1,
	);
});

test("resolveTrainable throws a resolution error for unknown refs", () => {
	assert.throws(() => resolveTrainable("nope"), TrainingResolutionError);
	assert.throws(
		() => resolveTrainable(Symbol("unbound")),
		TrainingResolutionError,
	);
});

test("marker form: training.infer grounds a bare use-training function", async () => {
	async function rankFeed(input: Ticket): Promise<Classification> {
		"use training";
		return { category: input.subject.toUpperCase() };
	}
	const ranked = training.infer(rankFeed);

	const record = getTrainable("rankFeed");
	assert.equal(record?.fact.contractRef, "inferred://rankFeed");
	assert.equal(record?.fact.baseline, "body");
	assert.deepEqual(record?.fact.rubric, { exactMatch: 1 });
	assert.match(record?.fact.intent ?? "", /rankFeed/);

	assert.deepEqual(await ranked({ subject: "abc" }), { category: "ABC" });
	applyTrainingArtifact("rankFeed", {
		...artifactFor("rankFeed"),
	});
	assert.ok(getAppliedArtifact("rankFeed"));
	assert.deepEqual(await ranked({ subject: "billing question" }), {
		category: "billing",
	});
	assert.deepEqual(await ranked({ subject: "unseen" }), { category: "UNSEEN" });
	applyTrainingArtifact("rankFeed", null);
	assert.deepEqual(await ranked({ subject: "billing question" }), {
		category: "BILLING QUESTION",
	});
	assert.deepEqual(
		getTrainable("rankFeed")?.calls.map((call) => call.served),
		["body", "matched-demo", "body", "body"],
	);
});

test("marker form: infer requires the directive and honors overrides", () => {
	async function unmarked(input: Ticket): Promise<Classification> {
		return { category: input.subject };
	}
	assert.throws(() => training.infer(unmarked), TrainingGroundingError);

	async function marked(input: Ticket): Promise<Classification> {
		"use training";
		return { category: input.subject };
	}
	training.infer(marked, {
		methodRef: "refined",
		rubric: { categoryCorrect: 0.9 },
	});
	const fact = getTrainable("refined")?.fact;
	assert.equal(fact?.contractRef, "inferred://refined");
	assert.deepEqual(fact?.rubric, { categoryCorrect: 0.9 });
});

test("marker form: structured intent and explicit overrides take precedence", async () => {
	async function summarize(input: Ticket): Promise<Classification> {
		"use training";
		return { category: input.subject };
	}
	summarize.trainingIntent = "Summarize the ticket subject.";
	const summarized = training.infer(summarize);
	assert.equal(
		getTrainable("summarize")?.fact.intent,
		summarize.trainingIntent,
	);
	assert.deepEqual(await summarized({ subject: "access" }), {
		category: "access",
	});

	async function classify(input: Ticket): Promise<Classification> {
		"use training";
		return { category: input.subject };
	}
	classify.trainingIntent = "Use the structured intent.";
	training.infer(classify, { intent: "Use the explicit override." });
	assert.equal(
		getTrainable("classify")?.fact.intent,
		"Use the explicit override.",
	);
});

test("marker form: an authored comment provides training intent", () => {
	async function summarize(input: Ticket): Promise<Classification> {
		"use training";
		// One-paragraph summary; no blame, no internal names.
		return { category: input.subject };
	}
	training.infer(summarize);
	assert.equal(
		getTrainable("summarize")?.fact.intent,
		"One-paragraph summary; no blame, no internal names.",
	);
});

test.each([
	[
		"line",
		"// One-paragraph summary; no blame, no internal names.",
		"One-paragraph summary; no blame, no internal names.",
	],
	[
		"block",
		"/* Summarize the ticket subject. */",
		"Summarize the ticket subject.",
	],
])("marker form: %s comments provide training intent", (_kind, comment, intent) => {
	const source = [
		"async function summarize(input) {",
		'  "use training";',
		`  ${comment}`,
		"  return { category: input.subject };",
		"}",
	].join("\n");
	const summarize: ((input: Ticket) => Promise<Classification>) & {
		trainingIntent?: string;
	} = runInNewContext(`(${source})`);
	summarize.trainingIntent = "Secondary structured intent.";
	training.infer(summarize);
	assert.equal(getTrainable("summarize")?.fact.intent, intent);
});

test("marker form: an empty comment does not turn code into intent", () => {
	const source = [
		"async function summarize(input) {",
		'  "use training";',
		"  //",
		"  return { category: input.subject };",
		"}",
	].join("\n");
	const summarize: ((input: Ticket) => Promise<Classification>) & {
		trainingIntent?: string;
	} = runInNewContext(`(${source})`);
	summarize.trainingIntent = "Summarize the ticket subject.";
	training.infer(summarize);
	assert.equal(
		getTrainable("summarize")?.fact.intent,
		"Summarize the ticket subject.",
	);
});

test("rubric is optional: declaration grounds with intent + shape alone", () => {
	const declared = training.define<Ticket, Classification>({
		methodRef: "storefront.classify",
		intent: "Route tickets to the right queue.",
		contract: {
			input: { subject: "string" },
			output: { category: "string" },
		},
	});
	assert.equal(isTrainable(declared), true);
	const fact = getTrainable("storefront.classify")?.fact;
	assert.deepEqual(fact?.rubric, {});
	assert.equal(fact?.contractRef, "decl://storefront.classify");
});

test("shape is not optional: a contract needs a ref or input + output", () => {
	assert.throws(
		() =>
			training.define<Ticket, Classification>({
				methodRef: "storefront.unshaped",
				intent: "Route tickets.",
				contract: { input: { subject: "string" } },
			}),
		TrainingGroundingError,
	);
});

test("an explicit contract ref still wins over the synthesized one", () => {
	training.define<Ticket, Classification>({
		methodRef: "storefront.reffed",
		intent: "Route tickets.",
		contract: { ...CONTRACT },
	});
	assert.equal(
		getTrainable("storefront.reffed")?.fact.contractRef,
		CONTRACT.ref,
	);
});

test("@component + @operation declare a component; param() annotates", async () => {
	class Storefront {
		async classify(_ticket: Ticket): Promise<Classification> {
			return { category: "unset" };
		}
	}
	const context = decoratorContext<
		ClassMethodDecoratorContext<
			Storefront,
			(this: Storefront, input: Ticket) => Promise<Classification>
		>
	>({
		kind: "method",
		name: "classify",
		metadata: {},
		addInitializer: undefined,
	});
	Storefront.prototype.classify = operation<Storefront, Ticket, Classification>(
		{
			methodRef: "storefront.operation.classify",
			intent: "Route tickets to the right queue.",
			contract: {
				input: { subject: "string" },
				output: { category: "string" },
			},
			params: { ticket: param("Support ticket, PII-redacted") },
			output: { category: param("Known category", "outage") },
		},
	)(Storefront.prototype.classify, context);
	component({ intent: "Support desk operations." })(
		Storefront,
		decoratorContext<ClassDecoratorContext<typeof Storefront>>({
			kind: "class",
			name: "Storefront",
			metadata: context.metadata,
		}),
	);

	const componentMeta = (context.metadata as Record<symbol, JsonValue>)[
		COMPONENT_METADATA
	] as {
		intent: string;
		operations: readonly string[];
	};
	assert.equal(componentMeta.intent, "Support desk operations.");
	assert.deepEqual(componentMeta.operations, ["storefront.operation.classify"]);

	const desk = new Storefront();
	const out = await desk.classify({ subject: "site is down" });
	assert.equal(out.category, "unset");
	const fact = getTrainable("storefront.operation.classify")?.fact;
	assert.equal(fact?.contractRef, "decl://storefront.operation.classify");
	assert.equal(
		fact?.params.ticket?.description,
		"Support ticket, PII-redacted",
	);
	assert.equal(fact?.output.category?.exampleJson, JSON.stringify("outage"));
});

test("@operation field form: a stub() initializer declares code to generate", async () => {
	class Storefront {
		rankFeed!: (input: Ticket) => Promise<Classification>;
	}
	const metadata: Record<PropertyKey, JsonValue> = {};
	const transform = operation<Storefront, Ticket, Classification>({
		methodRef: "storefront.field.rankFeed",
		intent: "Rank the feed.",
		contract: {
			input: { subject: "string" },
			output: { category: "string" },
			examples: [
				{ input: { subject: "seed" }, output: { category: "ranked" } },
			],
		},
	})(
		undefined,
		decoratorContext<
			ClassFieldDecoratorContext<
				Storefront,
				(input: Ticket) => Promise<Classification>
			>
		>({
			kind: "field",
			name: "rankFeed",
			metadata,
			static: false,
			private: false,
		}),
	);

	const desk = new Storefront();
	desk.rankFeed = (
		transform as (
			this: Storefront,
			initial: ((input: Ticket) => Promise<Classification>) | undefined,
		) => (input: Ticket) => Promise<Classification>
	).call(desk, stub<Ticket, Classification>());

	const record = getTrainable("storefront.field.rankFeed");
	assert.equal(record?.fact.baseline, "stub");
	assert.equal(record?.fact.contractRef, "decl://storefront.field.rankFeed");
	const out = await desk.rankFeed({ subject: "seed" });
	assert.equal(out.category, "ranked");
	assert.deepEqual(metadata[TRAINABLE_METADATA], ["storefront.field.rankFeed"]);
});
