import { isJsonString, isJsonObject } from "./json.js";
const credentialFieldPattern = /(token|credential|authorization|svid|secret|key)$/i;
const secretLikePattern = /(eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_.-]+|provider-token-[a-zA-Z0-9_-]+|AKIA[0-9A-Z]+)/g;
const secretLikeTestPattern = /(eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_.-]+|provider-token-[a-zA-Z0-9_-]+|AKIA[0-9A-Z]+)/;

export function createCliCredentialHardeningHarness(options = {}) {
  const trustedIssuer = options.trustedIssuer ?? "https://identity.hobo.local";
  const credentials = new Map();
  const auditLog = [];
  const doctorFindings = [];
  let nextCredentialId = 1;

  return {
    loginWithSvid({ principal, jwtSvid, ttlSeconds }) {
      const credentialRef = `os-secret://${stableRef(principal)}-${nextCredentialId++}`;
      credentials.set(credentialRef, {
        principal,
        jwtSvid,
        ttlSeconds,
        revoked: false,
        issuer: trustedIssuer
      });
      auditLog.push({ type: "identity.Issued", principal, credentialRef });

      return {
        status: "stored",
        credentialRef,
        storage: {
          kind: "os-secret-store",
          ref: credentialRef,
          worldReadable: false
        },
        plaintextCredentialFiles: [],
        shellHistoryVisibleArgs: []
      };
    },

    acceptCredential({ source, type, value }) {
      if (type.includes("static") || /AKIA[0-9A-Z]+/.test(value)) {
        doctorFindings.push({
          severity: "error",
          code: "static-cloud-key-present",
          message: "Static cloud keys are refused; use brokered short-lived SVID credentials."
        });
        return {
          status: "rejected",
          reason: "static-cloud-key-not-accepted",
          source,
          storedRefs: []
        };
      }

      return { status: "accepted", storedRefs: [] };
    },

    renderFailureReport({ command, error, env, json }) {
      const cleanJson = redactCredentialMaterial(json);
      const message = error instanceof Error ? error.message : String(error);

      return {
        verbose: redactString(`${command}\n${message}`),
        crashDump: redactString(`${message}\n${JSON.stringify(env)}\n${JSON.stringify(json)}`),
        childProcessEnv: redactString(JSON.stringify(redactCredentialMaterial(env))),
        json: cleanJson
      };
    },

    revokeSvid(credentialRef, reason) {
      const credential = credentials.get(credentialRef);
      if (credential) {
        credential.revoked = true;
        credential.revocationReason = reason;
      }
      auditLog.push({ type: "token.Revoked", credentialRef, reason });
    },

    runCredentialedCommand({ credentialRef, command, mutates }) {
      const credential = credentials.get(credentialRef);
      if (!credential || credential.revoked) {
        auditLog.push({
          type: "token.Denied",
          credentialRef,
          command,
          reason: credential?.revoked ? "svid-revoked" : "missing-svid"
        });
        return {
          status: "denied",
          reason: credential?.revoked ? "svid-revoked" : "missing-svid",
          mutationApplied: false
        };
      }

      return {
        status: "succeeded",
        mutationApplied: Boolean(mutates)
      };
    },

    runConcurrentCredentialedCommands({ credentialRef, commands }) {
      const credential = credentials.get(credentialRef);
      if (!credential || credential.revoked) {
        return {
          status: "denied",
          reason: credential?.revoked ? "svid-revoked" : "missing-svid",
          results: [],
          secretStoreWrites: 0,
          leakedCredentials: []
        };
      }

      return {
        status: "serialized",
        results: commands.map((command) => ({
          command,
          credentialRef,
          status: "succeeded"
        })),
        secretStoreWrites: 1,
        leakedCredentials: []
      };
    },

    runCiDryRun({ oidcAssertion, brokeredToken, command }) {
      const audit = [
        { type: "token.Granted", source: "oidc", command },
        { type: "token.Used", command },
        { type: "token.Revoked", reason: "ci-dry-run-complete" }
      ];

      return {
        status: "planned",
        oidcAssertionRef: stableRef(oidcAssertion),
        brokeredTokenRef: stableRef(brokeredToken),
        persistedSecrets: [],
        storedCredentials: [],
        audit
      };
    },

    loadLegacyCredentialState({ files, env }) {
      const reasons = [];
      for (const file of files) {
        if (secretLikeTestPattern.test(file.contents) || file.mode !== "0600") {
          reasons.push("legacy-plaintext-credential");
          break;
        }
      }
      if (env.HOBO_ISSUER_URL && env.HOBO_ISSUER_URL !== trustedIssuer) {
        reasons.push("untrusted-hobo-issuer-env");
      }

      return {
        status: reasons.length ? "denied" : "accepted",
        reasons,
        trusted: reasons.length === 0
      };
    },

    doctor() {
      return { findings: [...doctorFindings] };
    },

    auditEvents() {
      return [...auditLog];
    }
  };
}

export function redactCredentialMaterial(value, fieldName = "") {
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentialMaterial(item, fieldName));
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactCredentialMaterial(entry, key)])
    );
  }
  if (isJsonString(value)) {
    if (credentialFieldPattern.test(fieldName)) {
      return `<redacted:${fieldName}>`;
    }
    return redactString(value);
  }
  return value;
}

function redactString(value) {
  return value.replace(secretLikePattern, "<redacted:credential>");
}

function stableRef(value) {
  let hash = 0;
  for (const character of String(value)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
