import { spawnSync } from "node:child_process";
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

const configuredJar = process.env.HOBO_TLA_TOOLS;
const expected =
	"7e53aa636dac8a3cb0533f343115c0548e03fc0ce5edc7739becf58d3d0fb84f";
if (!configuredJar) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.8.0");
const jar = resolve(configuredJar);
const actual = createHash("sha256").update(readFileSync(jar)).digest("hex");
if (actual !== expected)
	throw new Error("TLA+ tool digest does not match the pinned release");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "hobo-iac-models-"));
try {
	for (const [directory, name] of [
		["dispatcher", "IacRouting"],
		["broker", "IacBudget"],
		["cloud", "IacTransitions"],
		["iac/iac-alchemy", "IacGrant"],
	] as const) {
		const result = spawnSync(
			"java",
			[
				"-XX:+UseParallelGC",
				"-cp",
				jar,
				"tlc2.TLC",
				"-workers",
				"2",
				"-metadir",
				join(scratch, name),
				"-config",
				`${name}.cfg`,
				`${name}.tla`,
			],
			{
				cwd: join(root, "packages", directory, "model"),
				stdio: "inherit",
			},
		);
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`${name} model checking failed`);
	}
	// Check the same safety invariants with less headroom, not just the default
	// limit of two. This makes competing unit reservations exceed the budget.
	const narrowBudget = join(scratch, "budget-limit-one");
	mkdirSync(narrowBudget);
	const budgetModelDirectory = join(root, "packages/broker/model");
	writeFileSync(
		join(narrowBudget, "IacBudget.tla"),
		readFileSync(join(budgetModelDirectory, "IacBudget.tla")),
	);
	const budgetConfig = readFileSync(
		join(budgetModelDirectory, "IacBudget.cfg"),
		"utf8",
	);
	if (budgetConfig.split("CONSTANT Limit = 2").length !== 2)
		throw new Error("IacBudget limit configuration changed");
	writeFileSync(
		join(narrowBudget, "IacBudget.cfg"),
		`${budgetConfig.replace("CONSTANT Limit = 2", "CONSTANT Limit = 1")}\nINVARIANT AtMostOnePricedHold\n`,
	);
	const narrowResult = spawnSync(
		"java",
		[
			"-XX:+UseParallelGC",
			"-cp",
			jar,
			"tlc2.TLC",
			"-workers",
			"2",
			"-metadir",
			join(narrowBudget, "states"),
			"-config",
			"IacBudget.cfg",
			"IacBudget.tla",
		],
		{ cwd: narrowBudget, stdio: "inherit" },
	);
	if (narrowResult.error) throw narrowResult.error;
	if (narrowResult.status !== 0)
		throw new Error("IacBudget limit-one model checking failed");
	// Check that representative removals of safety guards produce counterexamples.
	const mutations = [
		[
			"broker",
			"IacBudget",
			"/\\ guard \\in BOOLEAN /\\ (settlementTrust \\/ guard)",
			"/\\ guard \\in BOOLEAN",
		],
		[
			"broker",
			"IacBudget",
			'/\\ mode[o] # "priced" \\/ settlementTrust \\/ guarded[o]',
			"/\\ TRUE",
		],
		[
			"broker",
			"IacBudget",
			'/\\ status[o] = "idle" /\\ ActiveUnpriced = {}',
			'/\\ status[o] = "idle"',
		],
		[
			"broker",
			"IacBudget",
			"/\\ fenced[o] /\\ verified[o] /\\ ~live[o] /\\ actual \\in 0..3",
			"/\\ actual \\in 0..3",
		],
		[
			"dispatcher",
			"IacRouting",
			'/\\ phase = "uncertain" /\\ candidate \\in fenced /\\ candidate \\notin live\n  /\\ verified\' = TRUE',
			'/\\ phase = "uncertain"\n  /\\ verified\' = TRUE',
		],
		[
			"cloud",
			"IacTransitions",
			"StartApply(c) ==\n  /\\ snapshot[c] = version /\\ version < MaxVersion",
			"StartApply(c) ==\n  /\\ version < MaxVersion",
		],
		[
			"cloud",
			"IacTransitions",
			'/\\ apply = "uncertain" /\\ fenced /\\ verified /\\ live = "none"\n  /\\ result',
			'/\\ apply = "uncertain"\n  /\\ result',
		],
	] as const;
	for (const [index, [directory, name, before, after]] of mutations.entries()) {
		const original = join(root, "packages", directory, "model");
		const source = readFileSync(join(original, `${name}.tla`), "utf8");
		if (source.split(before).length !== 2)
			throw new Error(`${name} mutation target changed`);
		const isolated = join(scratch, `mutation-${index}`);
		mkdirSync(isolated);
		writeFileSync(join(isolated, `${name}.tla`), source.replace(before, after));
		writeFileSync(
			join(isolated, `${name}.cfg`),
			readFileSync(join(original, `${name}.cfg`)),
		);
		const result = spawnSync(
			"java",
			[
				"-XX:+UseParallelGC",
				"-cp",
				jar,
				"tlc2.TLC",
				"-workers",
				"2",
				"-metadir",
				join(isolated, "states"),
				"-config",
				`${name}.cfg`,
				`${name}.tla`,
			],
			{ cwd: isolated, encoding: "utf8" },
		);
		if (result.error) throw result.error;
		if (result.status === 0 || !/Invariant .+ is violated/u.test(result.stdout))
			throw new Error(
				`${name} mutation did not produce an invariant counterexample`,
			);
		process.stdout.write(
			`${name} mutation ${index + 1}: counterexample found\n`,
		);
	}

	// Check both the reserve-time budget guarantee and its limit: actual
	// provider charges can exceed an estimate, even after a valid reservation.
	const budgetDirectory = join(root, "packages/broker/model");
	const budgetSource = readFileSync(
		join(budgetDirectory, "IacBudget.tla"),
		"utf8",
	);
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
		const result = spawnSync(
			"java",
			[
				"-XX:+UseParallelGC",
				"-cp",
				jar,
				"tlc2.TLC",
				"-workers",
				"2",
				"-metadir",
				join(isolated, "states"),
				"-config",
				"IacBudget.cfg",
				"IacBudget.tla",
			],
			{ cwd: isolated, encoding: "utf8" },
		);
		if (result.error) throw result.error;
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

	// The normal safety check cannot prove that an interesting history was
	// reachable. Find an A -> B -> A witness and then require a real stale
	// credential counterexample when epoch non-reuse is deliberately removed.
	const grantDirectory = join(root, "packages/iac/iac-alchemy/model");
	const grantSource = readFileSync(
		join(grantDirectory, "IacGrant.tla"),
		"utf8",
	);
	const grantConfig = readFileSync(
		join(grantDirectory, "IacGrant.cfg"),
		"utf8",
	);
	const expectGrantViolation = (
		label: string,
		source: string,
		config: string,
		invariant: string,
	) => {
		const isolated = join(scratch, `grant-${label}`);
		mkdirSync(isolated);
		writeFileSync(join(isolated, "IacGrant.tla"), source);
		writeFileSync(join(isolated, "IacGrant.cfg"), config);
		const result = spawnSync(
			"java",
			[
				"-XX:+UseParallelGC",
				"-cp",
				jar,
				"tlc2.TLC",
				"-workers",
				"2",
				"-metadir",
				join(isolated, "states"),
				"-config",
				"IacGrant.cfg",
				"IacGrant.tla",
			],
			{ cwd: isolated, encoding: "utf8" },
		);
		if (result.error) throw result.error;
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`IacGrant ${label} did not violate ${invariant}`);
		process.stdout.write(
			`IacGrant ${label}: ${invariant} counterexample found\n`,
		);
	};
	const witnessConfig = (invariant: string) =>
		`SPECIFICATION Spec\nCONSTANTS MaxEpochs = 3\n          RequestSlots = 1\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`;
	expectGrantViolation(
		"A-B-A-witness",
		grantSource,
		witnessConfig("AtoBtoAUnreachable"),
		"AtoBtoAUnreachable",
	);
	expectGrantViolation(
		"timed-out-provider-still-completes",
		grantSource,
		witnessConfig("NoTimeoutCompletionAfterRouteFence"),
		"NoTimeoutCompletionAfterRouteFence",
	);
	const grantMutations = [
		[
			"fresh-epoch",
			'/\\ phase[e] = "unused"',
			'/\\ phase[e] \\in {"unused", "retired"}',
			"FreshGrantEpochs",
		],
		[
			"route-fence",
			"/\\ ~routeOpen[current]",
			"/\\ TRUE",
			"RetiredRoutesFenced",
		],
		[
			"drain",
			"/\\ \\A r \\in Requests : requestGeneration[r] # Len(history) \\/\n       ~ledgerPending[r] \\/ Len(history) \\in permanentlyFenced",
			"/\\ TRUE",
			"NoRetiredOutstanding",
		],
		[
			"timeout",
			"TimeoutPending(r) == ledgerPending",
			"TimeoutPending(r) == [ledgerPending EXCEPT ![r] = FALSE]",
			"NoRetiredOutstanding",
		],
		[
			"provider-fence",
			"/\\ requestGeneration[r] \\notin permanentlyFenced",
			"/\\ TRUE",
			"NoLateEffect",
		],
		[
			"ownership",
			"MigrateOwnership ==\n  /\\ owner = 1\n  /\\ current = 0",
			"MigrateOwnership ==\n  /\\ owner = 1",
			"CurrentGrantOwnsResource",
		],
	] as const;
	let reusedEpochSource = "";
	let unfencedRouteSource = "";
	for (const [label, before, after, invariant] of grantMutations) {
		if (grantSource.split(before).length !== 2)
			throw new Error(`IacGrant ${label} mutation target changed`);
		const mutated = grantSource.replace(before, after);
		if (label === "fresh-epoch") reusedEpochSource = mutated;
		if (label === "route-fence") unfencedRouteSource = mutated;
		expectGrantViolation(label, mutated, grantConfig, invariant);
	}
	expectGrantViolation(
		"A-B-A-stale-request",
		reusedEpochSource,
		witnessConfig("StaleAfterAtoBtoA"),
		"StaleAfterAtoBtoA",
	);
	expectGrantViolation(
		"retired-proxy-remains-reachable",
		unfencedRouteSource,
		witnessConfig("NoLateStart"),
		"NoLateStart",
	);
	expectGrantViolation(
		"old-proxy-after-successor",
		unfencedRouteSource,
		witnessConfig("NoOldProxyAfterSuccessor"),
		"NoOldProxyAfterSuccessor",
	);
	if (
		grantConfig.split("MaxEpochs = 3").length !== 2 ||
		grantConfig.split("RequestSlots = 1").length !== 2
	)
		throw new Error("IacGrant concurrency bounds changed");
	const concurrencyConfig = grantConfig
		.replace("MaxEpochs = 3", "MaxEpochs = 2")
		.replace("RequestSlots = 1", "RequestSlots = 2");
	const concurrencyDirectory = join(scratch, "grant-two-requests");
	mkdirSync(concurrencyDirectory);
	writeFileSync(join(concurrencyDirectory, "IacGrant.tla"), grantSource);
	writeFileSync(join(concurrencyDirectory, "IacGrant.cfg"), concurrencyConfig);
	const concurrent = spawnSync(
		"java",
		[
			"-XX:+UseParallelGC",
			"-cp",
			jar,
			"tlc2.TLC",
			"-workers",
			"2",
			"-metadir",
			join(concurrencyDirectory, "states"),
			"-config",
			"IacGrant.cfg",
			"IacGrant.tla",
		],
		{ cwd: concurrencyDirectory, stdio: "inherit" },
	);
	if (concurrent.error) throw concurrent.error;
	if (concurrent.status !== 0)
		throw new Error("IacGrant two-request model checking failed");
	const allRequests =
		"/\\ \\A r \\in Requests : requestGeneration[r] # Len(history) \\/\n       ~ledgerPending[r] \\/ Len(history) \\in permanentlyFenced";
	if (grantSource.split(allRequests).length !== 2)
		throw new Error("IacGrant all-request drain guard changed");
	const oneDrained = grantSource.replace(
		allRequests,
		allRequests.replace("\\A r", "\\E r"),
	);
	expectGrantViolation(
		"drain-one-of-two",
		oneDrained,
		concurrencyConfig,
		"NoRetiredOutstanding",
	);
	const concurrencyWitness = (invariant: string) =>
		`SPECIFICATION Spec\nCONSTANTS MaxEpochs = 2\n          RequestSlots = 2\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`;
	expectGrantViolation(
		"two-concurrent-requests",
		grantSource,
		concurrencyWitness("TwoConcurrentRequestsUnreachable"),
		"TwoConcurrentRequestsUnreachable",
	);
	expectGrantViolation(
		"one-completes-one-still-running",
		oneDrained,
		concurrencyWitness("NoPartialConcurrentDrain"),
		"NoPartialConcurrentDrain",
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
