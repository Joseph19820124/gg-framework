import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

// Google OAuth2 credentials for Gemini CLI (installed application).
// These are the same public credentials used by the official Gemini CLI.
// Ref: https://developers.google.com/identity/protocols/oauth2#installed
// "In this context, the client secret is obviously not treated as a secret."
const CLIENT_ID = atob(
  "NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xl" +
    "dXNlcmNvbnRlbnQuY29t",
);
const CLIENT_SECRET = atob("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=");

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_URI = "https://codeassist.google.com/authcode";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

/**
 * Authenticate with Google via OAuth2 Authorization Code + PKCE flow.
 * Opens the browser for the user to sign in, then they paste back the code.
 */
export async function loginGemini(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    access_type: "offline",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${AUTHORIZE_URL}?${params}`;
  callbacks.onOpenUrl(authUrl);
  callbacks.onStatus("Opening browser for Google sign-in...");

  const raw = await callbacks.onPromptCode("Paste the authorization code from the browser:");

  const code = raw.trim();
  if (!code) {
    throw new Error("No authorization code provided. Login cancelled.");
  }

  return exchangeGeminiCode(code, verifier);
}

async function exchangeGeminiCode(code: string, verifier: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  if (!data.access_token) {
    throw new Error("No access token received from Google.");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

/**
 * Refresh a Google OAuth2 access token using a refresh token.
 */
export async function refreshGeminiToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}
