import { describe, expect, it } from "vitest";
import {
  MAX_SLEEP_SECONDS,
  normalizeApiUrl,
  parseRetryAfter,
  resolveVerificationUrl,
  restoreDeviceCredential,
  runDeviceLogin,
} from "../src/auth/device-auth.js";
import { DEVICE_AUTH_ACCOUNT, DEVICE_AUTH_SERVICE } from "../src/constants.js";
import type { CredentialStore } from "../src/auth/credential-store.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function startData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      deviceCode: "device_code_1234567890",
      userCode: "ABCD-EFGH",
      verificationUrl: "/device",
      expiresIn: 600,
      interval: 5,
      userCodeExpiresIn: 600,
      scopes: ["device:read", "device:write", "presence:read", "messages:read", "messages:write"],
      ...overrides,
    },
  };
}

function tokenData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      accessToken: "opaque_access_token_0123456789",
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "device:read device:write presence:read messages:read messages:write",
      organizationId: "org_1",
      userId: "user_1",
      deviceId: "device_1",
      ...overrides,
    },
  };
}

function errorData(code: string, message: string, retryAfter?: string): { status: number; body: unknown; headers: Record<string, string> } {
  return { status: 400, body: { error: { code, message } }, headers: retryAfter ? { "retry-after": retryAfter } : {} };
}

function makeStore(): CredentialStore & { saved: string[]; deleted: string[] } {
  const saved: string[] = [];
  const deleted: string[] = [];
  return {
    saved,
    deleted,
    async save(_service, _account, secret) { saved.push(secret); await Promise.resolve(); },
    async read() { await Promise.resolve(); return null; },
    async delete() { deleted.push("deleted"); await Promise.resolve(); },
  };
}

function makeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

function makeSleep(clock: ReturnType<typeof makeClock>) {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => { slept.push(ms); clock.advance(ms); await Promise.resolve(); },
  };
}

describe("device auth client", () => {
  it("rejects insecure non-loopback URLs before a request", () => {
    expect(() => normalizeApiUrl("http://api.example.test")).toThrow(/HTTPS/u);
    expect(() => normalizeApiUrl("https://user:pass@api.example.test")).toThrow(/credentials/u);
    expect(normalizeApiUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    expect(normalizeApiUrl("https://pinboard-backend-4p35sr23vq-uc.a.run.app/")).toBe("https://pinboard-backend-4p35sr23vq-uc.a.run.app");
  });

  it("resolves a same-origin verification path against the API origin", () => {
    expect(resolveVerificationUrl("https://pinboard-backend-4p35sr23vq-uc.a.run.app", "/device")).toBe("https://pinboard-backend-4p35sr23vq-uc.a.run.app/device");
    expect(resolveVerificationUrl("https://pinboard-backend-4p35sr23vq-uc.a.run.app", "https://usepinboard.com/device")).toBe("https://usepinboard.com/device");
    expect(() => resolveVerificationUrl("https://pinboard-backend-4p35sr23vq-uc.a.run.app", "//evil.test")).toThrow(/invalid verification URL/u);
  });
});

describe("device login flow", () => {
  it("shows the code, opens the browser, polls pending to success, and stores the token without printing it", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const shown: Array<{ url: string; code: string }> = [];
    let opened = 0;
    let polls = 0;
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(400, errorData("AUTHORIZATION_PENDING", "pending").body, { "retry-after": "5" }),
      jsonResponse(200, tokenData()),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      if (response.status === 400) polls += 1;
      return Promise.resolve(response);
    };
    const result = await runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
      openBrowser: () => Promise.resolve((opened += 1, true)),
      onShow: (url, code) => { shown.push({ url, code }); },
    });
    expect(shown[0]).toEqual({ url: "https://pinboard-backend-4p35sr23vq-uc.a.run.app/device", code: "ABCD-EFGH" });
    expect(opened).toBe(1);
    expect(polls).toBe(1);
    expect(sleep.slept).toEqual([5000]);
    expect(store.saved).toEqual(["opaque_access_token_0123456789"]);
    expect(result.organizationId).toBe("org_1");
    expect(result.accessToken).toBe("opaque_access_token_0123456789");
  });

  it("honors slow_down by extending the interval and retrying", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(400, errorData("SLOW_DOWN", "too fast", "10").body, { "retry-after": "10" }),
      jsonResponse(200, tokenData()),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    const result = await runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    });
    expect(sleep.slept).toEqual([10000]);
    expect(result.accessToken).toBe("opaque_access_token_0123456789");
  });

  it("fails closed on denial", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(400, errorData("ACCESS_DENIED", "denied").body),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    await expect(runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(store.saved).toEqual([]);
  });

  it("fails closed on expiry", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(400, errorData("EXPIRED_TOKEN", "expired").body),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    await expect(runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    })).rejects.toMatchObject({ code: "EXPIRED_TOKEN" });
    expect(store.saved).toEqual([]);
  });

  it("fails closed when the approval window expires while polling", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const responses: Response[] = [
      jsonResponse(200, startData({ expiresIn: 1, interval: 1 })),
      jsonResponse(400, errorData("AUTHORIZATION_PENDING", "pending").body, { "retry-after": "1" }),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    await expect(runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    })).rejects.toMatchObject({ code: "EXPIRED_TOKEN" });
    expect(store.saved).toEqual([]);
  });

  it("honours cancellation (Ctrl-C) without storing a token", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    let cancelled = false;
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(400, errorData("AUTHORIZATION_PENDING", "pending").body, { "retry-after": "5" }),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    const promise = runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
      isCancelled: () => cancelled,
    });
    cancelled = true;
    await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(store.saved).toEqual([]);
  });

  it("retries transient network errors on poll", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return Promise.resolve(jsonResponse(200, startData()));
      if (calls === 2) return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve(jsonResponse(200, tokenData()));
    };
    const result = await runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    });
    expect(calls).toBe(3);
    expect(result.accessToken).toBe("opaque_access_token_0123456789");
  });

  it("retries rate-limited polls honoring retry-after", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(429, errorData("RATE_LIMITED", "slow down", "60").body, { "retry-after": "60" }),
      jsonResponse(200, tokenData()),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    const result = await runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    });
    expect(sleep.slept).toEqual([60000]);
    expect(result.accessToken).toBe("opaque_access_token_0123456789");
  });

  it("fails closed when the credential store cannot persist the token", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store: CredentialStore = {
      save() { return Promise.reject(new Error("keychain unavailable")); },
      async read() { await Promise.resolve(); return null; },
      async delete() { await Promise.resolve(); },
    };
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(200, tokenData()),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    await expect(runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    })).rejects.toThrow(/keychain unavailable/u);
  });

  it("never discloses the token in error text", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(400, errorData("ACCESS_DENIED", "denied").body),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    const error = await runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    }).catch((failure: unknown) => failure);
    expect(JSON.stringify(error)).not.toContain("opaque_access_token_0123456789");
  });

  it("does not re-print the code when the browser fails to open", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const shown: Array<{ url: string; code: string }> = [];
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(200, tokenData()),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    await runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
      openBrowser: () => Promise.resolve(false),
      onShow: (url, code) => { shown.push({ url, code }); },
    });
    // onShow is invoked exactly once even when openBrowser returns false.
    expect(shown).toHaveLength(1);
    expect(shown[0]).toEqual({ url: "https://pinboard-backend-4p35sr23vq-uc.a.run.app/device", code: "ABCD-EFGH" });
  });

  it("returns the server-authoritative deviceId from the token response", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const responses: Response[] = [
      jsonResponse(200, startData()),
      jsonResponse(200, tokenData({ deviceId: "server_bound_device_id" })),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    const result = await runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "client_sent_id",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    });
    expect(result.deviceId).toBe("server_bound_device_id");
  });
});

describe("device credential rollback", () => {
  it("restores a previously stored OS token when activation fails after a new login", async () => {
    const store = makeStore();
    await store.save(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT, "prior_token_0123456789");
    store.saved.length = 0;
    await store.save(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT, "new_token_0123456789");
    await restoreDeviceCredential(store, "prior_token_0123456789");
    expect(store.deleted).toEqual([]);
    expect(store.saved).toEqual(["new_token_0123456789", "prior_token_0123456789"]);
  });

  it("deletes the newly stored token when no prior token existed", async () => {
    const store = makeStore();
    await store.save(DEVICE_AUTH_SERVICE, DEVICE_AUTH_ACCOUNT, "new_token_0123456789");
    await restoreDeviceCredential(store, null);
    expect(store.deleted).toEqual(["deleted"]);
    expect(store.saved).toEqual(["new_token_0123456789"]);
  });
});

describe("retry-after parsing and cap", () => {
  it("caps a maliciously large numeric retry-after at MAX_SLEEP_SECONDS", () => {
    expect(parseRetryAfter("999999999999")).toBe(MAX_SLEEP_SECONDS);
  });

  it("caps a far-future HTTP-date retry-after at MAX_SLEEP_SECONDS", () => {
    const far = new Date(Date.now() + 999_999_999_000).toUTCString();
    expect(parseRetryAfter(far)).toBe(MAX_SLEEP_SECONDS);
  });

  it("passes through a reasonable retry-after unchanged", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter("60")).toBe(60);
  });

  it("returns null for missing or unparseable values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("not a date")).toBeNull();
  });

  it("caps a slow_down retry-after sleep so a hostile server cannot stall forever", async () => {
    const clock = makeClock();
    const sleep = makeSleep(clock);
    const store = makeStore();
    const responses: Response[] = [
      jsonResponse(200, startData({ expiresIn: 3600, interval: 5 })),
      jsonResponse(400, errorData("SLOW_DOWN", "too fast", "999999").body, { "retry-after": "999999" }),
      jsonResponse(200, tokenData()),
    ];
    const fetchImpl = (): Promise<Response> => {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("unexpected fetch"));
      return Promise.resolve(response);
    };
    const result = await runDeviceLogin({
      apiUrl: "https://pinboard-backend-4p35sr23vq-uc.a.run.app",
      deviceId: "device_1",
      credentialStore: store,
      fetchImpl,
      sleep: sleep.sleep,
      now: clock.now,
    });
    expect(sleep.slept[0]).toBe(MAX_SLEEP_SECONDS * 1000);
    expect(result.accessToken).toBe("opaque_access_token_0123456789");
  });
});
