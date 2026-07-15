/**
 * GitHub App authentication with zero dependencies: an RS256 app JWT is
 * exchanged for a short-lived installation access token, which authorizes
 * git pushes and REST calls on the repos the app is installed on.
 */

import crypto from "node:crypto"

export type AppCredentials = {
  appId: string
  installationId: string
  privateKeyPem: string
}

/** Mint the app-level JWT GitHub expects: iat backdated 60s, 9min expiry. */
export function signAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: appId,
  })}`
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem).toString("base64url")
  return `${signingInput}.${signature}`
}

export type InstallationToken = {
  token: string
  /** Epoch ms. GitHub tokens live ~1 hour. */
  expiresAt: number
}

export async function fetchInstallationToken(
  credentials: AppCredentials,
  fetchImpl: typeof fetch = fetch,
  nowSeconds?: number,
): Promise<InstallationToken> {
  const jwt = signAppJwt(credentials.appId, credentials.privateKeyPem, nowSeconds)
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${credentials.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "lorebot",
      },
    },
  )
  if (response.status !== 201) {
    const body = await response.text().catch(() => "")
    throw new Error(`GitHub installation token request failed (${response.status}): ${body.slice(0, 300)}`)
  }
  const data = (await response.json()) as { token: string; expires_at: string }
  return { token: data.token, expiresAt: Date.parse(data.expires_at) }
}

export type TokenProvider = {
  getToken(): Promise<string>
  /** Drop the cached token (call after an auth failure) so the next getToken refetches. */
  invalidate(): void
}

const REFRESH_MARGIN_MS = 10 * 60 * 1000

export function makeTokenProvider(
  credentials: AppCredentials,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): TokenProvider {
  let cached: InstallationToken | undefined
  return {
    async getToken() {
      if (!cached || cached.expiresAt - now() < REFRESH_MARGIN_MS) {
        cached = await fetchInstallationToken(credentials, fetchImpl, Math.floor(now() / 1000))
      }
      return cached.token
    },
    invalidate() {
      cached = undefined
    },
  }
}

/** Authenticated remote URL. Passed as a git argument, never written to .git/config. */
export function tokenRemote(repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`
}

/** Scrub installation tokens from text (git prints remote URLs in errors). */
export function redactSecrets(text: string): string {
  return text.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@")
}

/**
 * Open a PR for the sync branch, or return the existing open one (the
 * force-push that preceded this call already updated its contents).
 */
export async function openOrUpdatePullRequest(options: {
  repo: string
  head: string
  base: string
  title: string
  body: string
  token: string
  fetchImpl?: typeof fetch
}): Promise<{ url: string; created: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "lorebot",
    "content-type": "application/json",
  }

  const create = await fetchImpl(`https://api.github.com/repos/${options.repo}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: options.title, body: options.body, head: options.head, base: options.base }),
  })
  if (create.status === 201) {
    const data = (await create.json()) as { html_url: string }
    return { url: data.html_url, created: true }
  }
  if (create.status === 422) {
    // A PR for this head already exists; find and reuse it.
    const org = options.repo.split("/")[0]
    const list = await fetchImpl(
      `https://api.github.com/repos/${options.repo}/pulls?state=open&head=${org}:${options.head}`,
      { headers },
    )
    if (list.ok) {
      const pulls = (await list.json()) as Array<{ html_url: string }>
      if (pulls[0]) return { url: pulls[0].html_url, created: false }
    }
  }
  const body = await create.text().catch(() => "")
  throw new Error(`GitHub PR request failed (${create.status}): ${body.slice(0, 300)}`)
}
