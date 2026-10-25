export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AuthTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
  expires_in?: number | null;
  token_type?: string | null;
};

export type PendingOAuth = {
  state: string;
  nonce: string;
  code_verifier: string;
  code_challenge: string;
  code_challenge_method: "S256";
  redirect_uri: string;
  created_at: string;
};

export type LastAuthError = {
  code: string;
  message: string;
  relogin_required: boolean;
  at: string;
};

export type AuthFile = {
  version: 1;
  provider: string;
  auth_mode: string;
  session_id?: string;
  base_url: string;
  tokens: AuthTokens;
  discovery: {
    authorization_endpoint: string;
    token_endpoint: string;
  };
  redirect_uri: string;
  last_refresh: string | null;
  last_auth_error: LastAuthError | null;
  pending_oauth: PendingOAuth | null;
  profile: { email?: string; sub?: string; picture?: string } | null;
};
