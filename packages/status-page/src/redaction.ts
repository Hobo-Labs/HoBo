/**
 * Redaction gate for public publishing (ADR-0077 §4, Plan 49 verification).
 *
 * Pages are internal by default. Publishing publicly requires:
 * 1. a declared-public component allowlist (never publish by omission),
 * 2. a denylist scan over the *rendered output* (not the inputs — free text
 *    in `statuspage.IncidentPosted` bodies flows into the render), and
 * 3. a content hash recorded on the `statuspage.Published` audit event so a
 *    served snapshot can be matched to its audit trail.
 */
import { createHash } from "node:crypto";

import type { StatusPagePublishedData } from "./events.js";
import {
	describeIndicator,
	type EvaluateOptions,
	overallIndicatorFor,
	toStatusPageModel,
} from "./model.js";
import type { StatusPageRow } from "./projection.js";
import { renderStatusPageHtml } from "./render.js";
import type { StatusPageModel } from "./types.js";

export interface RedactionRule {
	readonly id: string;
	readonly pattern: RegExp;
	readonly description: string;
}

// public-contract: denylist scanned over rendered public output.
export const REDACTION_RULES: readonly RedactionRule[] = Object.freeze([
	{
		id: "credential-in-url",
		pattern: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@<>&"']+:[^/\s@<>&"']+@/gi,
		description: "URL with embedded credentials (user:pass@host)",
	},
	{
		id: "aws-access-key",
		pattern: /\bAKIA[0-9A-Z]{16}\b/g,
		description: "AWS access key id",
	},
	{
		id: "private-key-block",
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
		description: "PEM private key block",
	},
	{
		id: "private-ipv4",
		pattern:
			/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
		description: "RFC-1918 private IPv4 address",
	},
	{
		id: "loopback-url",
		pattern: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\b/gi,
		description: "loopback URL (internal occupancy endpoint)",
	},
	{
		id: "internal-hostname",
		pattern: /\b[a-z0-9][a-z0-9-]*\.(?:internal|corp|lan|intranet)\b/gi,
		description: "internal hostname suffix",
	},
	{
		id: "email-address",
		pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
		description: "email address (customer-specific data)",
	},
	{
		id: "secret-assignment",
		pattern:
			/\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*[^\s<>&"']{6,}/gi,
		description: "inline secret assignment",
	},
]);

export interface RedactionViolation {
	readonly rule: string;
	readonly description: string;
	readonly match: string;
	readonly index: number;
}

export interface ScanOptions {
	/** Matches for which any predicate returns true are allowed through. */
	readonly allow?: readonly ((match: string) => boolean)[];
}

export function scanRenderedOutput(
	rendered: string,
	options: ScanOptions = {},
): readonly RedactionViolation[] {
	const violations: RedactionViolation[] = [];
	for (const rule of REDACTION_RULES) {
		const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
		for (const match of rendered.matchAll(pattern)) {
			const value = match[0];
			if (options.allow?.some((predicate) => predicate(value))) continue;
			violations.push({
				rule: rule.id,
				description: rule.description,
				match: value,
				index: match.index ?? 0,
			});
		}
	}
	return Object.freeze(violations);
}

export class StatusPageRedactionError extends Error {
	readonly violations: readonly RedactionViolation[];
	constructor(violations: readonly RedactionViolation[]) {
		super(
			`[status-page-redaction] rendered output failed the public redaction gate: ${violations
				.map((violation) => violation.rule)
				.join(", ")}`,
		);
		this.name = "StatusPageRedactionError";
		this.violations = violations;
	}
}

export function assertPublishable(
	rendered: string,
	options: ScanOptions = {},
): void {
	const violations = scanRenderedOutput(rendered, options);
	if (violations.length > 0) {
		throw new StatusPageRedactionError(violations);
	}
}

export function contentHashOf(rendered: string): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(rendered, "utf8").digest("hex")}`;
}

export interface PublishOptions extends ScanOptions {
	/**
	 * Declared-public component allowlist (ADR-0077 §4). Required — a public
	 * publish with no allowlist is a configuration error, not "publish all".
	 */
	readonly componentAllowlist: readonly string[];
	readonly evaluate: EvaluateOptions;
}

export interface PublishedStatusPage {
	readonly model: StatusPageModel;
	readonly html: string;
	readonly contentHash: `sha256:${string}`;
	/** Payload for the `statuspage.Published` audit event. */
	readonly publishedEvent: StatusPagePublishedData;
}

/**
 * Produce the public rendering of a page: filter to the declared-public
 * component allowlist, render, run the redaction gate, and hash the exact
 * bytes served.
 */
export function publishStatusPage(
	row: StatusPageRow | undefined,
	options: PublishOptions,
): PublishedStatusPage {
	if (options.componentAllowlist.length === 0) {
		throw new TypeError(
			"publishStatusPage requires a non-empty declared-public component allowlist (ADR-0077 §4)",
		);
	}
	const allowed = new Set(options.componentAllowlist);
	const internalModel = toStatusPageModel(row, options.evaluate);
	const components = internalModel.components.filter((component) =>
		allowed.has(component.spec.id),
	);
	const componentIds = new Set(components.map((c) => c.spec.id));
	const filterIncident = (incident: {
		readonly affectedComponents: readonly string[];
	}): boolean =>
		incident.affectedComponents.length === 0 ||
		incident.affectedComponents.some((id) => componentIds.has(id));
	// Recompute the banner from public components only — the public indicator
	// must not leak the health of undeclared internal components.
	const indicator = overallIndicatorFor(
		components.map((component) => component.status),
	);
	const model: StatusPageModel = Object.freeze({
		...internalModel,
		overall: Object.freeze({
			indicator,
			description:
				indicator === internalModel.overall.indicator
					? internalModel.overall.description
					: describeIndicator(indicator),
		}),
		components: Object.freeze(components),
		activeIncidents: Object.freeze(
			internalModel.activeIncidents.filter(filterIncident),
		),
		recentIncidents: Object.freeze(
			internalModel.recentIncidents.filter(filterIncident),
		),
		maintenances: Object.freeze(
			internalModel.maintenances.filter(filterIncident),
		),
	});
	const html = renderStatusPageHtml(model);
	assertPublishable(html, options);
	const contentHash = contentHashOf(html);
	return Object.freeze({
		model,
		html,
		contentHash,
		publishedEvent: Object.freeze({
			scopeKind: model.scope.kind,
			scopeId: model.scope.id,
			contentHash,
			components: Object.freeze([...componentIds].sort()),
		}),
	});
}
