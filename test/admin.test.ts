import { describe, expect, it, beforeAll } from "vitest";
import {
  parseAdminUsers,
  verifyBasicAuth,
  FALLBACK_USERS,
  mintSessionToken,
  verifySessionToken,
  safeNextPath,
  parseCookies,
  SESSION_TTL_MS,
} from "../src/admin/auth.js";
import { escapeHtml } from "../src/admin/routes.js";

// Session HMAC needs config.DATABASE_URL — tests load dotenv or empty; pin env.
beforeAll(() => {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
  process.env.BASE_URL ??= "https://example.test";
});

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

describe("admin auth — ADMIN_USERS parsing", () => {
  it("parses two accounts", () => {
    const users = parseAdminUsers("babakar:secret1,reception:secret2");
    expect(users.size).toBe(2);
    expect(users.get("babakar")).toBe("secret1");
    expect(users.get("reception")).toBe("secret2");
  });

  it("tolerates spaces around entries (whole entry is trimmed)", () => {
    const users = parseAdminUsers(" babakar:secret1 , reception:secret2 ");
    expect(users.get("babakar")).toBe("secret1");
    expect(users.get("reception")).toBe("secret2");
  });

  it("keeps colons inside passwords", () => {
    const users = parseAdminUsers("babakar:pa:ss:word");
    expect(users.get("babakar")).toBe("pa:ss:word");
  });

  it("drops malformed entries (no colon, empty user or password)", () => {
    const users = parseAdminUsers("nopassword,:orphan,user:,ok:yes");
    expect(users.size).toBe(1);
    expect(users.get("ok")).toBe("yes");
  });

  it("empty string → no accounts (the hook then uses the built-in fallback)", () => {
    expect(parseAdminUsers("").size).toBe(0);
  });
});

describe("admin auth — built-in fallback (ADMIN_USERS unset)", () => {
  it("accepts revive/revive", () => {
    expect(verifyBasicAuth(basic("revive", "revive"), FALLBACK_USERS)).toBe("revive");
  });

  it("rejects a wrong password and a missing header (never open)", () => {
    expect(verifyBasicAuth(basic("revive", "wrong"), FALLBACK_USERS)).toBeNull();
    expect(verifyBasicAuth(undefined, FALLBACK_USERS)).toBeNull();
  });
});

describe("admin auth — Basic header verification", () => {
  const users = parseAdminUsers("babakar:secret1,reception:secret2");

  it("accepts a valid header and returns the username", () => {
    expect(verifyBasicAuth(basic("babakar", "secret1"), users)).toBe("babakar");
    expect(verifyBasicAuth(basic("reception", "secret2"), users)).toBe("reception");
  });

  it("rejects a wrong password", () => {
    expect(verifyBasicAuth(basic("babakar", "wrong"), users)).toBeNull();
  });

  it("rejects an unknown user", () => {
    expect(verifyBasicAuth(basic("intru", "secret1"), users)).toBeNull();
  });

  it("rejects a swapped user/password pair", () => {
    expect(verifyBasicAuth(basic("babakar", "secret2"), users)).toBeNull();
  });

  it("rejects missing, non-Basic or garbage headers", () => {
    expect(verifyBasicAuth(undefined, users)).toBeNull();
    expect(verifyBasicAuth("Bearer abc", users)).toBeNull();
    expect(verifyBasicAuth("Basic %%%not-base64%%%", users)).toBeNull();
    expect(verifyBasicAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`, users)).toBeNull();
  });

  it("password may contain a colon", () => {
    const u = parseAdminUsers("a:b:c");
    expect(verifyBasicAuth(basic("a", "b:c"), u)).toBe("a");
  });
});

describe("admin — escapeHtml (client text is untrusted)", () => {
  it("escapes the five HTML special characters", () => {
    expect(escapeHtml(`<script>alert("x&y'z")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;y&#39;z&quot;)&lt;/script&gt;",
    );
  });

  it("stringifies null/undefined/numbers safely", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("admin session cookie", () => {
  const users = parseAdminUsers("babakar:secret1,reception:secret2");

  it("mints a token that verifies for the same user", () => {
    const token = mintSessionToken("babakar");
    expect(verifySessionToken(token, users)).toBe("babakar");
  });

  it("rejects tampered tokens and unknown users", () => {
    const token = mintSessionToken("babakar");
    expect(verifySessionToken(token + "x", users)).toBeNull();
    expect(verifySessionToken(token, parseAdminUsers("other:x"))).toBeNull();
    expect(verifySessionToken(undefined, users)).toBeNull();
  });

  it("rejects expired tokens", () => {
    const token = mintSessionToken("babakar", Date.now() - SESSION_TTL_MS - 1000);
    expect(verifySessionToken(token, users)).toBeNull();
  });

  it("safeNextPath only allows /admin paths", () => {
    expect(safeNextPath("/admin/bookings")).toBe("/admin/bookings");
    expect(safeNextPath("/admin")).toBe("/admin");
    expect(safeNextPath("https://evil.test")).toBe("/admin");
    expect(safeNextPath("//evil.test")).toBe("/admin");
    expect(safeNextPath("/elsewhere")).toBe("/admin");
  });

  it("parseCookies reads multiple cookies", () => {
    expect(parseCookies("a=1; awa_admin_session=tok%2B; b=c")).toEqual({
      a: "1",
      awa_admin_session: "tok+",
      b: "c",
    });
  });
});
