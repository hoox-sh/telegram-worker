/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from "bun:test";
import {
  checkOutboundChatId,
  isInboundChatAuthorized,
  normalizeChatId,
  parseAuthorizedChatIds,
} from "../../src/logic/chatAllowlist";

describe("normalizeChatId", () => {
  test("accepts integer and digit strings (incl. negative group ids)", () => {
    expect(normalizeChatId(123)).toBe("123");
    expect(normalizeChatId(" 987654321 ")).toBe("987654321");
    expect(normalizeChatId("-1001234567890")).toBe("-1001234567890");
  });

  test("rejects non-integer numbers and injection shapes", () => {
    expect(normalizeChatId(1.5)).toBeNull();
    expect(normalizeChatId(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeChatId("../x")).toBeNull();
    expect(normalizeChatId("abc")).toBeNull();
    expect(normalizeChatId("")).toBeNull();
    expect(normalizeChatId(null)).toBeNull();
    expect(normalizeChatId("__proto__")).toBeNull();
  });
});

describe("parseAuthorizedChatIds", () => {
  test("treats empty / placeholder as unset", () => {
    expect(parseAuthorizedChatIds(undefined)).toBeNull();
    expect(parseAuthorizedChatIds("")).toBeNull();
    expect(parseAuthorizedChatIds("__SECRET__")).toBeNull();
    expect(parseAuthorizedChatIds("  ")).toBeNull();
  });

  test("parses comma-separated ids and drops invalids", () => {
    expect(parseAuthorizedChatIds("111, bad, 222")).toEqual(["111", "222"]);
  });
});

describe("isInboundChatAuthorized", () => {
  test("fail-closed when allowlist unset", () => {
    const r = isInboundChatAuthorized(111, {});
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not configured/i);
  });

  test("allows listed chat", () => {
    const r = isInboundChatAuthorized(111, {
      AUTHORIZED_CHAT_IDS: "111,222",
    });
    expect(r.allowed).toBe(true);
    expect(r.normalized).toBe("111");
  });

  test("denies unlisted chat", () => {
    const r = isInboundChatAuthorized(333, {
      AUTHORIZED_CHAT_IDS: "111,222",
    });
    expect(r.allowed).toBe(false);
  });
});

describe("checkOutboundChatId", () => {
  test("when allowlist unset, only TG_CHAT_ID_BINDING is permitted", () => {
    const ok = checkOutboundChatId("123", {
      TG_CHAT_ID_BINDING: "123",
    });
    expect(ok.allowed).toBe(true);

    const blocked = checkOutboundChatId("999", {
      TG_CHAT_ID_BINDING: "123",
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/TG_CHAT_ID_BINDING/i);
  });

  test("when allowlist set, destination must be listed", () => {
    const env = {
      AUTHORIZED_CHAT_IDS: "10,20",
      TG_CHAT_ID_BINDING: "10",
    };
    expect(checkOutboundChatId("20", env).allowed).toBe(true);
    expect(checkOutboundChatId("10", env).allowed).toBe(true);
    expect(checkOutboundChatId("99", env).allowed).toBe(false);
  });

  test("rejects invalid format", () => {
    const r = checkOutboundChatId("not-a-chat", {
      AUTHORIZED_CHAT_IDS: "1",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/invalid/i);
  });
});
