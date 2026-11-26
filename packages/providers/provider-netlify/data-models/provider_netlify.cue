// Invariants for every protobuf type in provider_netlify.proto.
//
// These are the rules that keep a genuinely anonymous, claimable deploy honest:
// nobody is billed before the claim, the deadline is Netlify's documented one
// hour rather than a locally chosen TTL, the claim URL exists only as a custody
// locator, and a verification that could not compare ownership fails closed.

package provider_netlify

// Exactly what `assertSiteId` in src/client.ts accepts before a site id is
// placed in a request path.
#SiteId: =~"^[A-Za-z0-9._~-]{1,128}$"

// A custody locator, never material. The second clause is the one that matters:
// a claim URL with its query string is bearer authority, not a reference.
#SecretRefLocator: =~"^hobo-(?:secret|token)://[A-Za-z0-9._~/-]+$" & !~"[?#]"

// What a receipt may carry: the redacted projection of a locator, or the
// placeholder when nothing parseable was held. Never an http(s) URL, and never
// a query string — that is where a claim code would ride.
#RedactedCustodyRef: (=~"^hobo-(?:secret|token)://" & !~"\\?") | "<redacted-secret-ref>"

#EpochMillis: int & >0

#IsoDate: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"

// The only REST origin the guarded transport will dial
// (NETLIFY_API_ALLOWED_HOSTS).
#NetlifyApiHost: "api.netlify.com"

// The dashboard host that serves the human claim ceremony. Never called by this
// package; the claim action is validated against it by shape.
#NetlifyClaimHost: "app.netlify.com"

// Documented: "You have one hour to claim ownership of the deployed project…
// After one hour, unclaimed projects are removed." (checked 2026-08-08)
#AnonymousClaimWindowMs: 3600000

// The CLI build this adapter parses `--json` output from. Bumping the pinned
// version is a contract change, not an upgrade.
#NetlifyCliPackageSpec: =~"^netlify-cli@[0-9]+\\.[0-9]+\\.[0-9]+$"

#ExpirySource: "EXPIRY_SOURCE_DOCUMENTED_WINDOW" | "EXPIRY_SOURCE_PROVIDER_REPORTED"

#AnonymousClaimObservedStatus: "ANONYMOUS_CLAIM_OBSERVED_STATUS_PENDING" |
	"ANONYMOUS_CLAIM_OBSERVED_STATUS_CLAIMED" |
	"ANONYMOUS_CLAIM_OBSERVED_STATUS_EXPIRED"

#NetlifySourceRef: {
	url:        =~"^https://"
	checked_on: #IsoDate
	note:       string & !=""
}

#NetlifyCliInvocationRecord: {
	package_spec: #NetlifyCliPackageSpec
	// Array elements only: there is no command line to quote for, so a publish
	// directory named "; rm -rf /" is one inert element. A value in an argument
	// position may not look like a flag, which is option injection.
	argv: [...string & !="" & !~"\\x00"]
	env_allowlist: [...=~"^[A-Za-z_][A-Za-z0-9_]*$"]
	forbidden_env_keys: [
		"NETLIFY_AUTH_TOKEN",
		"NETLIFY_ACCESS_TOKEN",
		"NETLIFY_TOKEN",
		"NETLIFY_API_TOKEN",
	]
	// An inherited token would make the deploy authenticated and quietly turn a
	// claimable site into one that already belongs to someone.
	shell: false
}

#AnonymousDeployFactsRecord: {
	site_id:   #SiteId
	site_name: string & !=""
	deploy_id: string & !=""
	site_url:  =~"^https://"
	deploy_url?: =~"^https://"
	claim_url_secret_ref: #SecretRefLocator
	claim_action_id:      string & !=""
	deployed_at_ms:       #EpochMillis
	claim_deadline_at_ms: #EpochMillis
	expiry_source:        #ExpirySource
	// A derived deadline is the documented window applied to the deploy
	// instant. A provider-reported one is whatever Netlify said, and only that
	// case may differ.
	_documentedWindowIsOneHour: true & (expiry_source != "EXPIRY_SOURCE_DOCUMENTED_WINDOW" |
		claim_deadline_at_ms == deployed_at_ms + #AnonymousClaimWindowMs)
}

#AnonymousSiteRecord: {
	schema_version:         "hobo.provider-netlify.anonymous-site/v1"
	definition_id:          "netlify.anonymous-static-site/v1"
	provider_id:            "netlify"
	claim_strategy_ref:     "netlify.anonymous-static-site/v1"
	bootstrap_strategy_ref: "bootstrap.netlify.anonymous-cli/v1"
	deployment_ref:         string & !=""
	facts:                  #AnonymousDeployFactsRecord
	// Load-bearing: no account and no payer exist before the claim, so any
	// non-zero exposure would describe a different offer entirely.
	sponsor_exposure_minor_units: 0
	cli_package_spec:             #NetlifyCliPackageSpec
	anonymous_authority_revoked:  bool
	observed_at_ms:               #EpochMillis
}

#NetlifySiteOwnershipSignalRecord: {
	id:          "site-owned-by-claimer" | "anonymous-authority-unusable"
	subject_ref: =~"^netlify:site:"
	// Both signals are independent reads; a provider "yes" is not a signal.
	independent: true
	passed:      bool
	detail:      string & !=""
}

#SiteOwnershipVerificationRecord: {
	item_id:     string & !=""
	subject_ref: =~"^netlify:site:"
	transferred: bool
	verified:    bool
	// Both signals must be present: the site resolves to the claiming account,
	// and the pre-claim anonymous material no longer works.
	signals: [#NetlifySiteOwnershipSignalRecord, #NetlifySiteOwnershipSignalRecord]
	reasons: [...string & !=""]
	observed_at_ms: #EpochMillis
	// A site that never moved cannot be verified as moved.
	_verifiedImpliesTransferred: true & (!verified | transferred)
	// Verification that carries a reason it failed is not verification.
	_verifiedHasNoReasons: true & (!verified | len(reasons) == 0)
}

#AnonymousClaimItemRecord: {
	id:                 =~"#site$"
	subject_ref:        =~"^netlify:site:"
	subject_kind:       "camp"
	provider_id:        "netlify"
	claim_strategy_ref: "netlify.anonymous-static-site/v1"
	mode:               "site-claim"
	deadline_at_ms:     #EpochMillis
	verification_ref:   "hobo.verification/netlify.site-claim/v1"
	// A static site produces no credentialed binding, so no rotation
	// obligation is invented. What must happen is that the anonymous claim
	// material stops working.
	post_claim_actions: ["revoke-bootstrap-authority"]
	// Netlify documents no way to revoke an anonymous deploy session, so
	// "absent" cannot be asserted from here.
	creator_authority_after_claim: "rotatable" | "unknown"
	status:                        "pending" | "in-progress" | "observed" | "verified" | "completed" | "expired" | "failed"
}

#AnonymousClaimPlanRecord: {
	lease_id:  =~"#lease$"
	bundle_id: =~"#claim$"
	// Genuinely anonymous and still claimable: the site belongs to whoever
	// claims it within the window.
	bootstrap_class: "anonymous-claimable"
	// One subject, so there is no second ownership fact that can be left
	// behind.
	atomicity:            "single-resource"
	claim_deadline_at_ms: #EpochMillis
	expiry_source:        #ExpirySource
	// Netlify reaps the unclaimed project itself; deleting it again would only
	// add a second failure path.
	cleanup_policy: "retain-until-provider-expiry"
	fencing_token:  string & !=""
}

#AnonymousSiteReceiptRecord: {
	schema_version: "hobo.receipt.netlify.anonymous-site/v1"
	definition_id:  "netlify.anonymous-static-site/v1"
	provider_id:    "netlify"
	deployment_ref: string & !=""
	site_id:        #SiteId
	site_name:      string & !=""
	site_url:       =~"^https://"
	// Redacted locator only. A receipt lands in logs, PR comments, support
	// tickets, and agent context windows.
	claim_action_custody:         #RedactedCustodyRef
	claim_action_id:              string & !=""
	claim_deadline_at_ms:         #EpochMillis
	expiry_source:                #ExpirySource
	sponsor_exposure_minor_units: 0
	cli_package_spec:             #NetlifyCliPackageSpec
	anonymous_authority_revoked:  bool
	claim_status:                 "unverified" | "not-transferred" | "transferred-unverified" | "verified"
	ownership_signals: [...#NetlifySiteOwnershipSignalRecord]
	reasons: [...string & !=""]
}
