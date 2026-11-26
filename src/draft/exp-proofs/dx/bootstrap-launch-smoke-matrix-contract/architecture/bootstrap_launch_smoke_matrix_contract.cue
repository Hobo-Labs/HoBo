// CUE constraints for every protobuf type in this package's schema, so the architecture guard can
// confirm the data shapes are bounded at parse time.

package architecture_evidence

#BootstrapLaunchSmokePathId: "unspecified" | "saas-bootstrap" | "self-host-bootstrap" | "local-dev-bootstrap"

#BootstrapLaunchSmokeStageId: "unspecified" | "preflight" | "auth-seed" | "first-project" | "first-deploy" | "failure-recovery" | "cleanup-or-uninstall"

#BootstrapLaunchSmokeResultFeedTarget: "unspecified" | "release-notes" | "troubleshooting" | "support-handoff"

#BootstrapLaunchSmokeStageEvidence: {
	id:                  #BootstrapLaunchSmokeStageId
	disposition:         "required" | "mocked" | "documented-boundary"
	fixture_ids:         [...string & !=""]
	mocked_boundary_ids: [...string & !=""]
	result_id:           string & !=""
	proves:              string & !=""
}

#BootstrapLaunchSmokeSeedAuthEvidence: {
	credential_source:  string & !=""
	allowed_scopes:     [...string & !=""]
	ttl_seconds:        uint & >0 & <=3600
	audit_event:        string & !=""
	identity_handoff:   string & !=""
	no_ambient_cloud_key: bool
	zero_egress_mode:   bool
}

#BootstrapLaunchSmokePath: {
	id:                 #BootstrapLaunchSmokePathId
	primary_user:       string & !=""
	fixtures:           [...string & !=""]
	mocked_boundaries:  [...string & !=""]
	unsupported_states: [...string & !=""]
	first_project_shape: string & !=""
	first_deploy_shape:  string & !=""
	seed_auth:          #BootstrapLaunchSmokeSeedAuthEvidence
	stages:             [...#BootstrapLaunchSmokeStageEvidence]
}

#BootstrapLaunchSmokeResultFeed: {
	target:            #BootstrapLaunchSmokeResultFeedTarget
	owner:             string & !=""
	source_result_ids: [...string & !=""]
	entries:           [...string & !=""]
}

#BootstrapLaunchSmokeMatrixRecord: {
	issue:        string & !=""
	phase:        "M1"
	paths:        [...#BootstrapLaunchSmokePath]
	result_feeds: [...#BootstrapLaunchSmokeResultFeed]
	scope_in:     [...string & !=""]
	scope_out:    [...string & !=""]
}
