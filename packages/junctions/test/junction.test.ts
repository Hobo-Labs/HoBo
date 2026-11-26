import { describe, expect, it } from "vitest";

import {
	JUNCTION_CONTRACT_VERSION,
	JunctionParseError,
	junction,
} from "../src/index.js";
import { makeYard } from "./helpers.js";

describe("junction()", () => {
	it("parses member yards into a frozen JunctionDefinition", () => {
		const aws = makeYard("aws", "aws");
		const azure = makeYard("azure", "azure");

		const app = junction("my-app", { yards: [aws, azure] });

		expect(app.kind).toBe("junction");
		expect(app.contract).toBe(JUNCTION_CONTRACT_VERSION);
		expect(app.name).toBe("my-app");
		expect(app.yards).toHaveLength(2);
		expect(app.members.map((member) => member.yardName)).toEqual([
			"aws",
			"azure",
		]);
		expect(app.members[0]?.providerId).toBe("aws");
		expect(Object.isFrozen(app)).toBe(true);
		expect(Object.isFrozen(app.members)).toBe(true);
	});

	it("derives member manifests deterministically regardless of input order", () => {
		const aws = makeYard("aws", "aws");
		const azure = makeYard("azure", "azure");

		const forward = junction("my-app", { yards: [aws, azure] });
		const reverse = junction("my-app", { yards: [azure, aws] });

		expect(forward.members).toEqual(reverse.members);
	});

	it("applies declared manifest region and capabilities", () => {
		const aws = makeYard("aws", "aws");
		const azure = makeYard("azure", "azure");

		const app = junction("my-app", {
			yards: [aws, azure],
			manifests: {
				aws: { region: "us-east-1", capabilities: ["public-mtls"] },
			},
		});

		const member = app.members.find((entry) => entry.yardName === "aws");
		expect(member?.region).toBe("us-east-1");
		expect(member?.capabilities).toEqual(["public-mtls"]);
		const other = app.members.find((entry) => entry.yardName === "azure");
		expect(other?.region).toBeNull();
		expect(other?.capabilities).toContain("overlay-mesh");
		expect(other?.capabilities).not.toContain("private-interconnect");
	});

	it("rejects invalid junction names with a typed error", () => {
		const aws = makeYard("aws", "aws");
		const azure = makeYard("azure", "azure");

		for (const bad of ["", "My App", "-leading", "UPPER"]) {
			try {
				junction(bad, { yards: [aws, azure] });
				expect.unreachable(`accepted invalid name ${bad}`);
			} catch (error) {
				expect(error).toBeInstanceOf(JunctionParseError);
				// SAFETY: `expect((error as JunctionParseError).code).toBe(` is required at this I/O or test boundary.
				expect((error as JunctionParseError).code).toBe(
					"junction.name.invalid",
				);
			}
		}
	});

	it("rejects empty membership", () => {
		try {
			junction("my-app", { yards: [] });
			expect.unreachable("accepted empty membership");
		} catch (error) {
			expect(error).toBeInstanceOf(JunctionParseError);
			// SAFETY: `expect((error as JunctionParseError).code).toBe("junction.members.empty");` is required at this I/O or test boundary.
			expect((error as JunctionParseError).code).toBe("junction.members.empty");
		}
	});

	it("rejects a single-member junction", () => {
		try {
			junction("my-app", { yards: [makeYard("aws", "aws")] });
			expect.unreachable("accepted single member");
		} catch (error) {
			// SAFETY: `expect((error as JunctionParseError).code).toBe(` is required at this I/O or test boundary.
			expect((error as JunctionParseError).code).toBe(
				"junction.members.insufficient",
			);
		}
	});

	it("rejects duplicate yard names", () => {
		const one = makeYard("aws", "aws");
		const two = makeYard("aws", "azure");

		try {
			junction("my-app", { yards: [one, two] });
			expect.unreachable("accepted duplicate yard names");
		} catch (error) {
			// SAFETY: `expect((error as JunctionParseError).code).toBe(` is required at this I/O or test boundary.
			expect((error as JunctionParseError).code).toBe(
				"junction.member.duplicate",
			);
		}
	});

	it("rejects members that are not parsed Yard objects", () => {
		const aws = makeYard("aws", "aws");

		try {
			junction("my-app", {
				// SAFETY: `yards: [aws, { kind: "camp" } as never],` is required at this I/O or test boundary.
				yards: [aws, { kind: "camp" } as never],
			});
			expect.unreachable("accepted a non-yard member");
		} catch (error) {
			// SAFETY: `expect((error as JunctionParseError).code).toBe(` is required at this I/O or test boundary.
			expect((error as JunctionParseError).code).toBe(
				"junction.member.invalid",
			);
		}
	});

	it("rejects manifests for yards that are not members", () => {
		const aws = makeYard("aws", "aws");
		const azure = makeYard("azure", "azure");

		try {
			junction("my-app", {
				yards: [aws, azure],
				manifests: { gcp: { region: "us-central1" } },
			});
			expect.unreachable("accepted a manifest for a non-member");
		} catch (error) {
			// SAFETY: `expect((error as JunctionParseError).code).toBe(` is required at this I/O or test boundary.
			expect((error as JunctionParseError).code).toBe(
				"junction.manifest.unknown-yard",
			);
		}
	});

	it("rejects manifest capabilities outside the tier model", () => {
		const aws = makeYard("aws", "aws");
		const azure = makeYard("azure", "azure");

		try {
			junction("my-app", {
				yards: [aws, azure],
				// SAFETY: `manifests: { aws: { capabilities: ["quantum-tunnel" as never] } },` is required at this I/O or test boundary.
				manifests: { aws: { capabilities: ["quantum-tunnel" as never] } },
			});
			expect.unreachable("accepted an unknown capability");
		} catch (error) {
			// SAFETY: `expect((error as JunctionParseError).code).toBe(` is required at this I/O or test boundary.
			expect((error as JunctionParseError).code).toBe(
				"junction.manifest.invalid",
			);
		}
	});
});
