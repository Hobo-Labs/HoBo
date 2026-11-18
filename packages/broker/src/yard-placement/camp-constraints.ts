import type { BindleDeploymentRequest, YardLayout } from "./types.js";

/** The broker has no evidence that these requested Camp constraints hold. */
export function hasUnverifiedCampConstraints(
	request: BindleDeploymentRequest,
): boolean {
	const camp = request.camp?.layout;
	return (
		hasUnverifiedYardCamps(request.yard.requestedLayout) ||
		(camp !== undefined &&
			(camp.require.length > 0 ||
				camp.runtimeRequirements.length > 0 ||
				Object.keys(camp.labels).length > 0))
	);
}

/** Nested Camp layouts are not yet matched or established by generation. */
export function hasUnverifiedYardCamps(layout: YardLayout): boolean {
	return layout.camps.length > 0;
}
