package ghactions

#RelayOwnerSealed: string & =~"^[A-Za-z0-9_-]{40,1000}$"

#RelayOwnerDeviceAuthorization: {
	device_code:      #RelayOwnerSealed
	user_code:        string & =~"^[A-Z0-9-]{4,32}$"
	verification_uri: "https://github.com/login/device"
	expires_in:       int & >0 & <=1800
	interval:         int & >=1 & <=60
}

#RelayOwnerTokenRequest: {device_code: #RelayOwnerSealed}

#RelayOwnerSession: {
	session_token: #RelayOwnerSealed
	expires_in:    int & >0 & <=28800
}

#RelayOwnerCredentialRequest: {
	ref:   string & (=~"^owner://[A-Za-z_][A-Za-z0-9_.-]{0,127}$" | =~"^github-app://[A-Za-z0-9-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
	scope: string & =~"^.{1,200}$"
}

#RelayOwnerCredential: {
	token:      string & =~"^\\S{1,1000}$"
	expires_in: int & >0 & <=3600
}

#RelayOwnerLoginError: {
	error: "authorization_pending" | "access_denied" | "expired_token" | "invalid_request" | "not_owner" | "not_configured" | "device_flow_unavailable" | "session_required" | "not_resolvable" | "not_bound" | "github_refused"
} | {
	error:    "slow_down"
	interval: int & >=1 & <=120
}

#RelayOwnerLogin: *#RelayOwnerLoginMessage | #Onboarding

#RelayOwnerLoginMessage: #RelayOwnerDeviceAuthorization | #RelayOwnerTokenRequest | #RelayOwnerSession | #RelayOwnerCredentialRequest | #RelayOwnerCredential | #RelayOwnerLoginError
