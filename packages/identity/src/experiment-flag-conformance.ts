import {
	type FeatureFlagPort,
	flagContextBinding,
} from "./feature-flag-store.js";
import { OpenExperimentEngine } from "./harness-experiment.js";

export type ExperimentFlagPortFixture = Readonly<{
	port: FeatureFlagPort;
	close(): void | Promise<void>;
}>;

export type ExperimentFlagPortConformance = Readonly<{
	ok: boolean;
	failures: readonly string[];
}>;

export async function runExperimentFlagPortConformance(
	create: () => ExperimentFlagPortFixture | Promise<ExperimentFlagPortFixture>,
): Promise<ExperimentFlagPortConformance> {
	const failures = new Set<string>();
	let fixture: ExperimentFlagPortFixture;
	try {
		fixture = await create();
	} catch {
		return { ok: false, failures: ["fixture-open"] };
	}
	try {
		const { port } = fixture;
		const key = "hobo-contract-experiment-flag";
		const name = "hobo-contract-experiment";
		const engine = new OpenExperimentEngine({ store: port });
		engine.define({
			name,
			flag: key,
			variants: ["control", "treatment"],
			allocation: { weights: { control: 30, treatment: 70 } },
		});
		const contexts = Array.from({ length: 100 }, (_, index) => ({
			targetingKey: `subject-${index}`,
		}));
		const evaluations = contexts.map((context) => ({
			context,
			assignment: engine.assign(name, context),
			evaluation: port.evaluate(key, context, false),
		}));
		if (
			evaluations.some(
				({ context, assignment, evaluation }) =>
					assignment.variant !== evaluation.variant ||
					evaluation.contextBinding !== flagContextBinding(context),
			) ||
			new Set(evaluations.map(({ evaluation }) => evaluation.variant)).size < 2
		)
			failures.add("allocation");
		const update = (percentage: number) => {
			const definition = port.get(key);
			if (!definition) throw new Error("missing fixture flag");
			port.define({ ...definition, percentage });
		};
		update(0);
		if (
			contexts.some(
				(context) => port.evaluate(key, context, false).variant !== "control",
			)
		)
			failures.add("zero-ramp");
		update(25);
		const partial = contexts.filter(
			(context) => port.evaluate(key, context, false).variant === "treatment",
		).length;
		if (partial === 0 || partial >= contexts.length)
			failures.add("partial-ramp");
		const current = port.get(key);
		if (!current) throw new Error("missing fixture flag");
		port.define({
			...current,
			percentage: 0,
			targeting: {
				rules: [
					{ attribute: "segment", equals: "forced", variant: "treatment" },
				],
			},
		});
		const forced = {
			targetingKey: "forced-subject",
			attributes: { segment: "forced" },
		};
		if (port.evaluate(key, forced, false).variant !== "treatment")
			failures.add("targeting");
		port.activateKillSwitch(key);
		const killed = port.evaluate(key, forced, false);
		if (killed.reason !== "kill-switch" || killed.variant !== "control")
			failures.add("kill-switch");
		port.clearKillSwitch(key);
		if (port.get(key)?.percentage !== 0) failures.add("kill-switch-restore");
		const restored = port.get(key);
		if (!restored) throw new Error("missing fixture flag");
		port.define({
			...restored,
			metadata: { ...restored.metadata, tenant: "contract-tenant" },
		});
		if (
			port.evaluate(key, { ...forced, tenant: "other" }, false).reason !==
			"fail-safe-default"
		)
			failures.add("tenant-isolation");
	} catch {
		failures.add("configuration");
	} finally {
		try {
			await fixture.close();
		} catch {
			failures.add("fixture-close");
		}
	}
	return Object.freeze({
		ok: failures.size === 0,
		failures: Object.freeze([...failures]),
	});
}
