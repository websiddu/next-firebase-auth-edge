import { getFirebaseAuth, IdAndRefreshTokens } from "../auth";
import { ServiceAccount } from "../auth/credential";
import { sign, SignedCookies } from "../auth/cookies/sign";
import { CookieSerializeOptions, serialize } from "cookie";
import { NextRequest, NextResponse } from "next/server";
import { getSignatureCookieName } from "../auth/cookies";
import { NextApiResponse } from "next";
import { RequestCookies } from "next/dist/server/web/spec-extension/cookies";
import { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { AuthError, AuthErrorCode } from "../auth/error";

export interface SetAuthCookiesOptions {
  cookieName: string;
  cookieSignatureKeys: string[];
  cookieSerializeOptions: CookieSerializeOptions;
  serviceAccount: ServiceAccount;
  apiKey: string;
  tenantId?: string;
}

export type CookiesObject = Partial<{ [K in string]: string }>;

const INTERNAL_VERIFIED_TOKEN_COOKIE_NAME =
  "x-next-firebase-auth-edge-verified";
const INTERNAL_VERIFIED_TOKEN_COOKIE_VALUE = "true";

export function validateMiddlewareRequestCookies(
  cookies: RequestCookies | ReadonlyRequestCookies
) {
  if (cookies.get(INTERNAL_VERIFIED_TOKEN_COOKIE_NAME)?.value) {
    throw new AuthError(
      AuthErrorCode.INVALID_ARGUMENT,
      `Looks like you're calling Next.js Middleware with cookie reserved for internal use. Please remove ${INTERNAL_VERIFIED_TOKEN_COOKIE_NAME} from request cookies.`
    );
  }
}

export function markCookiesAsVerified(
  cookies: RequestCookies | ReadonlyRequestCookies
) {
  cookies.set(
    INTERNAL_VERIFIED_TOKEN_COOKIE_NAME,
    INTERNAL_VERIFIED_TOKEN_COOKIE_VALUE
  );
}

export function wasResponseDecoratedWithModifiedRequestHeaders(
  response: NextResponse
) {
  return (
    response.headers
      .get("x-middleware-request-cookie")
      ?.includes(INTERNAL_VERIFIED_TOKEN_COOKIE_NAME) ?? false
  );
}

export function areCookiesVerifiedByMiddleware(
  cookies: RequestCookies | ReadonlyRequestCookies
) {
  return (
    cookies.get(INTERNAL_VERIFIED_TOKEN_COOKIE_NAME)?.value ===
    INTERNAL_VERIFIED_TOKEN_COOKIE_VALUE
  );
}

export function isCookiesObjectVerifiedByMiddleware(cookies: CookiesObject) {
  return (
    cookies[INTERNAL_VERIFIED_TOKEN_COOKIE_NAME] ===
    INTERNAL_VERIFIED_TOKEN_COOKIE_VALUE
  );
}

export async function appendAuthCookiesApi(
  response: NextApiResponse,
  tokens: IdAndRefreshTokens,
  options: SetAuthCookiesOptions
) {
  const value = JSON.stringify(tokens);
  const signedCookie = await sign(options.cookieSignatureKeys)({
    name: options.cookieName,
    value,
  });

  response.setHeader("Set-Cookie", [
    serialize(
      signedCookie.signature.name,
      signedCookie.signature.value,
      options.cookieSerializeOptions
    ),
    serialize(
      signedCookie.signed.name,
      signedCookie.signed.value,
      options.cookieSerializeOptions
    ),
  ]);
}

export function updateRequestAuthCookies(
  request: NextRequest,
  cookies: SignedCookies
) {
  request.cookies.set(cookies.signed.name, cookies.signed.value);
  request.cookies.set(cookies.signature.name, cookies.signature.value);
}

export function updateResponseAuthCookies(
  response: NextResponse,
  cookies: SignedCookies,
  options: CookieSerializeOptions
) {
  response.headers.append(
    "Set-Cookie",
    serialize(cookies.signature.name, cookies.signature.value, options)
  );

  response.headers.append(
    "Set-Cookie",
    serialize(cookies.signed.name, cookies.signed.value, options)
  );

  return response;
}

export function toSignedCookies(
  tokens: IdAndRefreshTokens,
  options: SetAuthCookiesOptions
) {
  const value = JSON.stringify(tokens);

  return sign(options.cookieSignatureKeys)({
    name: options.cookieName,
    value,
  });
}

export async function appendAuthCookies(
  response: NextResponse,
  tokens: IdAndRefreshTokens,
  options: SetAuthCookiesOptions
) {
  const signedCookies = await toSignedCookies(tokens, options);

  return updateResponseAuthCookies(
    response,
    signedCookies,
    options.cookieSerializeOptions
  );
}

export async function refreshAuthCookies(
  idToken: string,
  response: NextApiResponse,
  options: SetAuthCookiesOptions
): Promise<IdAndRefreshTokens> {
  const { getCustomIdAndRefreshTokens } = getFirebaseAuth(
    options.serviceAccount,
    options.apiKey
  );
  const idAndRefreshTokens = await getCustomIdAndRefreshTokens(
    idToken,
    options.apiKey
  );

  await appendAuthCookiesApi(response, idAndRefreshTokens, options);

  return idAndRefreshTokens;
}

export async function setAuthCookies(
  headers: Headers,
  options: SetAuthCookiesOptions
): Promise<NextResponse> {
  const { getCustomIdAndRefreshTokens } = getFirebaseAuth(
    options.serviceAccount,
    options.apiKey,
    options.tenantId
  );
  const token = headers.get("Authorization")?.split(" ")[1] ?? "";
  const idAndRefreshTokens = await getCustomIdAndRefreshTokens(
    token,
    options.apiKey
  );

  const response = new NextResponse(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  return appendAuthCookies(response, idAndRefreshTokens, options);
}

export interface RemoveAuthCookiesOptions {
  cookieName: string;
  cookieSerializeOptions: CookieSerializeOptions;
}

export function removeAuthCookies(
  headers: Headers,
  options: RemoveAuthCookiesOptions
): NextResponse {
  const response = new NextResponse(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const { maxAge, expires, ...cookieOptions } = options.cookieSerializeOptions;

  response.headers.append(
    "Set-Cookie",
    serialize(options.cookieName, "", {
      ...cookieOptions,
      expires: new Date(0),
    })
  );

  response.headers.append(
    "Set-Cookie",
    serialize(getSignatureCookieName(options.cookieName), "", {
      ...cookieOptions,
      expires: new Date(0),
    })
  );

  return response;
}
