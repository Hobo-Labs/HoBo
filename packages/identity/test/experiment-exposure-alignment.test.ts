import { describe, expect, it } from "vitest";
import {
	analyzeExperimentFromEngine,
	createBuiltinExperimentAnalysis,
	createHarness,
	EXPERIMENT_EVENTS,
	experimentAllocation,
	type FeatureFlagPort,
	FeatureFlagStore,
	type FlagDefinition,
	OpenDeliveryEngine,
	OpenExperimentEngine,
} from "../src/index.js";
import { isJsonObject } from "../src/json.js";

function engineWithFlag(percentage = 100) {
	const store = new FeatureFlagStore({ sampleRate: 1 });
	store.define({
		key: "checkout",
		percentage,
		variants: { control: false, treatment: true },
		defaultVariant: "control",
	});
	const engine = new OpenExperimentEngine({ store });
	engine.define({
		name: "checkout-experiment",
		flag: "checkout",
		variants: ["control", "treatment"],
		allocation: { weights: { control: 30, treatment: 70 } },
	});
	return { engine, store };
}

describe("experiment exposure and flag evaluation", () => {
	it("records what the flag serves at each ramp while retaining sticky allocation", () => {
		const { engine, store } = engineWithFlag(0);
		const subjects = Array.from({ length: 500 }, (_, index) => ({
			targetingKey: `subject-${index}`,
		}));
		const assignments = subjects.map((context) =>
			engine.assign("checkout-experiment", context),
		);
		const treatments: number[] = [];
		for (const percentage of [0, 25, 100]) {
			store.define({ key: "checkout", percentage });
			let treatmentCount = 0;
			for (const [index, context] of subjects.entries()) {
				const evaluation = store.evaluate("checkout", context, false);
				const exposure = engine.evaluateAndExpose(
					"checkout-experiment",
					context,
				);
				const event = engine.events.at(-1);
				expect(exposure.variant).toBe(evaluation.variant);
				expect(exposure.assignedVariant ?? exposure.variant).toBe(
					assignments[index]?.variant,
				);
				expect(event?.type).toBe(EXPERIMENT_EVENTS.Exposed);
				expect(event?.data.variant).toBe(evaluation.variant);
				expect(event?.data.reason).toBe(evaluation.reason);
				expect(
					engine.getAssignment("checkout-experiment", context.targetingKey)
						?.variant,
				).toBe(assignments[index]?.variant);
				if (evaluation.variant === "treatment") treatmentCount += 1;
			}
			treatments.push(treatmentCount);
		}
		expect(treatments[0]).toBe(0);
		expect(treatments[1]).toBeGreaterThan(45);
		expect(treatments[1]).toBeLessThan(140);
		expect(treatments[2]).toBeGreaterThan(290);
		expect(treatments[2]).toBeLessThan(410);
		const common = { targetingKey: "common" };
		expect(engine.evaluateAndExpose("checkout-experiment", common)).toEqual(
			engine.assign("checkout-experiment", common),
		);
	});

	it("preserves targeting, tenant isolation, disabled state and kill-switch behavior", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "checkout",
			percentage: 0,
			enabled: false,
			state: "DISABLED",
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			metadata: { tenant: "tenant-a" },
			targeting: {
				rules: [
					{ attribute: "segment", equals: "forced", variant: "treatment" },
				],
			},
		});
		const engine = new OpenExperimentEngine({ store });
		engine.define({
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		expect(store.get("checkout")?.state).toBe("DISABLED");
		const forced = {
			targetingKey: "subject",
			tenant: "tenant-a",
			attributes: { segment: "forced" },
		};
		const assertActual = (context: typeof forced) => {
			const evaluation = store.evaluate("checkout", context, false);
			const exposure = engine.evaluateAndExpose("checkout-experiment", context);
			expect(exposure.variant).toBe(evaluation.variant);
			expect(engine.events.at(-1)?.data.variant).toBe(evaluation.variant);
			expect(engine.events.at(-1)?.data.reason).toBe(evaluation.reason);
		};
		assertActual(forced);
		store.define({ key: "checkout", enabled: true, state: "ENABLED" });
		expect(store.evaluate("checkout", forced, false).variant).toBe("treatment");
		assertActual(forced);
		assertActual({ ...forced, tenant: "tenant-b" });
		expect(store.get("checkout")?.metadata.tenant).toBe("tenant-a");
		expect(
			store.evaluate("checkout", { ...forced, tenant: "tenant-b" }, false)
				.reason,
		).toBe("fail-safe-default");
		store.activateKillSwitch("checkout");
		expect(store.evaluate("checkout", forced, false).reason).toBe(
			"kill-switch",
		);
		assertActual(forced);
	});

	it("preserves a suspended ramp when an experiment is attached during a kill switch", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "checkout",
			percentage: 30,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
		});
		store.activateKillSwitch("checkout");
		const engine = new OpenExperimentEngine({ store });
		engine.define({
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		expect(store.get("checkout")?.percentage).toBe(0);
		expect(store.get("checkout")?.suspendedPercentage).toBe(30);
		expect(store.clearKillSwitch("checkout")?.percentage).toBe(30);
	});

	it("preserves tenant restrictions with a replacement-style external flag port", () => {
		let backing = new FeatureFlagStore();
		backing.define({
			key: "checkout",
			percentage: 100,
			metadata: { tenant: "tenant-a", owner: "fixture" },
			targeting: {
				rules: [{ attribute: "segment", equals: "forced", variant: "control" }],
			},
			variants: { control: false, treatment: true },
			defaultVariant: "control",
		});
		const external: FeatureFlagPort = {
			experimentAllocationVersion: 1,
			applyExperimentAllocation(input) {
				return this.define(input);
			},
			get rulesetSeq() {
				return backing.rulesetSeq;
			},
			list: () => backing.list(),
			get: (key) => backing.get(key),
			define(input) {
				const replacement = new FeatureFlagStore();
				const flag = replacement.define(input);
				backing = replacement;
				return flag;
			},
			loadDefinitions: (definitions) => backing.loadDefinitions(definitions),
			evaluate: (key, context, value) => backing.evaluate(key, context, value),
			evaluateBoolean: (key, context, value) =>
				backing.evaluateBoolean(key, context, value),
			activateKillSwitch: (key, actor) =>
				backing.activateKillSwitch(key, actor),
			clearKillSwitch: (key, actor) => backing.clearKillSwitch(key, actor),
			archive: (key) => backing.archive(key),
		};
		const engine = new OpenExperimentEngine({ store: external });
		engine.define({
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		expect(external.get("checkout")?.metadata).toMatchObject({
			tenant: "tenant-a",
			owner: "fixture",
		});
		expect(
			external.evaluate("checkout", {
				targetingKey: "subject",
				tenant: "tenant-b",
			}).reason,
		).toBe("fail-safe-default");
		expect(
			external.evaluate("checkout", {
				targetingKey: "subject",
				tenant: "tenant-a",
				attributes: { segment: "forced" },
			}).variant,
		).toBe("control");
		const allocation = external.get("checkout")?.experimentAllocation;
		const delivery = new OpenDeliveryEngine({ store: external });
		delivery.start({
			name: "checkout-rollout",
			flag: "checkout",
			stages: [{ percent: 25 }],
			traffic: "flag-only",
			autoRollback: true,
		});
		expect(external.get("checkout")?.experimentAllocation).toEqual(allocation);
		expect(external.get("checkout")?.metadata.tenant).toBe("tenant-a");
		expect(
			external.evaluate("checkout", {
				targetingKey: "subject",
				tenant: "tenant-b",
			}).reason,
		).toBe("fail-safe-default");
	});

	it("preserves existing fractional subject assignments when attaching an experiment", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "checkout",
			percentage: 100,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			targeting: {
				fractional: {
					key: ["targetingKey"],
					variants: [{ control: 30 }, { treatment: 70 }],
				},
			},
		});
		const contexts = Array.from({ length: 500 }, (_, index) => ({
			targetingKey: `subject-${index}`,
			tenant: index % 2 === 0 ? "tenant-a" : "tenant-b",
		}));
		const before = contexts.map(
			(context) => store.evaluate("checkout", context).variant,
		);
		const engine = new OpenExperimentEngine({ store });
		engine.define({
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
			allocation: { weights: { control: 30, treatment: 70 } },
		});
		expect(
			contexts.map((context) => store.evaluate("checkout", context).variant),
		).toEqual(before);
		for (const [index, context] of contexts.entries())
			expect(engine.assign("checkout-experiment", context).variant).toBe(
				before[index],
			);
		store.define({ key: "checkout", percentage: 25 });
		const partial = contexts.filter(
			(context) => store.evaluate("checkout", context).variant === "treatment",
		).length;
		expect(partial).toBeGreaterThan(35);
		expect(partial).toBeLessThan(140);
	});

	it.each([
		0, 25,
	])("refuses attaching to an existing fractional flag at %i percent before changing it", (percentage) => {
		const store = new FeatureFlagStore();
		store.define({
			key: "checkout",
			percentage,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			targeting: {
				fractional: {
					key: ["targetingKey"],
					variants: [{ control: 30 }, { treatment: 70 }],
				},
			},
		});
		const contexts = Array.from({ length: 100 }, (_, index) => ({
			targetingKey: `subject-${index}`,
		}));
		const before = store.get("checkout");
		const variants = contexts.map(
			(context) => store.evaluate("checkout", context).variant,
		);
		const engine = new OpenExperimentEngine({ store });
		expect(() =>
			engine.define({
				name: "checkout-experiment",
				flag: "checkout",
				variants: ["control", "treatment"],
			}),
		).toThrow(/fractional|rollout/i);
		expect(store.get("checkout")).toEqual(before);
		expect(
			contexts.map((context) => store.evaluate("checkout", context).variant),
		).toEqual(variants);
		expect(engine.list()).toEqual([]);
	});

	it("reattaches an unchanged fractional experiment after a partial ramp is reloaded", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "checkout",
			percentage: 100,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			targeting: {
				fractional: {
					key: ["targetingKey"],
					variants: [{ control: 30 }, { treatment: 70 }],
				},
			},
		});
		const definition = {
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		};
		new OpenExperimentEngine({ store }).define(definition);
		store.define({ key: "checkout", percentage: 25 });
		const snapshot = store.get("checkout");
		if (!snapshot) throw new Error("missing flag snapshot");
		const contexts = Array.from({ length: 100 }, (_, index) => ({
			targetingKey: `subject-${index}`,
		}));
		const before = contexts.map(
			(context) => store.evaluate("checkout", context).variant,
		);
		const restarted = new FeatureFlagStore();
		restarted.loadDefinitions([snapshot]);
		const engine = new OpenExperimentEngine({ store: restarted });
		expect(() => engine.define(definition)).not.toThrow();
		expect(
			contexts.map(
				(context) => restarted.evaluate("checkout", context).variant,
			),
		).toEqual(before);
	});

	it("reattaches an unchanged fractional experiment while its partial ramp is killed", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "checkout",
			percentage: 100,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			targeting: {
				fractional: {
					key: ["targetingKey"],
					variants: [{ control: 30 }, { treatment: 70 }],
				},
			},
		});
		const definition = {
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		};
		new OpenExperimentEngine({ store }).define(definition);
		store.define({ key: "checkout", percentage: 25 });
		store.activateKillSwitch("checkout");
		const snapshot = store.get("checkout");
		if (!snapshot) throw new Error("missing flag snapshot");
		const restarted = new FeatureFlagStore();
		restarted.loadDefinitions([snapshot]);
		const engine = new OpenExperimentEngine({ store: restarted });
		expect(() => engine.define(definition)).not.toThrow();
		expect(restarted.get("checkout")).toMatchObject({
			killSwitch: true,
			percentage: 0,
			suspendedPercentage: 25,
		});
		expect(restarted.clearKillSwitch("checkout")?.percentage).toBe(25);
	});

	it("keeps other fractional flags unchanged and refuses a conflicting allocation", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "unrelated",
			percentage: 0,
			variants: { a: "A", b: "B" },
			defaultVariant: "a",
			targeting: {
				fractional: { key: ["targetingKey"], variants: [{ a: 25 }, { b: 75 }] },
			},
		});
		const contexts = Array.from({ length: 100 }, (_, index) => ({
			targetingKey: `subject-${index}`,
		}));
		const before = contexts.map(
			(context) => store.evaluate("unrelated", context).variant,
		);
		const engine = new OpenExperimentEngine({ store });
		engine.define({
			name: "separate",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		expect(
			contexts.map((context) => store.evaluate("unrelated", context).variant),
		).toEqual(before);
		const previous = store.get("unrelated");
		expect(() =>
			engine.define({
				name: "conflict",
				flag: "unrelated",
				variants: ["a", "b"],
				allocation: { weights: { a: 90, b: 10 } },
			}),
		).toThrow(/fractional|allocation/i);
		expect(store.get("unrelated")).toEqual(previous);
	});

	it("keeps allocation stable across runtime instances and rejects changing an active allocation", () => {
		const first = engineWithFlag();
		const second = engineWithFlag();
		for (let index = 0; index < 100; index += 1) {
			const context = { targetingKey: `subject-${index}` };
			expect(first.engine.assign("checkout-experiment", context).variant).toBe(
				second.engine.assign("checkout-experiment", context).variant,
			);
		}
		expect(() =>
			first.engine.define({
				name: "checkout-experiment",
				flag: "checkout",
				variants: ["control", "treatment"],
				allocation: { weights: { control: 80, treatment: 20 } },
			}),
		).toThrow(/assignment|allocation/i);
	});

	it("retains the allocation in definitions and change events across reload", () => {
		const { store } = engineWithFlag();
		const snapshot = store.get("checkout");
		if (!snapshot) throw new Error("missing snapshot");
		const lastChange = store.events.findLast(
			(event) =>
				event.data.key === "checkout" &&
				(event.type === "flag.Defined" || event.type === "flag.Changed"),
		);
		expect(lastChange?.data.experimentAllocation).toMatchObject({
			name: "checkout-experiment",
			weights: { control: 30, treatment: 70 },
		});
		const restored = new FeatureFlagStore();
		restored.loadDefinitions([snapshot]);
		for (let index = 0; index < 100; index += 1) {
			const context = { targetingKey: `subject-${index}` };
			expect(restored.evaluate("checkout", context).variant).toBe(
				store.evaluate("checkout", context).variant,
			);
		}
	});

	it("refuses changing an active allocation through the flag port", () => {
		const { engine, store } = engineWithFlag();
		engine.assign("checkout-experiment", { targetingKey: "subject" });
		const before = store.get("checkout");
		const replacement = experimentAllocation(
			"checkout-experiment",
			["control", "treatment"],
			{ control: 80, treatment: 20 },
		);
		expect(() =>
			store.define({ key: "checkout", experimentAllocation: replacement }),
		).toThrow(/allocation/i);
		expect(store.get("checkout")).toEqual(before);
	});

	it("detects a conflicting saved allocation before invoking an external apply", () => {
		const { store } = engineWithFlag();
		const before = store.get("checkout");
		const restarted = new OpenExperimentEngine({ store });
		expect(() =>
			restarted.define({
				name: "checkout-experiment",
				flag: "checkout",
				variants: ["control", "treatment"],
				allocation: { weights: { control: 80, treatment: 20 } },
			}),
		).toThrow(
			expect.objectContaining({ code: "experiment-allocation-conflict" }),
		);
		expect(store.get("checkout")).toEqual(before);
	});

	it("accepts reordered fractional object fields while preserving array order", () => {
		const store = new FeatureFlagStore();
		const fractional = {
			key: ["identity.userId", "targetingKey"],
			variants: [{ control: 30 }, { treatment: 70 }],
		};
		store.define({
			key: "checkout",
			percentage: 100,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			targeting: { fractional },
		});
		new OpenExperimentEngine({ store }).define({
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		expect(() =>
			store.define({
				key: "checkout",
				targeting: {
					fractional: { variants: fractional.variants, key: fractional.key },
				},
			}),
		).not.toThrow();
		expect(() =>
			store.define({
				key: "checkout",
				targeting: {
					fractional: {
						variants: [...fractional.variants].reverse(),
						key: fractional.key,
					},
				},
			}),
		).toThrow(/fractional/i);
	});

	it("refuses changing an attached fractional split while allowing targeting rules", () => {
		const store = new FeatureFlagStore();
		const fractional = {
			key: ["targetingKey"],
			variants: [{ control: 30 }, { treatment: 70 }],
		};
		store.define({
			key: "checkout",
			percentage: 100,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			targeting: { fractional },
		});
		const engine = new OpenExperimentEngine({ store });
		engine.define({
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		const before = store.get("checkout");
		expect(() =>
			store.define({
				key: "checkout",
				targeting: {
					fractional: {
						key: ["targetingKey"],
						variants: [{ control: 80 }, { treatment: 20 }],
					},
				},
			}),
		).toThrow(/fractional|allocation/i);
		expect(store.get("checkout")).toEqual(before);
		expect(() =>
			store.define({
				key: "checkout",
				targeting: { fractional, stickyKey: "other-key" },
			}),
		).toThrow(/sticky|allocation/i);
		expect(store.get("checkout")).toEqual(before);
		expect(() =>
			store.define({
				key: "checkout",
				targeting: {
					fractional,
					rules: [
						{ attribute: "segment", equals: "forced", variant: "control" },
					],
				},
			}),
		).not.toThrow();
	});

	it("keeps sticky assignments isolated for the same subject in different tenants", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "checkout",
			percentage: 100,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			targeting: {
				fractional: {
					key: ["group"],
					variants: [{ control: 50 }, { treatment: 50 }],
				},
			},
		});
		const engine = new OpenExperimentEngine({ store });
		engine.define({
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		const first = {
			targetingKey: "same-subject",
			tenant: "tenant-a",
			attributes: { group: "group-a" },
		};
		const firstVariant = store.evaluate("checkout", first).variant;
		const alternative = Array.from(
			{ length: 100 },
			(_, index) => `group-${index}`,
		).find(
			(group) =>
				store.evaluate("checkout", {
					...first,
					tenant: "tenant-b",
					attributes: { group },
				}).variant !== firstVariant,
		);
		expect(alternative).toBeDefined();
		if (alternative === undefined) return;
		const second = {
			...first,
			tenant: "tenant-b",
			attributes: { group: alternative },
		};
		const firstAssignment = engine.assign("checkout-experiment", first);
		const secondAssignment = engine.assign("checkout-experiment", second);
		expect(firstAssignment.variant).toBe(firstVariant);
		expect(secondAssignment.variant).toBe(
			store.evaluate("checkout", second).variant,
		);
		expect(
			engine.getAssignment(
				"checkout-experiment",
				first.targetingKey,
				first.tenant,
			),
		).toEqual(firstAssignment);
		expect(
			engine.getAssignment(
				"checkout-experiment",
				second.targetingKey,
				second.tenant,
			),
		).toEqual(secondAssignment);
		expect(
			engine.getAssignment("checkout-experiment", first.targetingKey),
		).toBeUndefined();
		const assigned = engine.events.filter(
			(event) => event.type === EXPERIMENT_EVENTS.Assigned,
		);
		expect(assigned).toHaveLength(2);
		expect(assigned[0]?.data.subjectKeyHash).not.toBe(
			assigned[1]?.data.subjectKeyHash,
		);
	});

	it("refuses an external flag port that cannot apply the experiment allocation", () => {
		const backing = new FeatureFlagStore();
		const external: FeatureFlagPort = {
			get rulesetSeq() {
				return backing.rulesetSeq;
			},
			list: () => backing.list(),
			get: (key) => backing.get(key),
			define: (input) => backing.define({ key: input.key }),
			loadDefinitions: (definitions) => backing.loadDefinitions(definitions),
			evaluate: (key, context, value) => backing.evaluate(key, context, value),
			evaluateBoolean: (key, context, value) =>
				backing.evaluateBoolean(key, context, value),
			activateKillSwitch: (key, actor) =>
				backing.activateKillSwitch(key, actor),
			clearKillSwitch: (key, actor) => backing.clearKillSwitch(key, actor),
			archive: (key) => backing.archive(key),
		};
		const engine = new OpenExperimentEngine({ store: external });
		expect(() =>
			engine.define({
				name: "checkout",
				flag: "checkout",
				variants: ["control", "treatment"],
			}),
		).toThrow(/allocation|support/i);
		expect(backing.get("checkout")).toBeUndefined();
	});

	it("reports reconciliation when a claimed external apply leaves a partial mutation", () => {
		const backing = new FeatureFlagStore();
		const external: FeatureFlagPort = {
			experimentAllocationVersion: 1,
			get rulesetSeq() {
				return backing.rulesetSeq;
			},
			list: () => backing.list(),
			get: (key) => backing.get(key),
			define: (input) => backing.define(input),
			applyExperimentAllocation(input) {
				const { experimentAllocation: _discarded, ...partial } = input;
				return backing.define(partial);
			},
			loadDefinitions: (definitions) => backing.loadDefinitions(definitions),
			evaluate: (key, context, value) => backing.evaluate(key, context, value),
			evaluateBoolean: (key, context, value) =>
				backing.evaluateBoolean(key, context, value),
			activateKillSwitch: (key, actor) =>
				backing.activateKillSwitch(key, actor),
			clearKillSwitch: (key, actor) => backing.clearKillSwitch(key, actor),
			archive: (key) => backing.archive(key),
		};
		const engine = new OpenExperimentEngine({ store: external });
		expect(() =>
			engine.define({
				name: "checkout",
				flag: "checkout",
				variants: ["control", "treatment"],
			}),
		).toThrow(
			expect.objectContaining({
				code: "experiment-allocation-reconcile-required",
			}),
		);
		expect(engine.list()).toEqual([]);
		expect(backing.get("checkout")?.metadata.experiment).toBe("checkout");
		expect(backing.get("checkout")?.experimentAllocation).toBeUndefined();
	});

	it("refuses an external apply that silently drops tenant controls", () => {
		let backing = new FeatureFlagStore();
		backing.define({ key: "checkout", metadata: { tenant: "tenant-a" } });
		const external: FeatureFlagPort = {
			experimentAllocationVersion: 1,
			get rulesetSeq() {
				return backing.rulesetSeq;
			},
			list: () => backing.list(),
			get: (key) => backing.get(key),
			define: (input) => backing.define(input),
			applyExperimentAllocation(input) {
				const replacement = new FeatureFlagStore();
				const flag = replacement.applyExperimentAllocation({
					...input,
					metadata: { experiment: "checkout-experiment" },
				});
				backing = replacement;
				return flag;
			},
			loadDefinitions: (definitions) => backing.loadDefinitions(definitions),
			evaluate: (key, context, value) => backing.evaluate(key, context, value),
			evaluateBoolean: (key, context, value) =>
				backing.evaluateBoolean(key, context, value),
			activateKillSwitch: (key, actor) =>
				backing.activateKillSwitch(key, actor),
			clearKillSwitch: (key, actor) => backing.clearKillSwitch(key, actor),
			archive: (key) => backing.archive(key),
		};
		const engine = new OpenExperimentEngine({ store: external });
		expect(() =>
			engine.define({
				name: "checkout-experiment",
				flag: "checkout",
				variants: ["control", "treatment"],
			}),
		).toThrow(
			expect.objectContaining({
				code: "experiment-allocation-reconcile-required",
			}),
		);
		expect(engine.list()).toEqual([]);
	});

	it.each([
		"equivalent",
		"variant-array",
		"targeting-rules",
	] as const)("compares replacement-port JSON objects semantically while preserving %s order", (change) => {
		const backing = new FeatureFlagStore();
		backing.define({
			key: "checkout",
			percentage: 100,
			variants: {
				control: { copy: { first: "one", second: "two" }, order: [1, 2] },
				treatment: true,
			},
			defaultVariant: "control",
			targeting: {
				stickyKey: "user",
				rules: [
					{ attribute: "region", equals: "one", variant: "control" },
					{ attribute: "region", equals: "two", variant: "treatment" },
				],
			},
		});
		const external: FeatureFlagPort = {
			experimentAllocationVersion: 1,
			get rulesetSeq() {
				return backing.rulesetSeq;
			},
			list: () => backing.list(),
			get: (key) => backing.get(key),
			define: (input) => backing.define(input),
			applyExperimentAllocation(input) {
				const applied = backing.applyExperimentAllocation(input);
				const rules = [
					{ variant: "control", equals: "one", attribute: "region" },
					{ variant: "treatment", equals: "two", attribute: "region" },
				];
				return {
					...applied,
					targeting: {
						rules: change === "targeting-rules" ? rules.reverse() : rules,
						stickyKey: "user",
					},
					variants: {
						...applied.variants,
						control: {
							order: change === "variant-array" ? [2, 1] : [1, 2],
							copy: { second: "two", first: "one" },
						},
					},
				};
			},
			loadDefinitions: (definitions) => backing.loadDefinitions(definitions),
			evaluate: (key, context, value) => backing.evaluate(key, context, value),
			evaluateBoolean: (key, context, value) =>
				backing.evaluateBoolean(key, context, value),
			activateKillSwitch: (key, actor) =>
				backing.activateKillSwitch(key, actor),
			clearKillSwitch: (key, actor) => backing.clearKillSwitch(key, actor),
			archive: (key) => backing.archive(key),
		};
		const engine = new OpenExperimentEngine({ store: external });
		const define = () =>
			engine.define({
				name: "checkout-experiment",
				flag: "checkout",
				variants: ["control", "treatment"],
			});
		if (change === "equivalent") {
			expect(define).not.toThrow();
		} else {
			expect(define).toThrow(
				expect.objectContaining({
					code: "experiment-allocation-reconcile-required",
				}),
			);
		}
	});

	it("requires a new external flag to match the requested key and initial controls", () => {
		const backing = new FeatureFlagStore();
		const external: FeatureFlagPort = {
			experimentAllocationVersion: 1,
			get rulesetSeq() {
				return backing.rulesetSeq;
			},
			list: () => backing.list(),
			get: (key) => backing.get(key),
			define: (input) => backing.define(input),
			applyExperimentAllocation: (input) =>
				backing.applyExperimentAllocation({ ...input, key: "other-flag" }),
			loadDefinitions: (definitions) => backing.loadDefinitions(definitions),
			evaluate: (key, context, value) => backing.evaluate(key, context, value),
			evaluateBoolean: (key, context, value) =>
				backing.evaluateBoolean(key, context, value),
			activateKillSwitch: (key, actor) =>
				backing.activateKillSwitch(key, actor),
			clearKillSwitch: (key, actor) => backing.clearKillSwitch(key, actor),
			archive: (key) => backing.archive(key),
		};
		const engine = new OpenExperimentEngine({ store: external });
		expect(() =>
			engine.define({
				name: "checkout-experiment",
				flag: "checkout",
				variants: ["control", "treatment"],
			}),
		).toThrow(
			expect.objectContaining({
				code: "experiment-allocation-reconcile-required",
			}),
		);
		expect(backing.get("checkout")).toBeUndefined();
		expect(backing.get("other-flag")).toBeDefined();
		expect(engine.list()).toEqual([]);
	});

	it.each([
		["enabled", { enabled: false }],
		["state", { state: "DISABLED" }],
		["percentage", { percentage: 10 }],
		["suspended percentage", { suspendedPercentage: 10 }],
		["default value", { defaultValue: true }],
		["default variant", { defaultVariant: "treatment" }],
		["variant value", { variants: { control: false, treatment: false } }],
		[
			"extra allocation weight",
			{
				experimentAllocation: {
					name: "checkout-experiment",
					variants: ["control", "treatment"],
					weights: { control: 50, treatment: 50, unexpected: 100 },
					strategy: "salted",
				},
			},
		],
		[
			"metadata",
			{ metadata: { experiment: "checkout-experiment", tenant: "unexpected" } },
		],
		["kill switch", { killSwitch: true }],
		["targeting", { targeting: { rules: [] } }],
		["migration", { migrationId: "unexpected" }],
		["abort setting", { autoAbortOnDualFailure: true }],
	] satisfies readonly (readonly [
		string,
		Partial<FlagDefinition>,
	])[])("rejects a new external flag with a changed %s", (_label, override) => {
		const backing = new FeatureFlagStore();
		const external: FeatureFlagPort = {
			experimentAllocationVersion: 1,
			get rulesetSeq() {
				return backing.rulesetSeq;
			},
			list: () => backing.list(),
			get: (key) => backing.get(key),
			define: (input) => backing.define(input),
			applyExperimentAllocation: (input) => ({
				...backing.applyExperimentAllocation(input),
				...override,
			}),
			loadDefinitions: (definitions) => backing.loadDefinitions(definitions),
			evaluate: (key, context, value) => backing.evaluate(key, context, value),
			evaluateBoolean: (key, context, value) =>
				backing.evaluateBoolean(key, context, value),
			activateKillSwitch: (key, actor) =>
				backing.activateKillSwitch(key, actor),
			clearKillSwitch: (key, actor) => backing.clearKillSwitch(key, actor),
			archive: (key) => backing.archive(key),
		};
		const engine = new OpenExperimentEngine({ store: external });
		expect(() =>
			engine.define({
				name: "checkout-experiment",
				flag: "checkout",
				variants: ["control", "treatment"],
			}),
		).toThrow(
			expect.objectContaining({
				code: "experiment-allocation-reconcile-required",
			}),
		);
		expect(engine.list()).toEqual([]);
	});

	it("rejects invalid experiment targets and allocations before changing a flag", () => {
		const store = new FeatureFlagStore();
		const engine = new OpenExperimentEngine({ store });
		expect(() =>
			engine.define({
				name: "experiment",
				flag: "",
				variants: ["control", "treatment"],
			}),
		).toThrow(/flag/i);
		expect(store.list()).toEqual([]);
		const allocation = experimentAllocation("experiment", [
			"control",
			"treatment",
		]);
		expect(() =>
			store.define({
				key: "flag",
				variants: { control: false },
				experimentAllocation: allocation,
			}),
		).toThrow(/variant/i);
		expect(store.get("flag")).toBeUndefined();
		store.define({
			key: "owned",
			metadata: { experiment: "other", tenant: "tenant-a" },
		});
		const owned = store.get("owned");
		expect(() =>
			engine.define({
				name: "experiment",
				flag: "owned",
				variants: ["control", "treatment"],
			}),
		).toThrow(/experiment|allocation/i);
		expect(store.get("owned")).toEqual(owned);
	});

	it("gives custom analysis the actual exposures alongside intended assignments", () => {
		const { engine, store } = engineWithFlag(0);
		const context = { targetingKey: "subject-for-analysis" };
		const intended = engine.assign("checkout-experiment", context);
		const actual = store.evaluate("checkout", context, false);
		engine.expose("checkout-experiment", context);
		let seen: readonly { variant: string; assignedVariant?: string }[] = [];
		const result = analyzeExperimentFromEngine(engine, "checkout-experiment", {
			analyze(definition, assignments, exposedCount, exposures = []) {
				seen = exposures;
				return createBuiltinExperimentAnalysis().analyze(
					definition,
					assignments,
					exposedCount,
				);
			},
		});
		expect(result?.totalExposed).toBe(1);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			variant: actual.variant,
			assignedVariant: intended.variant,
		});
	});

	it("uses the caller's evaluation default when a flag is unavailable", () => {
		const { engine, store } = engineWithFlag();
		const context = { targetingKey: "subject" };
		engine.assign("checkout-experiment", context);
		store.archive("checkout");
		const evaluation = store.evaluate("checkout", context, true);
		const exposure = engine.evaluateAndExpose(
			"checkout-experiment",
			context,
			true,
		);
		expect(exposure.variant).toBe(evaluation.variant);
		expect(engine.events.at(-1)?.data.variant).toBe(evaluation.variant);
	});

	it("uses the fractional sticky subject for both assignment and ramp eligibility", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "checkout",
			percentage: 100,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			targeting: {
				fractional: {
					key: ["identity.userId"],
					variants: [{ control: 0 }, { treatment: 100 }],
				},
			},
		});
		const engine = new OpenExperimentEngine({ store });
		engine.define({
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		store.define({ key: "checkout", percentage: 50 });
		const variants = Array.from(
			{ length: 100 },
			(_, index) =>
				store.evaluate("checkout", {
					targetingKey: `session-${index}`,
					attributes: { "identity.userId": "same-user" },
				}).variant,
		);
		expect(new Set(variants).size).toBe(1);
	});

	it("uses the explicit sticky key for non-fractional experiment allocation and ramping", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "checkout",
			percentage: 100,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			targeting: { stickyKey: "identity.userId" },
		});
		const engine = new OpenExperimentEngine({ store });
		engine.define({
			name: "checkout-experiment",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		const contexts = Array.from({ length: 100 }, (_, index) => ({
			targetingKey: `session-${index}`,
			attributes: { "identity.userId": "same-user" },
		}));
		const assigned = contexts.map(
			(context) => engine.assign("checkout-experiment", context).variant,
		);
		expect(new Set(assigned).size).toBe(1);
		expect(
			contexts.map((context) => store.evaluate("checkout", context).variant),
		).toEqual(assigned);
		store.define({ key: "checkout", percentage: 50 });
		expect(
			new Set(
				contexts.map((context) => store.evaluate("checkout", context).variant),
			).size,
		).toBe(1);
		const before = store.get("checkout");
		expect(() =>
			store.define({ key: "checkout", targeting: { stickyKey: "other" } }),
		).toThrow(/sticky/i);
		expect(store.get("checkout")).toEqual(before);
	});

	it("rejects a progressive run whose rollout and experiment use different flags before mutation", () => {
		const store = new FeatureFlagStore();
		const harness = createHarness({ store });
		expect(() =>
			harness.startProgressive({
				rollout: {
					name: "rollout",
					flag: "flag-a",
					stages: [{ percent: 0 }],
					traffic: "flag-only",
					autoRollback: true,
				},
				experiment: {
					name: "experiment",
					flag: "flag-b",
					variants: ["control", "treatment"],
				},
			}),
		).toThrow(/flag/i);
		expect(store.list()).toEqual([]);
		expect(harness.delivery.events).toEqual([]);
		expect(harness.experiment.events).toEqual([]);
	});

	it.each([
		{
			label: "empty experiment variants",
			stages: [{ percent: 0 }],
			variants: [],
		},
		{
			label: "empty rollout stages",
			stages: [],
			variants: ["control", "treatment"],
		},
		{
			label: "empty rollout target group",
			stages: [{ percent: 0, groups: [{ name: "empty", targets: [] }] }],
			variants: ["control", "treatment"],
		},
	])("preflights $label before creating any progressive state", ({
		stages,
		variants,
	}) => {
		const store = new FeatureFlagStore();
		const harness = createHarness({ store });
		expect(() =>
			harness.startProgressive({
				rollout: {
					name: "rollout",
					flag: "checkout",
					stages,
					traffic: "flag-only",
					autoRollback: true,
				},
				experiment: { name: "experiment", flag: "checkout", variants },
			}),
		).toThrow();
		expect(store.list()).toEqual([]);
		expect(store.events).toEqual([]);
		expect(harness.delivery.events).toEqual([]);
		expect(harness.experiment.events).toEqual([]);
	});

	it("reports reconciliation if a delivery port fails after progressive state is created", () => {
		const store = new FeatureFlagStore();
		const delivery = new OpenDeliveryEngine({ store });
		delivery.start = () => {
			throw new Error("synthetic private-fixture.invalid delivery failure");
		};
		const harness = createHarness({ store, delivery });
		let caught: unknown;
		try {
			harness.startProgressive({
				rollout: {
					name: "rollout",
					flag: "checkout",
					stages: [{ percent: 0 }],
					traffic: "flag-only",
					autoRollback: true,
				},
				experiment: {
					name: "experiment",
					flag: "checkout",
					variants: ["control", "treatment"],
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({
			code: "progressive-start-reconcile-required",
		});
		expect(String(caught)).not.toContain("private-fixture.invalid");
		expect(caught).not.toHaveProperty("cause");
		expect(store.get("checkout")).toBeDefined();
	});

	it("retains the allocation reconciliation code without exposing an adapter error", () => {
		const store = new FeatureFlagStore();
		const experiment = new OpenExperimentEngine({ store });
		experiment.define = () => {
			throw Object.assign(new Error("synthetic private-fixture.invalid"), {
				code: "experiment-allocation-reconcile-required",
			});
		};
		const harness = createHarness({ store, experiment });
		let caught: unknown;
		try {
			harness.startProgressive({
				rollout: {
					name: "rollout",
					flag: "checkout",
					stages: [{ percent: 0 }],
					traffic: "flag-only",
					autoRollback: true,
				},
				experiment: {
					name: "experiment",
					flag: "checkout",
					variants: ["control", "treatment"],
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({
			code: "experiment-allocation-reconcile-required",
		});
		expect(String(caught)).not.toContain("private-fixture.invalid");
		expect(caught).not.toHaveProperty("cause");
	});

	it("records a previously served evaluation after a kill switch and exposes atomic details", () => {
		const { engine, store } = engineWithFlag();
		const context = Array.from({ length: 100 }, (_, index) => ({
			targetingKey: `subject-${index}`,
			tenant: "tenant-a",
			attributes: { segment: "fixture" },
		})).find(
			(item) => store.evaluate("checkout", item).variant === "treatment",
		);
		if (!context) throw new Error("missing treatment subject");
		const served = store.evaluate("checkout", context, false);
		store.activateKillSwitch("checkout");
		expect(store.evaluate("checkout", context, false).variant).toBe("control");
		const exposure = engine.exposeEvaluated(
			"checkout-experiment",
			context,
			served,
		);
		expect(exposure.variant).toBe(served.variant);
		expect(engine.events.at(-1)?.data.variant).toBe(served.variant);
		expect(() =>
			engine.exposeEvaluated(
				"checkout-experiment",
				{ targetingKey: "other" },
				served,
			),
		).toThrow(/context|evaluation/i);
		expect(() =>
			engine.exposeEvaluated(
				"checkout-experiment",
				{ ...context, tenant: "tenant-b" },
				served,
			),
		).toThrow(/context|evaluation/i);
		expect(() =>
			engine.exposeEvaluated(
				"checkout-experiment",
				{ ...context, attributes: { segment: "other" } },
				served,
			),
		).toThrow(/context|evaluation/i);
		expect(() =>
			engine.exposeEvaluated("checkout-experiment", context, {
				...served,
				flagKey: "other",
			}),
		).toThrow(/flag|evaluation/i);
		const current = engine.evaluateAndExposeDetails(
			"checkout-experiment",
			context,
		);
		expect(current.assignment.variant).toBe("control");
		expect(current.evaluation.variant).toBe("control");
		expect(current.evaluation.value).toBe(false);
	});

	it("keeps allocation history immutable in emitted flag events", () => {
		const { store } = engineWithFlag();
		const event = store.events.findLast(
			(item) => item.data.key === "checkout" && item.type === "flag.Changed",
		);
		const allocation = event?.data.experimentAllocation;
		if (
			!isJsonObject(allocation) ||
			!isJsonObject(allocation.weights) ||
			!Array.isArray(allocation.variants)
		)
			throw new Error("missing allocation event");
		expect(Object.isFrozen(allocation)).toBe(true);
		expect(Object.isFrozen(allocation.weights)).toBe(true);
		expect(Object.isFrozen(allocation.variants)).toBe(true);
		expect(Reflect.set(allocation.weights, "control", 99)).toBe(false);
		expect(Reflect.set(allocation.variants, "0", "other")).toBe(false);
	});
});
