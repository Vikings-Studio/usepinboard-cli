import { describe, expect, it } from "vitest";
import { createCredentialStore, CredentialStoreError } from "../src/auth/credential-store.js";

describe("credential store", () => {
  it("selects a platform adapter without throwing on supported platforms", () => {
    expect(createCredentialStore("darwin")).toBeTruthy();
    expect(createCredentialStore("linux")).toBeTruthy();
    expect(createCredentialStore("win32")).toBeTruthy();
  });

  it("fails closed on unsupported platforms rather than persisting plaintext", () => {
    expect(() => createCredentialStore("freebsd")).toThrow(CredentialStoreError);
    expect(() => createCredentialStore("freebsd")).toThrow(/Refusing to persist the access token in plaintext/u);
  });

  it("windows adapter fails closed with an actionable error", async () => {
    const store = createCredentialStore("win32");
    await expect(store.save("s", "a", "secret")).rejects.toThrow(/Windows Credential Manager/u);
    await expect(store.read("s", "a")).rejects.toThrow(/Windows Credential Manager/u);
    await expect(store.delete("s", "a")).rejects.toThrow(/Windows Credential Manager/u);
  });
});
