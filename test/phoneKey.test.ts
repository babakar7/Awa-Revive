import { describe, expect, it } from "vitest";
import { canonicalPhoneKey } from "../src/lib/phoneKey.js";

describe("canonicalPhoneKey", () => {
  it("normalizes Senegalese spellings to 221 + 9 national digits", () => {
    const expected = "221771234567";
    expect(canonicalPhoneKey("+221 77 123 45 67")).toBe(expected);
    expect(canonicalPhoneKey("221771234567")).toBe(expected);
    expect(canonicalPhoneKey("00221771234567")).toBe(expected);
    expect(canonicalPhoneKey("77 123 45 67")).toBe(expected);
    expect(canonicalPhoneKey("771234567")).toBe(expected);
  });

  it("collapses a local and an international Senegalese spelling to one key", () => {
    expect(canonicalPhoneKey("781234567")).toBe(canonicalPhoneKey("+221781234567"));
  });

  it("keeps a full international other-country number as its digit string", () => {
    expect(canonicalPhoneKey("+33612345678")).toBe("33612345678");
    expect(canonicalPhoneKey("+1 202 555 0143")).toBe("12025550143");
    expect(canonicalPhoneKey("0033612345678")).toBe("33612345678");
  });

  it("refuses ambiguous local foreign numbers (fail-closed)", () => {
    expect(canonicalPhoneKey("612345678")).toBeNull(); // 9 digits, not SN mobile
    expect(canonicalPhoneKey("12345678")).toBeNull(); // 8 digits, no country
    expect(canonicalPhoneKey("0612345678")).toBeNull(); // French local, no country
  });

  it("returns null on empty / junk input", () => {
    expect(canonicalPhoneKey("")).toBeNull();
    expect(canonicalPhoneKey(null)).toBeNull();
    expect(canonicalPhoneKey(undefined)).toBeNull();
    expect(canonicalPhoneKey("abc")).toBeNull();
  });

  it("keeps a 221 fixed-line number that is explicitly country-coded", () => {
    expect(canonicalPhoneKey("221338691234")).toBe("221338691234");
  });
});
