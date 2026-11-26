package provider_vercel

#VercelAnonymousDeploymentEvidenceRecord: {
 projectName: string & !=""
 deploymentId: string & !=""
 stationUrl: =~"^https://[A-Za-z0-9-]+\\.vercel\\.app(?:/[^?#]*)?$"
 claimUrl: =~"^https://vercel\\.com/claim-deployment\\?(?:[^&#]+&)*code=[^&#]+(?:&[^#]*)?$"
 anonymous: true
 expiresAt: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$"
 expirySource: "provider-reported"
}
