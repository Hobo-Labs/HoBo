import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

for (const mirror of [".agents", ".claude"]) {
	test(`${mirror} OptimizeXP guidance requires concrete implementation`, () => {
		const skill = readFileSync(`${mirror}/skills/optimizexp/SKILL.md`, "utf8");
		const doctor = readFileSync(
			`${mirror}/skills/optimizexp/references/doctor.md`,
			"utf8",
		);
		assert.match(skill, /implement the improvements/iu);
		assert.match(skill, /Do not create design documents, planning documents/iu);
		assert.match(doctor, /Resolve actionable failures in the implementation/iu);
		assert.match(
			doctor,
			/Do not generate planning documents, design documents/iu,
		);
	});
}
