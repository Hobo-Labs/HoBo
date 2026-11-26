import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";

const PERSONAS = [
	"steve-jobs",
	"jony-ive",
	"walt-disney",
	"hayao-miyazaki",
	"naoto-fukasawa",
	"shigeru-miyamoto",
] as const;

const EXPECTED = {
	"steve-jobs": {
		experiences: ["ux", "dx", "ax"],
		priority: 10,
		lens: "product-editor",
		sources: [
			"https://book.stevejobsarchive.com/",
			"https://stevejobsarchive.com/",
		],
	},
	"jony-ive": {
		experiences: ["ux", "dx"],
		priority: 20,
		lens: "coherence-engineer",
		sources: ["https://designmuseum.org/designers/jonathan-ive"],
	},
	"walt-disney": {
		experiences: ["ux", "dx", "ax"],
		priority: 30,
		lens: "experience-imagineer",
		sources: [
			"https://sites.disney.com/waltdisneyimagineering/our-process/",
			"https://www.waltdisney.org/blog/plussing-disneyland-1955",
			"https://www.waltdisney.org/blog/open-studio-storyboards",
			"https://www.waltdisney.org/blog/qa-vanessa-hunt-and-tony-baxter",
		],
	},
	"hayao-miyazaki": {
		experiences: ["ux", "dx"],
		priority: 40,
		lens: "living-world-humanist",
		sources: [
			"https://www.rogerebert.com/interviews/drawing-on-spirited-world",
			"https://www.midnighteye.com/interviews/hayao-miyazaki/",
			"https://www.newyorker.com/culture/the-new-yorker-interview/hayao-miyazaki-on-his-new-film-and-life-as-an-animator",
		],
	},
	"naoto-fukasawa": {
		experiences: ["ux", "dx"],
		priority: 50,
		lens: "behavioral-naturalist",
		sources: ["https://naotofukasawa.com/about/"],
	},
	"shigeru-miyamoto": {
		experiences: ["ux", "dx"],
		priority: 60,
		lens: "interaction-toymaker",
		sources: [
			"https://iwataasks.nintendo.com/interviews/wii/mario25th/1/0/",
			"https://iwataasks.nintendo.com/interviews/3ds/super-mario-3d-land/0/0/",
			"https://www.newyorker.com/culture/the-new-yorker-interview/shigeru-miyamoto-wants-to-create-a-kinder-world",
		],
	},
} as const;

const REQUIRED_SECTIONS = [
	"Who I am",
	"Market segment",
	"Demographic model",
	"Psychographic model",
	"Cognitive thresholds",
	"Goals",
	"Constraints",
	"Accessibility & inclusion needs",
	"Success looks like",
	"Failure modes I hate",
	"Vocabulary I use",
	"Review instructions",
	"Design doctrine",
	"Methodology",
	"How I work with others",
	"Relevance cues",
	"Argument posture",
	"Hard-blocker criteria",
	"Blind spots and self-check",
	"Research basis",
	"Experience involvement",
] as const;

const PERSONA_DIR = path.resolve(".optimizexp/personas");

function text(id: string): string {
	return readFileSync(path.join(PERSONA_DIR, `${id}.md`), "utf8");
}

function frontmatter(input: string): string {
	return input.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? "";
}

function list(fm: string, key: string): string[] {
	return (
		fm
			.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"))?.[1]
			?.split(",")
			.map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
			.filter(Boolean) ?? []
	);
}

function section(input: string, heading: string): string {
	const marker = `## ${heading}`;
	const start = input.indexOf(marker);
	if (start < 0) return "";
	const bodyStart = input.indexOf("\n", start + marker.length);
	if (bodyStart < 0) return "";
	const next = input.indexOf("\n## ", bodyStart + 1);
	return input.slice(bodyStart + 1, next < 0 ? undefined : next).trim();
}

describe("designer council personas", () => {
	test("the council marker selects exactly the six canonical IDs", () => {
		const selected = readdirSync(PERSONA_DIR)
			.filter((file) => file.endsWith(".md"))
			.map((file) => ({
				id: file.slice(0, -3),
				fm: frontmatter(text(file.slice(0, -3))),
			}))
			.filter(({ fm }) => list(fm, "segmentIds").includes("design-council"))
			.map(({ id }) => id)
			.sort();

		assert.deepEqual(selected, [...PERSONAS].sort());
	});

	for (const id of PERSONAS) {
		test(`${id} is a sourced schema-v2 synthetic review lens`, () => {
			const input = text(id);
			const fm = frontmatter(input);
			const expected = EXPECTED[id];

			assert.match(fm, new RegExp(`^id:\\s*${id}$`, "m"));
			assert.match(fm, /^schemaVersion:\s*2$/m);
			assert.match(fm, new RegExp(`^priority:\\s*${expected.priority}$`, "m"));
			assert.match(fm, /^generatedFromSeed:\s*false$/m);
			assert.match(fm, /^seedDigest:\s*null$/m);
			assert.deepEqual(list(fm, "experiences"), [...expected.experiences]);
			assert.deepEqual(list(fm, "segmentIds"), [
				"design-council",
				expected.lens,
			]);
			for (const heading of REQUIRED_SECTIONS) {
				assert.ok(
					section(input, heading),
					`${id}: missing or empty ## ${heading}`,
				);
			}

			const market = section(input, "Market segment");
			assert.match(market, /synthetic/i);
			assert.match(market, /expert.review|review instrument/i);
			assert.match(
				market,
				/not .*market research participant|not market research/i,
			);

			const who = section(input, "Who I am");
			assert.match(who, /documented|public/i);
			assert.match(
				who,
				/not .*private thoughts|not .*identity|does not reproduce/i,
			);
			const doctrine = section(input, "Design doctrine");
			assert.match(doctrine, /documented principles/i);
			assert.match(
				doctrine,
				/HoBo operationalization|repo-specific|repository/i,
			);

			const review = section(input, "Review instructions");
			for (const key of [
				"review:",
				`persona: ${id}`,
				"proposalInterpretation:",
				"strongestSuccess:",
				"centralViolation:",
				"arguments:",
				"respondsTo:",
				"blindSpotCheck:",
				"vote: yay | nay",
				"confidence:",
			]) {
				assert.ok(
					review.includes(key),
					`${id}: missing review contract key ${key}`,
				);
			}
			assert.match(review, /append.*bus|bus.*append/is);
			assert.match(review, /read.*(recent|earlier).*bus/is);
			assert.match(
				review,
				/preference.*hard.blocker|hard.blocker.*preference/is,
			);
			assert.match(review, /blind.?spot|self-check/i);
			assert.match(
				review,
				/no .*superior|more voting weight|equal voting|every .*vote.*equal|one equal vote|priority.*not.*authority/is,
			);

			const research = section(input, "Research basis");
			for (const source of expected.sources)
				assert.ok(research.includes(source), `${id}: ${source}`);
		});
	}

	test("each council lens has distinct relevance cues", () => {
		const cues = PERSONAS.map((id) =>
			section(text(id), "Relevance cues").toLowerCase(),
		);
		assert.equal(new Set(cues).size, PERSONAS.length);
	});
});
