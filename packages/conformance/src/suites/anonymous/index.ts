/**
 * The anonymous/claimable conformance dimension, assembled.
 *
 * Four suites, one registry entry each, and one convenience runner that drives
 * all four from a single set of executor ports.
 */
import { createConformanceSuiteRegistry } from "../../registry.js";
import type { ConformanceSuiteRegistry } from "../../types.js";
import {
	BINDING_CONFORMANCE_SUITE,
	type BindingProbeRequest,
} from "./binding.js";
import {
	BOOTSTRAP_CONFORMANCE_SUITE,
	type BootstrapAttemptRequest,
} from "./bootstrap.js";
import { CLAIM_CONFORMANCE_SUITE, type ClaimStepRequest } from "./claim.js";
import { describeAnonymousSuite, runAnonymousSuite } from "./harness.js";
import {
	MIGRATION_CONFORMANCE_SUITE,
	type MigrationStepRequest,
} from "./migration.js";
import type {
	AnonymousConformanceReport,
	AnonymousExecutor,
	AnonymousSuiteDescriptor,
} from "./types.js";

export * from "./binding.js";
export * from "./bootstrap.js";
export * from "./claim.js";
export * from "./harness.js";
export * from "./migration.js";
export * from "./reference-adapter.js";
export * from "./types.js";

/** Descriptors for the four suites, in the order the live lane runs them. */
export const ANONYMOUS_SUITE_DESCRIPTORS: readonly AnonymousSuiteDescriptor[] =
	Object.freeze([
		describeAnonymousSuite(BOOTSTRAP_CONFORMANCE_SUITE),
		describeAnonymousSuite(CLAIM_CONFORMANCE_SUITE),
		describeAnonymousSuite(BINDING_CONFORMANCE_SUITE),
		describeAnonymousSuite(MIGRATION_CONFORMANCE_SUITE),
	]);

/**
 * A registry pre-loaded with the anonymous dimension.
 *
 * Built fresh on each call so a caller that registers a provider-specific
 * variant cannot mutate everybody else's view of the catalog.
 */
export function createAnonymousSuiteRegistry(): ConformanceSuiteRegistry {
	return createConformanceSuiteRegistry(ANONYMOUS_SUITE_DESCRIPTORS);
}

/** The executor ports the whole dimension needs. One per suite. */
export interface AnonymousExecutorPorts {
	readonly bootstrap: AnonymousExecutor<BootstrapAttemptRequest>;
	readonly claim: AnonymousExecutor<ClaimStepRequest>;
	readonly binding: AnonymousExecutor<BindingProbeRequest>;
	readonly migration: AnonymousExecutor<MigrationStepRequest>;
}

export interface RunAnonymousConformanceOptions {
	readonly subjectId?: string;
	/** Restrict each suite to these case ids. Omitted cases report `unknown`. */
	readonly caseIds?: readonly string[];
}

/**
 * Run bootstrap, claim, binding, and migration against one product.
 *
 * Reports come back in descriptor order so a caller folding them into evidence
 * gets a stable digest regardless of how the executors resolved.
 */
export async function runAnonymousConformance(
	ports: AnonymousExecutorPorts,
	options: RunAnonymousConformanceOptions = {},
): Promise<readonly AnonymousConformanceReport[]> {
	const suiteOptions = {
		...(options.subjectId !== undefined
			? { subjectId: options.subjectId }
			: undefined),
		...(options.caseIds !== undefined
			? { caseIds: options.caseIds }
			: undefined),
	};

	return Object.freeze([
		await runAnonymousSuite(
			BOOTSTRAP_CONFORMANCE_SUITE,
			ports.bootstrap,
			suiteOptions,
		),
		await runAnonymousSuite(CLAIM_CONFORMANCE_SUITE, ports.claim, suiteOptions),
		await runAnonymousSuite(
			BINDING_CONFORMANCE_SUITE,
			ports.binding,
			suiteOptions,
		),
		await runAnonymousSuite(
			MIGRATION_CONFORMANCE_SUITE,
			ports.migration,
			suiteOptions,
		),
	]);
}
