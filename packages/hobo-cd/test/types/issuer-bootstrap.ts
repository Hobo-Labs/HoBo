import type { EventStore } from "@hobo/core";
import type { SecretsPort } from "@hobo/identity";
import {
	createIssuerCandidatesFromSecrets,
	createIssuerJournalFromEventStore,
} from "../../src/issuer-bootstrap.js";

declare const store: EventStore;
declare const secrets: SecretsPort;

createIssuerJournalFromEventStore({
	store,
	streamId: "fixture-issuer",
	tenant: "fixture-tenant",
});
createIssuerCandidatesFromSecrets(secrets);
