/** Optional dense encoder. Production default does not load Model2Vec. */
export type DenseEncoderPort = {
	readonly id: string;
	readonly digest: string;
	readonly dimensions: number;
	readonly normalization: "l2" | "none";
	encode(texts: readonly string[]): Promise<readonly Float32Array[]>;
};

export function rejectModel2Vec(): {
	readonly adopted: false;
	readonly reason: string;
	readonly gates: readonly string[];
} {
	return {
		adopted: false,
		reason:
			"Model2Vec fails offline packaging, no-download, no-native-compile, and catalog-size gates; ontology-vector remains the default.",
		gates: [
			"no-runtime-network",
			"no-install-download",
			"approved-license+digest",
			"cross-platform-load",
			"no-native-extension",
			"package-size",
			"quality-over-ontology+fts",
		],
	};
}
