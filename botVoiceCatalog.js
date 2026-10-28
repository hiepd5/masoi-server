import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const FORBIDDEN_MC_VOICE_ID = "b5d182f3";

const DURATIONS_JSON_PATH = path.join(__dirname, "botVoiceDurations.json");
let cachedDurationsMap = null;
let cachedDurationsMtimeMs = 0;

function loadBotVoiceDurations() {
  try {
    if (!fs.existsSync(DURATIONS_JSON_PATH)) return {};
    const stat = fs.statSync(DURATIONS_JSON_PATH);
    if (!cachedDurationsMap || stat.mtimeMs !== cachedDurationsMtimeMs) {
      cachedDurationsMap = JSON.parse(fs.readFileSync(DURATIONS_JSON_PATH, "utf8"));
      cachedDurationsMtimeMs = stat.mtimeMs;
    }
    return cachedDurationsMap || {};
  } catch {
    return cachedDurationsMap || {};
  }
}

/**
 * Danh mục 48 câu thoại AI Bot thu sẵn bằng RTX 3090 (4 nhân cách × 12 câu = 48 MP3).
 * - 100% Zero-Leak: Tuyệt đối KHÔNG đọc p.role ẩn của bất kỳ người chơi nào.
 * - 100% Khớp Chữ - Tiếng: Phần `text` trùng khớp từng âm tiết với file `/audio/bots/<personaId>/<clipId>.mp3`.
 * - Khi câu thoại chất vấn / nhắm vào mục tiêu cụ thể (`needsTargetPrefix: true`),
 *   bóng thoại 3D hiển thị `👉 @Tên: <text>` để người chơi nắm rõ đối tượng mà âm thanh không lệch chữ!
 */
export const BOT_VOICE_CATALOG = {
  sharp_fox: {
    label: "🦊 Sắc Sảo",
    gender: "female",
    voiceProfile: "omnivoice_seed_101_female_young_high",
    clips: {
      victim_1: {
        needsTargetPrefix: true,
        text: "Đêm qua bầy Sói ra tay quá tính toán, hướng nhìn lúc sáng nay khiến tôi phải đặt dấu hỏi đấy!",
      },
      victim_2: {
        needsTargetPrefix: true,
        text: "Mất người ngay lúc nhạy cảm thế này chứng tỏ Sói rất tỉnh táo. Thái độ im lặng vừa rồi hơi lạ nha!",
      },
      peace_1: {
        needsTargetPrefix: false,
        text: "Đêm qua cả làng bình an vô sự, chắc chắn Bảo Vệ hoặc Phù Thủy đã kịp ra tay cứu mạng rồi!",
      },
      peace_2: {
        needsTargetPrefix: true,
        text: "Không ai ngã xuống chưa chắc đã an toàn đâu, biết đâu Sói Đầu Đàn vừa âm thầm đồng hóa thêm người!",
      },
      mayor_1: {
        needsTargetPrefix: false,
        text: "Đã có Quyền Trượng Trưởng Làng dẫn nhịp rồi, mọi người bình tĩnh đối chiếu từng lời khai trước khi chỉ tay nhé!",
      },
      probe_1: {
        needsTargetPrefix: true,
        text: "Từ lúc trời sáng tới giờ ánh mắt bên đó cứ né tránh, thử nêu suy luận cho cả làng nghe xem nào!",
      },
      probe_2: {
        needsTargetPrefix: false,
        text: "Ai giữ thông tin soi đêm qua hãy gài tín hiệu khéo léo nhé, đừng để bầy Sói dẫn dắt mũi dùi!",
      },
      defense_1: {
        needsTargetPrefix: false,
        text: "Mọi người bình tĩnh suy xét kỹ đi! Treo nhầm dân tỉnh táo lúc này là dâng chiến thắng cho bầy Sói đấy!",
      },
      defense_2: {
        needsTargetPrefix: false,
        text: "Tôi hoàn toàn trong sạch! Hãy nhìn kỹ xem ai là người vội vàng chỉ tay đẩy tôi lên ghế nóng đầu tiên!",
      },
      defense_3: {
        needsTargetPrefix: false,
        text: "Tha cho tôi lượt này đi, ngày mai tôi sẽ cùng cả làng lật mặt kẻ đang nấp trong bóng tối!",
      },
      wolf_1: {
        needsTargetPrefix: true,
        text: "Suỵt... đêm nay tập trung vồ gọn mục tiêu này trước khi trời sáng nhé!",
      },
      wolf_2: {
        needsTargetPrefix: true,
        text: "Nhắm chuẩn vào ghế ít bị Bảo Vệ canh này đi anh em, chốt nhanh gọn nào!",
      },
    },
  },
  calm_owl: {
    label: "🦉 Điềm Đạm",
    gender: "male",
    voiceProfile: "omnivoice_seed_202_male_middle_low",
    clips: {
      victim_1: {
        needsTargetPrefix: true,
        text: "Vụ tấn công đêm qua có chủ đích rất rõ ràng. Chúng ta nên nghe giải thích thật kỹ trước khi bỏ phiếu.",
      },
      victim_2: {
        needsTargetPrefix: true,
        text: "Đừng để nỗi hoang mang làm rối đội hình, hãy nhìn lại xem ai hưởng lợi nhất sau biến cố đêm qua.",
      },
      peace_1: {
        needsTargetPrefix: false,
        text: "Một đêm trôi qua yên ả là lợi thế lớn cho phe Dân, mọi người khoan vội vàng treo nhầm người vô tội.",
      },
      peace_2: {
        needsTargetPrefix: false,
        text: "Đêm qua không có thương vong, chúng ta có thêm thời gian để lắng nghe từng ghế lên tiếng phân tích.",
      },
      mayor_1: {
        needsTargetPrefix: false,
        text: "Quyền Trượng Trưởng Làng đã mở đường, cả làng hãy tập trung phiếu bầu thật kỷ luật để không bị chia rẽ.",
      },
      probe_1: {
        needsTargetPrefix: true,
        text: "Từ đầu buổi tới giờ bên đó khá trầm ngâm, mời chia sẻ góc nhìn để cả làng cùng tham khảo nhé.",
      },
      probe_2: {
        needsTargetPrefix: false,
        text: "Lá phiếu hôm nay rất nặng ký, ai có manh mối xác thực thì hãy lên tiếng đúng thời điểm.",
      },
      defense_1: {
        needsTargetPrefix: false,
        text: "Xin cả làng giữ cái đầu lạnh. Đêm qua tôi hoàn toàn ngủ say, mất đi lá phiếu của tôi lúc này rất đáng tiếc.",
      },
      defense_2: {
        needsTargetPrefix: false,
        text: "Tôi hiểu vì sao mọi người nghi ngờ, nhưng hãy đối chiếu lại dữ kiện, bầy Sói đang muốn mượn tay làng đấy.",
      },
      defense_3: {
        needsTargetPrefix: false,
        text: "Hãy bấm Tha để giữ thế cân bằng cho dân làng, thời gian sẽ chứng minh tôi đứng về phía ánh sáng.",
      },
      wolf_1: {
        needsTargetPrefix: true,
        text: "Khẽ thôi... chọn mục tiêu này rất hợp lý, ít gây chú ý cho Tiên Tri đêm nay.",
      },
      wolf_2: {
        needsTargetPrefix: true,
        text: "Thống nhất một mục tiêu duy nhất thôi nhé, ra đòn dứt khoát trước bình minh.",
      },
    },
  },
  bold_bear: {
    label: "🔥 Quyết Liệt",
    gender: "male",
    voiceProfile: "omnivoice_seed_303_male_young_moderate",
    clips: {
      victim_1: {
        needsTargetPrefix: true,
        text: "Không thể để đồng đội ngã xuống vô ích được! Hôm nay nhất định phải đưa kẻ khả nghi lên ghế nóng hỏi cho ra lẽ!",
      },
      victim_2: {
        needsTargetPrefix: true,
        text: "Đêm qua Sói ra đòn quá táo tợn! Ai có biểu hiện lúng túng lúc mở mắt sáng nay phải giải trình ngay!",
      },
      peace_1: {
        needsTargetPrefix: false,
        text: "Đêm qua cản đòn quá đẹp! Nhân đà thắng thế này cả làng mạnh dạn lôi bầy Sói ra ánh sáng luôn đi!",
      },
      peace_2: {
        needsTargetPrefix: false,
        text: "Trời sáng lành lặn rồi, đừng ai ngồi im nghe ngóng nữa, lên tiếng thẳng thắn xem đang nghi ai nhất!",
      },
      mayor_1: {
        needsTargetPrefix: false,
        text: "Đã có Trưởng Làng cầm trịch lá phiếu nhân đôi, anh em dân làng cứ tự tin dồn phiếu bắt Sói!",
      },
      probe_1: {
        needsTargetPrefix: true,
        text: "Nãy giờ ngồi hơi kiệm lời đấy nhé, mạnh dạn nói rõ quan điểm cho cả bàn cùng nghe xem nào!",
      },
      probe_2: {
        needsTargetPrefix: false,
        text: "Cứ ngồi im nhìn nhau là Sói mừng thầm đấy, phải chất vấn trực diện mới lộ sơ hở được!",
      },
      defense_1: {
        needsTargetPrefix: false,
        text: "Tôi nói thẳng một lời thôi: tôi là dân lương thiện! Treo tôi xong tối nay Sói cắn thêm là vỡ trận đấy!",
      },
      defense_2: {
        needsTargetPrefix: false,
        text: "Đừng mắc bẫy khích bác! Chính kẻ đang hùa theo đòi treo tôi mới là người cần bị soi đêm nay!",
      },
      defense_3: {
        needsTargetPrefix: false,
        text: "Tha cho tôi ngay đi! Để tôi ở lại vòng tròn, ngày mai tôi thề lôi bằng được con Sói thật ra ánh sáng!",
      },
      wolf_1: {
        needsTargetPrefix: true,
        text: "Đêm nay vồ gọn mục tiêu này luôn đi anh em, đừng chần chừ nữa!",
      },
      wolf_2: {
        needsTargetPrefix: true,
        text: "Đổi hướng cắn thẳng vào ghế này đi, chắc chắn Bảo Vệ không kịp trở tay đâu!",
      },
    },
  },
  cautious_raven: {
    label: "🌙 Thận Trọng",
    gender: "female",
    voiceProfile: "omnivoice_seed_404_female_middle_low",
    clips: {
      victim_1: {
        needsTargetPrefix: true,
        text: "Sương mù còn dày quá... sau biến cố đêm qua, tôi cảm giác có ánh nhìn rất bất thường quanh bàn này.",
      },
      victim_2: {
        needsTargetPrefix: true,
        text: "Cái chết đêm qua không hề ngẫu nhiên đâu, mọi người hãy để ý kỹ những ai đang cố lái câu chuyện sang hướng khác.",
      },
      peace_1: {
        needsTargetPrefix: false,
        text: "Đêm yên ắng bất thường thế này càng phải dè chừng Kẻ Bị Nguyền hoặc Sói Đầu Đàn đang ẩn mình chờ thời.",
      },
      peace_2: {
        needsTargetPrefix: true,
        text: "Không ai mất mạng là điều may mắn, nhưng đừng vì thế mà chủ quan bỏ qua những biểu hiện khác lạ sáng nay.",
      },
      mayor_1: {
        needsTargetPrefix: false,
        text: "Trưởng Làng đã lộ diện rồi, nhưng cả làng vẫn phải thật thận trọng kẻo dồn nhầm phiếu vào bẫy của Chán Đời.",
      },
      probe_1: {
        needsTargetPrefix: true,
        text: "Tôi quan sát thấy phản ứng bên đó hơi ngập ngừng từ đầu ngày, liệu có điều gì khó nói chăng?",
      },
      probe_2: {
        needsTargetPrefix: false,
        text: "Đừng vội tin những lời buộc tội quá sớm, hãy lắng nghe nhịp thở và cách biện luận của từng ghế đã.",
      },
      defense_1: {
        needsTargetPrefix: false,
        text: "Mọi người đang vội vàng quá rồi... tôi chỉ quan sát kỹ để tránh bẫy cho làng thôi, xin đừng treo nhầm người tốt.",
      },
      defense_2: {
        needsTargetPrefix: false,
        text: "Nếu hôm nay làng xử tử nhầm tôi, đêm nay bóng tối sẽ nuốt chửng lợi thế cuối cùng của phe Dân đấy.",
      },
      defense_3: {
        needsTargetPrefix: false,
        text: "Xin hãy giữ lại lá phiếu khoan hồng cho tôi, kẻ thật sự nguy hiểm vẫn đang mỉm cười ngoài vòng ghế nóng kìa.",
      },
      wolf_1: {
        needsTargetPrefix: true,
        text: "Suỵt... nhẹ chân thôi, kết liễu mục tiêu này trong im lặng trước khi gà gáy nhé.",
      },
      wolf_2: {
        needsTargetPrefix: true,
        text: "Cẩn thận bẫy bình độc của Phù Thủy, nhắm vào ghế này an toàn hơn cho bầy mình.",
      },
    },
  },
};

function stripEmojisAndSymbols(text) {
  return String(text || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ước tính chính xác thời lượng MC đọc câu thông báo Tiếng Việt ở tốc độ `speed = 0.82`
 * cộng thêm `bufferMs` để người chơi mới kịp nghe hết chữ cuối & hiểu tình huống.
 */
export function estimateMcSpeechMs(
  text,
  { speed = 0.82, bufferMs = 1600, minMs = 3400, maxMs = 11500 } = {}
) {
  const clean = stripEmojisAndSymbols(text);
  if (!clean) return minMs;
  const words = clean.split(/\s+/).filter(Boolean).length;
  const pauseMatches = clean.match(/[.,!?;:—…]|\.\.\./g);
  const pauseCount = pauseMatches ? pauseMatches.length : 0;

  const basePerWordMs = 258 / Math.max(0.55, Number(speed) || 0.82); // ~315ms / âm tiết ở 0.82x
  const speechMs = Math.round(words * basePerWordMs + pauseCount * 290 + 420);
  const totalMs = speechMs + Math.max(0, Number(bufferMs) || 0);
  return Math.max(minMs, Math.min(maxMs, totalMs));
}

export function getBotClipDurationMs(personaId, clipId, fallbackText = "") {
  const durations = loadBotVoiceDurations();
  const exact = durations[`${personaId}/${clipId}`];
  if (typeof exact === "number" && exact >= 900) {
    return exact;
  }
  return estimateMcSpeechMs(fallbackText, { speed: 0.92, bufferMs: 0, minMs: 2600, maxMs: 9000 });
}

export function resolveEffectiveMcPacingMode(room) {
  if (!room) return "fast";
  if (room.mcPacingMode === "full" || room.mcPacingMode === "fast") {
    return room.mcPacingMode;
  }
  const hasBot = Array.isArray(room.players) && room.players.some((p) => p.isBot);
  if (hasBot && !room.isTurbo) {
    return "full";
  }
  return "fast";
}

export function isRoomFullMcPacing(room) {
  return resolveEffectiveMcPacingMode(room) === "full";
}

function pickFromPool(pool, usedSet = null) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const unused = usedSet ? pool.filter((k) => !usedSet.has(k)) : pool;
  const source = unused.length > 0 ? unused : pool;
  return source[Math.floor(Math.random() * source.length)];
}

/**
 * Chọn câu thoại + file MP3 thu sẵn tương ứng nhân cách AI Bot (100% Zero-Leak).
 * @param {object} params
 * @param {string} params.personaId - sharp_fox | calm_owl | bold_bear | cautious_raven
 * @param {"day_opening"|"day_followup"|"day_defense"|"night_wolf"} params.context
 * @param {boolean} [params.hasVictim=false]
 * @param {boolean} [params.hasMayor=false]
 * @param {string|null} [params.targetName=null]
 * @param {Set<string>|null} [params.usedClipIds=null]
 */
export function pickZeroLeakBotSpeech({
  personaId = "sharp_fox",
  context = "day_opening",
  hasVictim = false,
  hasMayor = false,
  targetName = null,
  usedClipIds = null,
} = {}) {
  const safePersonaId = BOT_VOICE_CATALOG[personaId] ? personaId : "sharp_fox";
  const personaEntry = BOT_VOICE_CATALOG[safePersonaId];
  const clips = personaEntry.clips;

  let candidateKeys = [];
  if (context === "night_wolf") {
    candidateKeys = ["wolf_1", "wolf_2"];
  } else if (context === "day_defense") {
    candidateKeys = ["defense_1", "defense_2", "defense_3"];
  } else if (context === "day_followup") {
    candidateKeys = hasVictim
      ? ["probe_1", "probe_2", "victim_2"]
      : ["probe_1", "probe_2", "peace_2"];
  } else {
    // day_opening
    if (hasMayor && Math.random() < 0.45) {
      candidateKeys = ["mayor_1"];
    } else if (hasVictim) {
      candidateKeys = ["victim_1", "victim_2"];
    } else {
      candidateKeys = ["peace_1", "peace_2"];
    }
  }

  const clipId = pickFromPool(candidateKeys, usedClipIds) || "probe_1";
  if (usedClipIds && typeof usedClipIds.add === "function") {
    usedClipIds.add(clipId);
  }

  const meta = clips[clipId] || clips.probe_1;
  const spokenText = meta.text;
  const cleanTarget = typeof targetName === "string" ? targetName.trim() : "";
  const bubbleText =
    meta.needsTargetPrefix && cleanTarget ? `👉 @${cleanTarget}: ${spokenText}` : spokenText;
  const botAudioUrl = `/audio/bots/${safePersonaId}/${clipId}.mp3`;
  const durationMs = getBotClipDurationMs(safePersonaId, clipId, spokenText);

  return {
    personaId: safePersonaId,
    personaLabel: personaEntry.label,
    clipId,
    botAudioUrl,
    spokenText,
    bubbleText,
    durationMs,
  };
}
