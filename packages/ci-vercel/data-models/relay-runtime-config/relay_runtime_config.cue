package vercel

// Constraints on the relay's runtime configuration as the config service holds
// it (ADR-0179). Field names are the protobuf JSON names in
// ../relay_runtime_config.proto. The TypeScript parser in
// src/relay-runtime-config.ts applies the same constraints, and more that CUE
// cannot express (an RSA key of at least 2048 bits, the onboarding token's
// digest among the control tokens).

#canonicalKey: string & =~"^[A-Za-z0-9_-]{43}$"

#RelayRuntimeConfig: {
	HOBO_CI_PUBLIC_URL:                string & =~"^https://[^/?#@]+$"
	HOBO_CI_SESSION_KEY:               #canonicalKey
	HOBO_CI_BOOTSTRAP_ACCOUNT_ID:      string & =~"^[A-Za-z0-9_-]{1,80}$"
	HOBO_CI_BOOTSTRAP_TOKEN_SHA256:    string & =~"^[a-f0-9]{64}$"
	HOBO_CI_INVITATION_EXPIRES_AT?:    string & =~"^[0-9]{13}$"
	HOBO_CI_CONTROL_TOKENS_JSON:       string & =~"(?s)^.{2,}$"
	HOBO_CI_ONBOARDING_CONTROL_TOKEN?: #canonicalKey
	HOBO_CI_CONFIG_JSON:               string & =~"(?s)^.{2,}$"
	CRON_SECRET:                       string & =~"^.{32,1024}$"
	HOBO_CI_SANDBOX_ENABLED?:          "1"
	HOBO_CI_SANDBOX_TEAM_ID?:          string & =~"^team_[A-Za-z0-9]{1,100}$"
	HOBO_CI_SANDBOX_PROJECT_ID?:       string & =~"^prj_[A-Za-z0-9]{1,100}$"
	HOBO_CI_SANDBOX_ISSUER?:           string & =~"^https?://"
	HOBO_CI_SANDBOX_PLAN?:             "hobby" | "pro" | "enterprise"
	HOBO_CI_SANDBOX_DOMAINS_JSON?:     string & =~"(?s)^.{2,}$"
	HOBO_CI_GITHUB_APP_ID:             string & =~"^[1-9][0-9]{0,15}$"
	HOBO_CI_GITHUB_APP_PRIVATE_KEY:    string & =~"^-----BEGIN (RSA )?PRIVATE KEY-----"
	HOBO_CI_WEBHOOK_SECRET:            string & =~"^.{32,1024}$"
	HOBO_CI_GITHUB_APP_CLIENT_ID:      string & =~"^[A-Za-z0-9._-]{1,100}$"
	HOBO_CI_GITHUB_APP_CLIENT_SECRET:  string & =~"^[!-~]{20,256}$"
	HOBO_CI_SANDBOX_PROXY_TOKEN_KEY?:  #canonicalKey
	// Cache bindings the config service may hold (ADR-0179 phase 4c), and
	// the declared cache offers (data-models/cache_offers.proto).
	VALKEY_URL?:                string & =~"^rediss?://[^\\s]+$"
	TURSO_DATABASE_URL?:        string & =~"^(libsql|https)://[^\\s@]+$"
	TURSO_AUTH_TOKEN?:          string & =~"^[!-~]{1,4096}$"
	BLOB_STORE_ID?:             string & =~"^(store_)?[A-Za-z0-9]{1,64}$"
	HOBO_CI_CACHE_OFFERS_JSON?: string & =~"(?s)^.{2,}$"
}
