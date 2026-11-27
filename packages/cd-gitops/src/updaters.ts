import type { JsonObject, JsonValue } from "@hobo/core";
import { GitopsError } from "./errors.js";
import { isJsonObject, isJsonString } from "./json.js";
import { stableDocument } from "./render.js";

export type JsonPathUpdateStep = Readonly<{
	kind: "json-path";
	path: string;
	keyPath: readonly string[];
	value: JsonValue;
}>;

export type YamlScalarUpdateStep = Readonly<{
	kind: "yaml-scalar";
	path: string;
	keyPath: readonly string[];
	value: string | number | boolean;
}>;

export type KustomizeImageUpdateStep = Readonly<{
	kind: "kustomize-image";
	path: string;
	imageName: string;
	newName?: string;
	newTag?: string;
	digest?: string;
}>;

export type ManifestUpdateStep =
	| JsonPathUpdateStep
	| YamlScalarUpdateStep
	| KustomizeImageUpdateStep;

interface MutableJsonDocument {
	[key: string]: JsonValue;
}

function validateKeyPath(keyPath: readonly string[], kind: string): void {
	if (keyPath.length === 0) {
		throw new GitopsError(
			"gitops-config-invalid",
			`${kind} update requires a non-empty keyPath`,
		);
	}
	for (const segment of keyPath) {
		if (segment.trim() === "" || /[\r\n]/u.test(segment)) {
			throw new GitopsError(
				"gitops-config-invalid",
				`${kind} update contains an invalid keyPath segment`,
			);
		}
	}
}

function cloneJsonObject(obj: JsonObject): MutableJsonDocument {
	const out: MutableJsonDocument = {};
	for (const [key, val] of Object.entries(obj)) {
		if (val !== undefined) out[key] = val;
	}
	return out;
}

function parseJsonDocument(source: string, label: string): JsonObject {
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new GitopsError(
			"gitops-config-invalid",
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isJsonObject(parsed)) {
		throw new GitopsError(
			"gitops-config-invalid",
			`${label} root must be a JSON object`,
		);
	}
	return parsed;
}

export function applyJsonPathUpdate(
	source: string,
	keyPath: readonly string[],
	value: JsonValue,
): string {
	validateKeyPath(keyPath, "json-path");
	const parsed = parseJsonDocument(source, "json-path target");
	const root = cloneJsonObject(parsed);
	let cursor: MutableJsonDocument = root;
	for (let i = 0; i < keyPath.length - 1; i += 1) {
		const segment = keyPath[i];
		if (segment === undefined) continue;
		const existing = cursor[segment];
		if (existing === undefined) {
			const created: MutableJsonDocument = {};
			cursor[segment] = created;
			cursor = created;
			continue;
		}
		if (!isJsonObject(existing)) {
			throw new GitopsError(
				"gitops-config-invalid",
				`json-path segment "${segment}" is not an object`,
			);
		}
		const clone = cloneJsonObject(existing);
		cursor[segment] = clone;
		cursor = clone;
	}
	const leaf = keyPath[keyPath.length - 1];
	if (leaf !== undefined) {
		cursor[leaf] = value;
	}
	return stableDocument(root);
}

function formatYamlScalar(value: string | number | boolean): string {
	if (!isJsonString(value)) {
		return String(value);
	}
	if (/[\r\n]/u.test(value)) {
		throw new GitopsError(
			"gitops-config-invalid",
			"yaml-scalar string value must not contain newlines",
		);
	}
	if (
		value === "" ||
		/^[\s]|[\s]$/u.test(value) ||
		/[:#{}[\],&*!?|>'"%@`]/u.test(value) ||
		/^(true|false|null|~|yes|no|on|off)$/iu.test(value) ||
		/^[+-]?\d+(\.\d+)?$/u.test(value)
	) {
		return JSON.stringify(value);
	}
	return value;
}

function lineIndent(line: string): number {
	let count = 0;
	while (count < line.length && line[count] === " ") {
		count += 1;
	}
	return count;
}

function parseYamlMappingKey(trimmed: string): string | undefined {
	if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("- ")) {
		return undefined;
	}
	const colon = trimmed.indexOf(":");
	if (colon <= 0) return undefined;
	const after = trimmed[colon + 1];
	if (after !== undefined && after !== " " && after !== "\t") return undefined;
	return trimmed
		.slice(0, colon)
		.trim()
		.replace(/^["']|["']$/gu, "");
}

function findBlockEnd(
	lines: readonly string[],
	parentIndex: number,
	parentIndent: number,
): number {
	let end = parentIndex + 1;
	while (end < lines.length) {
		const candidate = lines[end] ?? "";
		const trimmed = candidate.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			end += 1;
			continue;
		}
		if (lineIndent(candidate) <= parentIndent) {
			break;
		}
		end += 1;
	}
	return end;
}

export function applyYamlScalarUpdate(
	source: string,
	keyPath: readonly string[],
	value: string | number | boolean,
): string {
	validateKeyPath(keyPath, "yaml-scalar");
	const formatted = formatYamlScalar(value);
	const hadTrailingNewline = source.endsWith("\n") || source === "";
	const rawLines =
		source === ""
			? []
			: source.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n");
	const lines = [...rawLines];

	let rangeStart = 0;
	let rangeEnd = lines.length;
	let expectedIndent = 0;
	let matchedDepth = 0;

	for (let depth = 0; depth < keyPath.length; depth += 1) {
		const targetKey = keyPath[depth];
		if (targetKey === undefined) break;
		let foundIndex = -1;
		let foundIndent = expectedIndent;

		for (let i = rangeStart; i < rangeEnd; i += 1) {
			const line = lines[i] ?? "";
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;
			const indent = lineIndent(line);
			if (depth === 0) {
				if (indent !== 0) continue;
			} else if (indent < expectedIndent) {
				break;
			} else if (indent > expectedIndent) {
				continue;
			}
			const key = parseYamlMappingKey(trimmed);
			if (key === targetKey) {
				foundIndex = i;
				foundIndent = indent;
				break;
			}
		}

		if (foundIndex === -1) {
			break;
		}

		matchedDepth = depth + 1;
		if (depth === keyPath.length - 1) {
			const prefix = `${" ".repeat(foundIndent)}${targetKey}: `;
			lines[foundIndex] = `${prefix}${formatted}`;
			return `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
		}

		const nextEnd = findBlockEnd(lines, foundIndex, foundIndent);
		rangeStart = foundIndex + 1;
		rangeEnd = nextEnd;
		let childIndent = foundIndent + 2;
		for (let i = rangeStart; i < rangeEnd; i += 1) {
			const candidate = lines[i] ?? "";
			const trimmed = candidate.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;
			childIndent = lineIndent(candidate);
			break;
		}
		expectedIndent = childIndent;
	}

	const insertAt = rangeEnd;
	const newLines: string[] = [];
	let currentIndent = expectedIndent;
	for (let depth = matchedDepth; depth < keyPath.length; depth += 1) {
		const segment = keyPath[depth];
		if (segment === undefined) continue;
		const indentStr = " ".repeat(currentIndent);
		if (depth === keyPath.length - 1) {
			newLines.push(`${indentStr}${segment}: ${formatted}`);
		} else {
			newLines.push(`${indentStr}${segment}:`);
			currentIndent += 2;
		}
	}
	lines.splice(insertAt, 0, ...newLines);
	return `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

export type KustomizeImageUpdate = Omit<
	KustomizeImageUpdateStep,
	"kind" | "path"
>;

function applyKustomizeImageJson(
	source: string,
	update: KustomizeImageUpdate,
): string {
	const parsed = parseJsonDocument(source, "kustomization");
	const existingImages = parsed.images;
	const images: JsonObject[] = Array.isArray(existingImages)
		? existingImages.filter((item): item is JsonObject => isJsonObject(item))
		: [];
	let updated = false;
	const nextImages: JsonObject[] = images.map((entry) => {
		if (entry.name !== update.imageName) return entry;
		updated = true;
		const next = cloneJsonObject(entry);
		if (update.newName !== undefined) next.newName = update.newName;
		if (update.newTag !== undefined) next.newTag = update.newTag;
		if (update.digest !== undefined) next.digest = update.digest;
		return next;
	});
	if (!updated) {
		const entry: MutableJsonDocument = { name: update.imageName };
		if (update.newName !== undefined) entry.newName = update.newName;
		if (update.newTag !== undefined) entry.newTag = update.newTag;
		if (update.digest !== undefined) entry.digest = update.digest;
		nextImages.push(entry);
	}
	const nextDoc = cloneJsonObject(parsed);
	nextDoc.images = nextImages;
	return stableDocument(nextDoc);
}

function applyKustomizeImageYaml(
	source: string,
	update: KustomizeImageUpdate,
): string {
	const hadTrailingNewline = source.endsWith("\n") || source === "";
	const rawLines =
		source === ""
			? []
			: source.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n");
	const lines = [...rawLines];

	let imagesIndex = -1;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (
			lineIndent(line) === 0 &&
			parseYamlMappingKey(line.trim()) === "images"
		) {
			imagesIndex = i;
			break;
		}
	}

	const fieldsToSet: Array<readonly [string, string]> = [];
	if (update.newName !== undefined) {
		fieldsToSet.push(["newName", formatYamlScalar(update.newName)]);
	}
	if (update.newTag !== undefined) {
		fieldsToSet.push(["newTag", formatYamlScalar(update.newTag)]);
	}
	if (update.digest !== undefined) {
		fieldsToSet.push(["digest", formatYamlScalar(update.digest)]);
	}

	if (imagesIndex === -1) {
		const appended = [
			"images:",
			`  - name: ${formatYamlScalar(update.imageName)}`,
			...fieldsToSet.map(([key, val]) => `    ${key}: ${val}`),
		];
		lines.push(...appended);
		return `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
	}

	const blockEnd = findBlockEnd(lines, imagesIndex, 0);
	const itemStarts: number[] = [];
	let itemIndent = 2;
	for (let i = imagesIndex + 1; i < blockEnd; i += 1) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();
		if (trimmed.startsWith("- ")) {
			itemIndent = lineIndent(line);
			itemStarts.push(i);
		}
	}

	for (let idx = 0; idx < itemStarts.length; idx += 1) {
		const start = itemStarts[idx];
		if (start === undefined) continue;
		const end = itemStarts[idx + 1] ?? blockEnd;
		let matchesImage = false;
		const fieldIndent = itemIndent + 2;

		for (let i = start; i < end; i += 1) {
			const line = lines[i] ?? "";
			const trimmed = line.trim();
			const content =
				i === start && trimmed.startsWith("- ")
					? trimmed.slice(2).trim()
					: trimmed;
			if (parseYamlMappingKey(content) === "name") {
				const rawVal = content.slice(content.indexOf(":") + 1).trim();
				const unquoted = rawVal.replace(/^["']|["']$/gu, "");
				if (unquoted === update.imageName) {
					matchesImage = true;
				}
			}
		}

		if (!matchesImage) continue;

		const remaining = new Map<string, string>(fieldsToSet);
		for (let i = start; i < end; i += 1) {
			const line = lines[i] ?? "";
			const trimmed = line.trim();
			const isItemHead = i === start && trimmed.startsWith("- ");
			const content = isItemHead ? trimmed.slice(2).trim() : trimmed;
			const key = parseYamlMappingKey(content);
			if (key !== undefined && remaining.has(key)) {
				const nextVal = remaining.get(key);
				if (nextVal !== undefined) {
					lines[i] = isItemHead
						? `${" ".repeat(itemIndent)}- ${key}: ${nextVal}`
						: `${" ".repeat(fieldIndent)}${key}: ${nextVal}`;
					remaining.delete(key);
				}
			}
		}

		if (remaining.size > 0) {
			const extra = [...remaining.entries()].map(
				([key, val]) => `${" ".repeat(fieldIndent)}${key}: ${val}`,
			);
			lines.splice(end, 0, ...extra);
		}
		return `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
	}

	const newEntry = [
		`${" ".repeat(itemIndent)}- name: ${formatYamlScalar(update.imageName)}`,
		...fieldsToSet.map(
			([key, val]) => `${" ".repeat(itemIndent + 2)}${key}: ${val}`,
		),
	];
	lines.splice(blockEnd, 0, ...newEntry);
	return `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

export function applyKustomizeImageUpdate(
	source: string,
	update: KustomizeImageUpdate,
): string {
	if (update.imageName.trim() === "") {
		throw new GitopsError(
			"gitops-config-invalid",
			"kustomize-image update requires a non-empty imageName",
		);
	}
	if (
		update.newName === undefined &&
		update.newTag === undefined &&
		update.digest === undefined
	) {
		throw new GitopsError(
			"gitops-config-invalid",
			"kustomize-image update requires at least one of newName, newTag, or digest",
		);
	}
	const trimmed = source.trimStart();
	if (trimmed.startsWith("{")) {
		return applyKustomizeImageJson(source, update);
	}
	return applyKustomizeImageYaml(source, update);
}

export function applyManifestUpdateStep(
	source: string,
	step: ManifestUpdateStep,
): string {
	switch (step.kind) {
		case "json-path":
			return applyJsonPathUpdate(source, step.keyPath, step.value);
		case "yaml-scalar":
			return applyYamlScalarUpdate(source, step.keyPath, step.value);
		case "kustomize-image":
			return applyKustomizeImageUpdate(source, step);
	}
}
