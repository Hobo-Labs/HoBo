import { types } from "node:util";
import { AlchemyIacError, digestData } from "./plan.js";
import type { IacProgram } from "./port.js";

type JsonData =
	| null
	| boolean
	| number
	| string
	| readonly JsonData[]
	| { readonly [key: string]: JsonData };

export interface CapturedAlchemyProgram {
	readonly program: Readonly<IacProgram>;
	readonly declarationPresence: "absent" | "present";
	readonly declarationDigest: string;
}

const REQUIRED = [
	"programId",
	"deploymentId",
	"resourceId",
	"provider",
	"driver",
	"action",
	"stackName",
] as const;
const OPTIONAL = ["resource", "operationGeneration"] as const;
const MAX_NODES = 16_384;
const MAX_TEXT = 1_048_576;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- SAFETY: this boundary rejects proxies, accessors and exotic objects before copying untrusted program data. */
function record(input: unknown): Record<string, unknown> | undefined {
	if (
		typeof input !== "object" ||
		input === null ||
		types.isProxy(input) ||
		Array.isArray(input)
	)
		return undefined;
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	// SAFETY: the runtime checks establish an ordinary object with string-keyed data read via descriptors.
	return input as Record<string, unknown>;
}

function boundedName(value: unknown, limit = 200): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= limit &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function snapshot(
	value: unknown,
	ancestors: Set<object>,
	budget: { nodes: number; text: number },
	depth: number,
): JsonData {
	if (--budget.nodes < 0 || depth > 32)
		throw new Error("declaration exceeds limits");
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		budget.text += value.length;
		if (value.length > 4096 || budget.text > MAX_TEXT)
			throw new Error("declaration text exceeds limits");
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("invalid number");
		return value;
	}
	if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value))
		throw new Error("invalid declaration value");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype)
				throw new Error("invalid array");
			const length = Object.getOwnPropertyDescriptor(value, "length");
			if (
				length === undefined ||
				!("value" in length) ||
				!Number.isSafeInteger(length.value) ||
				length.value < 0 ||
				length.value > 1024
			)
				throw new Error("invalid array length");
			const keys = Reflect.ownKeys(value);
			if (keys.length !== length.value + 1)
				throw new Error("array has extra fields or holes");
			const result: JsonData[] = [];
			for (let index = 0; index < length.value; index++) {
				const element = Object.getOwnPropertyDescriptor(value, String(index));
				if (
					element === undefined ||
					!("value" in element) ||
					!element.enumerable
				)
					throw new Error("invalid array item");
				result.push(snapshot(element.value, ancestors, budget, depth + 1));
			}
			return Object.freeze(result);
		}
		const source = record(value);
		if (source === undefined) throw new Error("invalid object");
		let enumerated = 0;
		for (const _key in source)
			if (++enumerated > 256) throw new Error("too many properties");
		const keys = Reflect.ownKeys(source);
		if (keys.length > 256) throw new Error("too many properties");
		const result: Record<string, JsonData> = Object.create(null);
		for (const key of keys) {
			if (typeof key !== "string" || key.length === 0 || key.length > 200)
				throw new Error("invalid property name");
			budget.text += key.length;
			if (budget.text > MAX_TEXT)
				throw new Error("declaration text exceeds limits");
			const property = Object.getOwnPropertyDescriptor(source, key);
			if (
				property === undefined ||
				!("value" in property) ||
				!property.enumerable
			)
				throw new Error("invalid property");
			result[key] = snapshot(property.value, ancestors, budget, depth + 1);
		}
		return Object.freeze(result);
	} finally {
		ancestors.delete(value);
	}
}

/** Capture a bounded immutable program and an unambiguous declaration digest. */
export function captureAlchemyProgram(
	input: IacProgram,
): CapturedAlchemyProgram {
	try {
		const source = record(input);
		if (source === undefined) throw new Error("invalid program");
		const keys = Reflect.ownKeys(source);
		const allowed = new Set<string>([...REQUIRED, ...OPTIONAL]);
		if (keys.length < REQUIRED.length || keys.length > allowed.size)
			throw new Error("invalid program fields");
		const data: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			if (typeof key !== "string" || !allowed.has(key))
				throw new Error("unknown program field");
			const property = Object.getOwnPropertyDescriptor(source, key);
			if (
				property === undefined ||
				!("value" in property) ||
				!property.enumerable
			)
				throw new Error("computed or hidden program field");
			data[key] = property.value;
		}
		if (REQUIRED.some((key) => !Object.hasOwn(data, key)))
			throw new Error("missing program field");
		const {
			programId,
			deploymentId,
			resourceId,
			provider,
			driver,
			action,
			stackName,
		} = data;
		if (
			!boundedName(programId, 401) ||
			!boundedName(deploymentId) ||
			!boundedName(resourceId) ||
			!boundedName(provider) ||
			!boundedName(driver) ||
			!boundedName(stackName, 602) ||
			(action !== "preview" && action !== "apply" && action !== "destroy")
		)
			throw new Error("invalid program identity");
		const program: IacProgram = {
			programId,
			deploymentId,
			resourceId,
			provider,
			driver,
			action,
			stackName,
		};
		if (
			Object.hasOwn(data, "operationGeneration") &&
			data.operationGeneration !== undefined
		) {
			if (!boundedName(data.operationGeneration))
				throw new Error("invalid operation generation");
			program.operationGeneration = data.operationGeneration;
		}
		let declarationDigest: string;
		let declarationPresence: CapturedAlchemyProgram["declarationPresence"];
		if (Object.hasOwn(data, "resource") && data.resource !== undefined) {
			const declaration = snapshot(
				data.resource,
				new Set(),
				{ nodes: MAX_NODES, text: 0 },
				0,
			);
			if (
				typeof declaration !== "object" ||
				declaration === null ||
				Array.isArray(declaration)
			)
				throw new Error("resource must be an object");
			const resource = record(declaration);
			if (
				resource === undefined ||
				resource.name !== resourceId ||
				resource.provider !== provider ||
				(Object.hasOwn(resource, "deploymentId") &&
					resource.deploymentId !== deploymentId)
			)
				throw new Error("resource identity differs from program");
			program.resource = declaration;
			declarationPresence = "present";
			declarationDigest = digestData({ kind: "present", value: declaration });
		} else {
			declarationPresence = "absent";
			declarationDigest = digestData({ kind: "absent" });
		}
		return Object.freeze({
			program: Object.freeze(program),
			declarationPresence,
			declarationDigest,
		});
	} catch {
		throw new AlchemyIacError(
			"PROGRAM_INVALID",
			"a bounded, complete, unambiguous program is required",
		);
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof */
