export type YardDeploySource = {
	readonly targetId: string;
	readonly sourcePath: string;
	readonly source: string;
};

export type ProviderImportSpec = {
	readonly packageName: string;
	readonly exportName: string;
};

const PROVIDER_IMPORTS = {
	"browser-wasm": {
		packageName: "@hobo/provider-browser-wasm",
		exportName: "browserWasm",
	},
	webernetes: {
		packageName: "@hobo/provider-webernetes",
		exportName: "webernetes",
	},
	cloudflare: {
		packageName: "@hobo/provider-cloudflare",
		exportName: "cloudflare",
	},
	netlify: {
		packageName: "@hobo/provider-netlify",
		exportName: "netlify",
	},
	vercel: {
		packageName: "@hobo/provider-vercel",
		exportName: "vercel",
	},
	lakebed: {
		packageName: "@hobo/provider-lakebed",
		exportName: "lakebed",
	},
	aws: { packageName: "@hobo/provider-aws", exportName: "aws" },
	azure: { packageName: "@hobo/provider-azure", exportName: "azure" },
	gcp: { packageName: "@hobo/provider-gcp", exportName: "gcp" },
	digitalocean: {
		packageName: "@hobo/provider-digitalocean",
		exportName: "digitalocean",
	},
	hetzner: { packageName: "@hobo/provider-hetzner", exportName: "hetzner" },
	hostinger: {
		packageName: "@hobo/provider-hostinger",
		exportName: "hostinger",
	},
	kubernetes: {
		packageName: "@hobo/provider-kubernetes",
		exportName: "kubernetes",
	},
} as const satisfies Readonly<Record<string, ProviderImportSpec>>;

export function providerImportForTarget(targetId: string): ProviderImportSpec {
	if (Object.hasOwn(PROVIDER_IMPORTS, targetId)) {
		return PROVIDER_IMPORTS[targetId as keyof typeof PROVIDER_IMPORTS];
	}
	const exportName = targetId.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
	return {
		packageName: `@hobo/provider-${targetId}`,
		exportName,
	};
}

export function yardDeployByTarget(
	sources: readonly YardDeploySource[],
): ReadonlyMap<string, YardDeploySource> {
	return new Map(sources.map((entry) => [entry.targetId, entry]));
}

export type PoolDeploySourceText = {
	readonly pathLabel: string;
	readonly source: string;
};

export function composePoolDeploySource(input: {
	readonly provision: readonly { readonly target: { readonly id: string } }[];
}): PoolDeploySourceText {
	if (input.provision.length === 0) {
		return {
			pathLabel: "examples/try-site/station.deploy.ts",
			source:
				'import { station } from "@hobo/stations";\n' +
				"\n" +
				"// Select yards Policy will provision — then Deploy stations.\n" +
				"export default station({\n" +
				"  yards: [],\n" +
				"});\n",
		};
	}

	const imports = input.provision.map(({ target }) => providerImportForTarget(target.id));
	const seen = new Set<string>();
	const uniqueImports: ProviderImportSpec[] = [];
	for (const spec of imports) {
		const key = `${spec.packageName}\0${spec.exportName}`;
		if (seen.has(key)) continue;
		seen.add(key);
		uniqueImports.push(spec);
	}

	const lines: string[] = [
		'import { station } from "@hobo/stations";',
		...uniqueImports.map(
			(spec) => `import { ${spec.exportName} } from "${spec.packageName}";`,
		),
		"",
		"export default station({",
		`  yards: [${uniqueImports.map((spec) => spec.exportName).join(", ")}],`,
		"});",
		"",
	];

	return {
		pathLabel: "examples/try-site/station.deploy.ts",
		source: lines.join("\n"),
	};
}
