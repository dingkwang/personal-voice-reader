import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { appOrigin, issuer, ownerSubject, required, validateResourceIdentity } from "./config";
import { AppError } from "./errors";

export type Scope = "read:voices" | "create:readings" | "read:readings";
let client: Auth0Client | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
export function auth0() {
  required("AUTH0_SECRET");
  required("AUTH0_CLIENT_ID");
  required("AUTH0_CLIENT_SECRET");
  client ??= new Auth0Client({
    domain: new URL(issuer()).hostname,
    appBaseUrl: appOrigin(),
    session: { rolling: false, absoluteDuration: 60 * 60 * 12 },
    enableAccessTokenEndpoint: false,
    includeIdTokenHintInOIDCLogoutUrl: false,
    authorizationParameters: { scope: "openid profile" },
    beforeSessionSaved: async (session) => {
      if (session.user.sub !== ownerSubject()) throw new AppError("仅限拥有者登录", 403, "FORBIDDEN");
      return session;
    },
  });
  return client;
}

export function assertCsrf(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.get("origin") !== appOrigin() ||
    request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AppError("请求来源验证失败", 403, "CSRF_REJECTED");
  }
}
export function assertTokenClaims(payload: JWTPayload, scope?: Scope) {
  if (payload.sub !== ownerSubject() || payload.azp !== required("AUTH0_MCP_CLIENT_ID") ||
    typeof payload.exp !== "number") throw new AppError("无权访问", 403, "FORBIDDEN");
  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
  if (scope && !scopes.includes(scope)) throw new AppError("授权范围不足", 403, "INSUFFICIENT_SCOPE");
  return { owner: payload.sub, scopes };
}
export async function requireOAuth(request: Request, scope?: Scope) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new AppError("需要 OAuth 登录", 401, "UNAUTHORIZED");
  let payload: JWTPayload;
  try {
    jwks ??= createRemoteJWKSet(new URL(".well-known/jwks.json", issuer()));
    ({ payload } = await jwtVerify(authorization.slice(7), jwks, {
      issuer: issuer(), audience: required("AUTH0_AUDIENCE"), algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat", "azp"],
    }));
  } catch {
    throw new AppError("OAuth 令牌无效或已过期", 401, "UNAUTHORIZED");
  }
  const result = assertTokenClaims(payload, scope);
  await validateResourceIdentity();
  return result;
}
export async function requireOwner(request?: Request) {
  // Browser routes never accept OAuth tokens. The MCP boundary is separate.
  if (request) assertCsrf(request);
  const session = await auth0().getSession();
  if (!session) throw new AppError("请先登录", 401, "UNAUTHORIZED");
  if (session.user.sub !== ownerSubject()) throw new AppError("无权访问", 403, "FORBIDDEN");
  await validateResourceIdentity();
  return session.user.sub;
}
