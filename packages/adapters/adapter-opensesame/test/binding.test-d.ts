// Compile-time tests: `tsc -p tsconfig.types.json` (the `typecheck:types` script) must pass,
// which means every @ts-expect-error below is a real error. A ParsedCredentialBinding
// can only come from parseCredentialBindings; copying one, or writing one, does not make one.
import type { ParsedCredentialBinding } from "../src/binding.js";

declare const good: ParsedCredentialBinding;

// @ts-expect-error a spread copy of a parsed binding is not a parsed binding
export const spread: ParsedCredentialBinding = { ...good, envName: "PATH" };

// @ts-expect-error a literal with every public field is not a parsed binding
export const literal: ParsedCredentialBinding = {
	locator: "hobo-token://vercel/deploy",
	connection: "conn://acme/vercel",
	provider: "vercel",
	envName: "VERCEL_TOKEN",
	paths: ["/"],
	methods: ["GET"],
	projection: "legacy-token",
};

// Object.assign({}, good) is typed `{} & ParsedCredentialBinding`, so the compiler cannot tell it
// from the original; isParsedCredentialBinding does at run time, and the renderer, the port and
// the evidence maker call it (test/schema.test.ts).

// A parsed binding is still assignable to itself and read as the generated record narrows it.
export const same: ParsedCredentialBinding = good;
export const provider: "vercel" = good.provider;
