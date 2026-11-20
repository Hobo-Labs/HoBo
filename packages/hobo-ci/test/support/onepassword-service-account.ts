export const ONE_PASSWORD_TEST_TOKEN = `ops_${Buffer.from(
	JSON.stringify({
		email: "service-account@example.invalid",
		muk: { alg: "A256GCM", k: "fixture-key" },
		secretKey: "A3-FIXTURE-SECRET-KEY",
		srpX: "fixture-srp",
		signInAddress: "example.1password.com",
		userAuth: { method: "SRPg-4096", alg: "PBES2g-HS256" },
	}),
).toString("base64url")}`;
