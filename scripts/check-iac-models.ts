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
	"936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
if (!configuredJar) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.7.4");
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
	const transitionDirectory = join(root, "packages/cloud/model");
	const transitionSource = readFileSync(
		join(transitionDirectory, "IacTransitions.tla"),
		"utf8",
	);
	const transitionConfig = readFileSync(
		join(transitionDirectory, "IacTransitions.cfg"),
		"utf8",
	);
	const transitionResult = check(
		"IacTransitions",
		transitionDirectory,
		join(scratch, "IacTransitions"),
	);
	process.stdout.write(transitionResult.stdout);
	process.stderr.write(transitionResult.stderr);
	if (transitionResult.status !== 0)
		throw new Error("IacTransitions model checking failed");
	const transitionMutations = [
		[
			"StartApply(c) ==\n  /\\ snapshot[c] = version /\\ version < MaxVersion",
			"StartApply(c) ==\n  /\\ version < MaxVersion",
		],
		[
			'/\\ apply = "uncertain" /\\ fenced /\\ verified /\\ live = "none"\n  /\\ result',
			'/\\ apply = "uncertain"\n  /\\ result',
		],
	] as const;
	for (const [index, [before, after]] of transitionMutations.entries()) {
		if (transitionSource.split(before).length !== 2)
			throw new Error("IacTransitions mutation target changed");
		const isolated = join(scratch, `transition-mutation-${index}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "IacTransitions.tla"),
			transitionSource.replace(before, after),
		);
		writeFileSync(join(isolated, "IacTransitions.cfg"), transitionConfig);
		const result = check("IacTransitions", isolated, join(isolated, "states"));
		if (result.status === 0 || !/Invariant .+ is violated/u.test(result.stdout))
			throw new Error(
				"IacTransitions mutation did not produce an invariant counterexample",
			);
		process.stdout.write(
			`IacTransitions mutation ${index + 1}: counterexample found\n`,
		);
	}
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
	for (const name of [
		"IacAgreementStatus",
		"IacSharedFixedQuantity",
		"IacPricingScope",
		"IacDestroyPricing",
		"IacFixedPricing",
	]) {
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
		["IacAgreementStatus", "IF NeedsRejection", "IF FALSE"],
		[
			"IacSharedFixedQuantity",
			"Eligible == targetKnown /\\ otherKnown /\\ selectorKnown",
			"Eligible == targetKnown /\\ selectorKnown",
		],
		[
			"IacSharedFixedQuantity",
			"Eligible == targetKnown /\\ otherKnown /\\ selectorKnown",
			"Eligible == targetKnown /\\ otherKnown",
		],
		[
			"IacSharedFixedQuantity",
			"BaselineAmount == otherCost",
			'BaselineAmount == IF status = "past-due" THEN 0 ELSE otherCost',
		],
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
		["IacFixedPricing", "/\\ usagePriced \\/ fixedApplicable", "/\\ TRUE"],
		[
			"IacFixedPricing",
			"/\\ ~fixedApplicable \\/ ~requiresQuantity \\/ (agreementQuantity /\\ workloadQuantity)",
			"/\\ TRUE",
		],
		["IacFixedPricing", 'ELSE "unavailable"', 'ELSE "zero"'],
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
	for (const [name, invariant] of [
		["IacAgreementStatus", "AgreementNoUnavailable"],
		["IacAgreementStatus", "AgreementNoContinuation"],
		["IacAgreementStatus", "NoUnknownStatusRejection"],
		["IacAgreementStatus", "NoUnreferencedTrialRejection"],
		["IacSharedFixedQuantity", "NoMissingQuantity"],
		["IacSharedFixedQuantity", "NoUnknownSelector"],
		["IacSharedFixedQuantity", "NoExplicitZeroQuote"],
		["IacSharedFixedQuantity", "NoPastDueQuote"],
		["IacDestroyPricing", "NoPricedHold"],
		["IacDestroyPricing", "NoUnpricedHold"],
		["IacFixedPricing", "NoFixedZero"],
		["IacFixedPricing", "NoFixedPositive"],
		["IacFixedPricing", "NoUnavailable"],
	] as const) {
		const witness = join(scratch, invariant);
		mkdirSync(witness);
		writeFileSync(
			join(witness, `${name}.tla`),
			readFileSync(join(modelDirectory, `${name}.tla`)),
		);
		writeFileSync(
			join(witness, `${name}.cfg`),
			`${readFileSync(join(modelDirectory, `${name}.cfg`), "utf8")}\nINVARIANT ${invariant}\n`,
		);
		const result = check(name, witness, join(witness, "states"));
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`${invariant} witness was not reached`);
		process.stdout.write(`${invariant}: witness found\n`);
	}

	const receiptDirectory = join(root, "packages/broker/model");
	const receiptSource = readFileSync(
		join(receiptDirectory, "IacPricedReceipt.tla"),
		"utf8",
	);
	const receiptConfig = readFileSync(
		join(receiptDirectory, "IacPricedReceipt.cfg"),
		"utf8",
	);
	const receiptResult = check(
		"IacPricedReceipt",
		receiptDirectory,
		join(scratch, "IacPricedReceipt"),
	);
	process.stdout.write(receiptResult.stdout);
	process.stderr.write(receiptResult.stderr);
	if (receiptResult.status !== 0)
		throw new Error("IacPricedReceipt model checking failed");
	const receiptMutations = [
		[
			'IF reserveMatches THEN "await-claim" ELSE "uncertain-reserve"',
			'IF TRUE THEN "await-claim" ELSE "uncertain-reserve"',
		],
		[
			'IF claimMatches THEN "await-check" ELSE "uncertain-claim"',
			'IF TRUE THEN "await-check" ELSE "uncertain-claim"',
		],
		[
			'IF stillHeld THEN "admitted" ELSE "uncertain-revalidation"',
			'IF TRUE THEN "admitted" ELSE "uncertain-revalidation"',
		],
	] as const;
	for (const [index, [before, after]] of receiptMutations.entries()) {
		if (receiptSource.split(before).length !== 2)
			throw new Error("receipt mutation target changed");
		const isolated = join(scratch, `receipt-mutation-${index}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "IacPricedReceipt.tla"),
			receiptSource.replace(before, after),
		);
		writeFileSync(join(isolated, "IacPricedReceipt.cfg"), receiptConfig);
		const result = check(
			"IacPricedReceipt",
			isolated,
			join(isolated, "states"),
		);
		if (result.status === 0 || !/Invariant .+ is violated/u.test(result.stdout))
			throw new Error(
				"receipt mutation did not produce an invariant counterexample",
			);
		process.stdout.write(
			`IacPricedReceipt mutation ${index + 1}: counterexample found\n`,
		);
	}
	for (const invariant of [
		"NoAdmission",
		"NoReserveUncertainty",
		"NoClaimUncertainty",
		"NoRevalidationUncertainty",
	] as const) {
		const isolated = join(scratch, `receipt-${invariant}`);
		mkdirSync(isolated);
		writeFileSync(join(isolated, "IacPricedReceipt.tla"), receiptSource);
		writeFileSync(
			join(isolated, "IacPricedReceipt.cfg"),
			`${receiptConfig}\nINVARIANT ${invariant}\n`,
		);
		const result = check(
			"IacPricedReceipt",
			isolated,
			join(isolated, "states"),
		);
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`${invariant} witness was not reached`);
		process.stdout.write(`${invariant}: witness found\n`);
	}
	const grantDirectory = join(root, "packages/iac/iac-alchemy/model");
	const grantSource = readFileSync(
		join(grantDirectory, "IacGrant.tla"),
		"utf8",
	);
	const grantConfig = readFileSync(
		join(grantDirectory, "IacGrant.cfg"),
		"utf8",
	);
	const grantResult = check(
		"IacGrant",
		grantDirectory,
		join(scratch, "IacGrant"),
	);
	process.stdout.write(grantResult.stdout);
	process.stderr.write(grantResult.stderr);
	if (grantResult.status !== 0)
		throw new Error("IacGrant model checking failed");
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
		const result = runBoundedTlc(
			jar,
			[
				"-workers",
				"2",
				"-metadir",
				join(isolated, "states"),
				"-config",
				"IacGrant.cfg",
				"IacGrant.tla",
			],
			isolated,
		);
		assertTlcExited(result);
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
	const concurrent = runBoundedTlc(
		jar,
		[
			"-workers",
			"2",
			"-metadir",
			join(concurrencyDirectory, "states"),
			"-config",
			"IacGrant.cfg",
			"IacGrant.tla",
		],
		concurrencyDirectory,
	);
	assertTlcExited(concurrent);
	process.stdout.write(concurrent.stdout);
	process.stderr.write(concurrent.stderr);
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
	const sharedDirectory = join(root, "packages/iac/iac-alchemy/model");
	const sharedSource = readFileSync(
		join(sharedDirectory, "SharedMapping.tla"),
		"utf8",
	);
	const sharedConfig = readFileSync(
		join(sharedDirectory, "SharedMapping.cfg"),
		"utf8",
	);
	const sharedResult = check(
		"SharedMapping",
		sharedDirectory,
		join(scratch, "SharedMapping"),
	);
	if (
		sharedResult.status !== 0 ||
		!sharedResult.stdout.includes("No error has been found")
	)
		throw new Error(
			`SharedMapping model checking failed:\n${sharedResult.stdout}\n${sharedResult.stderr}`,
		);
	const sharedCases = [
		[
			"external",
			"/\\ owned /\\ ~shared",
			"/\\ (owned \\/ external) /\\ ~shared",
			"NoExternalAlias",
		],
		[
			"undeclared",
			"/\\ (declared \\/ graphValidated) /\\ exact /\\ writes = 0",
			"/\\ exact /\\ writes = 0",
			"ShareExactAndDeclared",
		],
		[
			"hidden",
			"/\\ (declared \\/ graphValidated) /\\ exact /\\ writes = 0",
			"/\\ (declared \\/ graphValidated) /\\ exact",
			"InventoryComplete",
		],
	] as const;
	for (const [label, before, after, invariant] of sharedCases) {
		if (sharedSource.split(before).length !== 2)
			throw new Error("SharedMapping mutation target changed");
		const isolated = join(scratch, `shared-${label}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "SharedMapping.tla"),
			sharedSource.replace(before, after),
		);
		writeFileSync(
			join(isolated, "SharedMapping.cfg"),
			`SPECIFICATION Spec\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`,
		);
		const result = check("SharedMapping", isolated, join(isolated, "states"));
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`SharedMapping ${label} did not violate ${invariant}`);
		process.stdout.write(
			`SharedMapping ${label}: ${invariant} counterexample found\n`,
		);
	}
	const witness = join(scratch, "shared-witness");
	mkdirSync(witness);
	writeFileSync(join(witness, "SharedMapping.tla"), sharedSource);
	writeFileSync(
		join(witness, "SharedMapping.cfg"),
		`${sharedConfig}\nINVARIANT NeverShared\n`,
	);
	const witnessResult = check(
		"SharedMapping",
		witness,
		join(witness, "states"),
	);
	if (
		witnessResult.status === 0 ||
		!witnessResult.stdout.includes("Invariant NeverShared is violated")
	)
		throw new Error("SharedMapping shared-resource state is unreachable");
	process.stdout.write("SharedMapping: shared-resource witness found\n");
	writeFileSync(
		join(witness, "SharedMapping.cfg"),
		`${sharedConfig}\nINVARIANT NeverGraphShared\n`,
	);
	const graphWitness = check(
		"SharedMapping",
		witness,
		join(witness, "graph-states"),
	);
	if (
		graphWitness.status === 0 ||
		!graphWitness.stdout.includes("Invariant NeverGraphShared is violated")
	)
		throw new Error("SharedMapping graph-validated sharing is unreachable");
	process.stdout.write(
		"SharedMapping: graph-validated sharing witness found\n",
	);
	const awsKvSource = readFileSync(
		join(sharedDirectory, "AwsKvRuntime.tla"),
		"utf8",
	);
	const awsKvResult = check(
		"AwsKvRuntime",
		sharedDirectory,
		join(scratch, "aws-kv"),
	);
	if (
		awsKvResult.status !== 0 ||
		!awsKvResult.stdout.includes("No error has been found")
	)
		throw new Error(
			`AwsKvRuntime model checking failed:\n${awsKvResult.stdout}\n${awsKvResult.stderr}`,
		);
	process.stdout.write(awsKvResult.stdout);
	const awsKvMutations = [
		[
			"start-without-authorization",
			'/\\ state[c] = "idle" /\\ permit /\\ Cardinality(slots) < Limit',
			'/\\ state[c] = "idle" /\\ Cardinality(slots) < Limit',
			"StartedAuthorized",
		],
		[
			"release-on-timeout",
			"/\\ UNCHANGED <<slots, permit, op, admitted, verified>>",
			"/\\ slots' = slots \\ {c} /\\ UNCHANGED <<permit, op, admitted, verified>>",
			"OutstandingRetainsSlot",
		],
		[
			"skip-revalidation",
			'IF permit /\\ verified[c] THEN "success" ELSE IF op[c] = "write" THEN "unknown" ELSE "unavailable"',
			'"success"',
			"SuccessReverified",
		],
	] as const;
	for (const [label, before, after, invariant] of awsKvMutations) {
		if (awsKvSource.split(before).length !== 2)
			throw new Error(`AwsKvRuntime ${label} mutation target changed`);
		const isolated = join(scratch, `aws-kv-${label}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "AwsKvRuntime.tla"),
			awsKvSource.replace(before, after),
		);
		writeFileSync(
			join(isolated, "AwsKvRuntime.cfg"),
			`SPECIFICATION Spec\nCONSTANTS Calls = {c1, c2, c3}\n          Limit = 2\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`,
		);
		const result = check("AwsKvRuntime", isolated, join(isolated, "states"));
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`AwsKvRuntime ${label} did not violate ${invariant}`);
		process.stdout.write(
			`AwsKvRuntime ${label}: ${invariant} counterexample found\n`,
		);
	}
	const awsWitness = join(scratch, "aws-kv-witness");
	mkdirSync(awsWitness);
	writeFileSync(join(awsWitness, "AwsKvRuntime.tla"), awsKvSource);
	writeFileSync(
		join(awsWitness, "AwsKvRuntime.cfg"),
		`SPECIFICATION Spec\nCONSTANTS Calls = {c1, c2, c3}\n          Limit = 2\nCHECK_DEADLOCK FALSE\nINVARIANT NeverReadyAfterRevocation\n`,
	);
	const awsWitnessResult = check(
		"AwsKvRuntime",
		awsWitness,
		join(awsWitness, "states"),
	);
	if (
		awsWitnessResult.status === 0 ||
		!awsWitnessResult.stdout.includes(
			"Invariant NeverReadyAfterRevocation is violated",
		)
	)
		throw new Error("AwsKvRuntime revocation after transport is unreachable");
	process.stdout.write(
		"AwsKvRuntime: revocation after transport witness found\n",
	);
	const s3Source = readFileSync(
		join(sharedDirectory, "AwsS3Objects.tla"),
		"utf8",
	);
	const s3Result = check(
		"AwsS3Objects",
		sharedDirectory,
		join(scratch, "aws-s3"),
	);
	if (
		s3Result.status !== 0 ||
		!s3Result.stdout.includes("No error has been found")
	)
		throw new Error(
			`AwsS3Objects model checking failed:\n${s3Result.stdout}\n${s3Result.stderr}`,
		);
	process.stdout.write(s3Result.stdout);
	const s3Cases = [
		[
			"skip-size-check",
			"Size(body) <= MaxBytes /\\ metadata = Digest(body)",
			"metadata = Digest(body)",
			"SuccessfulReadsAreBounded",
		],
		[
			"skip-digest-check",
			"Size(body) <= MaxBytes /\\ metadata = Digest(body)",
			"Size(body) <= MaxBytes",
			"SuccessfulReadsMatchDigest",
		],
		["empty-object-witness", undefined, undefined, "NeverReadEmpty"],
		["corrupt-object-witness", undefined, undefined, "NeverReadCorruption"],
	] as const;
	for (const [label, before, after, invariant] of s3Cases) {
		if (before !== undefined && s3Source.split(before).length !== 2)
			throw new Error(`AwsS3Objects ${label} mutation target changed`);
		const isolated = join(scratch, `aws-s3-${label}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "AwsS3Objects.tla"),
			before === undefined ? s3Source : s3Source.replace(before, after),
		);
		writeFileSync(
			join(isolated, "AwsS3Objects.cfg"),
			`SPECIFICATION Spec\nCONSTANT MaxBytes = 1\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`,
		);
		const result = check("AwsS3Objects", isolated, join(isolated, "states"));
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`AwsS3Objects ${label} did not reach ${invariant}`);
		process.stdout.write(
			`AwsS3Objects ${label}: ${invariant} counterexample found\n`,
		);
	}
	const awsHttpSource = readFileSync(
		join(sharedDirectory, "AwsHttpBindings.tla"),
		"utf8",
	);
	const awsHttpResult = check(
		"AwsHttpBindings",
		sharedDirectory,
		join(scratch, "aws-http"),
	);
	if (
		awsHttpResult.status !== 0 ||
		!awsHttpResult.stdout.includes("No error has been found")
	)
		throw new Error(
			`AwsHttpBindings model checking failed:\n${awsHttpResult.stdout}\n${awsHttpResult.stderr}`,
		);
	process.stdout.write(awsHttpResult.stdout);
	const awsHttpCases = [
		[
			"begin-without-grant",
			'/\\ state[r] = "running" /\\ grant /\\ operation[r] = "none"',
			'/\\ operation[r] = "none"',
			"OperationStartedAuthorized",
		],
		[
			"release-on-timeout",
			"/\\ UNCHANGED <<slots, grant, operation, opResult, opVerified, opAdmitted, responseVerified>>",
			"/\\ slots' = slots \\ {r} /\\ UNCHANGED <<grant, operation, opResult, opVerified, opAdmitted, responseVerified>>",
			"OutstandingRetainsSlot",
		],
		[
			"skip-operation-revalidation",
			'IF state[r] = "running" /\\ grant THEN "success" ELSE "unknown"',
			'"success"',
			"OperationSuccessVerified",
		],
		[
			"skip-response-revalidation",
			'IF grant THEN "success" ELSE "unavailable"',
			'"success"',
			"ResponseSuccessVerified",
		],
		[
			"in-flight-after-timeout",
			undefined,
			undefined,
			"NeverPendingAfterTimeout",
		],
		["successful-response", undefined, undefined, "NeverSuccessfulResponse"],
	] as const;
	for (const [label, before, after, invariant] of awsHttpCases) {
		if (before !== undefined && awsHttpSource.split(before).length !== 2)
			throw new Error(`AwsHttpBindings ${label} mutation target changed`);
		const isolated = join(scratch, `aws-http-${label}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "AwsHttpBindings.tla"),
			before === undefined
				? awsHttpSource
				: awsHttpSource.replace(before, after),
		);
		writeFileSync(
			join(isolated, "AwsHttpBindings.cfg"),
			`SPECIFICATION Spec\nCONSTANTS Requests = {r1, r2}\n          Limit = 1\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`,
		);
		const result = check("AwsHttpBindings", isolated, join(isolated, "states"));
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`AwsHttpBindings ${label} did not reach ${invariant}`);
		process.stdout.write(
			`AwsHttpBindings ${label}: ${invariant} counterexample found\n`,
		);
	}
	const ingressSource = readFileSync(
		join(sharedDirectory, "AwsHttpIngress.tla"),
		"utf8",
	);
	const ingressResult = check(
		"AwsHttpIngress",
		sharedDirectory,
		join(scratch, "aws-ingress"),
	);
	if (
		ingressResult.status !== 0 ||
		!ingressResult.stdout.includes("No error has been found")
	)
		throw new Error(
			`AwsHttpIngress model checking failed:\n${ingressResult.stdout}\n${ingressResult.stderr}`,
		);
	process.stdout.write(ingressResult.stdout);
	const ingressCases = [
		[
			"dispatch-oversized",
			'/\\ state[r] = "reading" /\\ ~timedOut[r] /\\ units[r] <= MaxUnits',
			'/\\ state[r] = "reading" /\\ ~timedOut[r]',
			"NoOversizedDispatch",
		],
		[
			"release-on-read-timeout",
			'TimeoutRead(r) ==\n  /\\ state[r] = "reading"\n  /\\ state\' = [state EXCEPT ![r] = "canceling"]\n  /\\ timedOut\' = [timedOut EXCEPT ![r] = TRUE]\n  /\\ response\' = [response EXCEPT ![r] = "timeout"]\n  /\\ UNCHANGED <<slots, units, dispatched>>',
			'TimeoutRead(r) ==\n  /\\ state[r] = "reading"\n  /\\ state\' = [state EXCEPT ![r] = "canceling"]\n  /\\ timedOut\' = [timedOut EXCEPT ![r] = TRUE]\n  /\\ response\' = [response EXCEPT ![r] = "timeout"]\n  /\\ slots\' = slots \\ {r} /\\ UNCHANGED <<units, dispatched>>',
			"OutstandingRetainsSlot",
		],
		["timeout-witness", undefined, undefined, "NeverTimedOut"],
		["dispatch-witness", undefined, undefined, "NeverDispatched"],
	] as const;
	for (const [label, before, after, invariant] of ingressCases) {
		if (before !== undefined && ingressSource.split(before).length !== 2)
			throw new Error(`AwsHttpIngress ${label} mutation target changed`);
		const isolated = join(scratch, `aws-ingress-${label}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "AwsHttpIngress.tla"),
			before === undefined
				? ingressSource
				: ingressSource.replace(before, after),
		);
		writeFileSync(
			join(isolated, "AwsHttpIngress.cfg"),
			`SPECIFICATION Spec\nCONSTANTS Requests = {r1, r2}\n          Limit = 1\n          MaxUnits = 1\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`,
		);
		const result = check("AwsHttpIngress", isolated, join(isolated, "states"));
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`AwsHttpIngress ${label} did not reach ${invariant}`);
		process.stdout.write(
			`AwsHttpIngress ${label}: ${invariant} counterexample found\n`,
		);
	}
	const secretSource = readFileSync(
		join(sharedDirectory, "AwsSecretVersions.tla"),
		"utf8",
	);
	const secretResult = check(
		"AwsSecretVersions",
		sharedDirectory,
		join(scratch, "aws-secret"),
	);
	if (
		secretResult.status !== 0 ||
		!secretResult.stdout.includes("No error has been found")
	)
		throw new Error(
			`AwsSecretVersions model checking failed:\n${secretResult.stdout}\n${secretResult.stderr}`,
		);
	process.stdout.write(secretResult.stdout);
	const secretCases = [
		[
			"overwrite-version",
			'/\\ state \\in {"running", "timedout"} /\\ versions[token] = "none"',
			'/\\ state \\in {"running", "timedout"}',
			"OneVersionPerToken",
		],
		[
			"release-on-timeout",
			"/\\ UNCHANGED <<slot, grant, token, payload, versions, writes, responseVerified>>",
			"/\\ slot' = FALSE /\\ UNCHANGED <<grant, token, payload, versions, writes, responseVerified>>",
			"TimeoutRetainsSlot",
		],
		[
			"skip-grant-check",
			'IF grant THEN "success" ELSE "unknown"',
			'"success"',
			"SuccessIsConfirmed",
		],
		["success-witness", undefined, undefined, "NeverSuccess"],
		["timeout-witness", undefined, undefined, "NeverTimeout"],
	] as const;
	for (const [label, before, after, invariant] of secretCases) {
		if (before !== undefined && secretSource.split(before).length !== 2)
			throw new Error(`AwsSecretVersions ${label} mutation target changed`);
		const isolated = join(scratch, `aws-secret-${label}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "AwsSecretVersions.tla"),
			before === undefined ? secretSource : secretSource.replace(before, after),
		);
		writeFileSync(
			join(isolated, "AwsSecretVersions.cfg"),
			`SPECIFICATION Spec\nCONSTANTS Tokens = {t1, t2}\n          Payloads = {p1, p2}\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`,
		);
		const result = check(
			"AwsSecretVersions",
			isolated,
			join(isolated, "states"),
		);
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`AwsSecretVersions ${label} did not reach ${invariant}`);
		process.stdout.write(
			`AwsSecretVersions ${label}: ${invariant} counterexample found\n`,
		);
	}
	const orderingSource = readFileSync(
		join(sharedDirectory, "AwsSecretOrdering.tla"),
		"utf8",
	);
	const orderingResult = check(
		"AwsSecretOrdering",
		sharedDirectory,
		join(scratch, "aws-secret-ordering"),
	);
	if (
		orderingResult.status !== 0 ||
		!orderingResult.stdout.includes("No error has been found")
	)
		throw new Error(
			`AwsSecretOrdering model checking failed:\n${orderingResult.stdout}\n${orderingResult.stderr}`,
		);
	process.stdout.write(orderingResult.stdout);
	const orderingCases = [
		["ignore-order", "Unique(o) /\\ Sorted(o)", "Unique(o)", "NewestFirst"],
		[
			"accept-tie",
			'IF Distinct THEN "success" ELSE "unavailable"',
			'"success"',
			"TieRejected",
		],
		["success-witness", undefined, undefined, "NeverSuccess"],
		["unavailable-witness", undefined, undefined, "NeverUnavailable"],
	] as const;
	for (const [label, before, after, invariant] of orderingCases) {
		if (before !== undefined && orderingSource.split(before).length !== 2)
			throw new Error(`AwsSecretOrdering ${label} mutation target changed`);
		const isolated = join(scratch, `aws-secret-ordering-${label}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "AwsSecretOrdering.tla"),
			before === undefined
				? orderingSource
				: orderingSource.replace(before, after),
		);
		writeFileSync(
			join(isolated, "AwsSecretOrdering.cfg"),
			`SPECIFICATION Spec\nCONSTANTS Versions = {v1, v2, v3}\n          Times = {1, 2, 3}\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`,
		);
		const result = check(
			"AwsSecretOrdering",
			isolated,
			join(isolated, "states"),
		);
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`AwsSecretOrdering ${label} did not reach ${invariant}`);
		process.stdout.write(
			`AwsSecretOrdering ${label}: ${invariant} counterexample found\n`,
		);
	}
	const httpSecretSource = readFileSync(
		join(sharedDirectory, "AwsHttpSecret.tla"),
		"utf8",
	);
	const httpSecretResult = check(
		"AwsHttpSecret",
		sharedDirectory,
		join(scratch, "aws-http-secret"),
	);
	if (
		httpSecretResult.status !== 0 ||
		!httpSecretResult.stdout.includes("No error has been found")
	)
		throw new Error(
			`AwsHttpSecret model checking failed:\n${httpSecretResult.stdout}\n${httpSecretResult.stderr}`,
		);
	process.stdout.write(httpSecretResult.stdout);
	const httpSecretCases = [
		[
			"skip-recheck",
			'IF request = "active" /\\ grant THEN "success" ELSE "unknown"',
			'"success"',
			"SuccessVerified",
		],
		[
			"lose-write-id",
			'THEN "none" ELSE token',
			'THEN "none" ELSE "none"',
			"UnknownIdentifiesWrite",
		],
		["unknown-witness", undefined, undefined, "NeverUnknown"],
		["success-witness", undefined, undefined, "NeverSuccess"],
	] as const;
	for (const [label, before, after, invariant] of httpSecretCases) {
		if (before !== undefined && httpSecretSource.split(before).length !== 2)
			throw new Error(`AwsHttpSecret ${label} mutation target changed`);
		const isolated = join(scratch, `aws-http-secret-${label}`);
		mkdirSync(isolated);
		writeFileSync(
			join(isolated, "AwsHttpSecret.tla"),
			before === undefined
				? httpSecretSource
				: httpSecretSource.replace(before, after),
		);
		writeFileSync(
			join(isolated, "AwsHttpSecret.cfg"),
			`SPECIFICATION Spec\nCONSTANTS Tokens = {t1, t2}\nCHECK_DEADLOCK FALSE\nINVARIANT TypeOK\nINVARIANT ${invariant}\n`,
		);
		const result = check("AwsHttpSecret", isolated, join(isolated, "states"));
		if (
			result.status === 0 ||
			!result.stdout.includes(`Invariant ${invariant} is violated`)
		)
			throw new Error(`AwsHttpSecret ${label} did not reach ${invariant}`);
		process.stdout.write(
			`AwsHttpSecret ${label}: ${invariant} counterexample found\n`,
		);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
