import type { BindleDeploymentRequest, YardLayout } from "./types.js";

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

export function hasUnverifiedYardCamps(layout: YardLayout): boolean {
	return layout.camps.length > 0;
}
