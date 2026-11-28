import { scanDeclaredTrainables } from "../../../../packages/runtime/src/training/scan.ts";

import type { ExampleRuntimeDescriptor, RuntimeAction } from "./catalog-contract.js";

export function synthesizeTryRuntimeFromDeclared(
	source: string,
): ExampleRuntimeDescriptor {
	const declared = scanDeclaredTrainables(source);
	const operations = declared.flatMap((entry) => entry.operations);
	if (operations.length === 0) {
		throw new TypeError(
			"No ambient @trainable operations found to synthesize try-runtime",
		);
	}

	const resources: ExampleRuntimeDescriptor["resources"] = {};
	const routes: ExampleRuntimeDescriptor["routes"][number][] = [
		{ method: "GET", path: "/health", action: "health" },
	];

	for (const operation of operations) {
		const methodName = operation.methodRef.split(".").pop() ?? operation.methodRef;
		const action = actionForMethod(methodName);
		const path = `/api/${kebab(methodName)}`;
		routes.push({ method: "POST", path, action });
	}

	return {
		schemaVersion: "hobo.try-runtime/v1",
		resources,
		routes,
	};
}

function actionForMethod(methodName: string): RuntimeAction {
	switch (methodName) {
		case "greet":
		case "health":
		case "read":
		case "increment":
		case "reset":
		case "list":
		case "create":
		case "delete":
		case "toggle":
		case "enqueue":
		case "drain":
			return methodName;
		default:
			throw new TypeError(
				`Cannot synthesize try-runtime action for method ${methodName}`,
			);
	}
}

function kebab(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
		.replace(/_/gu, "-")
		.toLowerCase();
}
