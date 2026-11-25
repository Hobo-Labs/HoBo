import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PARTICIPANT_NAME = /^[A-Z][A-Za-z0-9]*$/;

// domain-view: readonly parse target validated against PARTICIPANT_NAME; data-models/contract-harness.proto PactParticipant is its wire form.
export interface PactParticipant {
	readonly name: string;
}

// domain-view: readonly parse target narrowed to the HTTP method union; data-models/contract-harness.proto PactRequest is its wire form.
export interface PactRequest {
	readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly path: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: unknown;
}

// domain-view: readonly parse target; data-models/contract-harness.proto PactResponse is its wire form.
export interface PactResponse {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: unknown;
}

// domain-view: readonly parse target; data-models/contract-harness.proto PactInteraction is its wire form.
export interface PactInteraction {
	readonly description: string;
	readonly request: PactRequest;
	readonly response: PactResponse;
}

// domain-view: readonly parse-produced aggregate pinned to pact spec 3.0.0; data-models/contract-harness.proto PactDocument is its wire form.
export interface PactDocument {
	readonly consumer: PactParticipant;
	readonly provider: PactParticipant;
	readonly interactions: readonly PactInteraction[];
	readonly metadata: {
		readonly pactSpecification: { readonly version: "3.0.0" };
	};
}

export class PactParseError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[], source?: string) {
		const prefix = source
			? `Invalid pact document (${source})`
			: "Invalid pact document";
		super(`${prefix}: ${issues.join("; ")}`);
		this.name = "PactParseError";
		this.issues = issues;
	}
}

export function parsePactDocument(
	input: unknown,
	source?: string,
): PactDocument {
	const issues: string[] = [];

	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new PactParseError(["document must be an object"], source);
	}

	const record = input as Record<string, unknown>;
	const consumer = parseParticipant(record.consumer, "consumer", issues);
	const provider = parseParticipant(record.provider, "provider", issues);
	const interactions = parseInteractions(record.interactions, issues);
	parseMetadata(record.metadata, issues);

	if (issues.length > 0 || !consumer || !provider || !interactions) {
		// The `!` variants relied on "issues is empty implies all three parsed",
		// which is true today and invisible to the checker. Test the values.
		throw new PactParseError(
			issues.length > 0 ? issues : ["document is missing a required section"],
			source,
		);
	}

	return {
		consumer,
		provider,
		interactions,
		metadata: { pactSpecification: { version: "3.0.0" } },
	};
}

export async function loadPactDirectory(
	dir: string,
): Promise<readonly PactDocument[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const pactFiles = entries
		.filter(
			(entry: Dirent) => entry.isFile() && entry.name.endsWith(".pact.json"),
		)
		.map((entry: Dirent) => entry.name)
		.sort();

	return Promise.all(
		pactFiles.map(async (fileName: string) => {
			const filePath = path.join(dir, fileName);
			const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
			return parsePactDocument(raw, filePath);
		}),
	);
}

function parseParticipant(
	value: unknown,
	label: string,
	issues: string[],
): PactParticipant | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push(`${label} must be an object`);
		return undefined;
	}

	const name = (value as Record<string, unknown>).name;
	if (typeof name !== "string") {
		issues.push(`${label}.name must be a string`);
		return undefined;
	}

	if (!PARTICIPANT_NAME.test(name)) {
		issues.push(`${label}.name must match ${PARTICIPANT_NAME}`);
	}

	return { name };
}

function parseInteractions(
	value: unknown,
	issues: string[],
): readonly PactInteraction[] | undefined {
	if (!Array.isArray(value)) {
		issues.push("interactions must be an array");
		return undefined;
	}

	if (value.length === 0) {
		issues.push("interactions must be non-empty");
		return [];
	}

	return value.map((interaction, index) =>
		parseInteraction(interaction, index, issues),
	);
}

function parseInteraction(
	value: unknown,
	index: number,
	issues: string[],
): PactInteraction {
	const prefix = `interactions[${index}]`;

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push(`${prefix} must be an object`);
		return {
			description: "",
			request: { method: "GET", path: "/" },
			response: { status: 200 },
		};
	}

	const record = value as Record<string, unknown>;
	const description = record.description;
	if (typeof description !== "string" || description.length === 0) {
		issues.push(`${prefix}.description must be a non-empty string`);
	}

	const request = parseRequest(record.request, `${prefix}.request`, issues);
	const response = parseResponse(record.response, `${prefix}.response`, issues);

	return {
		description: typeof description === "string" ? description : "",
		request: request ?? { method: "GET", path: "/" },
		response: response ?? { status: 200 },
	};
}

function parseRequest(
	value: unknown,
	prefix: string,
	issues: string[],
): PactRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push(`${prefix} must be an object`);
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const method = record.method;
	if (typeof method !== "string" || !HTTP_METHODS.has(method)) {
		issues.push(
			`${prefix}.method must be one of GET, POST, PUT, PATCH, DELETE`,
		);
	}

	const requestPath = record.path;
	if (typeof requestPath !== "string" || !requestPath.startsWith("/")) {
		issues.push(`${prefix}.path must start with /`);
	}

	const headers = parseStringMap(record.headers, `${prefix}.headers`, issues);

	const request: PactRequest = {
		method: (typeof method === "string"
			? method
			: "GET") as PactRequest["method"],
		path: typeof requestPath === "string" ? requestPath : "/",
	};

	const withHeaders = headers ? { ...request, headers } : request;
	if (record.body !== undefined) {
		return { ...withHeaders, body: record.body };
	}

	return withHeaders;
}

function parseResponse(
	value: unknown,
	prefix: string,
	issues: string[],
): PactResponse | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push(`${prefix} must be an object`);
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const status = record.status;
	if (
		typeof status !== "number" ||
		!Number.isInteger(status) ||
		status < 100 ||
		status > 599
	) {
		issues.push(`${prefix}.status must be an integer between 100 and 599`);
	}

	const headers = parseStringMap(record.headers, `${prefix}.headers`, issues);

	const response: PactResponse = {
		status: typeof status === "number" ? status : 200,
	};

	const withHeaders = headers ? { ...response, headers } : response;
	if (record.body !== undefined) {
		return { ...withHeaders, body: record.body };
	}

	return withHeaders;
}

function parseMetadata(value: unknown, issues: string[]): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push("metadata must be an object");
		return;
	}

	const metadata = value as Record<string, unknown>;
	const pactSpecification = metadata.pactSpecification;
	if (typeof pactSpecification !== "object" || pactSpecification === null) {
		issues.push("metadata.pactSpecification must be an object");
		return;
	}

	const version = (pactSpecification as Record<string, unknown>).version;
	if (version !== "3.0.0") {
		issues.push('metadata.pactSpecification.version must be "3.0.0"');
	}
}

function parseStringMap(
	value: unknown,
	prefix: string,
	issues: string[],
): Readonly<Record<string, string>> | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push(`${prefix} must be an object`);
		return undefined;
	}

	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry !== "string") {
			issues.push(`${prefix}.${key} must be a string`);
			continue;
		}
		result[key] = entry;
	}

	return result;
}
