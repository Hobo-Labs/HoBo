import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	isParsedCredentialBinding,
	type ParsedCredentialBinding,
} from "../src/binding.js";
import { OpenSesameAdapterError } from "../src/errors.js";
import { renderEnvSchema } from "../src/schema.js";
import { onlyBinding, parsed, vercelRecord } from "./fixtures/bindings.js";

const here = dirname(fileURLToPath(import.meta.url));

function codeOf(run: () => string): string {
	try {
		run();
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) return error.code;
		throw error;
	}
	return "no error";
}

describe("renderEnvSchema", () => {
	it("renders the golden .env.schema for the vercel binding", () => {
		const golden = readFileSync(
			join(here, "__golden__/vercel.env.schema"),
			"utf8",
		);
		expect(renderEnvSchema(parsed())).toBe(golden);
	});

	it("renders one block per binding in a stable order, whatever order they were given", () => {
		const a = vercelRecord({
			locator: "hobo-token://vercel/zeta",
			env_name: "ZETA_TOKEN",
			connection: "conn://acme/web/vercel",
		});
		const b = vercelRecord({
			locator: "hobo-token://vercel/alpha",
			env_name: "ALPHA_TOKEN",
			paths: ["/v1/global-config"],
			methods: ["GET", "PUT"],
		});
		const forward = renderEnvSchema(parsed(a, b));
		expect(renderEnvSchema(parsed(b, a))).toBe(forward);
		const names = [...forward.matchAll(/^([A-Z_]+)=/gmu)].map((m) => m[1]);
		expect(names).toEqual(["ALPHA_TOKEN", "ZETA_TOKEN"]);
		expect(forward).toContain(
			'ALPHA_TOKEN=opensesameConnection(conn://acme/vercel, projection=legacy-token, paths="/v1/global-config", methods="GET,PUT")',
		);
		expect(forward).toContain("conn://acme/web/vercel");
	});

	it("marks every entry required and sensitive, and nothing else sensitive by default", () => {
		const text = renderEnvSchema(parsed());
		expect(text.startsWith("# @defaultSensitive=false\n# ---\n")).toBe(true);
		expect(text.match(/^# @required @sensitive$/gmu)).toHaveLength(1);
	});

	it("contains no token-shaped string", () => {
		const text = renderEnvSchema(parsed());
		expect(text).not.toMatch(/osr_[0-9a-f]{8}|ostest_|vtok_|Bearer |ghp_|sk_/u);
	});

	it("refuses a binding the parser did not make: a copy, a literal or an assigned object", () => {
		const good = onlyBinding();
		const forgeries: ParsedCredentialBinding[] = [
			// SAFETY: forged on purpose; the renderer must refuse what the parser did not make.
			{
				...good,
				connection: "conn://acme/vercel\nINJECTED=1",
			} as ParsedCredentialBinding,
			// SAFETY: forged on purpose.
			{ ...good, envName: "HOBO_OPENSESAME_CHILD" } as ParsedCredentialBinding,
			// SAFETY: forged on purpose.
			Object.assign({}, good, { paths: ["/"] }) as ParsedCredentialBinding,
			// The class is reachable from any parsed binding; constructing it anew is not parsing.
			Reflect.construct(good.constructor, [
				{ ...good, envName: "HTTPS_PROXY", paths: ["/"] },
			]),
			// SAFETY: forged on purpose: an object that inherits the parser's prototype has no brand.
			Object.assign(
				Object.create(Object.getPrototypeOf(good)),
				good,
			) as ParsedCredentialBinding,
		];
		for (const binding of forgeries) {
			expect(isParsedCredentialBinding(binding)).toBe(false);
			expect(codeOf(() => renderEnvSchema([binding]))).toBe("schema_injection");
		}
		expect(isParsedCredentialBinding(good)).toBe(true);
	});

	it("sorts by code unit, not by the locale: A_B before AB on every machine", () => {
		const a = vercelRecord({
			locator: "hobo-token://vercel/ab",
			env_name: "AB_TOKEN",
		});
		const b = vercelRecord({
			locator: "hobo-token://vercel/a-b",
			env_name: "A_BTOKEN",
		});
		const names = [
			...renderEnvSchema(parsed(a, b)).matchAll(/^([A-Z_]+)=/gmu),
		].map((m) => m[1]);
		expect(names).toEqual(["AB_TOKEN", "A_BTOKEN"]);
	});

	it("never echoes the refused value", () => {
		const leaked = "vtok_dummy_marker_0123456789abcdef";
		// SAFETY: forged on purpose.
		const forged = {
			...onlyBinding(),
			connection: `conn://${leaked}\n`,
		} as ParsedCredentialBinding;
		try {
			renderEnvSchema([forged]);
			expect.unreachable("must refuse");
		} catch (error) {
			expect(error).toBeInstanceOf(OpenSesameAdapterError);
			expect(String(error)).not.toContain(leaked);
		}
	});

	it("renders nothing for no bindings but the header, so a run with no credentials is still a schema", () => {
		expect(renderEnvSchema([])).toBe("# @defaultSensitive=false\n# ---\n");
	});
});
