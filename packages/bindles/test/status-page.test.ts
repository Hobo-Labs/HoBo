import { describe, expect, it } from "vitest";

import {
	bindle,
	isPlatformAnnotation,
	isStatusPageAnnotation,
	readStatusPageConfig,
	STATUS_PAGE_OPTION,
	statusPage,
} from "../src/index.js";

describe("statusPage annotation (ADR-0077 / ADR-0145)", () => {
	it("is a platform annotation, not a provider pin", () => {
		const annotation = statusPage();
		expect(annotation.provider).toBe("hobo");
		expect(annotation.option).toBe(STATUS_PAGE_OPTION);
		expect(isPlatformAnnotation(annotation)).toBe(true);
		expect(isStatusPageAnnotation(annotation)).toBe(true);
	});

	it("defaults enabled and freezes config", () => {
		const annotation = statusPage();
		expect(annotation.config.enabled).toBe(true);
		expect(Object.isFrozen(annotation)).toBe(true);
		expect(Object.isFrozen(annotation.config)).toBe(true);
	});

	it("is accepted on bindle resources (allowlisted platform option)", () => {
		const app = bindle("shop", (b) => ({
			web: b.web().with(statusPage({ project: "storefront" })),
		}));
		const config = readStatusPageConfig(app.resources.web?.annotations ?? []);
		expect(config?.project).toBe("storefront");
		expect(config?.enabled).toBe(true);
	});

	it("does not attach by default (read-side default keeps manifests stable)", () => {
		const app = bindle("shop", (b) => ({ web: b.web() }));
		const annotations = app.resources.web?.annotations ?? [];
		expect(annotations.some(isStatusPageAnnotation)).toBe(false);
		expect(readStatusPageConfig(annotations)).toBeNull();
	});

	it("replaces rather than stacks on repeated .with()", () => {
		const app = bindle("shop", (b) => ({
			web: b
				.web()
				.with(statusPage({ project: "one" }))
				.with(statusPage({ project: "two" })),
		}));
		const annotations = (app.resources.web?.annotations ?? []).filter(
			isStatusPageAnnotation,
		);
		expect(annotations).toHaveLength(1);
		expect(readStatusPageConfig(annotations)?.project).toBe("two");
	});

	it("rejects empty project or label", () => {
		expect(() => statusPage({ project: "" })).toThrow(TypeError);
		expect(() => statusPage({ label: "" })).toThrow(TypeError);
	});

	it("supports opt-out", () => {
		const app = bindle("shop", (b) => ({
			web: b.web().with(statusPage({ enabled: false })),
		}));
		expect(
			readStatusPageConfig(app.resources.web?.annotations ?? [])?.enabled,
		).toBe(false);
	});
});
