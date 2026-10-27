// =============================================================================
// HỆ THỐNG KHIÊN BẢO MẬT ZERO-TRUST (V4.1 SECURITY GUARD)
// - Chống lộ tài nguyên, khóa CORS chuẩn Web + CapacitorJS App
// - Rate-Limit tự dọn bộ nhớ (An toàn 100% cho Render Free 512MB RAM)
// - Chống dò mật khẩu phòng, lọc Avatar độc hại, giới hạn Chat & Emoji đêm
// =============================================================================

export const IS_PRODUCTION_ENV = Boolean(
  process.env.RENDER || process.env.NODE_ENV === "production"
);

export const MAX_ACTIVE_ROOMS = 150;
export const MAX_CHAT_LENGTH = 240;

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://masoi.hiepd5.com",
  "https://www.masoi.hiepd5.com",
  "capacitor://localhost",
  "ionic://localhost",
  "https://localhost",
  "http://localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://localhost:3001",
]);

function getConfiguredOriginsSet() {
  const set = new Set(DEFAULT_ALLOWED_ORIGINS);
  const extra = String(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of extra) set.add(o);
  return set;
}

export function isOriginAllowed(origin) {
  // Cho phép request không có Origin (Health check Render, Server-to-Server, Native WebView một số bản)
  if (!origin) return true;
  const clean = String(origin).trim().replace(/\/+$/, "");
  const allowed = getConfiguredOriginsSet();
  if (allowed.has(clean)) return true;

  // Cho phép link preview chính chủ Vercel của masoi-client
  if (/^https:\/\/masoi-client(-[a-z0-9-]+)?\.vercel\.app$/i.test(clean)) {
    return true;
  }

  // Trên máy Dev Local, cho phép mở từ IP mạng LAN nội bộ (192.168.x.x / 10.x.x.x) để test điện thoại thật
  if (!IS_PRODUCTION_ENV) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/i.test(clean)) {
      return true;
    }
  }

  return false;
}

export function extractClientIp(reqOrSocket) {
  if (!reqOrSocket) return "unknown";
  // Express Request
  const headers = reqOrSocket.headers || reqOrSocket.handshake?.headers || {};
  const xff = headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim().slice(0, 64);
  }
  const directIp =
    reqOrSocket.ip ||
    reqOrSocket.socket?.remoteAddress ||
    reqOrSocket.handshake?.address ||
    reqOrSocket.conn?.remoteAddress ||
    "unknown";
  return String(directIp).replace(/^::ffff:/, "").slice(0, 64);
}

// ── Bộ giới hạn tần suất theo IP (Sliding Window tự thu dọn chống tràn RAM) ──
const rateBuckets = new Map(); // key -> { count, resetAt }
let lastPruneAt = Date.now();

function pruneExpiredBuckets(now) {
  if (now - lastPruneAt < 60_000 && rateBuckets.size < 2500) return;
  lastPruneAt = now;
  for (const [k, v] of rateBuckets.entries()) {
    if (now >= v.resetAt) rateBuckets.delete(k);
  }
}

export function checkIpRateLimit(bucketName, ip, maxHits, windowMs) {
  const now = Date.now();
  pruneExpiredBuckets(now);

  const safeIp = ip || "unknown";
  const key = `${bucketName}:${safeIp}`;
  const entry = rateBuckets.get(key);

  if (!entry || now >= entry.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxHits - 1, retryAfterSec: 0 };
  }

  if (entry.count >= maxHits) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  entry.count += 1;
  return { allowed: true, remaining: maxHits - entry.count, retryAfterSec: 0 };
}

// ── Chống dò mật khẩu phòng (5 lần sai -> khóa 15 giây / IP) ──
const pwdFailMap = new Map(); // ip -> { fails, lockedUntil }

export function getPasswordLockRemainingSec(ip) {
  const entry = pwdFailMap.get(ip || "unknown");
  if (!entry) return 0;
  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
  }
  if (entry.lockedUntil && now >= entry.lockedUntil) {
    pwdFailMap.delete(ip || "unknown");
  }
  return 0;
}

export function recordPasswordFailure(ip) {
  const key = ip || "unknown";
  const now = Date.now();
  const prev = pwdFailMap.get(key) || { fails: 0, lockedUntil: 0 };
  const fails = prev.fails + 1;
  const lockedUntil = fails >= 5 ? now + 15_000 : 0;
  pwdFailMap.set(key, { fails: fails >= 5 ? 0 : fails, lockedUntil });
  return lockedUntil > 0 ? 15 : 0;
}

export function clearPasswordFailures(ip) {
  pwdFailMap.delete(ip || "unknown");
}

// ── Whitelist & Làm sạch Avatar URL (100% nội bộ, chặn XSS javascript:, api.dicebear.com & link ngoài) ──
export function sanitizeAvatarUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 280) return null;

  if (trimmed === "/icon-192.png" || trimmed === "/icon-512.png") {
    return trimmed;
  }

  // Chỉ nhận đường dẫn nội bộ hợp lệ (/portraits/..., /avatars/..., /icons/..., /images/...)
  if (/^\/(portraits|avatars|icons|images)\/[a-zA-Z0-9_./-]+$/i.test(trimmed)) {
    if (trimmed.includes("..")) return null;
    return trimmed;
  }

  return null;
}

export function sanitizeCitizenModelId(rawId) {
  if (!rawId || typeof rawId !== "string") return null;
  const trimmed = rawId.trim();
  if (!/^[a-zA-Z0-9_-]{3,48}$/.test(trimmed)) return null;
  return trimmed;
}

export function sanitizeDeviceId(rawId) {
  if (!rawId || typeof rawId !== "string") return null;
  const clean = rawId.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  return clean.length >= 6 ? clean : null;
}

export function sanitizeChatText(rawText, maxLen = MAX_CHAT_LENGTH) {
  if (typeof rawText !== "string") return "";
  return rawText
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLen);
}

export function checkSocketCooldown(socket, actionKey, cooldownMs) {
  if (!socket?.data) return true;
  if (!socket.data._cooldowns) socket.data._cooldowns = {};
  const now = Date.now();
  const prev = socket.data._cooldowns[actionKey] || 0;
  if (now - prev < cooldownMs) return false;
  socket.data._cooldowns[actionKey] = now;
  return true;
}

export function isSafeReactionEmoji(raw) {
  if (typeof raw !== "string") return false;
  const clean = raw.trim();
  if (!clean || clean.length > 10) return false;
  // Chặn chèn chữ dài / thẻ HTML giả làm emoji
  if (/[<>a-zA-Z0-9]{2,}/.test(clean)) return false;
  return true;
}
