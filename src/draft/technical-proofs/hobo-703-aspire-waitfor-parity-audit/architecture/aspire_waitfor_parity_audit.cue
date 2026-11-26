package aspire_waitfor_parity_audit

#AspireWaitForTrackerRow: {
	aspire_feature: =~"^`WaitFor`"
	hobo_equivalent: =~".*resource\\.Provisioned.*"
	status: "◐"
	hobo_doc: =~".*health-gated-dependency-ordering-iteration-hook.*"
}

#AspireWaitForParityAuditRequest: {
	aspire_markdown: =~".+"
	control_plane_markdown: =~".+"
}

#AspireWaitForParityAuditResult: {
	tracker_row: #AspireWaitForTrackerRow
	failures: [...string]
	pass: bool & {
		if len(failures) == 0 {
			true
		}
		if len(failures) > 0 {
			false
		}
	}
}
