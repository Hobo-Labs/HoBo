// @hobo/cd-gitops — a PublisherPort that delivers a Set through GitOps
// (plan 0024, WP16, D14). Vendor vocabulary (Argo CD, Flux, Git hosts) lives
// here, outside the neutral @hobo/cd core (I11).
export * from "./_generated/gitops_pb.js";
export {
	PUBLISHER_SCHEMA,
	type PublisherConfig,
	parsePublisherConfig,
} from "./config.js";
export {
	argoVerdict,
	ENGINE_CREDENTIAL_SCOPE,
	type EngineVerdict,
	fluxVerdict,
	observeEngine,
} from "./engines/index.js";
export {
	GITOPS_FAILURES,
	GitopsError,
	type GitopsFailureCode,
} from "./errors.js";
export {
	createBitbucketClient,
	createGiteaClient,
	createGitHostClient,
	createGitHubClient,
	createGitLabClient,
	type FileChange,
	GIT_CREDENTIAL_SCOPE,
	type GitHostClient,
	type RemoteFile,
} from "./hosts/index.js";
export {
	createGitopsPublisher,
	createPublisherRegistry,
	type GitopsPublisherOptions,
	type PublisherRegistry,
	publisherTarget,
} from "./publisher.js";
export {
	canonicalJson,
	type EngineDocumentRef,
	k8sName,
	MAX_SET_DOCUMENT_BYTES,
	type RenderedFile,
	type RenderedPublication,
	type ResolvedSet,
	renderPublication,
	sha256Digest,
	stableDocument,
} from "./render.js";
