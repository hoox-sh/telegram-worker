/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exercise pure helpers from @hoox-sh/hoox-shared already depended on by
 * telegram-worker (no network / real bindings).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  toError,
  createJsonResponse,
  createSuccessResponse,
  createErrorResponse,
  Errors,
} from "@hoox-sh/hoox-shared/errors";
import { healthCheck } from "@hoox-sh/hoox-shared/health";
import {
  timingSafeEqual,
  checkInternalAuth,
  requireInternalAuth,
  createInternalAuthMiddleware,
  validateJson,
  validateJsonLegacy,
  requireField,
  optionalField,
  createLogger,
  withRequestLog,
  corsHeaders,
  publicCorsHeaders,
  internalCorsHeaders,
  resolveCorsOptions,
  handleCorsPreflightRequest,
  createRateLimiter,
  secureHeaders,
  wrapWithSecurityHeaders,
} from "@hoox-sh/hoox-shared/middleware";
import { createRouter } from "@hoox-sh/hoox-shared/router";
import {
  resolveInternalAuthKey,
  serviceFetch,
  TELEGRAM_ALERT_AUTH_KEY_FIELDS,
  authenticatedServiceFetch,
} from "@hoox-sh/hoox-shared/service-bindings";
import { KVKeys } from "@hoox-sh/hoox-shared/kvKeys";

describe("shared errors + health", () => {
  test("toError variants", () => {
    expect(toError(new Error("e"))).toBe("e");
    expect(toError("s")).toBe("s");
    expect(toError({ message: "m" })).toBe("m");
    expect(toError(null, "fb")).toBe("fb");
    expect(toError(undefined)).toBe("Unknown error");
  });

  test("response factories and Errors", async () => {
    expect((await createJsonResponse({ ok: 1 })).status).toBe(200);
    expect((await createSuccessResponse()).status).toBe(200);
    expect((await createErrorResponse("x", 400)).status).toBe(400);
    expect((await Errors.badRequest("b")).status).toBe(400);
    expect((await Errors.unauthorized()).status).toBe(401);
    expect((await Errors.forbidden()).status).toBe(403);
    expect((await Errors.notFound()).status).toBe(404);
    expect((await Errors.methodNotAllowed()).status).toBe(405);
    expect((await Errors.rateLimited(5)).status).toBe(429);
    expect((await Errors.internal("e")).status).toBe(500);
  });

  test("healthCheck", async () => {
    const res = healthCheck({ worker: "telegram-worker", version: "t" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { service: string } };
    expect(j.result.service).toBe("telegram-worker");
  });
});

describe("shared middleware", () => {
  test("auth helpers", () => {
    expect(timingSafeEqual("x", "x")).toBe(true);
    expect(timingSafeEqual("x", "y")).toBe(false);
    const env = { INTERNAL_KEY_BINDING: "k" } as any;
    const good = new Request("https://t", {
      headers: { "X-Internal-Auth-Key": "k" },
    });
    expect(checkInternalAuth(good, env).authorized).toBe(true);
    expect(requireInternalAuth(good, env)).toBeNull();
    expect(typeof createInternalAuthMiddleware()).toBe("function");
  });

  test("validation helpers", async () => {
    const schema = z.object({ q: z.string() });
    expect(validateJson(schema, { q: "a" }).ok).toBe(true);
    expect(validateJson(schema, {}).ok).toBe(false);
    expect(
      (
        await validateJsonLegacy(
          new Request("https://t", {
            method: "POST",
            body: JSON.stringify({ a: 1 }),
          })
        )
      ).ok
    ).toBe(true);
    expect(requireField({ a: 1 }, "a").ok).toBe(true);
    expect(optionalField({}, "a", 3)).toBe(3);
  });

  test("cors + security + rate limit + logger", async () => {
    expect(corsHeaders({ allowOrigin: "https://o" })["Access-Control-Allow-Origin"]).toBe("https://o");
    expect(publicCorsHeaders()["Access-Control-Allow-Origin"]).toBe("*");
    expect(internalCorsHeaders()).toBeDefined();
    resolveCorsOptions(new Request("https://t"), {
      CORS_ALLOW_ORIGIN: "https://o",
    } as any);
    const pre = handleCorsPreflightRequest(
      new Request("https://t", { method: "OPTIONS" }),
      { allowOrigin: "https://o" }
    );
    expect(pre).not.toBeNull();
    expect(pre!.status).toBe(204);

    expect(secureHeaders()["X-Content-Type-Options"]).toBeDefined();
    expect(
      wrapWithSecurityHeaders(new Response("ok")).headers.get(
        "X-Content-Type-Options"
      )
    ).toBeTruthy();

    const limiter = createRateLimiter(undefined, { maxRequests: 1, windowSeconds: 30 });
    const req = new Request("https://t", {
      headers: { "CF-Connecting-IP": "8.8.8.8" },
    });
    expect((await limiter.check(req)).allowed).toBe(true);
    expect((await limiter.enforce(req))?.status).toBe(429);

    const log = createLogger({ service: "telegram-worker" });
    log.info("i");
    log.warn("w");
    log.error("e");
    log.debug("d");

    const wrapped = withRequestLog(async () => new Response("ok"), {
      service: "telegram-worker",
    });
    expect(
      (
        await wrapped(
          new Request("https://t/alert"),
          {} as any,
          { waitUntil: () => {} } as any
        )
      ).status
    ).toBe(200);
  });
});

describe("shared router + bindings + kv keys", () => {
  test("router hit/miss", async () => {
    const r = createRouter();
    r.get("/h", async () => new Response("ok"));
    expect(
      (await r.handle(new Request("https://t/h"), {} as any, {} as any)).status
    ).toBe(200);
    expect(
      (
        await r.handle(new Request("https://t/missing"), {} as any, {} as any)
      ).status
    ).toBe(404);
  });

  test("resolveInternalAuthKey + serviceFetch", async () => {
    expect(
      resolveInternalAuthKey(
        { TELEGRAM_INTERNAL_KEY_BINDING: "tg" },
        TELEGRAM_ALERT_AUTH_KEY_FIELDS
      )
    ).toBe("tg");
    const binding = {
      fetch: async () => new Response("{}", { status: 200 }),
    };
    const res = await serviceFetch(binding as any, "/x", { m: 1 });
    expect(res.ok).toBe(true);

    // authenticatedServiceFetch with binding env
    const authRes = await authenticatedServiceFetch(
      binding as any,
      { INTERNAL_KEY_BINDING: "k" } as any,
      "/alert",
      { message: "hi" },
      { internalKeyFields: TELEGRAM_ALERT_AUTH_KEY_FIELDS }
    );
    expect(authRes.ok).toBe(true);
  });

  test("KVKeys constants exist", () => {
    expect(typeof KVKeys.KV_TRADE_KILL_SWITCH).toBe("string");
  });
});
