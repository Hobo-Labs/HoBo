import assert from "node:assert/strict";
import { defineGrounding as upstreamDefineGrounding } from "ts-autocode-grounding";
import { afterEach, test } from "vitest";
import {
	defineGrounding,
	generateDeclaredRegistrations,
	getTrainable,
	isTrainable,
	listTrainables,
	resetTrainables,
	scanDeclaredTrainables,
	training,
} from "../src/index.js";

// `defineGrounding` is what the registrations `hobo stub` generates call
// (ts-autocode-grounding's emitter names that callee). The options below are
// the emitter's own output for a scanned ambient class, so every identity in
// them is derived from source by the machinery, never typed here.

afterEach(() => {
	resetTrainables();
});

const AMBIENT = `
@trainable
export declare class Greeter {
  @intent("Greet a person by name")
  @returns("A greeting")
  greet(
    @description("Who to greet")
    name?: string,
  ): string;
}
`;

function emittedOptions() {
	const [declared] = scanDeclaredTrainables(AMBIENT);
	assert.ok(declared);
	const [op] = declared.operations;
	assert.ok(op);
	const generated = generateDeclaredRegistrations(declared);
	const start =
		generated.indexOf("defineGrounding(") + "defineGrounding(".length;
	return {
		methodRef: op.methodRef,
		options: JSON.parse(generated.slice(start, generated.lastIndexOf(");"))),
	};
}

test("defineGrounding registers exactly what training.define registers for the same options", () => {
	const { methodRef, options } = emittedOptions();

	training.define(options);
	const viaDefine = getTrainable(methodRef);
	const listedViaDefine = listTrainables();
	resetTrainables();

	defineGrounding(options);
	const viaDefineGrounding = getTrainable(methodRef);

	assert.ok(viaDefine);
	assert.deepEqual(viaDefineGrounding, viaDefine);
	assert.deepEqual(listTrainables(), listedViaDefine);
	assert.equal(viaDefineGrounding?.fact.contractRef, `decl://${methodRef}`);
});

test("defineGrounding returns a callable that carries its methodRef", () => {
	const { methodRef, options } = emittedOptions();
	const callable = defineGrounding(options);

	assert.ok(isTrainable(callable));
	assert.equal(callable.methodRef, methodRef);
	assert.equal(getTrainable(callable)?.fact.methodRef, methodRef);
});

test("ts-autocode-grounding's own defineGrounding registers nothing, so @hobo/runtime does not re-export it", () => {
	const { methodRef, options } = emittedOptions();
	const checked = upstreamDefineGrounding(options);

	assert.equal(isTrainable(checked), false);
	assert.ok(Object.isFrozen(checked));
	assert.equal(getTrainable(methodRef), undefined);
	assert.deepEqual(listTrainables(), []);
	assert.notEqual(defineGrounding, upstreamDefineGrounding);
});
