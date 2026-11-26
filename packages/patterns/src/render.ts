import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";

import {
	ParameterKind,
	type PatternManifest,
	type PatternRenderReceipt,
	PatternRenderReceiptSchema,
	ReceiptStatus,
	RenderingKind,
} from "./_generated/patterns_pb.js";
import type { PatternCatalog } from "./catalog.js";
import { readRenderingBody } from "./catalog.js";
import { PatternParseError } from "./parse.js";

const TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu;

export function fillTemplate(
	body: string,
	params: Readonly<Record<string, string>>,
): string {
	return body.replace(TOKEN, (_, name: string) => {
		const value = params[name];
		if (value === undefined) {
			throw new PatternParseError(`missing parameter ${name}`);
		}
		return value;
	});
}

export function parseParams(
	pattern: PatternManifest,
	raw: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const param of pattern.parameters) {
		const value = raw?.[param.name] ?? param.defaultWire;
		if ((value === undefined || value === "") && param.required) {
			throw new PatternParseError(`${pattern.id}: missing ${param.name}`);
		}
		const text = String(value ?? "");
		if (
			param.kind === ParameterKind.TYPESCRIPT_IDENTIFIER &&
			!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(text)
		) {
			throw new PatternParseError(
				`${param.name} is not a TypeScript identifier`,
			);
		}
		if (
			param.kind === ParameterKind.RESOURCE_NAME &&
			!/^[a-z][a-z0-9-]*$/u.test(text)
		) {
			throw new PatternParseError(`${param.name} is not a resource name`);
		}
		if (param.kind === ParameterKind.RELATIVE_PATH) {
			if (text.startsWith("/") || text.includes("..")) {
				throw new PatternParseError(
					`${param.name} is not a safe relative path`,
				);
			}
		}
		if (
			param.kind === ParameterKind.LITERAL_CHOICE &&
			param.choices.length > 0
		) {
			if (!param.choices.includes(text)) {
				throw new PatternParseError(`${param.name} is not an allowed choice`);
			}
		}
		out[param.name] = text;
	}
	return out;
}

/**
 * The rendering to use when nothing else selected one: the explicit default, or
 * the first listed. A pattern with no renderings at all is a malformed pattern,
 * so say that instead of handing back `undefined`.
 */
function defaultRendering<T extends { readonly isDefault?: boolean }>(
	renderings: readonly T[],
): T[] {
	const chosen = renderings.find((item) => item.isDefault) ?? renderings[0];
	if (chosen === undefined) {
		throw new Error("pattern has no renderings");
	}
	return [chosen];
}

export function renderPattern(input: {
	readonly catalog: PatternCatalog;
	readonly pattern: PatternManifest;
	readonly renderingId?: string;
	readonly params?: Readonly<Record<string, unknown>>;
}): PatternRenderReceipt {
	const named = input.renderingId
		? input.pattern.renderings.filter(
				(item) => item.renderingId === input.renderingId,
			)
		: [];
	const multiFile = input.pattern.renderings.filter(
		(item) =>
			item.kind === RenderingKind.FILE || item.kind === RenderingKind.PROJECT,
	);
	const renderings =
		named.length > 0
			? named
			: multiFile.length > 1
				? multiFile
				: defaultRendering(input.pattern.renderings);
	const params = parseParams(input.pattern, input.params);
	const files = renderings.map((rendering) => {
		const body = fillTemplate(
			readRenderingBody(input.catalog, input.pattern, rendering.renderingId),
			params,
		);
		const path = fillTemplate(
			rendering.outputFiles[0] ||
				`src/${input.pattern.id.replaceAll(".", "-")}.ts`,
			params,
		);
		if (path.startsWith("/") || path.includes("..")) {
			throw new PatternParseError("rendering path escapes destination");
		}
		return {
			path,
			digest: createHash("sha256").update(body).digest("hex"),
			contents: body,
		};
	});
	const digest = createHash("sha256")
		.update(files.map((file) => file.digest).join(":"))
		.digest("hex");
	return create(PatternRenderReceiptSchema, {
		patternId: input.pattern.id,
		patternVersion: input.pattern.version,
		renderingId: renderings[0]?.renderingId ?? "",
		files,
		snippetDigest: digest,
		catalogDigest: input.catalog.digest,
		vocabularyDigest: "",
		encoderId: "hobo-ontology-vector-v1",
		replayDigest: digest,
		llmCalls: 0,
		llmInputTokens: 0,
		llmOutputTokens: 0,
		status: ReceiptStatus.ACCEPTED,
		reasonCode: "rendered",
	});
}
