import type { APIRoute } from "astro";
import { nav } from "../nav";

// Every docs page's raw markdown, in nav order, concatenated into one
// agent-consumable document. llms.txt stays the condensed briefing;
// llms-full.txt is the whole site.
const pages = import.meta.glob<string>("./**/*.md", {
	query: "?raw",
	import: "default",
	eager: true,
});

const SITE = "https://tyler-r-kendrick.github.io/HoBo";

const slugToFile = (slug: string) => {
	const trimmed = slug.replace(/^\/|\/$/g, "");
	const index = `./${trimmed}/index.md`.replace(/^\.\/\/index/, "./index");
	return pages[`./${trimmed}.md`] ?? pages[index];
};

const stripFrontmatter = (md: string) =>
	md.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

export const GET: APIRoute = async () => {
	const sections: string[] = [
		"# HoBo — full documentation",
		"",
		"> The complete HoBo docs as one markdown document, in reading order.",
		`> The condensed briefing lives at ${SITE}/llms.txt.`,
		"",
	];

	for (const group of nav) {
		for (const item of group.items) {
			const raw = slugToFile(item.slug);
			if (!raw) continue;
			sections.push(
				"---",
				"",
				`<!-- ${group.label} · ${item.label} · ${SITE}${item.slug} -->`,
				"",
				stripFrontmatter(raw),
				"",
			);
		}
	}

	return new Response(sections.join("\n"), {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
