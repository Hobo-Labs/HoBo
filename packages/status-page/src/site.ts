/**
 * Static status-site writer. Rendering stays pure; this module is the only
 * place that touches the filesystem (the `visual.ts` split convention).
 *
 * Layout per page (cState/Upptime-style static hosting, statuspage-v2 API):
 *   <root>/<slug>/index.html
 *   <root>/<slug>/api/v2/summary.json
 *   <root>/<slug>/api/v2/status.json
 *   <root>/index.html                  (portfolio directory of all pages)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { contentHashOf } from "./redaction.js";
import { escapeHtml, renderStatusPageHtml } from "./render.js";
import { toStatuspageStatus, toStatuspageSummary } from "./statuspage-json.js";
import { STATUS_PAGE_SCHEMA, type StatusPageModel } from "./types.js";

export interface StatusSitePage {
	readonly model: StatusPageModel;
	/** Directory slug; defaults to `<scope.kind>-<scope.id>`. */
	readonly slug?: string;
}

export interface WriteStatusSiteOptions {
	readonly rootDir: string;
	readonly pages: readonly StatusSitePage[];
	/** Base URL recorded in the statuspage-v2 `page.url` field. */
	readonly baseUrl?: string;
}

export interface WrittenStatusPage {
	readonly slug: string;
	readonly htmlPath: string;
	readonly summaryPath: string;
	readonly contentHash: `sha256:${string}`;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function slugFor(page: StatusSitePage): string {
	const slug = page.slug ?? `${page.model.scope.kind}-${page.model.scope.id}`;
	if (!SLUG_PATTERN.test(slug) || slug.includes("..")) {
		throw new TypeError(
			`status site slug must match ${SLUG_PATTERN} (got "${slug}")`,
		);
	}
	return slug;
}

function assertInside(rootDir: string, target: string): void {
	const root = resolve(rootDir);
	const resolved = resolve(target);
	if (resolved !== root && !resolved.startsWith(root + sep)) {
		throw new TypeError(`status site path escapes root: ${target}`);
	}
}

function renderDirectoryHtml(
	entries: readonly {
		readonly slug: string;
		readonly model: StatusPageModel;
	}[],
): string {
	const rows = entries
		.map(
			(entry) =>
				`<li class="component" data-state="${escapeHtml(
					entry.model.overall.indicator === "none"
						? "operational"
						: entry.model.overall.indicator === "maintenance"
							? "maintenance"
							: entry.model.overall.indicator === "unknown"
								? "unknown"
								: "degraded",
				)}"><div class="row"><a class="name" href="./${escapeHtml(entry.slug)}/">${escapeHtml(entry.model.scope.label)}</a><span class="state">${escapeHtml(entry.model.overall.description)}</span></div></li>`,
		)
		.join("\n");
	// The directory is a components-list page of links in the same chrome.
	const generatedAt = entries
		.map((entry) => entry.model.generatedAt)
		.sort()
		.at(-1);
	const shell = renderStatusPageHtml({
		schema: STATUS_PAGE_SCHEMA,
		scope: { kind: "project", id: "portfolio", label: "Status pages" },
		generatedAt: generatedAt ?? "",
		overall: { indicator: "none", description: "All status pages" },
		components: [],
		activeIncidents: [],
		recentIncidents: [],
		maintenances: [],
		freshness: { budgetMs: 0, staleComponentIds: [] },
	});
	return shell.replace(
		`<p class="empty">No components registered yet. Components appear when SLO measurements or incidents reference this scope.</p>`,
		`<ul class="components">${rows}</ul>`,
	);
}

/** Write every page (HTML + statuspage-v2 JSON) plus a portfolio index. */
export function writeStatusSite(
	options: WriteStatusSiteOptions,
): readonly WrittenStatusPage[] {
	const slugs = new Set<string>();
	const written: WrittenStatusPage[] = [];
	const directory: { slug: string; model: StatusPageModel }[] = [];
	mkdirSync(options.rootDir, { recursive: true });
	for (const page of options.pages) {
		const slug = slugFor(page);
		if (slugs.has(slug)) {
			throw new TypeError(`duplicate status site slug "${slug}"`);
		}
		slugs.add(slug);
		const pageDir = join(options.rootDir, slug);
		const apiDir = join(pageDir, "api", "v2");
		assertInside(options.rootDir, apiDir);
		mkdirSync(apiDir, { recursive: true });
		const pageUrl =
			options.baseUrl !== undefined ? `${options.baseUrl}/${slug}/` : "";
		const html = renderStatusPageHtml(page.model);
		const htmlPath = join(pageDir, "index.html");
		writeFileSync(htmlPath, html, "utf8");
		const summaryPath = join(apiDir, "summary.json");
		writeFileSync(
			summaryPath,
			`${JSON.stringify(toStatuspageSummary(page.model, { pageUrl }), null, 2)}\n`,
			"utf8",
		);
		writeFileSync(
			join(apiDir, "status.json"),
			`${JSON.stringify(toStatuspageStatus(page.model, { pageUrl }), null, 2)}\n`,
			"utf8",
		);
		directory.push({ slug, model: page.model });
		written.push(
			Object.freeze({
				slug,
				htmlPath,
				summaryPath,
				contentHash: contentHashOf(html),
			}),
		);
	}
	if (directory.length > 0) {
		writeFileSync(
			join(options.rootDir, "index.html"),
			renderDirectoryHtml(directory),
			"utf8",
		);
	}
	return Object.freeze(written);
}
