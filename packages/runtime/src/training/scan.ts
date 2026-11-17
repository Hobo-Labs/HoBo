import type {
	DeclaredOperation,
	DeclaredParameter,
	DeclaredTrainableClass,
} from "ts-autocode-grounding";
import {
	generateDeclaredRegistrations as emitRegistrations,
	scanDeclaredTrainables as scanWithGrounding,
} from "ts-autocode-grounding";

export type { DeclaredOperation, DeclaredParameter, DeclaredTrainableClass };

export function scanDeclaredTrainables(
	source: string,
): readonly DeclaredTrainableClass[] {
	return scanWithGrounding(source);
}

export function generateDeclaredRegistrations(
	declared: DeclaredTrainableClass,
	_source: { readonly file?: string } = {},
): string {
	return emitRegistrations(declared, {
		runtimeModule: "@hobo/runtime",
		header: ["// @generated"],
	});
}
