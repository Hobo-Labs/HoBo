package hobo

#CelldIsolationClass: "trusted"

#CelldRuntimeConfig: {
	camp_id:               string & !=""
	tenant_id:             string & !=""
	bucket_uri:            string & !=""
	bucket_secret_ref:     string & !=""
	advertise:             string & !=""
	internal_listen:       string & !=""
	overlay:               "tailscale" | "netbird" | "wireguard"
	operator_port_public:  false
	isolation:             #CelldIsolationClass
	svid_binding_ref:      string & !=""
}

#CelldDoctorReport: {
	overlay_required:      true
	overlay_present:       bool
	operator_port_private: bool
	bucket_cas_probed:     bool
	hostile_rejected:      bool
	fidelity:              "config-only" | "cas-mocked" | "live-unverified"
	notes:                 [...string]
	remediation:           [...string]
}
