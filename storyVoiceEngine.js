import http from "http";
import https from "https";
import { ROLE_LABELS, isWolfTeamRole } from "./roles.js";

export const DEFAULT_VOICE_ID = process.env.VOICESTUDIO_VOICE_ID || "b5d182f3";
export const DEFAULT_TTS_SPEED = 0.82;
const MAX_CACHE_ENTRIES = 320; // ~10MB RAM tối đa, an toàn tuyệt đối cho Render Free 512MB

const WINNER_SUBTITLES = {
  wolf: "Bóng tối đã hoàn toàn nuốt chửng ngôi làng...",
  village: "Ánh sáng công lý đã xua tan nanh vuốt bóng đêm!",
  tanner: "Kẻ chán sống đã thực hiện được tâm nguyện trên giá treo cổ!",
  lovers: "Tình yêu vượt qua ranh giới Sói và Dân, nắm tay nhau sống sót đến cuối cùng!",
};

export const RECAP_OPENING_NARRATION =
  "Bóng đêm dần tan. Hãy cùng quay ngược thời gian, theo chân từng người trong ngôi làng để chứng kiến toàn bộ sự thật phía sau tấm màn bí mật.";

/**
 * Đồng bộ 1:1 với client/src/utils/ttsTextUtils.js:
 * Lọc sạch Emoji & Việt hóa từ viết tắt để OmniVoice không bao giờ phát âm tiếng Anh.
 */
export function normalizeTtsText(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw;

  s = s.replace(/🤖\s*Bots?\s+/giu, "");
  s = s.replace(/[\p{Extended_Pictographic}\uFE00-\uFE0F\u200D]/gu, " ");
  s = s.replace(/[\[\]]/g, "");

  s = s.replace(/\bAI\s*Bots?\b/gi, "người máy");
  s = s.replace(/\bBots?\b/gi, "người máy");
  s = s.replace(/\bMVP\b/gi, "ngôi vương xuất sắc nhất");
  s = s.replace(/\bvote\b/gi, "bỏ phiếu");
  s = s.replace(/\bx2\b/gi, "nhân hai");
  s = s.replace(/\bvs\b/gi, "đối đầu");

  s = s.replace(/[—–•]/g, ", ");
  s = s.replace(/!{2,}/g, "!");
  s = s.replace(/\.{3,}/g, ".");
  s = s.replace(/\s+([,.;:!?])/g, "$1");
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

export function getTtsCacheKey(raw) {
  return normalizeTtsText(raw).toLowerCase();
}

export function getVoiceStudioBaseUrl() {
  const isLocalEnv = !process.env.RENDER && process.env.NODE_ENV !== "production";
  const defaultVsUrl = isLocalEnv
    ? "http://127.0.0.1:3900"
    : "https://cassette-letter-paralegal.ngrok-free.dev";
  return (process.env.VOICESTUDIO_URL || defaultVsUrl).trim();
}

// ── Bộ nhớ đệm LRU MP3 trên RAM Server + Hàng đợi GPU tuần tự 1 luồng ──
const audioLruCache = new Map(); // cacheKey -> Buffer
const inFlightMap = new Map();   // cacheKey -> Promise<Buffer | null>
const gpuQueue = [];             // [{ key, cleanText, voiceId, speed, resolve }]
let workerRunning = false;

let vsHealthState = {
  online: null,
  checkedAt: 0,
};

function getCachedBuffer(key) {
  if (!audioLruCache.has(key)) return null;
  const buf = audioLruCache.get(key);
  // Làm mới thứ tự LRU
  audioLruCache.delete(key);
  audioLruCache.set(key, buf);
  return buf;
}

function setCachedBuffer(key, buf) {
  if (!key || !Buffer.isBuffer(buf) || buf.length < 500) return;
  if (audioLruCache.has(key)) {
    audioLruCache.delete(key);
  } else if (audioLruCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = audioLruCache.keys().next().value;
    if (oldestKey !== undefined) audioLruCache.delete(oldestKey);
  }
  audioLruCache.set(key, buf);
}

export function getCachedMp3ByRawText(rawText) {
  const key = getTtsCacheKey(rawText);
  return key ? getCachedBuffer(key) : null;
}

export async function checkVoiceStudioHealth(force = false) {
  const now = Date.now();
  if (!force && vsHealthState.online !== null && now - vsHealthState.checkedAt < 15000) {
    return vsHealthState.online;
  }
  const vsUrl = getVoiceStudioBaseUrl();
  const ok = await new Promise((resolve) => {
    try {
      const targetUrl = new URL("/health", vsUrl);
      const httpLib = targetUrl.protocol === "https:" ? https : http;
      const req = httpLib.request(
        targetUrl,
        {
          method: "GET",
          headers: {
            "ngrok-skip-browser-warning": "true",
            "User-Agent": "MaSoiOnline-StoryVoiceEngine/3.5",
          },
          timeout: 3500,
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            if (res.statusCode !== 200) return resolve(false);
            try {
              const parsed = JSON.parse(body);
              resolve(["ok", "ready", "starting"].includes(parsed?.status));
            } catch {
              resolve(false);
            }
          });
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });

  vsHealthState = { online: ok, checkedAt: Date.now() };
  return ok;
}

export function getVoiceEngineStatus() {
  return {
    ok: true,
    vsOnline: vsHealthState.online,
    checkedAt: vsHealthState.checkedAt,
    voiceId: DEFAULT_VOICE_ID,
    speed: DEFAULT_TTS_SPEED,
    cachedCount: audioLruCache.size,
    queueLength: gpuQueue.length,
    inFlightCount: inFlightMap.size,
  };
}

function requestVoiceStudioSpeech(cleanText, voiceId, speed) {
  const vsUrl = getVoiceStudioBaseUrl();
  const payload = JSON.stringify({
    model: "omnivoice",
    voice: voiceId || DEFAULT_VOICE_ID,
    input: cleanText,
    response_format: "mp3",
    speed: typeof speed === "number" && speed > 0 && speed <= 2 ? speed : DEFAULT_TTS_SPEED,
  });

  return new Promise((resolve) => {
    try {
      const targetUrl = new URL("/v1/audio/speech", vsUrl);
      const httpLib = targetUrl.protocol === "https:" ? https : http;
      const chunks = [];
      const req = httpLib.request(
        targetUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer local",
            "ngrok-skip-browser-warning": "true",
            "User-Agent": "MaSoiOnline-StoryVoiceEngine/3.5",
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: 18000,
        },
        (res) => {
          const ct = String(res.headers["content-type"] || "").toLowerCase();
          const validAudio =
            res.statusCode === 200 && (ct.includes("audio") || ct.includes("octet-stream"));
          if (!validAudio) {
            res.resume();
            vsHealthState = { online: false, checkedAt: Date.now() };
            return resolve(null);
          }
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const full = Buffer.concat(chunks);
            if (full.length >= 500) {
              vsHealthState = { online: true, checkedAt: Date.now() };
              resolve(full);
            } else {
              resolve(null);
            }
          });
        }
      );
      req.on("error", () => {
        vsHealthState = { online: false, checkedAt: Date.now() };
        resolve(null);
      });
      req.on("timeout", () => {
        req.destroy();
        vsHealthState = { online: false, checkedAt: Date.now() };
        resolve(null);
      });
      req.write(payload);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

async function drainGpuQueue() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (gpuQueue.length > 0) {
      const job = gpuQueue.shift();
      if (!job) continue;
      const existing = getCachedBuffer(job.key);
      if (existing) {
        job.resolve(existing);
        continue;
      }
      // Nếu VoiceStudio vừa báo offline cách đây < 8s thì bỏ qua job nền để tránh nghẽn
      if (
        job.priority === "low" &&
        vsHealthState.online === false &&
        Date.now() - vsHealthState.checkedAt < 8000
      ) {
        job.resolve(null);
        continue;
      }
      const buf = await requestVoiceStudioSpeech(job.cleanText, job.voiceId, job.speed);
      if (buf) {
        setCachedBuffer(job.key, buf);
      }
      job.resolve(buf);
    }
  } finally {
    workerRunning = false;
  }
}

/**
 * Lấy ngay MP3 từ RAM Cache (~0ms) hoặc xếp hàng tạo mới có khử trùng lặp (Deduplication).
 * - priority = "urgent": chèn đầu hàng đợi (cho câu đang cần phát ngay hoặc câu chốt MVP cuối game).
 * - priority = "normal" | "low": xếp cuối hàng đợi (tạo cuốn chiếu ngầm trong trận).
 */
export function getOrGenerateMp3(
  rawText,
  { voice = DEFAULT_VOICE_ID, speed = DEFAULT_TTS_SPEED, priority = "normal" } = {}
) {
  const cleanText = normalizeTtsText(rawText);
  const key = cleanText.toLowerCase();
  if (!cleanText || cleanText.length > 550) {
    return Promise.resolve(null);
  }

  const cached = getCachedBuffer(key);
  if (cached) {
    return Promise.resolve(cached);
  }

  if (inFlightMap.has(key)) {
    return inFlightMap.get(key);
  }

  const voiceId =
    typeof voice === "string" && voice.trim() && voice.trim() !== "alloy"
      ? voice.trim()
      : DEFAULT_VOICE_ID;

  const p = new Promise((resolve) => {
    const job = { key, cleanText, voiceId, speed, priority, resolve };
    if (priority === "urgent") {
      gpuQueue.unshift(job);
    } else {
      gpuQueue.push(job);
    }
    drainGpuQueue();
  }).finally(() => {
    inFlightMap.delete(key);
  });

  inFlightMap.set(key, p);
  return p;
}

const IS_HEADLESS_SIM_TEST =
  process.env.DISABLE_BACKGROUND_TTS === "1" ||
  process.argv.some((a) => String(a).includes("sim_test"));

export function warmPhrasesInBackground(phrases = [], priority = "normal") {
  if (IS_HEADLESS_SIM_TEST) return;
  if (!Array.isArray(phrases) || phrases.length === 0) return;
  for (const raw of phrases) {
    if (!raw || typeof raw !== "string") continue;
    const key = getTtsCacheKey(raw);
    if (!key || audioLruCache.has(key) || inFlightMap.has(key)) continue;
    getOrGenerateMp3(raw, { priority }).catch(() => {});
  }
}

// ── Bộ biên tập kịch bản Replay khớp 1:1 với client/src/components/EndGameRecap.jsx ──
function curateCinematicFramesServer(rawTimeline = []) {
  if (!Array.isArray(rawTimeline) || rawTimeline.length === 0) return [];
  const cleaned = [];
  for (let i = 0; i < rawTimeline.length; i++) {
    const f = rawTimeline[i];
    if (!f || !f.kind) continue;

    if (f.kind === "reaction" && rawTimeline.length > 5) continue;

    if (f.kind === "day_final_vote") {
      const hasVerdictSameDay = rawTimeline
        .slice(i + 1)
        .some((nxt) => nxt.day === f.day && nxt.kind === "day_verdict" && nxt.targetId === f.targetId);
      if (hasVerdictSameDay) continue;

      const nextSameVote = rawTimeline[i + 1];
      if (
        nextSameVote &&
        nextSameVote.day === f.day &&
        nextSameVote.kind === "day_final_vote" &&
        nextSameVote.targetId === f.targetId
      ) {
        continue;
      }
    }

    if (f.kind === "day_nominate") {
      const switched = Boolean(f.prevTargetId && f.prevTargetId !== f.targetId);
      const prevSameDayNom = cleaned.some((c) => c.day === f.day && c.kind === "day_nominate");
      const moreNomSameDayAhead = rawTimeline
        .slice(i + 1)
        .some((nxt) => nxt.day === f.day && nxt.kind === "day_nominate");

      if (!switched && prevSameDayNom && moreNomSameDayAhead) {
        continue;
      }
      cleaned.push({
        ...f,
        _isCollectiveNominationSummary: prevSameDayNom && !moreNomSameDayAhead && !switched,
      });
      continue;
    }

    if (f.kind === "wolf_aim") {
      const nextFrame = rawTimeline[i + 1];
      if (
        nextFrame &&
        nextFrame.day === f.day &&
        nextFrame.kind === "wolf_aim" &&
        nextFrame.actorId === f.actorId
      ) {
        continue;
      }
    }

    cleaned.push(f);
  }
  return cleaned;
}

export function deriveStoryNarrationsFromRoom(room) {
  const g = room?.game;
  if (!g) return [];
  const players = room.players || [];
  const playerById = {};
  const simRoleMap = {};
  players.forEach((p) => {
    playerById[p.id] = p;
    simRoleMap[p.id] = p.initialRole || p.role || "villager";
  });

  const narrations = [RECAP_OPENING_NARRATION];
  const curated = curateCinematicFramesServer(g.replayTimeline || []);

  for (const frame of curated) {
    // Theo đặc tả v3: Bỏ qua hoàn toàn giọng đọc cho các câu chat tự do của người chơi (wolf_chat, village_chat) & reaction
    if (frame.kind === "wolf_chat" || frame.kind === "village_chat" || frame.kind === "reaction") {
      continue;
    }

    if (Array.isArray(frame.wolfIdsNow) && frame.wolfIdsNow.length > 0) {
      const wolfSet = new Set(frame.wolfIdsNow);
      players.forEach((p) => {
        const baseRole = p.initialRole || p.role || "villager";
        simRoleMap[p.id] = wolfSet.has(p.id)
          ? baseRole === "alpha_wolf"
            ? "alpha_wolf"
            : "wolf"
          : baseRole;
      });
    }

    const dayNum = frame.day || 1;
    const actor = frame.actorId ? playerById[frame.actorId] : null;
    const target = frame.targetId ? playerById[frame.targetId] : null;
    const prevTarget = frame.prevTargetId ? playerById[frame.prevTargetId] : null;
    const actorName = actor?.name || "Người chơi";
    const targetName = target?.name || "Mục tiêu";
    const prevName = prevTarget?.name || "Mục tiêu cũ";

    switch (frame.kind) {
      case "guard_pick":
        narrations.push(
          frame.caption ||
            `Giữa màn sương lạnh Đêm ${dayNum}, Bảo Vệ ${actorName} âm thầm hướng ánh mắt về phía ${targetName} và dựng lên vòm khiên hộ mệnh.`
        );
        break;
      case "wolf_aim": {
        const switched = Boolean(frame.prevTargetId && frame.prevTargetId !== frame.targetId);
        narrations.push(
          switched
            ? `Từ góc nhìn của Sói ${actorName}, sau một thoáng chần chừ trước ${prevName}, móng vuốt bất ngờ xoay sang nhắm thẳng vào ${targetName}.`
            : `Từ trong bóng tối, Sói ${actorName} nhe nanh hướng thẳng móng vuốt sắc lạnh về phía chiếc ghế của ${targetName}.`
        );
        break;
      }
      case "wolf_strike":
        narrations.push(
          `Thời khắc định đoạt của Đêm ${dayNum}! Khung hình mở rộng toàn cảnh khi cả đàn Sói đồng loạt phóng móng vuốt đỏ rực chụp xuống ${targetName}!`
        );
        break;
      case "shield_block":
        narrations.push(
          `Đúng khoảnh khắc sinh tử, vòm khiên ánh sáng của ${actorName} bùng nổ hất văng đòn cắn của đàn Sói, giữ toàn mạng cho ${targetName}!`
        );
        break;
      case "witch_save":
        narrations.push(
          `Chứng kiến ${targetName} hấp hối trong đêm, Phù Thủy ${actorName} quyết định tung bình linh dược xanh ngọc quý giá nhất để kéo họ về từ cõi chết.`
        );
        break;
      case "witch_poison":
        narrations.push(
          `Từ phía sau vành mũ bí ẩn, Phù Thủy ${actorName} rút chốt bình độc dược tím sẫm và ném thẳng sang chiếc ghế của ${targetName}!`
        );
        break;
      case "seer_scan": {
        const isWolfResult = frame.decision === "wolf";
        narrations.push(
          isWolfResult
            ? `Qua vai Tiên Tri ${actorName}, luồng sáng pha lê vừa chạm vào ${targetName} lập tức hóa đỏ rực — một con Ma Sói đã lộ diện trong đêm!`
            : `Tiên Tri ${actorName} lặng lẽ chiếu luồng sáng cổ ngữ sang ghế của ${targetName} và nhận được ánh lam hiền hòa của phe Dân Làng.`
        );
        break;
      }
      case "cursed_turn":
        if (frame.targetId) simRoleMap[frame.targetId] = "wolf";
        narrations.push(
          `Sau cú cắn trong đêm, chiếc mặt nạ phong ấn của ${targetName} vỡ vụn! Dòng máu Sói âm ỉ bấy lâu chính thức trỗi dậy.`
        );
        break;
      case "tough_endure":
        narrations.push(
          `Dù trúng đòn chí mạng trong đêm, ý chí sắt đá vẫn giúp ${targetName} gồng mình trụ vững để đón ánh bình minh thêm một ngày nữa!`
        );
        break;
      case "night_death":
        narrations.push(
          `Khi sương mù tan dần bên bếp lửa, cả làng bàng hoàng nhận ra ${targetName} đã mãi mãi ra đi trong đêm qua.`
        );
        break;
      case "peaceful_dawn":
        narrations.push(
          `Ánh nắng sớm mai chiếu rọi khắp ngôi làng — kỳ diệu thay, đêm thứ ${dayNum} khép lại mà không một ai phải ngã xuống!`
        );
        break;
      case "day_nominate": {
        const switched = Boolean(frame.prevTargetId && frame.prevTargetId !== frame.targetId);
        const isCollectiveVote = Boolean(frame._isCollectiveNominationSummary);
        narrations.push(
          isCollectiveVote
            ? `Khung hình mở rộng toàn vòng tròn khi hàng loạt cánh tay trong làng đồng loạt chỉ thẳng về chiếc ghế của ${targetName}!`
            : switched
              ? `Giữa lúc căng thẳng, ${actorName} rút lại lời buộc tội ${prevName} và quay ngoắt sang chỉ mặt ${targetName}!`
              : `Từ góc ghế của mình, ${actorName} đứng thẳng dậy giơ tay đề cử ${targetName} ra trước pháp trường.`
        );
        break;
      }
      case "day_defense":
        narrations.push(
          `Trước hàng chục ánh mắt phán xét của cả làng, ${targetName} nỗ lực cất lời bảo vệ mạng sống của chính mình trên ghế nóng.`
        );
        break;
      case "day_final_vote":
      case "day_verdict": {
        const isHanged = frame.decision === "hang";
        const roleLabel = ROLE_LABELS[frame.targetRole || simRoleMap[frame.targetId]] || "Người chơi";
        narrations.push(
          frame.caption ||
            (isHanged
              ? `Từ góc máy trên cao bao quát pháp trường, những lá phiếu đỏ định mệnh khép lại số phận của ${targetName} — chân tướng lộ diện là ${roleLabel}!`
              : `Những tia sáng xanh khoan hồng chiếm ưu thế trên khắp quảng trường, ${targetName} thoát khỏi giá treo cổ trong gang tấc!`)
        );
        break;
      }
      case "cupid_link": {
        const partnerId = frame.coActorIds?.[0] || null;
        const partnerName = partnerId ? playerById[partnerId]?.name || "Người thương" : "Người thương";
        narrations.push(
          frame.caption ||
            `Giữa Đêm ${dayNum}, mũi tên vàng của ${actorName} bay vút qua ánh lửa, gắn kết vận mệnh sinh tử của ${targetName} và ${partnerName}!`
        );
        break;
      }
      case "alpha_convert":
        if (frame.targetId) simRoleMap[frame.targetId] = "wolf";
        narrations.push(
          frame.caption ||
            `Thay vì kết liễu con mồi, Sói Đầu Đàn ${actorName} truyền dòng máu Huyết Nguyệt biến ${targetName} thành thành viên mới của bầy Sói!`
        );
        break;
      case "lover_heartbreak":
        narrations.push(
          frame.caption ||
            `Không thể chịu đựng nỗi đau mất đi người thương ${actorName}, ${targetName} quỳ sụp xuống và trút hơi thở cuối cùng theo lời thề sinh tử!`
        );
        break;
      case "hunter_shot":
        narrations.push(
          frame.caption ||
            `Dồn chút sinh lực cuối cùng trước khi ngã xuống, Thợ Săn ${actorName} giương nỏ phóng viên đạn bạc xuyên thẳng qua ${targetName}!`
        );
        break;
      case "mayor_reveal":
        narrations.push(
          frame.caption ||
            `Giữa vòng tròn căng thẳng, ${actorName} giơ cao Quyền Trượng Vàng khẳng định quyền uy Trưởng Làng — mọi lá phiếu từ nay mang sức nặng gấp đôi!`
        );
        break;
      default:
        break;
    }
  }

  return narrations;
}

/**
 * Hook 1: Kích hoạt ngay sau khi startGame() đã bù đủ AI Bot.
 * Tạo sẵn câu mở màn Phim Kể Chuyện + bộ câu đơn cá nhân hóa theo đúng ghế thật trong phòng.
 */
export function warmRoomOpeningVoices(room, defenseTimerSec = 60, autoAddedBots = 0) {
  if (!room?.players?.length) return;
  const highPhrases = [RECAP_OPENING_NARRATION];
  if (autoAddedBots > 0) {
    highPhrases.push(
      `🤖 Đã tự động triệu hồi thêm ${autoAddedBots} AI Bot lấp đủ ${room.players.length} ghế. Trò chơi bắt đầu!`
    );
  }

  const normalPhrases = [];
  for (const p of room.players) {
    if (!p?.name) continue;
    const defSec = p.isBot ? 8 : defenseTimerSec;
    normalPhrases.push(`Trời đã sáng. Đêm qua ${p.name} đã không qua khỏi.`);
    normalPhrases.push(`${p.name} bị đề cử nhiều nhất. Mời lần lượt lên biện hộ.`);
    normalPhrases.push(`🎤 Mời ${p.name} lên biện hộ. (${defSec} giây)`);
    normalPhrases.push(`⚖️ Mời cả làng vote cho ${p.name}: Treo cổ hay Tha.`);
    normalPhrases.push(
      `Làng đã quyết định! ${p.name} sẽ rời khỏi ván đấu. Xin hãy giữ im lặng tuyệt đối.`
    );
    normalPhrases.push(`Làng đã tha ${p.name}! Không ai bị xử tử hôm nay.`);

    if (p.role === "hunter") {
      normalPhrases.push(
        `🏹 Khoan đã! Thợ Săn ${p.name} còn 15 giây hơi thở cuối để bóp cò bắn đạn bạc trả thù!`
      );
      normalPhrases.push("🏹 Hết thời gian! Thợ Săn đã gục xuống mà không bóp cò.");
    }
    if (p.role === "mayor") {
      normalPhrases.push(
        `👑 ${p.name} giơ cao Quyền Trượng Vàng công bố thân phận Trưởng Làng — lá phiếu từ nay tính x2!`
      );
    }
  }

  warmPhrasesInBackground(highPhrases, "urgent");
  warmPhrasesInBackground(normalPhrases, "low");
}

/**
 * Hook 2: Chỉ khi Cupid ghép đôi đúng 2 người A & B mới tạo câu Tình Nhân cho cặp đó (Zero-Waste, không đẻ C(15,2)=105 câu thừa).
 */
export function warmCupidLoversVoices(room) {
  const g = room?.game;
  if (!Array.isArray(g?.lovers) || g.lovers.length !== 2) return;
  const pA = room.players.find((p) => p.id === g.lovers[0]);
  const pB = room.players.find((p) => p.id === g.lovers[1]);
  const phrases = [];
  if (pA?.name) {
    phrases.push(
      `💔 Tơ hồng đứt đoạn! Tình Nhân ${pA.name} không chịu nổi nỗi đau đã gục ngã theo!`
    );
  }
  if (pB?.name) {
    phrases.push(
      `💔 Tơ hồng đứt đoạn! Tình Nhân ${pB.name} không chịu nổi nỗi đau đã gục ngã theo!`
    );
  }
  warmPhrasesInBackground(phrases, "normal");
  warmStoryTimelineProgressively(room);
}

/**
 * Hook 3: Chạy cuốn chiếu sau mỗi pha Đêm/Ngày để tạo sẵn toàn bộ giọng đọc Phim Kể Chuyện cuối game (Zero-Leak).
 */
export function warmStoryTimelineProgressively(room) {
  if (!room?.game) return;
  const narrations = deriveStoryNarrationsFromRoom(room);
  warmPhrasesInBackground(narrations, "normal");
}

/**
 * Hook 4: Ngay khoảnh khắc Kết Game (endGame), đẩy câu vinh danh MVP lên đầu hàng đợi ưu tiên cao nhất.
 */
export function warmEndGameFinaleVoice(room) {
  const g = room?.game;
  if (!g) return;
  const awards = g.awards || [];
  const winner = g.winner || "village";
  const mvpAward = awards.find((a) => a.id === "mvp") || awards[0] || null;
  const finaleNarration = mvpAward
    ? `Khép lại câu chuyện sinh tử, ngôi vương MVP thuộc về ${mvpAward.name}. ${mvpAward.description}`
    : WINNER_SUBTITLES[winner] || "Trận đấu đã khép lại!";

  warmPhrasesInBackground([RECAP_OPENING_NARRATION, finaleNarration], "urgent");
  warmStoryTimelineProgressively(room);
}
