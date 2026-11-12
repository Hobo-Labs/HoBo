// SSRF rules promoted from src/draft/technical-proofs/hobo-relay-contract
// ("relay is not an SSRF or lateral-movement pivot"): a component reaches
// only registered hosts, never a metadata endpoint, never an address the
// host did not register (rebinding), and never a private range outside an
// agent-mode local allowlist.
import { describe, expect, it } from "vitest";
import {
	checkEgress,
	EgressDenialCode,
	type EgressPolicy,
	isPrivateAddress,
	parseComponentManifest,
} from "../src/index.js";
import { manifestJson } from "./fixtures.js";

const publicDns = async (host: string): Promise<readonly string[]> =>
	host === "rebind.acme.test" ? ["10.1.2.3"] : ["93.184.216.34"];

function policy(overrides: Partial<EgressPolicy> = {}): EgressPolicy {
	return {
		manifest: parseComponentManifest(
			manifestJson({
				egress: [
					{ host: "api.acme.test", pathPrefixes: ["/v1/"] },
					{ host: "upload.acme.test", ports: ["8443"] },
					{ host: "rebind.acme.test" },
					{ host: "metadata.google.internal" },
				],
			}),
		),
		mode: "conductor",
		resolveHost: publicDns,
		...overrides,
	};
}

async function denial(url: string, overrides: Partial<EgressPolicy> = {}) {
	const verdict = await checkEgress(url, policy(overrides));
	if (verdict.ok) throw new Error(`expected ${url} to be denied`);
	return verdict.denial;
}

describe("egress allowlist and SSRF rules (relay proof promoted)", () => {
	it("admits an allowlisted host, port and path and pins the resolved addresses", async () => {
		const verdict = await checkEgress(
			"https://api.acme.test/v1/sites",
			policy(),
		);
		expect(verdict.ok).toBe(true);
		if (verdict.ok) expect(verdict.addresses).toEqual(["93.184.216.34"]);
		const port = await checkEgress("https://upload.acme.test:8443/x", policy());
		expect(port.ok).toBe(true);
	});

	it("denies a host that is not registered (no forward proxy)", async () => {
		const result = await denial("https://evil.example/v1/");
		expect(result.code).toBe(EgressDenialCode.HOST_NOT_ALLOWLISTED);
		expect(result.host).toBe("evil.example");
	});

	it("denies a registered host on an unregistered port (address mismatch)", async () => {
		expect((await denial("https://api.acme.test:8443/v1/")).code).toBe(
			EgressDenialCode.PORT_FORBIDDEN,
		);
	});

	it("denies a path outside the registered prefixes, including encoded separators", async () => {
		expect((await denial("https://api.acme.test/admin")).code).toBe(
			EgressDenialCode.PATH_FORBIDDEN,
		);
		expect((await denial("https://api.acme.test/v1/%2e%2e%2fadmin")).code).toBe(
			EgressDenialCode.PATH_FORBIDDEN,
		);
	});

	it.each([
		"https://169.254.169.254/latest/meta-data/",
		"https://[fd00:ec2::254]/",
		"https://metadata.google.internal/computeMetadata/v1/",
	])("denies metadata endpoint %s even if listed", async (url) => {
		expect((await denial(url)).code).toBe(EgressDenialCode.METADATA_ENDPOINT);
	});

	it.each([
		"https://127.0.0.1/",
		"https://2130706433/",
		"https://[::1]/",
		"https://[::ffff:10.0.0.1]/",
	])("denies IP literal %s (allowlists name hosts)", async (url) => {
		expect((await denial(url)).code).toBe(
			EgressDenialCode.HOST_NOT_ALLOWLISTED,
		);
	});

	it("denies plain http and embedded userinfo", async () => {
		expect((await denial("http://api.acme.test/v1/")).code).toBe(
			EgressDenialCode.SCHEME_FORBIDDEN,
		);
		expect((await denial("https://user:pw@api.acme.test/v1/")).code).toBe(
			EgressDenialCode.HOST_NOT_ALLOWLISTED,
		);
	});

	it("denies an allowlisted host that resolves to a private address (rebinding)", async () => {
		expect((await denial("https://rebind.acme.test/")).code).toBe(
			EgressDenialCode.PRIVATE_ADDRESS,
		);
	});

	it("denies a host whose resolution fails", async () => {
		const failing = async (): Promise<readonly string[]> => [];
		expect(
			(await denial("https://api.acme.test/v1/", { resolveHost: failing }))
				.code,
		).toBe(EgressDenialCode.REBINDING);
	});

	it("admits a private address only in agent mode and only from the local allowlist", async () => {
		const agentManifest = parseComponentManifest(
			manifestJson({
				egress: [{ host: "bridge.local", localAddresses: ["127.0.0.1"] }],
				credential: { hosts: [] },
				modes: ["RECONCILER_MODE_RECORD_AGENT"],
			}),
		);
		const loopback = async (): Promise<readonly string[]> => ["127.0.0.1"];
		const ok = await checkEgress("https://bridge.local/files", {
			manifest: agentManifest,
			mode: "agent",
			resolveHost: loopback,
		});
		expect(ok.ok).toBe(true);
		const conductor = await checkEgress("https://bridge.local/files", {
			manifest: agentManifest,
			mode: "conductor",
			resolveHost: loopback,
		});
		expect(conductor.ok ? undefined : conductor.denial.code).toBe(
			EgressDenialCode.PRIVATE_ADDRESS,
		);
		const moved = await checkEgress("https://bridge.local/files", {
			manifest: agentManifest,
			mode: "agent",
			resolveHost: async () => ["10.9.9.9"],
		});
		expect(moved.ok ? undefined : moved.denial.code).toBe(
			EgressDenialCode.REBINDING,
		);
	});

	it.each([
		["10.0.0.1", true],
		["172.16.5.4", true],
		["192.168.1.1", true],
		["100.64.0.1", true],
		["169.254.1.1", true],
		["0.0.0.0", true],
		["224.0.0.1", true],
		["::1", true],
		["fe80::1", true],
		["fc00::1", true],
		["::ffff:192.168.0.1", true],
		["64:ff9b::a00:1", true],
		["93.184.216.34", false],
		["2606:4700::1111", false],
	])("classifies %s as private=%s", (address, expected) => {
		expect(isPrivateAddress(address)).toBe(expected);
	});
});
