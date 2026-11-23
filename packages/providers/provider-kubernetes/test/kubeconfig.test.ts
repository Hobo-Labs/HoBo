import { describe, expect, it } from "vitest";

import { KubernetesProviderError, parseKubeconfig } from "../src/index.js";

const TOKEN = "synthetic-kubeconfig-token-0123456789abcdef";
const CA =
	"-----BEGIN CERTIFICATE-----\nsynthetic-ca\n-----END CERTIFICATE-----\n";
const CERT =
	"-----BEGIN CERTIFICATE-----\nsynthetic-client\n-----END CERTIFICATE-----\n";
const KEY =
	"-----BEGIN EC PRIVATE KEY-----\nsynthetic-key\n-----END EC PRIVATE KEY-----\n";

const base64 = (text: string) => Buffer.from(text).toString("base64");

function kubeconfig(cluster: string, user: string): string {
	return [
		"apiVersion: v1",
		"kind: Config",
		"current-context: fleet",
		"contexts:",
		"- name: other",
		"  context: {cluster: other, user: other}",
		"- name: fleet",
		"  context: {cluster: hostinger, user: fleet-admin}",
		"clusters:",
		"- name: hostinger",
		"  cluster:",
		...cluster.split("\n").map((line) => `    ${line}`),
		"users:",
		"- name: fleet-admin",
		"  user:",
		...user.split("\n").map((line) => `    ${line}`),
	].join("\n");
}

function refusal(text: string): string {
	try {
		parseKubeconfig(text);
	} catch (error) {
		expect(error).toBeInstanceOf(KubernetesProviderError);
		if (error instanceof KubernetesProviderError) {
			expect(error.code).toBe("KUBECONFIG_UNSUPPORTED");
			expect(error.message).not.toContain(TOKEN);
			expect(error.message).not.toContain(base64(KEY));
			return error.message;
		}
	}
	throw new Error("the kubeconfig was accepted");
}

describe("parseKubeconfig", () => {
	it("reads the current context's server, CA and bearer token", () => {
		const access = parseKubeconfig(
			kubeconfig(
				`server: https://203.0.113.7:6443\ncertificate-authority-data: ${base64(CA)}`,
				`token: ${TOKEN}`,
			),
		);
		expect(access).toEqual({
			apiServerUrl: "https://203.0.113.7:6443",
			bearerToken: TOKEN,
			tls: { ca: CA },
			secrets: [TOKEN],
		});
	});

	it("reads inline client certificate data, as a k3s kubeconfig carries", () => {
		const access = parseKubeconfig(
			kubeconfig(
				`server: https://203.0.113.7:6443\ncertificate-authority-data: ${base64(CA)}`,
				`client-certificate-data: ${base64(CERT)}\nclient-key-data: ${base64(KEY)}`,
			),
		);
		expect(access.tls).toEqual({ ca: CA, cert: CERT, key: KEY });
		expect(access.bearerToken).toBeUndefined();
		expect(access.secrets).toEqual([KEY, base64(KEY)]);
	});

	it("accepts the same document as JSON", () => {
		const access = parseKubeconfig(
			JSON.stringify({
				"current-context": "c",
				contexts: [{ name: "c", context: { cluster: "k", user: "u" } }],
				clusters: [
					{ name: "k", cluster: { server: "https://k.example.test" } },
				],
				users: [{ name: "u", user: { token: TOKEN } }],
			}),
		);
		expect(access.apiServerUrl).toBe("https://k.example.test");
		expect(access.tls).toEqual({});
	});

	it.each([
		[
			"skipped TLS verification",
			kubeconfig(
				"server: https://k.example.test\ninsecure-skip-tls-verify: true",
				`token: ${TOKEN}`,
			),
			/skips TLS verification/u,
		],
		[
			"a CA file",
			kubeconfig(
				"server: https://k.example.test\ncertificate-authority: /etc/ca.crt",
				`token: ${TOKEN}`,
			),
			/points at a file/u,
		],
		[
			"an exec plugin",
			kubeconfig(
				"server: https://k.example.test",
				"exec: {command: aws, apiVersion: client.authentication.k8s.io/v1}",
			),
			/authenticates with exec/u,
		],
		[
			"half a client certificate",
			kubeconfig(
				"server: https://k.example.test",
				`client-key-data: ${base64(KEY)}`,
			),
			/half of a client certificate/u,
		],
		[
			"no credential",
			kubeconfig("server: https://k.example.test", "{}"),
			/neither a token/u,
		],
		["no current context", "apiVersion: v1", /no current-context/u],
		["not a mapping", "- just\n- a list", /not a mapping/u],
	])("refuses %s without echoing secrets", (_case, text, pattern) => {
		expect(refusal(text)).toMatch(pattern);
	});
});
