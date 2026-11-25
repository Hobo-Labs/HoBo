import { z } from "zod";
import {
	collectAllowedRelayOrigins,
	defaultCiWebhookEngine,
	resolveEngineRelayOrigin,
} from "./engine-relay-routing.js";
import type { GithubRun } from "./github.js";
import {
	type CiProjectConfig,
	type CiProjectEnvironment,
	parseCiProjectConfig,
	selectCiEnvironment,
} from "./project-config.js";
import { parseRunnerRouting, type RunnerRouting } from "./runner-routing.js";

// public-contract: default committed CI project path at repository root.
export const DEFAULT_CI_PROJECT_PATH = ".hobo/ci.json";
// public-contract: gitignored local overlay merged at load time.
export const CI_PROJECT_LOCAL_OVERRIDE_PATH = ".hobo/ci.local.json";

const environmentName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const SelectionMatch = z
	.object({
		refPrefix: z.string().min(1).max(200).optional(),
		branch: z.string().min(1).max(255).optional(),
		events: z.array(z.string().min(1).max(100)).max(16).optional(),
	})
	.strict();
const SelectionRule = z
	.object({
		environment: z.string().regex(environmentName),
		match: SelectionMatch.optional(),
	})
	.strict();
export const CiProjectSelectionSchema = z
	.object({
		rules: z.array(SelectionRule).max(32).optional(),
		forkPullRequestEnvironment: z.string().regex(environmentName).optional(),
	})
	.strict()
	.optional();

const JsonValue = z.json();
const JsonObjectSchema = z.record(z.string(), JsonValue);

const CiProjectJsonEnvelopeSchema = z
	.object({
		environments: JsonObjectSchema.optional(),
		templates: JsonObjectSchema.optional(),
		selection: CiProjectSelectionSchema,
	})
	.passthrough();

function parseJsonObject(
	value: z.infer<typeof JsonValue> | undefined,
): CiProjectJsonObject {
	const parsed = JsonObjectSchema.safeParse(value);
	return parsed.success ? parsed.data : {};
}

type CiProjectJsonObject = z.infer<typeof JsonObjectSchema>;

function mergeJsonObjects(
	base: CiProjectJsonObject,
	override: CiProjectJsonObject,
): CiProjectJsonObject {
	const merged: z.infer<typeof JsonObjectSchema> = { ...base };
	for (const key of Object.keys(override)) {
		// SAFETY: override is a parsed JSON object; keys index JsonValue entries.
		const value = override[key] as z.infer<typeof JsonValue>;
		const inherited = merged[key];
		const inheritedObject = JsonObjectSchema.safeParse(inherited);
		const overrideObject = JsonObjectSchema.safeParse(value);
		if (
			inheritedObject.success &&
			overrideObject.success &&
			!Array.isArray(inheritedObject.data) &&
			!Array.isArray(overrideObject.data)
		)
			merged[key] = mergeJsonObjects(inheritedObject.data, overrideObject.data);
		else merged[key] = value;
	}
	return merged;
}

export type CiJobAdmission = "push" | "pull";

export interface CiWebhookRoutingContext {
	readonly repositoryFullName: string;
	readonly repositoryId: number;
	readonly installationId: number;
	readonly workflowRunId: number;
	readonly eventName: string;
	readonly headBranch: string | undefined;
	readonly headRef: string | undefined;
	readonly isForkPullRequest: boolean;
	readonly configRef: string;
}

export interface ResolvedCiRelayRoute {
	readonly engine: string;
	readonly environment: CiProjectEnvironment;
	readonly relayOrigin: string;
	readonly admission: CiJobAdmission;
	readonly configRef: string;
	readonly isForkPullRequest: boolean;
}

/**
 * The committed `runnerRouting` block of `.hobo/ci.json` (ADR-0181, "Routing list"), or
 * nothing when the file has none or it is not a policy. Never throws.
 */
export function parseCiRunnerRouting(json: string): RunnerRouting | undefined {
	try {
		const document = JsonObjectSchema.safeParse(JSON.parse(json));
		return document.success
			? parseRunnerRouting(document.data.runnerRouting)
			: undefined;
	} catch {
		return undefined;
	}
}

export function parseCiProjectSelection(
	document: z.infer<typeof JsonValue>,
): z.infer<typeof CiProjectSelectionSchema> {
	const envelope = CiProjectJsonEnvelopeSchema.safeParse(document);
	return CiProjectSelectionSchema.parse(
		envelope.success ? envelope.data.selection : undefined,
	);
}

/** Merge a gitignored local overlay onto committed project JSON (environments only). */
export function mergeCiProjectLocalOverlay(
	committedJson: string,
	localJson: string,
): string {
	const committed = CiProjectJsonEnvelopeSchema.parse(
		JSON.parse(committedJson),
	);
	const local = CiProjectJsonEnvelopeSchema.parse(JSON.parse(localJson));
	const mergedEnvironments = mergeJsonObjects(
		parseJsonObject(committed.environments),
		parseJsonObject(local.environments),
	);
	const mergedTemplates = mergeJsonObjects(
		parseJsonObject(committed.templates),
		parseJsonObject(local.templates),
	);
	const merged: z.infer<typeof CiProjectJsonEnvelopeSchema> = {
		...committed,
		...local,
	};
	if (Object.keys(mergedTemplates).length > 0)
		merged.templates = mergedTemplates;
	if (Object.keys(mergedEnvironments).length > 0)
		merged.environments = mergedEnvironments;
	return JSON.stringify(merged);
}

export function loadCiProjectConfigDocument(
	committedJson: string,
	localJson?: string,
	organization?: CiProjectConfig,
): CiProjectConfig {
	const merged = localJson
		? mergeCiProjectLocalOverlay(committedJson, localJson)
		: committedJson;
	return parseCiProjectConfig(merged, organization);
}

export function resolveExplicitCiEnvironmentName(
	config: CiProjectConfig,
	explicit: string | undefined,
	fallbackEnv?: NodeJS.ProcessEnv,
): string {
	const fromEnv = fallbackEnv?.HOBO_CI_ENVIRONMENT?.trim();
	const chosen = explicit ?? fromEnv ?? config.defaultEnvironment;
	if (
		!environmentName.test(chosen) ||
		!Object.hasOwn(config.environments, chosen)
	)
		throw new Error("unknown CI environment");
	return chosen;
}

export function isForkPullRequestRun(
	run: GithubRun,
	baseRepositoryId: number,
): boolean {
	return (
		run.event === "pull_request" &&
		run.head_repository !== null &&
		run.head_repository.id !== baseRepositoryId
	);
}

/** Config ref is a branch name or 40-char commit SHA for GitHub contents API. */
export function resolveCiConfigRefForRun(
	run: GithubRun,
	baseRepositoryId: number,
): string {
	if (isForkPullRequestRun(run, baseRepositoryId)) {
		const baseRef = run.pull_requests?.[0]?.base.ref;
		if (!baseRef) throw new Error("fork pull request missing base ref");
		return baseRef;
	}
	if (!/^[0-9a-f]{40}$/i.test(run.head_sha))
		throw new Error("workflow run missing head sha");
	return run.head_sha.toLowerCase();
}

export function inferJobAdmission(
	environment: CiProjectEnvironment,
	declared?: CiJobAdmission,
): CiJobAdmission {
	if (declared === "push" || declared === "pull") return declared;
	if (environment.allowInsecureLoopback) {
		try {
			const host = new URL(environment.relayOrigin).hostname;
			if (host === "127.0.0.1" || host === "localhost") return "pull";
		} catch {
			/* fall through */
		}
	}
	return "push";
}

function ruleMatches(
	rule: z.infer<typeof SelectionRule>,
	context: CiWebhookRoutingContext,
): boolean {
	const match = rule.match;
	if (!match) return true;
	if (
		match.events &&
		!match.events.some(
			(event) => event.toLowerCase() === context.eventName.toLowerCase(),
		)
	)
		return false;
	const ref =
		context.headRef ??
		(context.headBranch ? `refs/heads/${context.headBranch}` : undefined);
	if (match.refPrefix && !ref?.startsWith(match.refPrefix)) return false;
	if (match.branch) {
		const branch = ref?.startsWith("refs/heads/")
			? ref.slice("refs/heads/".length)
			: context.headBranch;
		if (branch !== match.branch) return false;
	}
	return true;
}

export function selectEnvironmentForWebhook(
	config: CiProjectConfig,
	selection: z.infer<typeof CiProjectSelectionSchema>,
	context: CiWebhookRoutingContext,
): CiProjectEnvironment {
	if (
		context.isForkPullRequest &&
		selection?.forkPullRequestEnvironment &&
		Object.hasOwn(config.environments, selection.forkPullRequestEnvironment)
	)
		return selectCiEnvironment(config, selection.forkPullRequestEnvironment);
	for (const rule of selection?.rules ?? []) {
		if (!Object.hasOwn(config.environments, rule.environment)) continue;
		if (ruleMatches(rule, context))
			return selectCiEnvironment(config, rule.environment);
	}
	return selectCiEnvironment(config);
}

export function resolveCiRelayRoute(options: {
	config: CiProjectConfig;
	selection: z.infer<typeof CiProjectSelectionSchema>;
	context: CiWebhookRoutingContext;
	jobAdmission?: CiJobAdmission;
	engine?: string;
}): ResolvedCiRelayRoute {
	const environment = selectEnvironmentForWebhook(
		options.config,
		options.selection,
		options.context,
	);
	const engine = options.engine ?? defaultCiWebhookEngine();
	const admission = inferJobAdmission(environment, options.jobAdmission);
	return Object.freeze({
		engine,
		environment,
		relayOrigin: resolveEngineRelayOrigin(environment, engine),
		admission,
		configRef: options.context.configRef,
		isForkPullRequest: options.context.isForkPullRequest,
	});
}

/** Only forward to origins declared in the resolved project config document. */
export function assertRelayOriginAllowed(
	route: ResolvedCiRelayRoute,
	config: CiProjectConfig,
): void {
	const allowed = new Set<string>();
	for (const entry of Object.values(config.environments))
		for (const origin of collectAllowedRelayOrigins(entry)) allowed.add(origin);
	if (!allowed.has(route.relayOrigin))
		throw new Error("relay origin not allowed");
}

export function relayWebhookPath(engine: string): string {
	return `/engines/${engine}/github/webhooks`;
}
