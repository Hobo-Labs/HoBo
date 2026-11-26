import type { BindleDefinition } from "@hobo/bindles";

/**
 * Extract OCI image refs from a Bindle definition's container resources.
 * Ship/bridge paths must use this — never invent images from example ids.
 */

export type BindleContainerRef = {
	readonly name: string;
	readonly image: string;
};

export function bindleContainerImages(
	definition: BindleDefinition,
): readonly BindleContainerRef[] {
	const out: BindleContainerRef[] = [];
	for (const [name, resource] of Object.entries(definition.resources)) {
		if (resource === undefined || resource.kind !== "container") continue;
		const annotations = resource.annotations;
		if (!Array.isArray(annotations)) continue;
		const dep = annotations.find(
			(entry) => entry.option === "dependency" && entry.provider === "hobo",
		);
		const image = dep?.config.image;
		if (Object.prototype.toString.call(image) !== "[object String]") continue;
		const imageText = String(image);
		if (imageText.length > 0) {
			out.push({ name, image: imageText });
		}
	}
	return Object.freeze(out);
}

export function requireBindleContainer(
	containers: readonly BindleContainerRef[],
	name: string,
): BindleContainerRef {
	const hit = containers.find((entry) => entry.name === name);
	if (!hit) {
		throw new Error(
			`Bindle missing container resource "${name}" with an image — cannot ship`,
		);
	}
	return hit;
}
