import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { SetRecordSchema } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import {
	GitopsError,
	k8sName,
	MAX_SET_DOCUMENT_BYTES,
	renderPublication,
} from "../src/index.js";
import { asResolved, config, resolved, set } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = (name: string) =>
	readFileSync(join(here, "golden", name), "utf8");

describe("renderPublication", () => {
	it("publisher output is byte-stable (Argo CD Application golden)", () => {
		const out = renderPublication(
			config("GITOPS_ENGINE_ARGO_CD"),
			set,
			resolved,
		);
		expect(out.files.map((f) => f.path)).toEqual([
			"hobo/camps/camp-prod/argo-cd.application.json",
			"hobo/camps/camp-prod/manifests/hobo-set.configmap.json",
		]);
		expect(out.files[0]?.content).toBe(
			golden("argo-cd.application.json.golden"),
		);
		expect(out.files[1]?.content).toBe(
			golden("hobo-set.configmap.json.golden"),
		);
		expect(out.engineDocument).toEqual({
			apiVersion: "argoproj.io/v1alpha1",
			kind: "Application",
			name: "hobo-prod",
			namespace: "argocd",
		});
	});

	it("publisher output is byte-stable (Flux Kustomization golden)", () => {
		const out = renderPublication(config("GITOPS_ENGINE_FLUX"), set, resolved);
		expect(out.files[0]?.path).toBe(
			"hobo/camps/camp-prod/flux.kustomization.json",
		);
		expect(out.files[0]?.content).toBe(
			golden("flux.kustomization.json.golden"),
		);
		expect(out.files[1]?.content).toBe(
			golden("hobo-set.configmap.json.golden"),
		);
	});

	it("is independent of key order in the resolved set and identical across runs", () => {
		const a = renderPublication(
			config(),
			set,
			asResolved({
				resources: [{ b: 1, a: 2 }],
				schemaVersion: "x",
			}),
		);
		const b = renderPublication(
			config(),
			set,
			asResolved({
				schemaVersion: "x",
				resources: [{ a: 2, b: 1 }],
			}),
		);
		expect(a).toEqual(b);
		expect(JSON.stringify(renderPublication(config(), set, resolved))).toBe(
			JSON.stringify(renderPublication(config(), set, resolved)),
		);
	});

	it("derives DNS-1123 names and disambiguates unsafe Camp ids with a hash", () => {
		expect(k8sName("hobo", "prod")).toBe("hobo-prod");
		const odd = k8sName("hobo", "Prod/EU West");
		expect(odd).toMatch(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u);
		expect(odd).not.toBe(k8sName("hobo", "prod-eu-west"));
		expect(k8sName("hobo", "x".repeat(100)).length).toBeLessThanOrEqual(63);
	});

	it("refuses a resolved set larger than a ConfigMap can carry", () => {
		const big = asResolved({ blob: "x".repeat(MAX_SET_DOCUMENT_BYTES) });
		expect(() => renderPublication(config(), set, big)).toThrow(GitopsError);
		expect(() => renderPublication(config(), set, big)).toThrow(
			/gitops-set-too-large/,
		);
	});

	it("refuses a Set without a Camp", () => {
		expect(() =>
			renderPublication(
				config(),
				create(SetRecordSchema, { setId: "s" }),
				resolved,
			),
		).toThrow(/gitops-config-invalid/);
	});
});
