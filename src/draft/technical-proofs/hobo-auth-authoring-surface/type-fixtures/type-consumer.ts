import type {
  AuthGeneratedSurface,
  AuthProviderDeclaration,
  PrincipalRef,
} from "@hobo/auth-authoring-surface-contract";

type Providers = [
  AuthProviderDeclaration<"google", "oidc">,
  AuthProviderDeclaration<"shoo", "customJwt">,
  AuthProviderDeclaration<"builtin", "builtin">,
];

type Claims = {
  sub: string;
  email: string;
  tenant: string;
  plan: "free" | "pro";
};

declare const surface: AuthGeneratedSurface<Providers, Claims, "tenant">;

surface.signIn("google");
surface.signIn("shoo");
surface.signIn("builtin");
// @ts-expect-error unknown providers are not part of the generated surface
surface.signIn("github");

const authState = surface.useAuth();
if (authState.status === "authenticated") {
  const userId: string = authState.user.id;
  const plan: "free" | "pro" = authState.user.claims.plan;
  const tenant: string = authState.user.tenant.app;
  userId satisfies string;
  plan satisfies "free" | "pro";
  tenant satisfies string;
}

const serverUser: PrincipalRef<Claims, "tenant"> = surface.ctx.user;
serverUser.claims.email satisfies string;
serverUser.tenant.claim satisfies "tenant";
surface.ctx.tenant.unresolved satisfies "fail-closed";
