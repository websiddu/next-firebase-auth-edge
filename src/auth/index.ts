import {debug} from '../debug/index.js';
import {
  AuthRequestHandler,
  CreateRequest,
  UpdateRequest
} from './auth-request-handler';
import {
  Credential,
  ServiceAccount,
  ServiceAccountCredential
} from './credential';
import {
  CustomTokens,
  ParsedTokens,
  VerifiedTokens
} from './custom-token/index.js';
import {getApplicationDefault} from './default-credential.js';
import {
  AuthError,
  AuthErrorCode,
  InvalidTokenError,
  InvalidTokenReason
} from './error';
import {useEmulator} from './firebase.js';
import {createFirebaseTokenGenerator} from './token-generator.js';
import {createIdTokenVerifier} from './token-verifier.js';
import {DecodedIdToken, VerifyOptions} from './types.js';
import {UserRecord} from './user-record.js';
import {filterStandardClaims} from './claims';

export * from './types.js';
export * from './error.js';

const getCustomTokenEndpoint = (apiKey: string) => {
  if (useEmulator() && process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    let protocol = 'http://';
    if (
      (process.env.FIREBASE_AUTH_EMULATOR_HOST as string).startsWith('http://')
    ) {
      protocol = '';
    }
    return `${protocol}${process.env
      .FIREBASE_AUTH_EMULATOR_HOST!}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`;
  }

  return `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`;
};

const getSignUpEndpoint = (apiKey: string) => {
  return `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`;
};

const getRefreshTokenEndpoint = (apiKey: string) => {
  if (useEmulator() && process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    let protocol = 'http://';
    if (
      (process.env.FIREBASE_AUTH_EMULATOR_HOST as string).startsWith('http://')
    ) {
      protocol = '';
    }

    return `${protocol}${process.env
      .FIREBASE_AUTH_EMULATOR_HOST!}/securetoken.googleapis.com/v1/token?key=${apiKey}`;
  }

  return `https://securetoken.googleapis.com/v1/token?key=${apiKey}`;
};

interface CustomTokenToIdAndRefreshTokensOptions {
  tenantId?: string;
  appCheckToken?: string;
  referer?: string;
}

export async function customTokenToIdAndRefreshTokens(
  customToken: string,
  firebaseApiKey: string,
  options: CustomTokenToIdAndRefreshTokensOptions
): Promise<IdAndRefreshTokens> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.referer ? {Referer: options.referer} : {})
  };

  const body: Record<string, string | boolean> = {
    token: customToken,
    returnSecureToken: true
  };

  if (options.appCheckToken) {
    headers['X-Firebase-AppCheck'] = options.appCheckToken;
  }

  if (options.tenantId) {
    body['tenantId'] = options.tenantId;
  }

  const refreshTokenResponse = await fetch(
    getCustomTokenEndpoint(firebaseApiKey),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }
  );

  const refreshTokenJSON =
    (await refreshTokenResponse.json()) as DecodedIdToken;

  if (!refreshTokenResponse.ok) {
    throw new Error(
      `Problem getting a refresh token: ${JSON.stringify(refreshTokenJSON)}`
    );
  }

  return {
    idToken: refreshTokenJSON.idToken as string,
    refreshToken: refreshTokenJSON.refreshToken as string
  };
}

export async function createAnonymousAccount(
  firebaseApiKey: string,
  options: CreateAnonymousRequest = {}
): Promise<AnonymousTokens> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.referer ? {Referer: options.referer} : {})
  };

  const body: Record<string, string | boolean> = {
    returnSecureToken: true
  };

  if (options.appCheckToken) {
    headers['X-Firebase-AppCheck'] = options.appCheckToken;
  }

  if (options.tenantId) {
    body['tenantId'] = options.tenantId;
  }

  const createResponse = await fetch(getSignUpEndpoint(firebaseApiKey), {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  return (await createResponse.json()) as AnonymousTokens;
}

interface ErrorResponse {
  error: {
    code: number;
    message: 'USER_NOT_FOUND' | 'TOKEN_EXPIRED';
    status: 'INVALID_ARGUMENT';
  };
  error_description?: string;
}

interface UserNotFoundResponse extends ErrorResponse {
  error: {
    code: 400;
    message: 'USER_NOT_FOUND';
    status: 'INVALID_ARGUMENT';
  };
}

const isUserNotFoundResponse = (
  data: unknown
): data is UserNotFoundResponse => {
  return (
    (data as UserNotFoundResponse)?.error?.code === 400 &&
    (data as UserNotFoundResponse)?.error?.message === 'USER_NOT_FOUND'
  );
};

export interface TokenRefreshOptions {
  apiKey: string;
  referer?: string;
}

const refreshExpiredIdToken = async (
  refreshToken: string,
  options: TokenRefreshOptions
): Promise<IdAndRefreshTokens> => {
  // https://firebase.google.com/docs/reference/rest/auth/#section-refresh-token
  const response = await fetch(getRefreshTokenEndpoint(options.apiKey), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(options.referer ? {Referer: options.referer} : {})
    },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`
  });

  if (!response.ok) {
    const data = await response.json();
    const errorMessage = `Error fetching access token: ${JSON.stringify(
      data.error
    )} ${data.error_description ? `(${data.error_description})` : ''}`;

    if (isUserNotFoundResponse(data)) {
      throw new AuthError(AuthErrorCode.USER_NOT_FOUND);
    }

    throw new AuthError(AuthErrorCode.INVALID_CREDENTIAL, errorMessage);
  }

  const data = await response.json();

  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token
  };
};

export function isUserNotFoundError(error: unknown): error is AuthError {
  return (error as AuthError)?.code === AuthErrorCode.USER_NOT_FOUND;
}

export function isInvalidCredentialError(error: unknown): error is AuthError {
  return (error as AuthError)?.code === AuthErrorCode.INVALID_CREDENTIAL;
}

async function handleVerifyTokenError<T>(
  e: unknown,
  onExpired: (e: AuthError) => Promise<T>,
  onError: (e: unknown) => Promise<T>
) {
  try {
    return await onExpired(e as AuthError);
  } catch (e) {
    return onError(e);
  }
}

export async function handleExpiredToken<T>(
  verifyIdToken: () => Promise<T>,
  onExpired: (e: AuthError) => Promise<T>,
  onError: (e: unknown) => Promise<T>,
  shouldExpireOnNoMatchingKidError: boolean
): Promise<T> {
  try {
    return await verifyIdToken();
  } catch (e: unknown) {
    switch ((e as AuthError)?.code) {
      case AuthErrorCode.NO_MATCHING_KID:
        if (shouldExpireOnNoMatchingKidError) {
          return handleVerifyTokenError(
            e,
            async (e) => {
              const result = await onExpired(e);

              debug(
                'experimental_refresh_on_expired_kid: Successfully refreshed token after kid has expired'
              );

              return result;
            },
            (e) => {
              debug(
                'experimental_refresh_on_expired_kid: Error when trying to refresh token after kid has expired',
                {message: (e as Error)?.message, stack: (e as Error)?.stack}
              );

              return onError(e);
            }
          );
        }

        return onError(e);
      case AuthErrorCode.TOKEN_EXPIRED:
        return handleVerifyTokenError(e, onExpired, onError);
      default:
        return onError(e);
    }
  }
}

export interface IdAndRefreshTokens {
  idToken: string;
  refreshToken: string;
}

export interface CreateAnonymousRequest {
  tenantId?: string;
  appCheckToken?: string;
  referer?: string;
}

export interface Tokens {
  decodedToken: DecodedIdToken;
  token: string;
  // Set `enableCustomToken` to true in `authMiddleware` to enable custom token
  customToken?: string;
}

export interface AnonymousTokens {
  idToken: string;
  refreshToken: string;
  localId: string;
}

export interface UsersList {
  users: UserRecord[];
  nextPageToken?: string;
}

export interface GetCustomIdAndRefreshTokensOptions {
  appCheckToken?: string;
  referer?: string;
  dynamicCustomClaimsKeys?: string[];
}

interface AuthOptions {
  credential: Credential;
  apiKey: string;
  tenantId?: string;
  serviceAccountId?: string;
  enableCustomToken?: boolean;
}

export type Auth = ReturnType<typeof getAuth>;

const DEFAULT_VERIFY_OPTIONS = {referer: ''};

function getAuth(options: AuthOptions) {
  const credential = options.credential ?? getApplicationDefault();
  const tenantId = options.tenantId;
  const authRequestHandler = new AuthRequestHandler(credential, {
    tenantId
  });
  const tokenGenerator = createFirebaseTokenGenerator(credential, tenantId);

  const handleTokenRefresh = async (
    refreshToken: string,
    tokenRefreshOptions: {referer?: string; enableCustomToken?: boolean} = {}
  ): Promise<VerifiedTokens> => {
    const {idToken, refreshToken: newRefreshToken} =
      await refreshExpiredIdToken(refreshToken, {
        apiKey: options.apiKey,
        referer: tokenRefreshOptions.referer
      });

    const decodedIdToken = await verifyIdToken(idToken, {
      referer: tokenRefreshOptions.referer
    });

    if (!tokenRefreshOptions.enableCustomToken) {
      return {
        decodedIdToken,
        idToken,
        refreshToken: newRefreshToken
      };
    }

    const customToken = await createCustomToken(decodedIdToken.uid, {
      email_verified: decodedIdToken.email_verified,
      source_sign_in_provider: decodedIdToken.firebase.sign_in_provider
    });

    return {
      decodedIdToken,
      idToken,
      refreshToken: newRefreshToken,
      customToken
    };
  };

  async function createSessionCookie(
    idToken: string,
    expiresInMs: number
  ): Promise<string> {
    // Verify tenant ID before creating session cookie
    if (tenantId) {
      await verifyIdToken(idToken);
    }

    return authRequestHandler.createSessionCookie(idToken, expiresInMs);
  }

  async function getUser(uid: string): Promise<UserRecord | null> {
    return authRequestHandler.getAccountInfoByUid(uid).then((response) => {
      return response.users?.length ? new UserRecord(response.users[0]) : null;
    });
  }

  async function listUsers(
    nextPageToken?: string,
    maxResults?: number
  ): Promise<UsersList> {
    return authRequestHandler
      .listUsers(nextPageToken, maxResults)
      .then((response) => {
        const result: UsersList = {
          users: response.users.map((user) => new UserRecord(user))
        };

        if (response.nextPageToken) {
          result.nextPageToken = response.nextPageToken;
        }

        return result;
      });
  }

  async function getUserByEmail(email: string): Promise<UserRecord> {
    return authRequestHandler.getAccountInfoByEmail(email).then((response) => {
      if (!response.users || !response.users.length) {
        throw new AuthError(AuthErrorCode.USER_NOT_FOUND);
      }

      return new UserRecord(response.users[0]);
    });
  }

  async function verifyDecodedJWTNotRevokedOrDisabled(
    decodedIdToken: DecodedIdToken
  ): Promise<DecodedIdToken> {
    return getUser(decodedIdToken.sub).then((user: UserRecord | null) => {
      if (!user) {
        throw new AuthError(AuthErrorCode.USER_NOT_FOUND);
      }

      if (user.disabled) {
        throw new AuthError(AuthErrorCode.USER_DISABLED);
      }

      if (user.tokensValidAfterTime) {
        const authTimeUtc = decodedIdToken.auth_time * 1000;
        const validSinceUtc = new Date(user.tokensValidAfterTime).getTime();
        if (authTimeUtc < validSinceUtc) {
          throw new AuthError(AuthErrorCode.TOKEN_REVOKED);
        }
      }

      return decodedIdToken;
    });
  }

  async function verifyIdToken(
    idToken: string,
    options: VerifyOptions = DEFAULT_VERIFY_OPTIONS
  ): Promise<DecodedIdToken> {
    const projectId = await credential.getProjectId();
    const idTokenVerifier = createIdTokenVerifier(projectId, tenantId);
    const decodedIdToken = await idTokenVerifier.verifyJWT(idToken, options);
    const checkRevoked = options.checkRevoked ?? false;

    if (checkRevoked) {
      return verifyDecodedJWTNotRevokedOrDisabled(decodedIdToken);
    }

    return decodedIdToken;
  }

  async function verifyAndRefreshExpiredIdToken(
    parsedTokens: ParsedTokens,
    verifyOptions: VerifyOptions & {
      onTokenRefresh?: (tokens: VerifiedTokens) => Promise<void>;
    } = DEFAULT_VERIFY_OPTIONS
  ): Promise<VerifiedTokens> {
    return await handleExpiredToken(
      async () => {
        const decodedIdToken = await verifyIdToken(
          parsedTokens.idToken,
          verifyOptions
        );
        return {
          idToken: parsedTokens.idToken,
          decodedIdToken,
          refreshToken: parsedTokens.refreshToken,
          customToken: parsedTokens.customToken
        };
      },
      async () => {
        if (parsedTokens.refreshToken) {
          const result = await handleTokenRefresh(parsedTokens.refreshToken, {
            referer: verifyOptions.referer,
            enableCustomToken: options.enableCustomToken
          });

          await verifyOptions.onTokenRefresh?.(result);

          return result;
        }

        throw new InvalidTokenError(InvalidTokenReason.MISSING_REFRESH_TOKEN);
      },
      async (e) => {
        if (
          e instanceof AuthError &&
          e.code === AuthErrorCode.NO_MATCHING_KID
        ) {
          throw InvalidTokenError.fromError(e, InvalidTokenReason.INVALID_KID);
        }

        throw InvalidTokenError.fromError(
          e,
          InvalidTokenReason.INVALID_CREDENTIALS
        );
      },
      verifyOptions.experimental_enableTokenRefreshOnExpiredKidHeader ?? false
    );
  }

  function createCustomToken(
    uid: string,
    developerClaims?: {[key: string]: unknown}
  ): Promise<string> {
    return tokenGenerator.createCustomToken(uid, developerClaims);
  }

  async function getCustomIdAndRefreshTokens(
    idToken: string,
    customTokensOptions: GetCustomIdAndRefreshTokensOptions = DEFAULT_VERIFY_OPTIONS
  ): Promise<CustomTokens> {
    const decodedToken = await verifyIdToken(idToken, {
      referer: customTokensOptions.referer
    });

    const customClaims = filterStandardClaims(decodedToken);

    if (customTokensOptions.dynamicCustomClaimsKeys?.length) {
      customTokensOptions.dynamicCustomClaimsKeys.forEach((key) => {
        delete customClaims[key];
      });
    }

    const customToken = await createCustomToken(decodedToken.uid, {
      ...customClaims,
      email_verified: decodedToken.email_verified,
      source_sign_in_provider: decodedToken.firebase.sign_in_provider
    });

    debug('Generated custom token based on provided idToken', {customToken});

    const idAndRefreshTokens = await customTokenToIdAndRefreshTokens(
      customToken,
      options.apiKey,
      {
        tenantId: options.tenantId,
        appCheckToken: customTokensOptions.appCheckToken,
        referer: customTokensOptions.referer
      }
    );

    return {
      ...idAndRefreshTokens,
      customToken
    };
  }

  async function deleteUser(uid: string): Promise<void> {
    await authRequestHandler.deleteAccount(uid);
  }

  async function setCustomUserClaims(
    uid: string,
    customUserClaims: object | null
  ) {
    await authRequestHandler.setCustomUserClaims(uid, customUserClaims);
  }

  async function createUser(properties: CreateRequest): Promise<UserRecord> {
    return authRequestHandler
      .createNewAccount(properties)
      .then((uid) => getUser(uid))
      .then((user) => {
        if (!user) {
          throw new AuthError(
            AuthErrorCode.INTERNAL_ERROR,
            'Could not get recently created user from database. Most likely it was deleted.'
          );
        }
        return user;
      });
  }

  async function createAnonymousUser(
    firebaseApiKey: string
  ): Promise<AnonymousTokens> {
    return createAnonymousAccount(firebaseApiKey);
  }

  async function updateUser(
    uid: string,
    properties: UpdateRequest
  ): Promise<UserRecord> {
    return authRequestHandler
      .updateExistingAccount(uid, properties)
      .then((existingUid) => getUser(existingUid))
      .then((user) => {
        if (!user) {
          throw new AuthError(
            AuthErrorCode.INTERNAL_ERROR,
            'Could not get recently updated user from database. Most likely it was deleted.'
          );
        }

        return user;
      });
  }

  return {
    verifyAndRefreshExpiredIdToken,
    verifyIdToken,
    createCustomToken,
    getCustomIdAndRefreshTokens,
    handleTokenRefresh,
    deleteUser,
    setCustomUserClaims,
    getUser,
    getUserByEmail,
    updateUser,
    createUser,
    createAnonymousUser,
    listUsers,
    createSessionCookie
  };
}

function isFirebaseAuthOptions(
  options: FirebaseAuthOptions | ServiceAccount
): options is FirebaseAuthOptions {
  const serviceAccount = options as ServiceAccount;

  return (
    !serviceAccount.privateKey ||
    !serviceAccount.projectId ||
    !serviceAccount.clientEmail
  );
}

export interface FirebaseAuthOptions {
  serviceAccount?: ServiceAccount;
  apiKey: string;
  tenantId?: string;
  serviceAccountId?: string;
  enableCustomToken?: boolean;
}
export function getFirebaseAuth(options: FirebaseAuthOptions): Auth;
/** @deprecated Use `FirebaseAuthOptions` configuration object instead */
export function getFirebaseAuth(
  serviceAccount: ServiceAccount,
  apiKey: string,
  tenantId?: string
): Auth;
export function getFirebaseAuth(
  serviceAccount: ServiceAccount | FirebaseAuthOptions,
  apiKey?: string,
  tenantId?: string
): Auth {
  if (!isFirebaseAuthOptions(serviceAccount)) {
    const credential = new ServiceAccountCredential(serviceAccount);

    return getAuth({credential, apiKey: apiKey!, tenantId});
  }

  const options = serviceAccount;

  return getAuth({
    credential: options.serviceAccount
      ? new ServiceAccountCredential(options.serviceAccount)
      : getApplicationDefault(),
    apiKey: options.apiKey,
    tenantId: options.tenantId,
    serviceAccountId: options.serviceAccountId,
    enableCustomToken: options.enableCustomToken
  });
}
