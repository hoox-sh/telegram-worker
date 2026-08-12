/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chat ID allowlist helpers for telegram-worker.
 *
 * Two enforcement surfaces:
 *
 * 1. **Inbound webhook commands** (`POST /webhook`) — fail-closed when
 *    `AUTHORIZED_CHAT_IDS` is unset/placeholder. Without this, any Telegram
 *    user who can message the bot could run `/kill_on` or burn AI credits.
 *
 * 2. **Outbound `/alert` destinations** — defense-in-depth against arbitrary
 *    Telegram spam if an internal auth key leaks:
 *    - When `AUTHORIZED_CHAT_IDS` is configured → effective chatId must be in set
 *    - When unset → only the operator default `TG_CHAT_ID_BINDING` is permitted
 *
 * Public gateway notify (`hoox-worker`) already fail-closes via
 * `TELEGRAM_ALLOWED_CHAT_IDS` / `AUTHORIZED_CHAT_IDS` (+ CONFIG_KV). Mesh peers
 * (trade-worker, agent-worker, …) typically omit `chatId` and rely on
 * `TG_CHAT_ID_BINDING`, so the unset path stays compatible with default-only
 * notifications while still blocking arbitrary overrides.
 */

/** Wrangler template placeholder — treat as unset. */
export const SECRET_PLACEHOLDER = "__SECRET__";

/** Telegram chat IDs are signed 64-bit ints; keep a generous string cap. */
export const MAX_CHAT_ID_LEN = 32;

export type ChatAllowlistEnv = {
  AUTHORIZED_CHAT_IDS?: string | null;
  TG_CHAT_ID_BINDING?: string | null;
};

export interface OutboundChatCheck {
  allowed: boolean;
  reason?: string;
  /** Normalized chatId when format is valid. */
  normalized?: string;
}

/**
 * Normalize and validate a Telegram chat ID (string or finite integer).
 * Rejects path/injection tokens and non-digit shapes.
 */
export function normalizeChatId(raw: unknown): string | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return null;
    if (!Number.isSafeInteger(raw)) return null;
    return String(raw);
  }
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CHAT_ID_LEN) return null;

  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("\0") ||
    trimmed.includes("__proto__") ||
    trimmed.includes("constructor") ||
    trimmed.includes("prototype")
  ) {
    return null;
  }

  // Optional leading minus, digits only (e.g. -100123..., 123456)
  if (!/^-?\d+$/.test(trimmed)) return null;

  return trimmed;
}

/**
 * Parse comma-separated AUTHORIZED_CHAT_IDS.
 * Returns null when unset / placeholder / empty after filtering invalids.
 */
export function parseAuthorizedChatIds(
  raw: string | null | undefined
): string[] | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value || value === SECRET_PLACEHOLDER) return null;

  const ids: string[] = [];
  for (const part of value.split(",")) {
    const normalized = normalizeChatId(part.trim());
    if (normalized) ids.push(normalized);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Inbound webhook: chat must be on AUTHORIZED_CHAT_IDS (fail-closed when unset).
 */
export function isInboundChatAuthorized(
  chatId: unknown,
  env: ChatAllowlistEnv
): { allowed: boolean; reason?: string; normalized?: string } {
  const allowedIds = parseAuthorizedChatIds(env.AUTHORIZED_CHAT_IDS ?? undefined);
  if (!allowedIds) {
    return {
      allowed: false,
      reason: "AUTHORIZED_CHAT_IDS not configured",
    };
  }

  const normalized = normalizeChatId(chatId);
  if (!normalized) {
    return { allowed: false, reason: "Invalid chatId format" };
  }

  if (!allowedIds.includes(normalized)) {
    return {
      allowed: false,
      reason: "chatId not in AUTHORIZED_CHAT_IDS",
      normalized,
    };
  }

  return { allowed: true, normalized };
}

/**
 * Outbound `/alert` destination check (defense-in-depth).
 *
 * @see module docstring for policy when allowlist is unset vs configured.
 */
export function checkOutboundChatId(
  chatId: unknown,
  env: ChatAllowlistEnv
): OutboundChatCheck {
  const normalized = normalizeChatId(chatId);
  if (!normalized) {
    return {
      allowed: false,
      reason: "Invalid chatId format",
    };
  }

  const allowedIds = parseAuthorizedChatIds(env.AUTHORIZED_CHAT_IDS ?? undefined);
  if (allowedIds) {
    if (!allowedIds.includes(normalized)) {
      return {
        allowed: false,
        reason: "chatId not in AUTHORIZED_CHAT_IDS allowlist",
        normalized,
      };
    }
    return { allowed: true, normalized };
  }

  // Allowlist unset: only the operator default destination is permitted.
  // Public gateway notify is separately fail-closed via TELEGRAM_ALLOWED_CHAT_IDS.
  const defaultChat = normalizeChatId(env.TG_CHAT_ID_BINDING ?? undefined);
  if (defaultChat && defaultChat === normalized) {
    return { allowed: true, normalized };
  }

  return {
    allowed: false,
    reason:
      "AUTHORIZED_CHAT_IDS not configured — only TG_CHAT_ID_BINDING is permitted for outbound alerts (fail-closed)",
    normalized,
  };
}
