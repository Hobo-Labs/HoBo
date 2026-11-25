import { isJsonString } from "../json.js";
import { UsageError } from "../shell/errors.js";

export const VALID_TEMPLATES = ["todo", "api", "agent", "fullstack"] as const;
export type TemplateId = (typeof VALID_TEMPLATES)[number];

const RESERVED_WINDOWS_NAMES = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	"COM1",
	"COM2",
	"COM3",
	"COM4",
	"COM5",
	"COM6",
	"COM7",
	"COM8",
	"COM9",
	"LPT1",
	"LPT2",
	"LPT3",
	"LPT4",
	"LPT5",
	"LPT6",
	"LPT7",
	"LPT8",
	"LPT9",
]);

export type ProjectName = string & { readonly __brand: "ProjectName" };
export type ParsedTemplateId = TemplateId & { readonly __brand: "TemplateId" };

export function parseProjectName(raw: string): ProjectName {
	if (!isJsonString(raw) || raw.trim() === "") {
		throw new UsageError(
			"Invalid project name: project name cannot be empty.",
			["Provide a single directory name, for example `hobo new my-app`."],
		);
	}
	if (raw !== raw.trim()) {
		throw new UsageError(
			`Invalid project name "${raw}": leading and trailing spaces are not allowed.`,
			["Remove leading or trailing spaces from the project name."],
		);
	}
	if (raw === "." || raw === ".." || raw.includes("..")) {
		throw new UsageError(
			`Invalid project name "${raw}": parent directory traversal is not allowed.`,
			["Use a simple directory name without `..` segments."],
		);
	}
	if (/[\\/:*?"<>|]/.test(raw)) {
		throw new UsageError(
			`Invalid project name "${raw}": path separators and reserved characters are not allowed.`,
			["Use letters, numbers, hyphens, and underscores only."],
		);
	}
	const base = raw.replace(/\..*$/, "").toUpperCase();
	if (RESERVED_WINDOWS_NAMES.has(base)) {
		throw new UsageError(
			`Invalid project name "${raw}": reserved device names are not allowed.`,
			["Pick a name that is not a reserved Windows device name."],
		);
	}
	// SAFETY: `return raw as ProjectName;` is required at this I/O or test boundary.
	return raw as ProjectName;
}

export function parseTemplateId(raw: string): ParsedTemplateId {
	// SAFETY: `if (!VALID_TEMPLATES.includes(raw as TemplateId)) {` is required at this I/O or test boundary.
	if (!VALID_TEMPLATES.includes(raw as TemplateId)) {
		throw new UsageError(
			`Unknown template "${raw}". Valid templates: ${VALID_TEMPLATES.join(", ")}.`,
			[`Pass -t with one of: ${VALID_TEMPLATES.join(", ")}.`],
		);
	}
	// SAFETY: `return raw as ParsedTemplateId;` is required at this I/O or test boundary.
	return raw as ParsedTemplateId;
}

// domain-view: parsed CLI-facing type (string unions, branded ids, literal fields); the package's data-models/*.proto is its wire contract (technical-standards.md).
export interface ScaffoldRequest {
	readonly name: ProjectName;
	readonly template: ParsedTemplateId;
	readonly force: boolean;
}

// domain-view: parsed CLI-facing type (string unions, branded ids, literal fields); the package's data-models/*.proto is its wire contract (technical-standards.md).
export interface ScaffoldResult {
	readonly projectDir: string;
	readonly name: ProjectName;
	readonly template: ParsedTemplateId;
	readonly createdFiles: readonly string[];
	readonly offline: true;
	readonly nextSteps: readonly string[];
}
