import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTlcExited, runBoundedTlc } from "./lib/bounded-tlc.ts";

const configuredJar = process.env.HOBO_TLA_TOOLS;
const expected =
	"7e53aa636dac8a3cb0533f343115c0548e03fc0ce5edc7739becf58d3d0fb84f";
if (!configuredJar) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.8.0");
const jar = resolve(configuredJar);
const actual = createHash("sha256").update(readFileSync(jar)).digest("hex");
if (actual !== expected)
	throw new Error("TLA+ tool digest does not match the pinned release");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modelDirectory = join(root, "packages/pricing/model");
const scratch = mkdtempSync(join(tmpdir(), "hobo-iac-models-"));

function check(name: string, directory: string, stateDirectory: string) {
	const result = runBoundedTlc(
		jar,
		[
			"-workers",
			"2",
			"-metadir",
			stateDirectory,
			"-config",
			`${name}.cfg`,
			`${name}.tla`,
		],
		directory,
	);
	assertTlcExited(result);
	return result;
}

try {
	const routeDirectory = join(root, "packages/dispatcher/model");
	const routeSource = readFileSync(
		join(routeDirectory, "IacRouting.tla"),
		"utf8",
	);
	const routeConfig = readFileSync(
		join(routeDirectory, "IacRouting.cfg"),
		"utf8",
	);
	const routeResult = check(
		"IacRouting",
		routeDirectory,
		join(scratch, "IacRouting"),
	);
	process.stdout.write(routeResult.stdout);
	process.stderr.write(routeResult.stderr);
	if (routeResult.status !== 0)
		throw new Error("IacRouting model checking failed");
	const routeGuard =
		'/\\ phase = "uncertain" /\\ candidate \\in fenced /\\ candidate \\notin live\n  /\\ verified\' = TRUE';
	if (routeSource.split(routeGuard).length !== 2)
		throw new Error("IacRouting mutation target changed");
	const routeMutation = join(scratch, "route-mutation");
	mkdirSync(routeMutation);
	writeFileSync(
		join(routeMutation, "IacRouting.tla"),
		routeSource.replace(
			routeGuard,
			'/\\ phase = "uncertain"\n  /\\ verified\' = TRUE',
		),
	);
	writeFileSync(join(routeMutation, "IacRouting.cfg"), routeConfig);
	const routeMutationResult = check(
		"IacRouting",
		routeMutation,
		join(routeMutation, "states"),
	);
	if (
		routeMutationResult.status === 0 ||
		!/Invariant .+ is violated/u.test(routeMutationResult.stdout)
	)
		throw new Error(
			"IacRouting mutation did not produce an invariant counterexample",
		);
	process.stdout.write("IacRouting mutation: counterexample found\n");
	for (const name of ["IacPricingScope", "IacDestroyPricing"]) {
		const result = check(name, modelDirectory, join(scratch, name));
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		if (result.status !== 0) throw new Error(`${name} model checking failed`);
	}
	const budgetDirectory = join(root, "packages/broker/model");
	const budgetSource = readFileSync(
		join(budgetDirectory, "IacBudget.tla"),
		"utf8",
	);
	const budgetConfig = readFileSync(
		join(budgetDirectory, "IacBudget.cfg"),
		"utf8",
	);
	const budgetResult = check(
		"IacBudget",
		budgetDirectory,
		join(scratch, "IacBudget"),
	);
	process.stdout.write(budgetResult.stdout);
	process.stderr.write(budgetResult.stderr);
	if (budgetResult.status !== 0)
		throw new Error("IacBudget model checking failed");
	const narrow = join(scratch, "budget-limit-one");
	mkdirSync(narrow);
	if (budgetConfig.split("CONSTANT Limit = 2").length !== 2)
		throw new Error("IacBudget limit configuration changed");
	writeFileSync(join(narrow, "IacBudget.tla"), budgetSource);
	writeFileSync(
		join(narrow, "IacBudget.cfg"),
		`${budgetConfig.replace("CONSTANT Limit = 2", "CONSTANT Limit = 1")}\nINVARIANT AtMostOnePricedHold\n`,
	);
	const narrowResult = check("IacBudget", narrow, join(narrow, "states"));
	process.stdout.write(narrowResult.stdout);
	process.stderr.write(narrowResult.stderr);
	if (narrowResult.status !== 0)
		throw new Error("IacBudget limit-one model checking failed");
	const budgetMutations = [
		[
			"/\\ guard \\in BOOLEAN /\\ (settlementTrust \\/ guard)",
			"/\\ guard \\in BOOLEAN",
		],
		['/\\ mode[o] # "priced" \\/ settlementTrust \\/ guarded[o]', "/\\ TRUE"],
		[
			'/\\ status[o] = "idle" /\\ ActiveUnpriced = {}',
			'/\\ status[o] = "idle"',
		],
		[
			"/\\ fenced[o] /\\ verified[o] /\\ ~live[o] /\\ actual \\in 0..3",
			"/\\ actual \\in 0..3",
		],
	] as const;
	for (const [index, [before, after]] of budgetMutations.entries()) {
		if (budgetSource.split(before).length !== 2)
			throw new Error("IacBudget mutation target changed");
		const isolated = join(scratch, `budget-mutation-${index}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "IacBudget.tla"),
			budgetSource.replace(before, after),
		);
		writeFileSync(join(isolated, "IacBudget.cfg"), budgetConfig);
		const result = check("IacBudget", isolated, join(isolated, "states"));
		if (result.status === 0 || !/Invariant .+ is violated/u.test(result.stdout))
			throw new Error(
				"IacBudget mutation did not produce an invariant counterexample",
			);
		process.stdout.write(
			`IacBudget mutation ${index + 1}: counterexample found\n`,
		);
	}
	const expectBudgetViolation = (
		label: string,
		source: string,
		invariant: string,
		limit = 2,
	) => {
		const isolated = join(scratch, `budget-${label}`);
		mkdirSync(isolated);
		writeFileSync(join(isolated, "IacBudget.tla"), source);
		writeFileSync(
			join(isolated, "IacBudget.cfg"),
			`SPECIFICATION Spec\nCONSTANT Limit = ${limit}\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`,
		);
		const result = check("IacBudget", isolated, join(isolated, "states"));
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`IacBudget ${label} did not violate ${invariant}`);
		process.stdout.write(
			`IacBudget ${label}: ${invariant} counterexample found\n`,
		);
	};
	const budgetGuard = "/\\ spent + Cardinality(ActivePriced) + 1 <= Limit";
	if (budgetSource.split(budgetGuard).length !== 2)
		throw new Error("IacBudget reserve-limit mutation target changed");
	expectBudgetViolation(
		"missing-reserve-limit",
		budgetSource.replace(budgetGuard, "/\\ TRUE"),
		"PricedReservationWithinBudget",
	);
	expectBudgetViolation(
		"missing-outstanding-holds",
		budgetSource.replace(budgetGuard, "/\\ spent + 1 <= Limit"),
		"PricedReservationWithinBudget",
		1,
	);
	expectBudgetViolation(
		"missing-settled-spend",
		budgetSource.replace(
			budgetGuard,
			"/\\ Cardinality(ActivePriced) + 1 <= Limit",
		),
		"PricedReservationWithinBudget",
	);
	expectBudgetViolation(
		"two-concurrent-priced-holds",
		budgetSource,
		"AtMostOnePricedHold",
	);
	expectBudgetViolation(
		"actual-cost-overrun",
		budgetSource,
		"PricedActualNeverExceedsBudget",
	);
	const mutations = [
		[
			"IacDestroyPricing",
			'ELSE IF operation = "destroy" /\\ model # "destroy" THEN "unsupported"',
			'ELSE IF FALSE THEN "unsupported"',
		],
		[
			"IacDestroyPricing",
			'ELSE IF model = "destroy" /\\ declaration = "missing" THEN "incomplete"',
			'ELSE IF FALSE THEN "incomplete"',
		],
		[
			"IacDestroyPricing",
			'ELSE IF model = "destroy" /\\\n          (declaration = "cancels" \\/ workload = "remove" \\/ sourceRefs)',
			"ELSE IF FALSE",
		],
		[
			"IacDestroyPricing",
			'ELSE IF model = "source-action" THEN "unsupported"',
			'ELSE IF FALSE THEN "unsupported"',
		],
		[
			"IacDestroyPricing",
			'ELSE IF workload = "remove" THEN "unsupported"',
			'ELSE IF FALSE THEN "unsupported"',
		],
		[
			"IacDestroyPricing",
			'ELSE IF sourceRefs THEN "unsupported"',
			'ELSE IF FALSE THEN "unsupported"',
		],
		[
			"IacDestroyPricing",
			'/\\ assessment = "unavailable" /\\ route = "pending"',
			'/\\ assessment # "pending" /\\ route = "pending"',
		],
		[
			"IacDestroyPricing",
			'/\\ route\' = IF budgetAllows THEN "priced-held" ELSE "denied"',
			'/\\ route\' = "priced-held"',
		],
		[
			"IacPricingScope",
			"IF present /\\ ScopeMatches",
			"IF ~present \\/ ScopeMatches",
		],
	] as const;
	for (const [index, [name, before, after]] of mutations.entries()) {
		const source = readFileSync(join(modelDirectory, `${name}.tla`), "utf8");
		if (source.split(before).length !== 2)
			throw new Error(`${name} mutation target changed`);
		const isolated = join(scratch, `mutation-${index}`);
		mkdirSync(isolated);
		writeFileSync(join(isolated, `${name}.tla`), source.replace(before, after));
		writeFileSync(
			join(isolated, `${name}.cfg`),
			readFileSync(join(modelDirectory, `${name}.cfg`)),
		);
		const result = check(name, isolated, join(isolated, "states"));
		if (result.status === 0 || !/Invariant .+ is violated/u.test(result.stdout))
			throw new Error(
				`${name} mutation did not produce an invariant counterexample`,
			);
		process.stdout.write(
			`${name} mutation ${index + 1}: counterexample found\n`,
		);
	}
	for (const invariant of ["NoPricedHold", "NoUnpricedHold"]) {
		const witness = join(scratch, invariant);
		mkdirSync(witness);
		writeFileSync(
			join(witness, "IacDestroyPricing.tla"),
			readFileSync(join(modelDirectory, "IacDestroyPricing.tla")),
		);
		writeFileSync(
			join(witness, "IacDestroyPricing.cfg"),
			`${readFileSync(join(modelDirectory, "IacDestroyPricing.cfg"), "utf8")}\nINVARIANT ${invariant}\n`,
		);
		const result = check("IacDestroyPricing", witness, join(witness, "states"));
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`${invariant} witness was not reached`);
		process.stdout.write(`${invariant}: witness found\n`);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
