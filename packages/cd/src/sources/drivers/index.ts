// createSubscriptionDrivers (WP2): one SubscriptionDriver per SubscriptionKind.
import type {
	CdFactories,
	CiArtifactReader,
	CiEventReader,
	RailEventReader,
	SubscriptionDriver,
} from "../../ports.js";
import { createGitDriver } from "./git.js";
import { createCiDriver } from "./hobo-ci.js";
import { createRailDriver } from "./hobo-rail.js";
import { createHttpIndexDriver } from "./http-index.js";
import { createOciDriver } from "./oci.js";
import { createPackageRegistryDriver } from "./packages.js";

type CiReaders = { readCiEvents?: CiEventReader; readCiArtifact?: CiArtifactReader };
type RailReaders = { readRailEvents?: RailEventReader };

export const createSubscriptionDrivers: CdFactories["createSubscriptionDrivers"] = (d) => {
	const http = { http: d.http, credentials: d.credentials };
	const ci: CiReaders = {};
	if (d.readCiEvents) ci.readCiEvents = d.readCiEvents;
	if (d.readCiArtifact) ci.readCiArtifact = d.readCiArtifact;
	const rail: RailReaders = {};
	if (d.readRailEvents) rail.readRailEvents = d.readRailEvents;
	const drivers: SubscriptionDriver[] = [
		createOciDriver(http),
		createGitDriver(http),
		createPackageRegistryDriver(http),
		createHttpIndexDriver(http),
		createCiDriver(ci),
		createRailDriver(rail),
	];
	return drivers;
};

export { createGitDriver, fetchRequest, lsRefsRequest, treeDigest } from "./git.js";
export { CI_PASSED, CI_RESULT_EVENT, ciOutputs, createCiDriver } from "./hobo-ci.js";
export { createRailDriver, railCoordinate } from "./hobo-rail.js";
export { createHttpIndexDriver } from "./http-index.js";
export {
	createOciDriver,
	OCI_ATTESTATION_TYPES,
	OCI_CREATED_ANNOTATION,
	OCI_MANIFEST_ACCEPT,
	OCI_REVISION_ANNOTATION,
	parseOciLocator,
} from "./oci.js";
export {
	createPackageRegistryDriver,
	PACKAGE_ECOSYSTEMS,
	PACKAGE_REGISTRY_DEFAULTS,
	packagePurl,
	parsePackageLocator,
} from "./packages.js";
