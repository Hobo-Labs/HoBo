import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const GENERIC_WHEN =
	/When I exercise the surface as this persona would/i;
const GENERIC_THEN_STATUS =
	/Then I receive clear status about what happened/i;
const CONCRETE_WHEN =
	/When I (?:run|start|open|invoke|execute|type|issue) |When I run `|When I start bare TTY|When I run slash command/i;
const BACKTICK_CMD = /When[^`\n]*`[^`]+`/;

export type GherkinQualityResult = {
	ok: boolean;
	problems: string[];
	templateOnly: boolean;
};

export function checkGherkinQuality(featureDir: string): GherkinQualityResult {
	const problems: string[] = [];
	let templateOnly = false;
	if (!existsSync(featureDir)) {
		return { ok: false, problems: ["feature dir missing"], templateOnly: true };
	}
	const files = readdirSync(featureDir).filter((f) => f.endsWith(".feature"));
	if (files.length === 0) {
		return { ok: false, problems: ["no .feature files"], templateOnly: true };
	}
	for (const f of files) {
		const text = readFileSync(path.join(featureDir, f), "utf8");
		const scenarios = (text.match(/^\s*Scenario:/gim) ?? []).length;
		if (scenarios < 2) {
			problems.push(`${f}: need ≥2 scenarios (found ${scenarios})`);
		}
		const hasConcrete =
			CONCRETE_WHEN.test(text) || BACKTICK_CMD.test(text);
		const hasGenericWhen = GENERIC_WHEN.test(text);
		if (hasGenericWhen && !hasConcrete) {
			problems.push(
				`${f}: template-only When ("exercise the surface") without concrete command/TUI step`,
			);
			templateOnly = true;
		}
		if (GENERIC_THEN_STATUS.test(text)) {
			const concreteThen =
				/Then (?:the |I (?:see|get|receive) |stdout|help |panel|error |exit)/i.test(
					text,
				) || /Then .{10,}(?:◈|not stock|remediation|verb)/i.test(text);
			if (!concreteThen && !hasConcrete) {
				problems.push(
					`${f}: Then steps too generic (clear status only) without observable chrome asserts`,
				);
				templateOnly = true;
			}
		}
		if (!/@persona:/.test(text)) {
			problems.push(`${f}: missing @persona: tag`);
		}
		if (!/@interface:/.test(text)) {
			problems.push(`${f}: missing @interface: tag`);
		}
	}
	return { ok: problems.length === 0, problems, templateOnly };
}

export type ScenarioBindingResult = {
	ok: boolean;
	problems: string[];
};

export function checkScenarioBinding(
	featureDir: string,
	productBinary: string,
): ScenarioBindingResult {
	const problems: string[] = [];
	if (!existsSync(featureDir)) {
		return { ok: false, problems: ["feature dir missing"] };
	}
	const featureJsonPath = path.join(featureDir, "feature.json");
	if (existsSync(featureJsonPath)) {
		try {
			const meta = JSON.parse(readFileSync(featureJsonPath, "utf8")) as {
				primaryCommand?: string;
			};
			if (
				typeof meta.primaryCommand === "string" &&
				meta.primaryCommand.length > 0 &&
				!meta.primaryCommand.includes(productBinary)
			) {
				problems.push(
					`feature.json primaryCommand ("${meta.primaryCommand}") does not invoke ${productBinary}`,
				);
			}
		} catch {
			problems.push("feature.json unreadable");
		}
	}
	for (const f of readdirSync(featureDir).filter((n) => n.endsWith(".feature"))) {
		const text = readFileSync(path.join(featureDir, f), "utf8");
		if (!text.includes(productBinary)) {
			problems.push(
				`${f}: no scenario invokes ${productBinary} — persona scenarios must exercise the product, not repo scripts`,
			);
		}
	}
	return { ok: problems.length === 0, problems };
}
