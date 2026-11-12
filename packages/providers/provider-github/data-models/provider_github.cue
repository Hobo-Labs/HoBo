// CUE constraints for every protobuf type in provider_github.proto, over the
// JSON (camelCase) spellings the realizer actually exchanges.
//
// The invariants written down here are the ones the realizer's correctness
// rests on: Freight addressed by digest only, tree paths that cannot escape
// the tree or touch .git, mode-specific desired keys that cannot be mixed,
// and outputs that claim readiness only when the published content was
// observed equal to the Freight and its Pages build or deployment finished.

package provider_github

#GithubPagesPublishMode: "branch" | "pages-deployment"

#GithubPagesDeleteAction: "unpublish" | "retain"

#GithubPagesRefusalReason: "github-credential-rejected" | "github-permission-missing" | "github-rate-limited" | "github-pages-disabled" | "github-pages-source-mismatch" | "github-ref-not-fast-forward" | "github-pages-build-errored" | "github-pages-deployment-failed" | "github-pages-artifact-unavailable"

#Sha256Digest: =~"^sha256:[0-9a-f]{64}$"

#GitSha: =~"^[0-9a-f]{40}$"

#Owner: =~"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$"

#Repo: =~"^[A-Za-z0-9._-]{1,100}$" & !="." & !=".."

#SitePath: =~"^[^/\\\\]+(/[^/\\\\]+)*$" & !~"(^|/)\\.\\.?(/|$)" & !~"(^|/)\\.[Gg][Ii][Tt](/|$)"

#StaticSiteFile: {
	path:        #SitePath
	digest:      #Sha256Digest
	size:        int & >=0 & <=104857600
	executable?: bool
}

#StaticSiteTree: {
	contract: "hobo.static-site-tree/v1"
	files: [#StaticSiteFile, ...#StaticSiteFile]
}

#GithubPagesSiteDesired: {
	owner:               #Owner
	repo:                #Repo
	publishMode:         #GithubPagesPublishMode
	artifactDigest:      #Sha256Digest
	artifactCoordinate?: =~"^store://[a-z0-9-]+/sha256:[0-9a-f]{64}$"
	commitMessage?:      string & =~"\\S"
	onDelete?:           #GithubPagesDeleteAction
	if publishMode == "branch" {
		branch: string & =~"^[A-Za-z0-9._/-]{1,200}$"
		path?:  "/" | "/docs"
	}
	if publishMode == "pages-deployment" {
		actionsArtifactId:     int & >0
		actionsArtifactDigest: #Sha256Digest
	}
}

#GithubPagesSiteOutputs: {
	owner:              #Owner
	repo:               #Repo
	publishMode:        #GithubPagesPublishMode
	artifactDigest:     #Sha256Digest
	treeSha:            #GitSha
	fileCount:          int & >0
	htmlUrl:            =~"^https://" | null
	ready:              bool
	operationConfirmed: bool
	operationTerminal:  ready
	absenceConfirmed:   false
	lifecycleStatus:    "pending" | "building" | "ready"
	if ready {
		lifecycleStatus:    "ready"
		operationConfirmed: true
	}
	if !ready && operationConfirmed {
		lifecycleStatus: "building"
	}
	if !operationConfirmed {
		lifecycleStatus: "pending"
	}
	if publishMode == "branch" {
		branch:              string
		path:                "/" | "/docs"
		publishedTreeSha:    #GitSha | null
		headCommitSha:       #GitSha | null
		pagesBuildStatus:    string | null
		pagesBuildCommitSha: #GitSha | null
		contentMatches:      operationConfirmed
		if ready {
			publishedTreeSha:    treeSha
			pagesBuildStatus:    "built"
			pagesBuildCommitSha: headCommitSha
		}
	}
	if publishMode == "pages-deployment" {
		actionsArtifactId:     int & >0
		pagesBuildVersion:     treeSha
		pagesDeploymentId:     string | null
		pagesDeploymentStatus: string | null
		if ready {
			pagesDeploymentStatus: "succeed"
		}
	}
}
