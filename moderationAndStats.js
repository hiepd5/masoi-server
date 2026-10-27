// =============================================================================
// HỆ THỐNG VĂN MINH CỘNG ĐỒNG, GIỜ VÀNG UTC+7 & CHỈ SỐ VẬN HÀNH (V4.1)
// - Bộ lọc từ tục tĩu tiếng Việt / tiếng Anh không làm hỏng từ ghép bình thường
// - Khung Giờ Vàng Đêm Huyết Nguyệt (20:00 - 23:00 UTC+7) tính chuẩn giờ Server (Chốt #9)
// - Lưu trữ giới hạn (Ring Buffer <= 200) báo cáo người chơi xấu, an toàn 512MB RAM Render
// =============================================================================

const PROFANITY_PATTERNS = [
  /(?<![\p{L}\p{N}_])(dmm|dkm|dcm|vcl|vl|vkl|cc|clgt|dm|đm|đkm|đcm|đmm|vãi\s*lồn|lồn|buồi|cặc|địt|đéo|chó\s*đẻ|óc\s*chó|ngu\s*lồn)(?![\p{L}\p{N}_])/giu,
  /(?<![\p{L}\p{N}_])(fuck|fucking|bitch|asshole|motherfucker|dickhead)(?![\p{L}\p{N}_])/giu,
];

/**
 * Làm sạch và che dấu sao (***) các từ ngữ tục tĩu trong tin nhắn Chat & Tên phòng/Tên người chơi
 */
export function filterVietnameseProfanity(rawText) {
  if (typeof rawText !== "string" || !rawText) return "";
  let out = rawText;
  for (const regex of PROFANITY_PATTERNS) {
    out = out.replace(regex, (match) => "*".repeat(Math.min(4, Math.max(2, match.length))));
  }
  return out;
}

/**
 * Chốt #9: Xác thực Khung Giờ Vàng Đêm Huyết Nguyệt (20:00 – 23:00 giờ Việt Nam UTC+7)
 * hoàn toàn bằng đồng hồ của Server để chống chỉnh giờ thiết bị ăn gian XP / Streak!
 */
export function getVietnamGoldenHourInfo(nowMs = Date.now()) {
  const vnShifted = new Date(nowMs + 7 * 3600 * 1000);
  const utc7Hour = vnShifted.getUTCHours();
  const utc7Minute = vnShifted.getUTCMinutes();
  const yyyy = vnShifted.getUTCFullYear();
  const mm = String(vnShifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(vnShifted.getUTCDate()).padStart(2, "0");
  const serverDateKey = `${yyyy}-${mm}-${dd}`;

  // 20:00:00 -> 22:59:59 UTC+7 (trọn 3 tiếng buổi tối đông vui nhất)
  const active = utc7Hour >= 20 && utc7Hour < 23;

  return {
    active,
    multiplier: active ? 2 : 1,
    utc7Hour,
    utc7Minute,
    serverDateKey,
    windowLabel: "20:00 – 23:00",
  };
}

const MAX_RECENT_REPORTS = 200;
const recentReports = [];
let totalReportsCount = 0;

export function recordPlayerReport({
  reporterIp = "unknown",
  roomCode = "",
  reporterId = "",
  reporterName = "",
  targetId = "",
  targetName = "",
  reason = "Ngôn từ thiếu văn minh",
} = {}) {
  totalReportsCount += 1;
  const entry = {
    id: `rep_${Date.now().toString(36)}_${totalReportsCount}`,
    createdAtIso: new Date().toISOString(),
    roomCode: String(roomCode || "").slice(0, 8),
    reporterId: String(reporterId || "").slice(0, 48),
    reporterName: String(reporterName || "").slice(0, 24),
    targetId: String(targetId || "").slice(0, 48),
    targetName: String(targetName || "").slice(0, 24),
    reason: String(reason || "Ngôn từ thiếu văn minh").slice(0, 120),
    reporterIpHash: String(reporterIp || "unknown").slice(-6),
  };
  recentReports.push(entry);
  if (recentReports.length > MAX_RECENT_REPORTS) {
    recentReports.shift();
  }
  return entry;
}

export function getModerationStats() {
  return {
    totalReportsCount,
    recentReportsCount: recentReports.length,
    latestReports: recentReports.slice(-15).reverse(),
  };
}
