import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isJsonString, isJsonNumber, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PARTICIPANT_NAME = /^[A-Z][A-Za-z0-9]*$/;

// domain-view: parse-produced draft-proof record; its wire form is the PactParticipant proto message in data-models/.
export interface PactParticipant {
  readonly name: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the PactRequest proto message in data-models/.
export interface PactRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}

// domain-view: parse-produced draft-proof record; its wire form is the PactResponse proto message in data-models/.
export interface PactResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}

// domain-view: parse-produced draft-proof record; its wire form is the PactInteraction proto message in data-models/.
export interface PactInteraction {
  readonly description: string;
  readonly request: PactRequest;
  readonly response: PactResponse;
}

// domain-view: parse-produced draft-proof record; its wire form is the PactDocument proto message in data-models/.
export interface PactDocument {
  readonly consumer: PactParticipant;
  readonly provider: PactParticipant;
  readonly interactions: readonly PactInteraction[];
  readonly metadata: { readonly pactSpecification: { readonly version: "3.0.0" } };
}

export class PactParseError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[], source?: string) {
    const prefix = source ? `Invalid pact document (${source})` : "Invalid pact document";
    super(`${prefix}: ${issues.join("; ")}`);
    this.name = "PactParseError";
    this.issues = issues;
  }
}

export function parsePactDocument(input: JsonValue, source?: string): PactDocument {
  const issues: string[] = [];

  if (!isJsonObject(input)) {
    throw new PactParseError(["document must be an object"], source);
  }

  // SAFETY: assertion to `const record = input as JsonObject;` is required at this boundary.
  const record = input as JsonObject;
  const consumer = parseParticipant(record.consumer, "consumer", issues);
  const provider = parseParticipant(record.provider, "provider", issues);
  const interactions = parseInteractions(record.interactions, issues);
  parseMetadata(record.metadata, issues);

  if (issues.length > 0) {
    throw new PactParseError(issues, source);
  }

  return {
    consumer: consumer!,
    provider: provider!,
    interactions: interactions!,
    metadata: { pactSpecification: { version: "3.0.0" } },
  };
}

export async function loadPactDirectory(dir: string): Promise<readonly PactDocument[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const pactFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".pact.json"))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    pactFiles.map(async (fileName) => {
      const filePath = path.join(dir, fileName);
      // SAFETY: assertion to `const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;` is required at this boundary.
      const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      return parsePactDocument(raw, filePath);
    }),
  );
}

function parseParticipant(
  value: JsonValue,
  label: string,
  issues: string[],
): PactParticipant | undefined {
  if (!isJsonObject(value)) {
    issues.push(`${label} must be an object`);
    return undefined;
  }

  // SAFETY: assertion to `const name = (value as JsonObject).name;` is required at this boundary.
  const name = (value as JsonObject).name;
  if (!isJsonString(name)) {
    issues.push(`${label}.name must be a string`);
    return undefined;
  }

  if (!PARTICIPANT_NAME.test(name)) {
    issues.push(`${label}.name must match ${PARTICIPANT_NAME}`);
  }

  return { name };
}

function parseInteractions(
  value: JsonValue,
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

  return value.map((interaction, index) => parseInteraction(interaction, index, issues));
}

function parseInteraction(
  value: JsonValue,
  index: number,
  issues: string[],
): PactInteraction {
  const prefix = `interactions[${index}]`;

  if (!isJsonObject(value)) {
    issues.push(`${prefix} must be an object`);
    return {
      description: "",
      request: { method: "GET", path: "/" },
      response: { status: 200 },
    };
  }

  // SAFETY: assertion to `const record = value as JsonObject;` is required at this boundary.
  const record = value as JsonObject;
  const description = record.description;
  if (!isJsonString(description) || description.length === 0) {
    issues.push(`${prefix}.description must be a non-empty string`);
  }

  const request = parseRequest(record.request, `${prefix}.request`, issues);
  const response = parseResponse(record.response, `${prefix}.response`, issues);

  return {
    description: isJsonString(description) ? description : "",
    request: request ?? { method: "GET", path: "/" },
    response: response ?? { status: 200 },
  };
}

function parseRequest(
  value: JsonValue,
  prefix: string,
  issues: string[],
): PactRequest | undefined {
  if (!isJsonObject(value)) {
    issues.push(`${prefix} must be an object`);
    return undefined;
  }

  // SAFETY: assertion to `const record = value as JsonObject;` is required at this boundary.
  const record = value as JsonObject;
  const method = record.method;
  if (!isJsonString(method) || !HTTP_METHODS.has(method)) {
    issues.push(`${prefix}.method must be one of GET, POST, PUT, PATCH, DELETE`);
  }

  const requestPath = record.path;
  if (!isJsonString(requestPath) || !requestPath.startsWith("/")) {
    issues.push(`${prefix}.path must start with /`);
  }

  const headers = parseStringMap(record.headers, `${prefix}.headers`, issues);

  const request: PactRequest = {
    // SAFETY: assertion to `method: (isJsonString(method) ? method : "GET") as PactRequest["method"],` is required at this boundary.
    method: (isJsonString(method) ? method : "GET") as PactRequest["method"],
    path: isJsonString(requestPath) ? requestPath : "/",
  };

  const withHeaders = headers ? { ...request, headers } : request;
  if (record.body !== undefined) {
    return { ...withHeaders, body: record.body };
  }

  return withHeaders;
}

function parseResponse(
  value: JsonValue,
  prefix: string,
  issues: string[],
): PactResponse | undefined {
  if (!isJsonObject(value)) {
    issues.push(`${prefix} must be an object`);
    return undefined;
  }

  // SAFETY: assertion to `const record = value as JsonObject;` is required at this boundary.
  const record = value as JsonObject;
  const status = record.status;
  if (!isJsonNumber(status) || !Number.isInteger(status) || status < 100 || status > 599) {
    issues.push(`${prefix}.status must be an integer between 100 and 599`);
  }

  const headers = parseStringMap(record.headers, `${prefix}.headers`, issues);

  const response: PactResponse = {
    status: isJsonNumber(status) ? status : 200,
  };

  const withHeaders = headers ? { ...response, headers } : response;
  if (record.body !== undefined) {
    return { ...withHeaders, body: record.body };
  }

  return withHeaders;
}

function parseMetadata(value: JsonValue, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push("metadata must be an object");
    return;
  }

  // SAFETY: assertion to `const metadata = value as JsonObject;` is required at this boundary.
  const metadata = value as JsonObject;
  const pactSpecification = metadata.pactSpecification;
  if (!isJsonObject(pactSpecification) || pactSpecification === null) {
    issues.push("metadata.pactSpecification must be an object");
    return;
  }

  // SAFETY: assertion to `const version = (pactSpecification as JsonObject).version;` is required at this boundary.
  const version = (pactSpecification as JsonObject).version;
  if (version !== "3.0.0") {
    issues.push('metadata.pactSpecification.version must be "3.0.0"');
  }
}

function parseStringMap(
  value: JsonValue,
  prefix: string,
  issues: string[],
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJsonObject(value)) {
    issues.push(`${prefix} must be an object`);
    return undefined;
  }

  const result: Record<string, string> = {};
  // SAFETY: assertion to `for (const [key, entry] of Object.entries(value as JsonObject)) {` is required at this boundary.
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    if (!isJsonString(entry)) {
      issues.push(`${prefix}.${key} must be a string`);
      continue;
    }
    result[key] = entry;
  }

  return result;
}
