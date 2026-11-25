import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"ai-bdd",
);

export type ReportNode =
	| string
	| number
	| boolean
	| null
	| ReportNode[]
	| ReportDoc;
export interface ReportDoc {
	[key: string]: ReportNode;
}

export function fixtureBytes(name: string): Buffer {
	return readFileSync(join(FIXTURE_DIR, name));
}

export function fixtureDoc(name: "passed" | "failed"): ReportDoc {
	const text = fixtureBytes(`report.v1.${name}.json`).toString("utf8");
	return JSON.parse(text) as ReportDoc;
}

export function bytesOf(doc: ReportDoc): Buffer {
	return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

function isDoc(node: ReportNode | undefined): node is ReportDoc {
	return (
		node !== undefined &&
		node !== null &&
		!Array.isArray(node) &&
		Object.prototype.toString.call(node) === "[object Object]"
	);
}

function childDocs(node: ReportNode | undefined): ReportDoc[] {
	if (Array.isArray(node)) return node.flatMap((entry) => childDocs(entry));
	return isDoc(node) ? [node] : [];
}

function parentsOf(doc: ReportDoc, segments: readonly string[]): ReportDoc[] {
	let current: ReportDoc[] = [doc];
	for (const segment of segments) {
		const key = segment.replace(/\[\]$/u, "");
		current = current.flatMap((node) => childDocs(node[key]));
	}
	return current;
}

export function removeAt(doc: ReportDoc, path: string): ReportDoc {
	const segments = path.split(".");
	const leaf = segments.at(-1)?.replace(/\[\]$/u, "") ?? "";
	for (const parent of parentsOf(doc, segments.slice(0, -1))) {
		delete parent[leaf];
	}
	return doc;
}

export function docAt(doc: ReportDoc, key: string): ReportDoc {
	const node = doc[key];
	if (!isDoc(node)) throw new Error(`fixture has no object at ${key}`);
	return node;
}

export function scenarioAt(doc: ReportDoc, index: number): ReportDoc {
	const scenarios = doc.scenarios;
	const node = Array.isArray(scenarios) ? scenarios[index] : undefined;
	if (!isDoc(node)) throw new Error(`fixture has no scenario ${index}`);
	return node;
}

export function stepAt(
	doc: ReportDoc,
	scenario: number,
	index: number,
): ReportDoc {
	const steps = scenarioAt(doc, scenario).steps;
	const node = Array.isArray(steps) ? steps[index] : undefined;
	if (!isDoc(node)) throw new Error(`fixture has no step ${scenario}.${index}`);
	return node;
}

export function nodeAt(doc: ReportDoc, path: string): ReportDoc {
	let node: ReportNode = doc;
	for (const segment of path === "" ? [] : path.split(".")) {
		const next: ReportNode | undefined = Array.isArray(node)
			? node[Number(segment)]
			: isDoc(node)
				? node[segment]
				: undefined;
		if (next === undefined) throw new Error(`fixture has nothing at ${path}`);
		node = next;
	}
	if (!isDoc(node)) throw new Error(`fixture has no object at ${path}`);
	return node;
}

export function perturbAt(doc: ReportDoc, path: string): ReportDoc {
	const segments = path.split(".");
	const leaf = segments.at(-1)?.replace(/\[\]$/u, "") ?? "";
	for (const parent of parentsOf(doc, segments.slice(0, -1))) {
		const value = parent[leaf];
		if (value === undefined) continue;
		if (Array.isArray(value)) parent[leaf] = value.length === 0 ? [{}] : [];
		else if (isDoc(value)) parent[leaf] = {};
		else if (value === true || value === false) parent[leaf] = !value;
		else if (value === null) parent[leaf] = 0;
		else if (Object.prototype.toString.call(value) === "[object Number]") {
			parent[leaf] = Number(value) + 1;
		} else parent[leaf] = `${String(value)}~`;
	}
	return doc;
}
