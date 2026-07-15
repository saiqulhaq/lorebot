import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import {
  fetchInstallationToken,
  makeTokenProvider,
  openOrUpdatePullRequest,
  redactSecrets,
  signAppJwt,
  tokenRemote,
} from "../../src/sync/github-app"

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()

const credentials = { appId: "12345", installationId: "678", privateKeyPem: pem }

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (url: any, init?: any) => handler(String(url), init)) as typeof fetch
}

function tokenResponse(token: string, expiresInMs: number, now = Date.now()): Response {
  return new Response(JSON.stringify({ token, expires_at: new Date(now + expiresInMs).toISOString() }), {
    status: 201,
  })
}

describe("signAppJwt", () => {
  test("produces a verifiable RS256 JWT with the expected claims", () => {
    const now = 1_800_000_000
    const jwt = signAppJwt("12345", pem, now)
    const [headerB64, payloadB64, signatureB64] = jwt.split(".")
    expect(headerB64).toBeDefined()

    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString())
    expect(header).toEqual({ alg: "RS256", typ: "JWT" })

    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString())
    expect(payload).toEqual({ iat: now - 60, exp: now + 540, iss: "12345" })

    const verified = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      publicKey,
      Buffer.from(signatureB64!, "base64url"),
    )
    expect(verified).toBe(true)
  })
})

describe("fetchInstallationToken", () => {
  test("posts to the installation endpoint with a bearer JWT", async () => {
    let seenUrl = ""
    let seenAuth = ""
    const result = await fetchInstallationToken(
      credentials,
      fakeFetch((url, init) => {
        seenUrl = url
        seenAuth = new Headers(init?.headers).get("authorization") ?? ""
        return tokenResponse("ghs_test", 3_600_000)
      }),
    )
    expect(seenUrl).toBe("https://api.github.com/app/installations/678/access_tokens")
    expect(seenAuth).toStartWith("Bearer eyJ")
    expect(result.token).toBe("ghs_test")
    expect(result.expiresAt).toBeGreaterThan(Date.now())
  })

  test("throws with status on failure", async () => {
    expect(
      fetchInstallationToken(credentials, fakeFetch(() => new Response("nope", { status: 401 }))),
    ).rejects.toThrow("401")
  })
})

describe("makeTokenProvider", () => {
  test("caches, refreshes near expiry, and invalidates", async () => {
    let clock = 1_800_000_000_000
    let calls = 0
    const provider = makeTokenProvider(
      credentials,
      fakeFetch(() => {
        calls++
        return tokenResponse(`ghs_${calls}`, 3_600_000, clock)
      }),
      () => clock,
    )

    expect(await provider.getToken()).toBe("ghs_1")
    expect(await provider.getToken()).toBe("ghs_1") // cached
    expect(calls).toBe(1)

    clock += 55 * 60 * 1000 // inside the 10-minute refresh margin
    expect(await provider.getToken()).toBe("ghs_2")

    provider.invalidate()
    expect(await provider.getToken()).toBe("ghs_3")
    expect(calls).toBe(3)
  })
})

describe("redactSecrets / tokenRemote", () => {
  test("scrubs tokens from git error output", () => {
    const remote = tokenRemote("org/app", "ghs_supersecret")
    const error = `fatal: unable to access '${remote}': 403`
    expect(redactSecrets(error)).toBe("fatal: unable to access 'https://x-access-token:***@github.com/org/app.git': 403")
    expect(redactSecrets(error)).not.toContain("ghs_supersecret")
  })
})

describe("openOrUpdatePullRequest", () => {
  const options = {
    repo: "org/app",
    head: "lorebot/graphify-sync",
    base: "main",
    title: "t",
    body: "b",
    token: "ghs_x",
  }

  test("creates a new PR", async () => {
    const result = await openOrUpdatePullRequest({
      ...options,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ html_url: "https://pr/1" }), { status: 201 })),
    })
    expect(result).toEqual({ url: "https://pr/1", created: true })
  })

  test("falls back to the existing open PR on 422", async () => {
    const result = await openOrUpdatePullRequest({
      ...options,
      fetchImpl: fakeFetch((url, init) => {
        if (init?.method === "POST") return new Response("already exists", { status: 422 })
        expect(url).toContain("head=org:lorebot/graphify-sync")
        return new Response(JSON.stringify([{ html_url: "https://pr/7" }]), { status: 200 })
      }),
    })
    expect(result).toEqual({ url: "https://pr/7", created: false })
  })
})
