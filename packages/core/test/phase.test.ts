// ADR-0158: deployment phases as vocabulary + enforcement primitives. The
// cases below pin the two rules that make the phase model worth having — a
// phase token is never defaulted, and a phase-scoped capability touched
// outside its phase is refused — plus the independence of dev mode.
import { describe, expect, it } from "vitest";

import {
	assertCapabilityPhase,
	DEPLOYMENT_PHASES,
	HOBO_DEV_ENV,
	HOBO_PHASE_ENV,
	INIT_SCOPED_CAPABILITIES,
	PHASE_SCOPED_CAPABILITIES,
	PhaseParseError,
	PhaseViolationError,
	parseDeploymentPhase,
	parsePhaseScope,
	parsePhaseScopeFromEnv,
	phaseForCapability,
	REQUEST_SCOPED_CAPABILITIES,
} from "../src/index.js";

describe("deployment phase vocabulary", () => {
	it.each([...DEPLOYMENT_PHASES])("parses the %s phase literal", (phase) => {
		expect(parseDeploymentPhase(phase)).toBe(phase);
	});

	it.each([
		[undefined, "absent value must not resolve to a phase"],
		[null, "null is not a phase token"],
		["", "empty string is not a phase token"],
		["deploy", "an unknown phase name is refused, never mapped"],
		["PLAN", "phase tokens are case sensitive"],
		["handle ", "no trimming: whitespace is a different token"],
		[0, "an ordinal is not a phase token"],
	])("refuses %o (%s) instead of defaulting", (value) => {
		expect(() => parseDeploymentPhase(value)).toThrow(PhaseParseError);
		try {
			parseDeploymentPhase(value);
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			expect((error as PhaseParseError).code).toBe("HOBO_CORE_PHASE_PARSE");
		}
	});

	it("exposes exactly the request- and init-scoped capabilities", () => {
		expect([...PHASE_SCOPED_CAPABILITIES].sort()).toEqual(
			[...REQUEST_SCOPED_CAPABILITIES, ...INIT_SCOPED_CAPABILITIES].sort(),
		);
	});

	it("maps every request capability to handle and every init capability to init", () => {
		for (const capability of REQUEST_SCOPED_CAPABILITIES) {
			expect(phaseForCapability(capability)).toBe("handle");
		}
		for (const capability of INIT_SCOPED_CAPABILITIES) {
			expect(phaseForCapability(capability)).toBe("init");
		}
	});

	it("refuses a capability outside the declared vocabulary", () => {
		expect(() =>
			phaseForCapability(
				// SAFETY: assertion required at this I/O or test boundary.
				"databaseConnection" as (typeof PHASE_SCOPED_CAPABILITIES)[number],
			),
		).toThrow(PhaseParseError);
	});
});

describe("phase scope parsing", () => {
	it("returns a frozen record", () => {
		const scope = parsePhaseScope({ phase: "init", dev: true });
		expect(scope).toEqual({ phase: "init", dev: true });
		expect(Object.isFrozen(scope)).toBe(true);
	});

	it.each([
		[{ phase: "init" }, "dev must be stated explicitly"],
		[{ phase: "init", dev: "true" }, "dev is a boolean, not a string"],
		[{ phase: "boot", dev: false }, "unknown phase"],
		[{ phase: "init", dev: false, extra: 1 }, "unknown key"],
		[["init", false], "an array is not a phase scope"],
		[null, "null is not a phase scope"],
	])("refuses %o (%s)", (value) => {
		expect(() => parsePhaseScope(value)).toThrow(PhaseParseError);
	});
});

describe("phase enforcement", () => {
	it("refuses a request-scoped capability during init", () => {
		const scope = parsePhaseScope({ phase: "init", dev: false });
		expect(() => assertCapabilityPhase(scope, "request")).toThrow(
			PhaseViolationError,
		);
		try {
			assertCapabilityPhase(scope, "request");
			throw new Error("expected a phase violation");
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			const violation = error as PhaseViolationError;
			expect(violation.code).toBe("PHASE_VIOLATION");
			expect(violation.capability).toBe("request");
			expect(violation.requiredPhase).toBe("handle");
			expect(violation.actualPhase).toBe("init");
			expect(violation.message).toMatch(/handle/u);
		}
	});

	it("refuses an init-scoped capability during handle", () => {
		const scope = parsePhaseScope({ phase: "handle", dev: false });
		try {
			assertCapabilityPhase(scope, "bindingClient");
			throw new Error("expected a phase violation");
		} catch (error) {
			// SAFETY: assertion required at this I/O or test boundary.
			const violation = error as PhaseViolationError;
			expect(violation.code).toBe("PHASE_VIOLATION");
			expect(violation.requiredPhase).toBe("init");
			expect(violation.actualPhase).toBe("handle");
		}
	});

	it("admits each capability in its own phase", () => {
		for (const capability of PHASE_SCOPED_CAPABILITIES) {
			const scope = parsePhaseScope({
				phase: phaseForCapability(capability),
				dev: false,
			});
			expect(() => assertCapabilityPhase(scope, capability)).not.toThrow();
		}
	});

	it("refuses every phase-scoped capability during plan", () => {
		const scope = parsePhaseScope({ phase: "plan", dev: false });
		for (const capability of PHASE_SCOPED_CAPABILITIES) {
			expect(() => assertCapabilityPhase(scope, capability)).toThrow(
				PhaseViolationError,
			);
		}
	});

	it("treats dev as a mode: it never changes which capabilities a phase admits", () => {
		for (const phase of DEPLOYMENT_PHASES) {
			for (const capability of PHASE_SCOPED_CAPABILITIES) {
				const production = parsePhaseScope({ phase, dev: false });
				const development = parsePhaseScope({ phase, dev: true });
				const refusedInProduction = attempt(() =>
					assertCapabilityPhase(production, capability),
				);
				const refusedInDev = attempt(() =>
					assertCapabilityPhase(development, capability),
				);
				expect(refusedInDev).toBe(refusedInProduction);
			}
		}
	});
});

describe("host environment contract", () => {
	it("parses HOBO_PHASE plus HOBO_DEV", () => {
		expect(
			parsePhaseScopeFromEnv({ [HOBO_PHASE_ENV]: "init", [HOBO_DEV_ENV]: "1" }),
		).toEqual({ phase: "init", dev: true });
		expect(
			parsePhaseScopeFromEnv({
				[HOBO_PHASE_ENV]: "handle",
				[HOBO_DEV_ENV]: "0",
			}),
		).toEqual({ phase: "handle", dev: false });
	});

	it("reads an absent HOBO_DEV as production, never as dev", () => {
		expect(parsePhaseScopeFromEnv({ [HOBO_PHASE_ENV]: "plan" })).toEqual({
			phase: "plan",
			dev: false,
		});
	});

	it.each([
		[{}, "a missing phase is a refusal, not a default"],
		[{ [HOBO_PHASE_ENV]: "serve" }, "unknown phase token"],
		[
			{ [HOBO_PHASE_ENV]: "init", [HOBO_DEV_ENV]: "true" },
			"HOBO_DEV is 1 or 0, never a word",
		],
		[
			{ [HOBO_PHASE_ENV]: "init", [HOBO_DEV_ENV]: "" },
			"an empty HOBO_DEV is an unknown value, not an absent one",
		],
	])("refuses %o (%s)", (env) => {
		expect(() => parsePhaseScopeFromEnv(env)).toThrow(PhaseParseError);
	});
});

function attempt(action: () => void): boolean {
	try {
		action();
		return false;
	} catch {
		return true;
	}
}
