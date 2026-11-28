import type { ClusterSyncPort } from "@hobo/cd";
import {
	type CdEngineRegistration,
	clusterSyncRegistration,
} from "@hobo/cd/compose";

export function cdArgocdEngineRegistration(
	name: string,
	port: ClusterSyncPort,
): CdEngineRegistration {
	return clusterSyncRegistration(name, port);
}
