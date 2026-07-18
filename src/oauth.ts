export interface OAuthClientConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
}

export class OAuthInvalidGrantError extends Error {
  constructor(provider: string) {
    super(
      `OAuth refresh token for "${provider}" was rejected (invalid_grant). ` +
        `Re-run the auth CLI to consent again.`,
    );
    this.name = 'OAuthInvalidGrantError';
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

async function requestToken(
  config: OAuthClientConfig,
  provider: string,
  params: Record<string, string>,
): Promise<TokenPair> {
  const basic = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString('base64');
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 400 || response.status === 401) {
      if (body.includes('invalid_grant')) {
        throw new OAuthInvalidGrantError(provider);
      }
    }
    throw new Error(
      `Token request for "${provider}" failed (${String(response.status)}): ${body}`,
    );
  }

  const data = (await response.json()) as TokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:
      data.expires_in === undefined
        ? null
        : new Date(Date.now() + data.expires_in * 1000),
  };
}

export async function exchangeCode(
  config: OAuthClientConfig,
  provider: string,
  code: string,
  redirectUri: string,
): Promise<TokenPair> {
  return requestToken(config, provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
}

export async function refreshTokenPair(
  config: OAuthClientConfig,
  provider: string,
  refreshToken: string,
): Promise<TokenPair> {
  return requestToken(config, provider, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}
