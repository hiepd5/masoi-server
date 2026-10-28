import "./envLoader.js";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import {
  createRoom,
  canCreateNewRoom,
  hasValidActiveSessionToken,
  getRoom,
  addPlayer,
  addSpectator,
  findOrCreateQuickMatchRoom,
  reconnectByToken,
  removePlayer,
  renamePlayer,
  setPlayerCitizenModel,
  toggleReady,
  setRolesConfig,
  setScenePreset,
  setRoomAccess,
  setRoomTurbo,
  setRoomMcPacingMode,
  setSoloPracticeRole,
  addBotsToRoom,
  clearBotsFromRoom,
  getPublicRoomsList,
  addLobbyMessage,
  publicRoomView,
  publicSpectatorView,
  getGlobalServerRuntimeMetrics,
} from "./rooms.js";
import {
  getVietnamGoldenHourInfo,
  recordPlayerReport,
  getModerationStats,
} from "./moderationAndStats.js";
import {
  IS_PRODUCTION_ENV,
  MAX_CHAT_LENGTH,
  isOriginAllowed,
  extractClientIp,
  checkIpRateLimit,
  getPasswordLockRemainingSec,
  recordPasswordFailure,
  clearPasswordFailures,
  sanitizeChatText,
  checkSocketCooldown,
  isSafeReactionEmoji,
} from "./securityGuard.js";

import { createGameController } from "./gameController.js";
import { isWolfTeamRole, generateExpandedV33Roles } from "./roles.js";
import {
  DEFAULT_VOICE_ID,
  DEFAULT_TTS_SPEED,
  getOrGenerateMp3,
  getCachedMp3ByRawText,
  warmPhrasesInBackground,
  checkVoiceStudioHealth,
  getVoiceEngineStatus,
} from "./storyVoiceEngine.js";
import {
  setupDevPhaseHook,
  registerDevSocketHandlers,
  checkBotVoteConsensus,
} from "./devSandbox.js";
import {
  DEFAULT_STUN_SERVERS,
  registerVoiceRelaySocketHandlers,
  removeSocketFromVoiceRelay,
  getVoiceRelayRuntimeStats,
} from "./voiceRelayHub.js";
import { AccessToken } from "livekit-server-sdk";
import https from "https";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_DIR = path.resolve(__dirname, "../client/public/config");
const VILLAGE_LAYOUT_PATH = path.join(CONFIG_DIR, "village_layout.json");
const PRESETS_DIR = path.join(CONFIG_DIR, "presets");
const PRESETS_INDEX_PATH = path.join(CONFIG_DIR, "scene_presets_index.json");
const LAYOUT_BACKUPS_DIR = path.resolve(__dirname, "../data/layout_backups");
const VILLAGE_LAYOUT_BACKUP_PATH = path.join(LAYOUT_BACKUPS_DIR, "village_layout.backup.json");
const LEGACY_PUBLIC_BACKUP_PATH = path.join(CONFIG_DIR, "village_layout.backup.json");
const SYNC_TRIPO_SCRIPT_PATH = path.resolve(__dirname, "../scripts/optimize_tripo_web.mjs");
const CONCEPTS_MANIFEST_PATH = path.resolve(
  __dirname,
  "../client/public/models/props/concepts_manifest.json"
);

// Tự động dọn file .backup.json cũ ra khỏi client/public/config/ sang data/layout_backups/ để thư mục Web sạch 100%
try {
  if (fs.existsSync(LEGACY_PUBLIC_BACKUP_PATH)) {
    fs.mkdirSync(LAYOUT_BACKUPS_DIR, { recursive: true });
    fs.copyFileSync(LEGACY_PUBLIC_BACKUP_PATH, VILLAGE_LAYOUT_BACKUP_PATH);
    fs.unlinkSync(LEGACY_PUBLIC_BACKUP_PATH);
  }
} catch {
  // ignore
}

function readScenePresetsIndexSafe() {
  const defaultBuiltIn = {
    id: "nordic_village_v3",
    name: "🌲 Làng Bắc Âu V3 (Chuẩn 141 thực thể)",
    description: "Bối cảnh rừng thông Bắc Âu sương mù, nhà gỗ & lửa trại mặc định (Bản Lề V3)",
    url: "/config/village_layout.json",
    builtIn: true,
    nodeCount: 141,
    moodHint: "auto",
  };
  try {
    if (fs.existsSync(PRESETS_INDEX_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PRESETS_INDEX_PATH, "utf8"));
      const list = Array.isArray(raw?.presets) ? raw.presets : [];
      if (!list.some((p) => p.id === "nordic_village_v3")) {
        list.unshift(defaultBuiltIn);
      }
      return {
        schemaVersion: 1,
        defaultPresetId: raw?.defaultPresetId || "nordic_village_v3",
        updatedAtIso: new Date().toISOString(),
        presets: list,
      };
    }
  } catch {
    // fallback below
  }
  return {
    schemaVersion: 1,
    defaultPresetId: "nordic_village_v3",
    updatedAtIso: new Date().toISOString(),
    presets: [defaultBuiltIn],
  };
}

function writeScenePresetsIndexSafe(indexDoc) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const payload = {
    schemaVersion: 1,
    defaultPresetId: indexDoc.defaultPresetId || "nordic_village_v3",
    updatedAtIso: new Date().toISOString(),
    presets: indexDoc.presets || [],
  };
  fs.writeFileSync(PRESETS_INDEX_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return payload;
}

function slugifyPresetId(raw) {
  const cleaned = String(raw || "custom_scene")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 44);
  const base = cleaned || `scene_${Date.now().toString(36).slice(-5)}`;
  return base.startsWith("preset_") ? base : `preset_${base}`;
}

// SEC-01 FIX: Đọc 100% khóa LiveKit từ biến môi trường (.env / Render Environment), xóa sạch fallback nhạy cảm trong source!
const LIVEKIT_URL = String(
  process.env.LIVEKIT_URL || "wss://ma-soi-online-rac6j8ri.livekit.cloud"
).trim();
const LIVEKIT_API_KEY = String(process.env.LIVEKIT_API_KEY || "").trim();
const LIVEKIT_API_SECRET = String(process.env.LIVEKIT_API_SECRET || "").trim();

// LiveKit health check cache (45s TTL — xác thực thật qua /rtc/validate bằng JWT ngắn hạn 30s)
let livekitHealthCache = {
  ok: false,
  configured: Boolean(LIVEKIT_API_KEY && LIVEKIT_API_SECRET && LIVEKIT_URL),
  reason: "UNCHECKED",
  checkedAt: 0,
  message: null,
};
const LIVEKIT_HEALTH_TTL = 45_000;

async function checkLivekitHealth(force = false) {
  const now = Date.now();
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
    livekitHealthCache = {
      ok: false,
      configured: false,
      reason: "LIVEKIT_NOT_CONFIGURED",
      checkedAt: now,
      message: null,
    };
    return livekitHealthCache;
  }

  if (!force && livekitHealthCache.checkedAt > 0 && now - livekitHealthCache.checkedAt < LIVEKIT_HEALTH_TTL) {
    return livekitHealthCache;
  }

  let probeJwt = "";
  try {
    const probeToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: "srv_health_probe",
      ttl: "30s",
    });
    probeToken.addGrant({
      roomJoin: true,
      room: "_srv_health_probe",
      canPublish: false,
      canPublishData: false,
      canSubscribe: false,
    });
    probeJwt = await probeToken.toJwt();
  } catch (err) {
    livekitHealthCache = {
      ok: false,
      configured: true,
      reason: "LIVEKIT_AUTH_INVALID",
      checkedAt: Date.now(),
      message: err?.message || null,
    };
    return livekitHealthCache;
  }

  return new Promise((resolve) => {
    const httpUrl =
      LIVEKIT_URL.replace(/^wss?:\/\//, "https://").replace(/\/+$/, "") +
      `/rtc/validate?access_token=${encodeURIComponent(probeJwt)}&protocol=11`;

    let settled = false;
    const finish = (nextState) => {
      if (settled) return;
      settled = true;
      livekitHealthCache = nextState;
      resolve(livekitHealthCache);
    };

    const req = https.get(httpUrl, { timeout: 4500 }, (res) => {
      const code = Number(res.statusCode || 0);
      let body = "";
      res.on("data", (d) => {
        if (body.length < 512) body += d;
      });
      res.on("end", () => {
        if (code >= 200 && code < 300) {
          finish({
            ok: true,
            configured: true,
            reason: "healthy",
            checkedAt: Date.now(),
            message: null,
          });
        } else if (code === 429) {
          finish({
            ok: false,
            configured: true,
            reason: "LIVEKIT_QUOTA_EXCEEDED",
            checkedAt: Date.now(),
            message: body.trim() || null,
          });
        } else if (code === 401 || code === 403) {
          finish({
            ok: false,
            configured: true,
            reason: "LIVEKIT_AUTH_INVALID",
            checkedAt: Date.now(),
            message: body.trim() || null,
          });
        } else {
          finish({
            ok: false,
            configured: true,
            reason: "LIVEKIT_UNREACHABLE",
            checkedAt: Date.now(),
            message: `HTTP_${code}`,
          });
        }
      });
    });

    req.on("error", (err) => {
      finish({
        ok: false,
        configured: true,
        reason: "LIVEKIT_UNREACHABLE",
        checkedAt: Date.now(),
        message: err?.code || "NETWORK_ERROR",
      });
    });

    req.on("timeout", () => {
      req.destroy();
      finish({
        ok: false,
        configured: true,
        reason: "LIVEKIT_UNREACHABLE",
        checkedAt: Date.now(),
        message: "TIMEOUT",
      });
    });
  });
}

const app = express();
app.set("trust proxy", 1);
app.use(
  cors({
    origin: (origin, cb) => {
      if (isOriginAllowed(origin)) return cb(null, true);
      return cb(new Error("Origin blocked by Ma Soi Zero-Trust CORS"));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-game-session", "x-admin-key"],
    exposedHeaders: ["X-TTS-Voice", "X-TTS-Cache"],
  })
);
// Riêng công cụ D5 Studio nội bộ trên máy Dev được nhận payload cảnh quan tới 1MB; toàn bộ API công khai giới hạn <= 64KB bảo vệ 512MB RAM Render
app.use("/api/dev", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "64kb" }));

function isLocalDevRequest(req) {
  // SEC-06: Khóa cứng 100% trên Render / Production & bắt buộc bật cờ ALLOW_LOCAL_STUDIO="1"
  if (IS_PRODUCTION_ENV || process.env.ALLOW_LOCAL_STUDIO !== "1") return false;
  const ip = String(req.ip || req.socket?.remoteAddress || "");
  const host = String(req.headers.host || "").toLowerCase();
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1")
  );
}

function isAuthorizedTtsRequest(req) {
  if (isLocalDevRequest(req)) return true;
  const sessionToken = String(req.headers["x-game-session"] || "").trim();
  return hasValidActiveSessionToken(sessionToken);
}

// Health check — Render dùng để verify server alive
app.get("/", (req, res) =>
  res.json({
    status: "ok",
    game: "Ma Soi Online",
    version: "4.2.0",
    uptime: process.uptime(),
  })
);

// Khung Giờ Vàng Đêm Huyết Nguyệt (20:00 – 23:00 UTC+7 tính theo đồng hồ Server — Chốt #9)
app.get("/api/golden-hour", (req, res) => {
  return res.json({
    ok: true,
    ...getVietnamGoldenHourInfo(),
  });
});

// Bảng chỉ số vận hành & văn minh cộng đồng dành cho Chủ dự án (/api/admin/stats)
app.get("/api/admin/stats", (req, res) => {
  const clientIp = extractClientIp(req);
  if (!checkIpRateLimit("admin_stats", clientIp, 30, 60_000).allowed) {
    return res.status(429).json({ ok: false, error: "Too many admin stats requests" });
  }

  const configuredKey = String(process.env.ADMIN_STATS_KEY || "").trim();
  const providedKey = String(req.headers["x-admin-key"] || req.query?.key || "").trim();

  if (IS_PRODUCTION_ENV) {
    if (!configuredKey || providedKey !== configuredKey) {
      return res.status(403).json({ ok: false, error: "Forbidden admin stats endpoint" });
    }
  } else if (configuredKey && providedKey && providedKey !== configuredKey) {
    return res.status(403).json({ ok: false, error: "Invalid admin stats key" });
  }

  const mem = process.memoryUsage();
  return res.json({
    ok: true,
    version: "4.2.0",
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssMB: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
      heapUsedMB: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
    },
    runtime: getGlobalServerRuntimeMetrics(),
    goldenHour: getVietnamGoldenHourInfo(),
    voiceStudio: getVoiceEngineStatus(),
    voiceRelay: getVoiceRelayRuntimeStats(),
    moderation: getModerationStats(),
  });
});

// Trạng thái VoiceStudio & bộ nhớ đệm StoryVoiceEngine (cho phép HUD báo chấm Online/Offline)
app.get("/api/tts-status", async (req, res) => {
  const clientIp = extractClientIp(req);
  const allowForce =
    req.query?.force === "1" && checkIpRateLimit("tts_probe", clientIp, 6, 60_000).allowed;
  await checkVoiceStudioHealth(allowForce);
  return res.json(getVoiceEngineStatus());
});

// Chẩn đoán công khai trạng thái Kênh Thoại Đôi (LiveKit Cloud SFU + P2P Mesh Fallback — 0% lộ khóa bí mật)
app.get("/api/voice-status", async (req, res) => {
  const clientIp = extractClientIp(req);
  const allowForce =
    req.query?.force === "1" && checkIpRateLimit("voice_probe", clientIp, 6, 60_000).allowed;
  const health = await checkLivekitHealth(allowForce);
  return res.json({
    ok: true,
    recommendedMode: health.ok ? "livekit" : "p2p",
    livekitConfigured: Boolean(LIVEKIT_API_KEY && LIVEKIT_API_SECRET && LIVEKIT_URL),
    livekitHealthy: Boolean(health.ok),
    livekitStatus: health.reason || "UNKNOWN",
    p2pFallbackReady: true,
    stunCount: DEFAULT_STUN_SERVERS.length,
    relay: getVoiceRelayRuntimeStats(),
  });
});

// ── TTS Proxy + LRU RAM Cache (SEC-02: Xác thực phiên chơi thật + Rate-Limit bảo vệ GPU RTX 3090 tại nhà) ──
app.post("/api/tts", async (req, res) => {
  if (!isAuthorizedTtsRequest(req)) {
    return res.status(401).json({ error: "Unauthorized game session" });
  }
  const clientIp = extractClientIp(req);
  if (!checkIpRateLimit("tts_total", clientIp, 60, 60_000).allowed) {
    return res.status(429).json({ error: "Too many TTS requests" });
  }

  const { text, voice, speed } = req.body || {};
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Missing or empty text" });
  }
  if (text.length > 550) {
    return res.status(400).json({ error: "Text too long (max 550 chars)" });
  }

  const ttsSpeed = typeof speed === "number" && speed > 0 && speed <= 2 ? speed : DEFAULT_TTS_SPEED;
  const ttsVoice =
    typeof voice === "string" && voice.trim() && voice.trim() !== "alloy"
      ? voice.trim()
      : DEFAULT_VOICE_ID;

  res.setHeader("Access-Control-Expose-Headers", "X-TTS-Voice, X-TTS-Cache");

  const cachedNow = getCachedMp3ByRawText(text);
  if (cachedNow) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-TTS-Voice", ttsVoice);
    res.setHeader("X-TTS-Cache", "HIT");
    return res.end(cachedNow);
  }

  // Chỉ trừ hạn mức GPU khi câu chưa có trong RAM Cache (cần đẩy về RTX 3090 tại nhà)
  const gpuLim = checkIpRateLimit("tts_gpu_miss", clientIp, 15, 60_000);
  if (!gpuLim.allowed) {
    return res.status(429).json({ error: `Rate limit GPU TTS (${gpuLim.retryAfterSec}s)` });
  }

  const buf = await getOrGenerateMp3(text, {
    voice: ttsVoice,
    speed: ttsSpeed,
    priority: "urgent",
  });
  if (!buf) {
    return res.status(502).json({
      error: "VoiceStudio offline or not ready",
      vsOnline: false,
    });
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-TTS-Voice", ttsVoice);
  res.setHeader("X-TTS-Cache", "MISS");
  return res.end(buf);
});

// API Tự động quét kho phụ kiện/tạo hình .GLB từ Tripo AI
const ROLE_MODELS_DIR = path.resolve(__dirname, "../client/public/models/roles");
const ROLE_MANIFEST_PATH = path.join(ROLE_MODELS_DIR, "roles_manifest.json");

app.get("/api/role-models", (req, res) => {
  try {
    fs.mkdirSync(ROLE_MODELS_DIR, { recursive: true });
    const files = fs.readdirSync(ROLE_MODELS_DIR);
    const roles = {};
    files.forEach((f) => {
      const m = /^role_([a-z0-9_]+)\.glb$/i.exec(f);
      if (m) {
        const key = m[1].toLowerCase();
        roles[key] = `/models/roles/${f}`;
      }
    });
    if (isLocalDevRequest(req)) {
      const manifestDoc = {
        schemaVersion: 1,
        updatedAtIso: new Date().toISOString(),
        note: "Thả file role_<key>.glb từ Tripo AI vào cùng thư mục này — Hệ thống sẽ tự động nhận diện và gắn lên nhân vật 3D!",
        roles,
      };
      fs.writeFileSync(ROLE_MANIFEST_PATH, JSON.stringify(manifestDoc, null, 2) + "\n", "utf8");
    }
    return res.json({ ok: true, roles });
  } catch {
    return res.json({ ok: true, roles: {} });
  }
});

// API Tự động quét Kho Nhân Vật Có Xương Auto-Rig .GLB
const CHARACTER_MODELS_DIR = path.resolve(__dirname, "../client/public/models/characters");
const CHARACTER_MANIFEST_PATH = path.join(CHARACTER_MODELS_DIR, "characters_manifest.json");

app.get("/api/character-models", (req, res) => {
  try {
    fs.mkdirSync(CHARACTER_MODELS_DIR, { recursive: true });
    const files = fs.readdirSync(CHARACTER_MODELS_DIR);
    const characters = {};
    files.forEach((f) => {
      const m = /^char_([a-z0-9_]+)\.glb$/i.exec(f);
      if (m) {
        const key = m[1].toLowerCase();
        characters[key] = `/models/characters/${f}`;
      }
    });
    if (isLocalDevRequest(req)) {
      const manifestDoc = {
        schemaVersion: 1,
        updatedAtIso: new Date().toISOString(),
        note: "Kho file char_<key>.glb có xương Auto-Rig từ Tripo AI — Engine tự động gập chân ngồi ghế 0.48m và diễn hoạt Đầu/Lưng/Tay!",
        characters,
      };
      fs.writeFileSync(CHARACTER_MANIFEST_PATH, JSON.stringify(manifestDoc, null, 2) + "\n", "utf8");
    }
    return res.json({ ok: true, characters });
  } catch {
    return res.json({ ok: true, characters: {} });
  }
});

// API Tự động quét Kho Đạo Cụ Cầm Tay Gắn Xương .GLB
const HAND_PROPS_DIR = path.resolve(__dirname, "../client/public/models/hand_props");
const HAND_PROPS_MANIFEST_PATH = path.join(HAND_PROPS_DIR, "hand_props_manifest.json");

app.get("/api/hand-prop-models", (req, res) => {
  try {
    fs.mkdirSync(HAND_PROPS_DIR, { recursive: true });
    const files = fs.readdirSync(HAND_PROPS_DIR);
    const handProps = {};
    files.forEach((f) => {
      const m = /^prop_hand_([a-z0-9_]+)\.glb$/i.exec(f);
      if (m) {
        const key = m[1].toLowerCase();
        handProps[key] = `/models/hand_props/${f}`;
      }
    });
    if (isLocalDevRequest(req)) {
      const manifestDoc = {
        schemaVersion: 1,
        updatedAtIso: new Date().toISOString(),
        note: "6 Dao cu cam tay gan xuong nhan vat (Khiên, Bình Cứu, Bình Độc, Cầu Tiên Tri, Đuốc, Thừng)!",
        handProps,
      };
      fs.writeFileSync(HAND_PROPS_MANIFEST_PATH, JSON.stringify(manifestDoc, null, 2) + "\n", "utf8");
    }
    return res.json({ ok: true, handProps });
  } catch {
    return res.json({ ok: true, handProps: {} });
  }
});

// API Nội Bộ Dev (D5 Architect Studio)
app.post("/api/dev/village-layout", (req, res) => {
  if (!isLocalDevRequest(req)) {
    return res.status(403).json({ ok: false, error: "Chỉ cho phép lưu bố cục trên máy Dev Local." });
  }
  try {
    const body = req.body;
    if (!body || !Array.isArray(body.nodes) || body.nodes.length === 0) {
      return res.status(400).json({ ok: false, error: "Dữ liệu nodes[] không hợp lệ." });
    }
    const safeNodes = body.nodes.filter((n) => n && n.type && n.type !== "prop_chair");

    fs.mkdirSync(path.dirname(VILLAGE_LAYOUT_PATH), { recursive: true });
    fs.mkdirSync(LAYOUT_BACKUPS_DIR, { recursive: true });
    if (fs.existsSync(VILLAGE_LAYOUT_PATH)) {
      fs.copyFileSync(VILLAGE_LAYOUT_PATH, VILLAGE_LAYOUT_BACKUP_PATH);
    }

    const doc = {
      schemaVersion: Number(body.schemaVersion || 1),
      updatedAtMs: Date.now(),
      updatedAtIso: new Date().toISOString(),
      note:
        body.note ||
        "Bố cục không gian Làng Ma Sói 3D được dàn dựng bằng D5 Architect Studio (Không tác động ghế ngồi người chơi)",
      totalNodes: safeNodes.length,
      nodes: safeNodes,
    };

    fs.writeFileSync(VILLAGE_LAYOUT_PATH, JSON.stringify(doc, null, 2) + "\n", "utf8");

    const indexDoc = readScenePresetsIndexSafe();
    indexDoc.presets = indexDoc.presets.map((p) =>
      p.id === "nordic_village_v3"
        ? { ...p, nodeCount: safeNodes.length, updatedAtIso: doc.updatedAtIso }
        : p
    );
    writeScenePresetsIndexSafe(indexDoc);

    return res.json({
      ok: true,
      savedCount: safeNodes.length,
      filePath: "client/public/config/village_layout.json",
      presetsIndex: indexDoc,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/dev/scene-presets", (req, res) => {
  if (!isLocalDevRequest(req)) {
    return res.status(403).json({ ok: false, error: "Chỉ cho phép quản lý bối cảnh trên máy Dev Local." });
  }
  try {
    const body = req.body || {};
    if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
      return res.status(400).json({ ok: false, error: "Danh sách nodes[] của bối cảnh không được rỗng." });
    }
    const safeNodes = body.nodes.filter((n) => n && n.type && n.type !== "prop_chair");
    const isBuiltInV3 = body.presetId === "nordic_village_v3";
    const finalId = isBuiltInV3
      ? "nordic_village_v3"
      : slugifyPresetId(body.presetId || body.name || "boi_canh_moi");

    const targetFilePath = isBuiltInV3
      ? VILLAGE_LAYOUT_PATH
      : path.join(PRESETS_DIR, `${finalId}.json`);
    const publicUrl = isBuiltInV3
      ? "/config/village_layout.json"
      : `/config/presets/${finalId}.json`;

    fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
    fs.mkdirSync(LAYOUT_BACKUPS_DIR, { recursive: true });
    if (fs.existsSync(targetFilePath)) {
      fs.copyFileSync(
        targetFilePath,
        path.join(LAYOUT_BACKUPS_DIR, `${finalId}.backup.json`)
      );
    }

    const indexDoc = readScenePresetsIndexSafe();
    const existingMeta = indexDoc.presets.find((p) => p.id === finalId) || null;
    const finalName =
      (typeof body.name === "string" && body.name.trim()) ||
      existingMeta?.name ||
      `🗺️ Bối cảnh ${finalId.replace(/^preset_/, "")}`;
    const finalDescription =
      (typeof body.description === "string" && body.description.trim()) ||
      existingMeta?.description ||
      "Bối cảnh tùy chọn dàn dựng bằng D5 Studio & Kho Concept Tripo";
    const finalMoodHint = body.moodHint || existingMeta?.moodHint || "auto";

    const doc = {
      schemaVersion: Number(body.schemaVersion || 1),
      presetId: finalId,
      name: finalName,
      description: finalDescription,
      moodHint: finalMoodHint,
      updatedAtMs: Date.now(),
      updatedAtIso: new Date().toISOString(),
      note: "Bối cảnh không gian 3D Làng Ma Sói dàn dựng bằng D5 Architect Studio (Không tác động ghế người chơi)",
      totalNodes: safeNodes.length,
      nodes: safeNodes,
    };

    fs.writeFileSync(targetFilePath, JSON.stringify(doc, null, 2) + "\n", "utf8");

    const upsertedMeta = {
      id: finalId,
      name: finalName,
      description: finalDescription,
      url: publicUrl,
      builtIn: isBuiltInV3,
      nodeCount: safeNodes.length,
      moodHint: finalMoodHint,
      updatedAtIso: doc.updatedAtIso,
    };

    if (existingMeta) {
      indexDoc.presets = indexDoc.presets.map((p) => (p.id === finalId ? upsertedMeta : p));
    } else {
      indexDoc.presets.push(upsertedMeta);
    }

    if (body.setAsDefault === true) {
      indexDoc.defaultPresetId = finalId;
    }

    const savedIndex = writeScenePresetsIndexSafe(indexDoc);
    return res.json({
      ok: true,
      savedCount: safeNodes.length,
      preset: upsertedMeta,
      presetsIndex: savedIndex,
      filePath: isBuiltInV3
        ? "client/public/config/village_layout.json"
        : `client/public/config/presets/${finalId}.json`,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/dev/scene-presets/:presetId", (req, res) => {
  if (!isLocalDevRequest(req)) {
    return res.status(403).json({ ok: false, error: "Chỉ cho phép xóa bối cảnh trên máy Dev Local." });
  }
  try {
    const rawId = String(req.params.presetId || "").trim();
    if (!rawId || rawId === "nordic_village_v3") {
      return res.status(400).json({
        ok: false,
        error: "Bản Lề V3 gốc (nordic_village_v3) được bảo vệ bất khả xâm phạm, không thể xóa!",
      });
    }
    const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
    const targetFilePath = path.join(PRESETS_DIR, `${safeId}.json`);
    if (fs.existsSync(targetFilePath)) {
      fs.mkdirSync(LAYOUT_BACKUPS_DIR, { recursive: true });
      fs.copyFileSync(targetFilePath, path.join(LAYOUT_BACKUPS_DIR, `${safeId}.deleted.json`));
      fs.unlinkSync(targetFilePath);
    }

    const indexDoc = readScenePresetsIndexSafe();
    indexDoc.presets = indexDoc.presets.filter((p) => p.id !== safeId);
    if (indexDoc.defaultPresetId === safeId) {
      indexDoc.defaultPresetId = "nordic_village_v3";
    }
    const savedIndex = writeScenePresetsIndexSafe(indexDoc);
    return res.json({ ok: true, deletedId: safeId, presetsIndex: savedIndex });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/dev/sync-tripo-concepts", (req, res) => {
  if (!isLocalDevRequest(req)) {
    return res.status(403).json({ ok: false, error: "Chỉ cho phép quét kho Tripo trên máy Dev Local." });
  }
  execFile(
    process.execPath,
    [SYNC_TRIPO_SCRIPT_PATH],
    { cwd: path.resolve(__dirname, ".."), timeout: 90000 },
    (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({
          ok: false,
          error: stderr || err.message || "Lỗi chạy sync_tripo_models.mjs",
        });
      }
      let manifest = { totalConcepts: 0, items: [] };
      try {
        if (fs.existsSync(CONCEPTS_MANIFEST_PATH)) {
          manifest = JSON.parse(fs.readFileSync(CONCEPTS_MANIFEST_PATH, "utf8"));
        }
      } catch {
        // ignore
      }
      return res.json({
        ok: true,
        totalConcepts: manifest.totalConcepts || 0,
        items: manifest.items || [],
        log: String(stdout || "").trim(),
      });
    }
  );
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => {
      if (isOriginAllowed(origin)) return cb(null, true);
      return cb(new Error("Socket Origin blocked by Ma Soi Zero-Trust CORS"));
    },
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 64 * 1024,
});

function broadcastRoomsList() {
  io.emit("lobby:roomsUpdate", getPublicRoomsList());
}

function broadcastRoom(room) {
  room.players.forEach((p) => {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit("room:update", publicRoomView(room, p.socketId));
    }
  });
  (room.spectators || []).forEach((s) => {
    if (s.connected && s.socketId) {
      io.to(s.socketId).emit("room:update", publicSpectatorView(room, s.socketId));
    }
  });
  broadcastRoomsList();
}

const gameCtrl = createGameController(io);
setupDevPhaseHook(gameCtrl, io);
gameCtrl.setRoomListHook(() => broadcastRoomsList());

io.on("connection", (socket) => {
  const clientIp = extractClientIp(socket);
  console.log("Kết nối mới:", socket.id);
  socket.emit("lobby:roomsUpdate", getPublicRoomsList());

  socket.on("lobby:getRooms", (_, cb) => {
    cb?.({ ok: true, rooms: getPublicRoomsList() });
  });

  // Heartbeat: ping mỗi 30s, kick sau 60s không pong
  let missedPings = 0;
  const heartbeatInterval = setInterval(() => {
    if (missedPings >= 2) {
      clearInterval(heartbeatInterval);
      socket.disconnect(true);
      return;
    }
    missedPings++;
    socket.emit("ping:server");
  }, 30000);

  socket.on("pong:client", () => {
    missedPings = 0;
  });

  socket.on("room:create", (payload = {}, cb) => {
    // SEC-04: Giới hạn tạo phòng <= 4 phòng/phút/IP & trần 150 phòng bảo vệ 512MB RAM Render
    const createLim = checkIpRateLimit("room_create", clientIp, 4, 60_000);
    if (!createLim.allowed) {
      return cb?.({
        ok: false,
        error: `Bạn tạo phòng quá nhanh! Vui lòng đợi ${createLim.retryAfterSec} giây.`,
      });
    }
    if (!canCreateNewRoom()) {
      return cb?.({
        ok: false,
        error: "Máy chủ đang đầy bàn chơi (150 phòng). Mời bạn tham gia các bàn đang mở trên Sảnh!",
      });
    }

    const {
      name,
      avatarSeed,
      avatarUrl,
      citizenModelId = null,
      roomTitle,
      accessMode = "public",
      password = "",
      isTurbo = false,
      soloQuickStart = false,
      deviceId = null,
    } = payload || {};

    if (accessMode === "password" && !String(password || "").trim()) {
      cb?.({ ok: false, error: "Vui lòng nhập mật khẩu cho phòng khóa!" });
      return;
    }

    const room = createRoom(socket.id, { roomTitle, accessMode, password, isTurbo });
    const { room: joinedRoom, player } = addPlayer(
      room.code,
      socket.id,
      name || null,
      avatarSeed || null,
      avatarUrl || null,
      password,
      { deviceId, citizenModelId }
    );

    if (soloQuickStart) {
      joinedRoom.rolesConfig = generateExpandedV33Roles(8);
      addBotsToRoom(joinedRoom.code, 7);
    }

    socket.join(joinedRoom.code);
    socket.data.roomCode = joinedRoom.code;
    socket.data.playerId = player.id;
    cb?.({
      ok: true,
      roomCode: joinedRoom.code,
      playerId: player.id,
      sessionToken: player.sessionToken,
    });
    broadcastRoom(joinedRoom);
  });

  socket.on("room:reconnect", ({ roomCode, sessionToken } = {}, cb) => {
    const result = reconnectByToken(roomCode, sessionToken, socket.id);
    if (result.error) {
      cb?.({ ok: false, error: result.error });
      return;
    }
    socket.join(result.room.code);
    socket.data.roomCode = result.room.code;
    if (result.isSpectator && result.spectator) {
      socket.data.playerId = result.spectator.id;
      socket.data.isSpectator = true;
      cb?.({
        ok: true,
        isSpectator: true,
        roomCode: result.room.code,
        playerId: result.spectator.id,
        sessionToken: result.spectator.sessionToken,
      });
    } else {
      socket.data.playerId = result.player.id;
      socket.data.isSpectator = false;
      cb?.({
        ok: true,
        roomCode: result.room.code,
        playerId: result.player.id,
        sessionToken: result.player.sessionToken,
      });
    }
    broadcastRoom(result.room);
  });

  socket.on("room:quickMatch", (payload = {}, cb) => {
    // SEC-04: Chống spam nhấn Ghép Bàn Nhanh liên tục (<= 6 lần/phút/IP)
    const qmLim = checkIpRateLimit("quick_match", clientIp, 6, 60_000);
    if (!qmLim.allowed) {
      return cb?.({
        ok: false,
        error: `Bạn thao tác quá nhanh! Vui lòng đợi ${qmLim.retryAfterSec} giây.`,
      });
    }
    const {
      name = null,
      avatarSeed = null,
      avatarUrl = null,
      citizenModelId = null,
      preferTurbo = false,
      deviceId = null,
    } = payload || {};

    const res = findOrCreateQuickMatchRoom(socket.id, {
      name,
      avatarSeed,
      avatarUrl,
      citizenModelId,
      preferTurbo,
      deviceId,
    });
    if (res.error) {
      return cb?.({ ok: false, error: res.error });
    }
    socket.join(res.room.code);
    socket.data.roomCode = res.room.code;
    socket.data.playerId = res.player.id;
    socket.data.isSpectator = false;
    cb?.({
      ok: true,
      matchedExisting: Boolean(res.matchedExisting),
      roomCode: res.room.code,
      playerId: res.player.id,
      sessionToken: res.player.sessionToken,
    });
    broadcastRoom(res.room);
  });

  socket.on("room:spectate", ({ roomCode, name, avatarSeed, avatarUrl, citizenModelId, password, deviceId } = {}, cb) => {
    const lockSec = getPasswordLockRemainingSec(clientIp);
    if (lockSec > 0) {
      return cb?.({
        ok: false,
        error: `Bạn nhập sai mật khẩu quá nhiều lần! Vui lòng thử lại sau ${lockSec} giây.`,
        requirePassword: true,
      });
    }
    const res = addSpectator(
      roomCode,
      socket.id,
      name,
      avatarSeed || null,
      avatarUrl || null,
      password || "",
      { deviceId, citizenModelId }
    );
    if (res.error) {
      if (res.passwordFailed) {
        const penaltySec = recordPasswordFailure(clientIp);
        if (penaltySec > 0) {
          return cb?.({
            ok: false,
            error: `Sai mật khẩu 5 lần liên tiếp! Tạm khóa thử lại trong ${penaltySec} giây.`,
            requirePassword: true,
          });
        }
      }
      return cb?.({
        ok: false,
        error: res.error,
        requirePassword: Boolean(res.requirePassword),
      });
    }
    if (res.room?.accessMode === "password") {
      clearPasswordFailures(clientIp);
    }
    socket.join(res.room.code);
    socket.data.roomCode = res.room.code;
    if (res.isSpectator && res.spectator) {
      socket.data.playerId = res.spectator.id;
      socket.data.isSpectator = true;
      cb?.({
        ok: true,
        isSpectator: true,
        roomCode: res.room.code,
        playerId: res.spectator.id,
        sessionToken: res.spectator.sessionToken,
      });
    } else if (res.player) {
      socket.data.playerId = res.player.id;
      socket.data.isSpectator = false;
      cb?.({
        ok: true,
        isSpectator: false,
        roomCode: res.room.code,
        playerId: res.player.id,
        sessionToken: res.player.sessionToken,
      });
    }
    broadcastRoom(res.room);
  });

  socket.on("room:join", ({ roomCode, name, avatarSeed, avatarUrl, citizenModelId, password, deviceId } = {}, cb) => {
    // SEC-05: Chống dò mật khẩu phòng hàng loạt (5 lần sai -> khóa 15 giây/IP)
    const lockSec = getPasswordLockRemainingSec(clientIp);
    if (lockSec > 0) {
      return cb?.({
        ok: false,
        error: `Bạn nhập sai mật khẩu quá nhiều lần! Vui lòng thử lại sau ${lockSec} giây.`,
        requirePassword: true,
      });
    }

    const result = addPlayer(
      roomCode,
      socket.id,
      name,
      avatarSeed || null,
      avatarUrl || null,
      password || "",
      { deviceId, citizenModelId }
    );
    if (result.error) {
      if (result.passwordFailed) {
        const penaltySec = recordPasswordFailure(clientIp);
        if (penaltySec > 0) {
          return cb?.({
            ok: false,
            error: `Sai mật khẩu 5 lần liên tiếp! Tạm khóa thử lại trong ${penaltySec} giây.`,
            requirePassword: true,
          });
        }
      }
      cb?.({
        ok: false,
        error: result.error,
        requirePassword: Boolean(result.requirePassword),
        phase: result.phase || null,
      });
      return;
    }

    if (result.room?.accessMode === "password") {
      clearPasswordFailures(clientIp);
    }

    socket.join(result.room.code);
    socket.data.roomCode = result.room.code;
    socket.data.playerId = result.player.id;
    cb?.({
      ok: true,
      roomCode: result.room.code,
      playerId: result.player.id,
      sessionToken: result.player.sessionToken,
    });
    broadcastRoom(result.room);
  });

  socket.on("room:setAccess", ({ roomTitle, accessMode, password } = {}, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = setRoomAccess(code, socket.id, { roomTitle, accessMode, password });
    if (result.error) return cb?.({ ok: false, error: result.error });
    broadcastRoom(result.room);
    cb?.({ ok: true });
  });

  socket.on("room:setTurbo", ({ isTurbo } = {}, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = setRoomTurbo(code, socket.id, isTurbo);
    if (result.error) return cb?.({ ok: false, error: result.error });
    broadcastRoom(result.room);
    cb?.({ ok: true, isTurbo: result.isTurbo });
  });

  socket.on("room:setMcPacing", ({ mode } = {}, cb) => {
    if (!checkSocketCooldown(socket, "set_mc_pacing", 250)) {
      return cb?.({ ok: false, error: "Thao tác quá nhanh." });
    }
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = setRoomMcPacingMode(code, socket.data.playerId || socket.id, mode);
    if (result.error) return cb?.({ ok: false, error: result.error });
    if (result.room.phase === "playing") {
      gameCtrl.reapplyMcPacingLive?.(result.room);
    }
    broadcastRoom(result.room);
    cb?.({ ok: true, mcPacingMode: result.mcPacingMode });
  });

  socket.on("room:setSoloRole", ({ role } = {}, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = setSoloPracticeRole(code, socket.id, role || null);
    if (result.error) return cb?.({ ok: false, error: result.error });
    broadcastRoom(result.room);
    cb?.({ ok: true, role: result.role });
  });

  socket.on("room:manageBots", ({ action = "add", count = 1 } = {}, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false, error: "Phòng không tồn tại." });
    if (room.phase !== "lobby") {
      return cb?.({ ok: false, error: "Chỉ chỉnh số ghế AI Bot khi đang ở sảnh chờ." });
    }
    const requester = room.players.find(
      (p) => p.socketId === socket.id || p.id === socket.data.playerId
    );
    if (!requester?.isHost) {
      return cb?.({ ok: false, error: "Chỉ chủ phòng mới có quyền chỉnh AI Bot." });
    }

    if (action === "clear") {
      const res = clearBotsFromRoom(code, { syncRoles: true });
      if (res.error) return cb?.({ ok: false, error: res.error });
      broadcastRoom(res.room);
      return cb?.({ ok: true, total: res.total });
    }

    if (action === "fill_v33_8") {
      const realHumans = room.players.filter((p) => !p.isBot).length;
      const targetSeats = Math.max(8, realHumans);
      room.rolesConfig = generateExpandedV33Roles(targetSeats);
      const needed = Math.max(0, targetSeats - room.players.length);
      const res = addBotsToRoom(code, needed);
      if (res.error) return cb?.({ ok: false, error: res.error });
      broadcastRoom(res.room);
      return cb?.({ ok: true, added: res.added, total: res.total });
    }

    if (action === "fill_roles") {
      const totalRoles = Object.values(room.rolesConfig || {}).reduce(
        (s, v) => s + (Number(v) || 0),
        0
      );
      const targetSeats = Math.max(6, totalRoles);
      const needed = Math.max(0, targetSeats - room.players.length);
      const res = addBotsToRoom(code, needed);
      if (res.error) return cb?.({ ok: false, error: res.error });
      broadcastRoom(res.room);
      return cb?.({ ok: true, added: res.added, total: res.total });
    }

    const res = addBotsToRoom(code, count, { syncRolesMode: "match" });
    if (res.error) return cb?.({ ok: false, error: res.error });
    broadcastRoom(res.room);
    cb?.({ ok: true, added: res.added, total: res.total });
  });

  socket.on("room:rename", ({ newName, avatarSeed, avatarUrl, citizenModelId } = {}, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = renamePlayer(
      code,
      socket.id,
      newName,
      avatarSeed || null,
      avatarUrl || null,
      citizenModelId || null
    );
    if (result.error) {
      cb?.({ ok: false, error: result.error });
      return;
    }
    cb?.({ ok: true });
    broadcastRoom(result.room);
  });

  socket.on("room:setCitizenModel", ({ citizenModelId } = {}, cb) => {
    if (!checkSocketCooldown(socket, "set_citizen_model", 350)) {
      return cb?.({ ok: false, error: "Thao tác quá nhanh." });
    }
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = setPlayerCitizenModel(code, socket.id, citizenModelId);
    if (result.error) {
      return cb?.({ ok: false, error: result.error });
    }
    broadcastRoom(result.room);
    cb?.({
      ok: true,
      citizenModelId: result.citizenModelId,
      avatar: result.avatar,
    });
  });

  socket.on("room:leave", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    removeSocketFromVoiceRelay(io, code, socket.id, getRoom);
    const room = removePlayer(code, socket.id, { explicitLeave: true });
    socket.leave(code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    if (room) {
      broadcastRoom(room);
    } else {
      gameCtrl.clearRoomTimer(code);
      broadcastRoomsList();
    }
  });

  socket.on("room:toggleReady", (_, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = toggleReady(code, socket.id);
    if (result.error) return cb?.({ ok: false, error: result.error });
    broadcastRoom(result.room);
    cb?.({ ok: true, ready: result.ready });
  });

  socket.on("room:setRolesConfig", ({ rolesConfig } = {}, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = setRolesConfig(code, socket.id, rolesConfig);
    if (result.error) return cb?.({ ok: false, error: result.error });
    broadcastRoom(result.room);
    cb?.({ ok: true });
  });

  socket.on("room:setScenePreset", ({ presetId } = {}, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = setScenePreset(code, socket.id, presetId);
    if (result.error) return cb?.({ ok: false, error: result.error });
    broadcastRoom(result.room);
    cb?.({ ok: true, scenePresetId: result.scenePresetId });
  });

  socket.on("room:lobbyChat", ({ message } = {}, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    if (!checkSocketCooldown(socket, "chat", 650)) {
      return cb?.({ ok: false, error: "Bạn nhắn tin quá nhanh!" });
    }
    const msg = addLobbyMessage(code, socket.id, message);
    if (!msg) return cb?.({ ok: false, error: "Không gửi được tin nhắn." });
    io.to(code).emit("room:lobbyMessage", msg);
    cb?.({ ok: true });
  });

  socket.on("livekit:token", async (_, cb) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false, error: "Không tìm thấy phòng." });
    const player =
      room.players.find((p) => p.socketId === socket.id) ||
      room.players.find((p) => p.id === socket.data.playerId);
    const spectator = !player
      ? (room.spectators || []).find(
          (s) => s.socketId === socket.id || s.id === socket.data.playerId
        )
      : null;
    if (!player && !spectator) return cb?.({ ok: false, error: "Không tìm thấy người chơi." });

    // Khán giả (Spectator) & Người đã chết bị khóa cứng canPublish: false trên cả SFU lẫn P2P!
    const canPublishAudio = Boolean(player && player.alive !== false);
    const identity = player ? player.id : `spec_${spectator.id}`;
    const displayName = player ? player.name : `👀 ${spectator.name}`;

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return cb?.({
        ok: true,
        mode: "p2p",
        fallbackReason: "LIVEKIT_NOT_CONFIGURED",
        canPublish: canPublishAudio,
        identity,
        displayName,
        iceServers: DEFAULT_STUN_SERVERS,
      });
    }

    const health = await checkLivekitHealth();
    if (!health.ok) {
      return cb?.({
        ok: true,
        mode: "p2p",
        fallbackReason: health.reason || "LIVEKIT_QUOTA_EXCEEDED",
        canPublish: canPublishAudio,
        identity,
        displayName,
        iceServers: DEFAULT_STUN_SERVERS,
      });
    }

    try {
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity,
        name: displayName,
        ttl: "2h",
      });
      at.addGrant({
        roomJoin: true,
        room: code,
        canPublish: canPublishAudio,
        canPublishData: false,
        canSubscribe: true,
      });
      cb?.({
        ok: true,
        mode: "livekit",
        token: await at.toJwt(),
        url: LIVEKIT_URL,
        canPublish: canPublishAudio,
        identity,
        displayName,
        iceServers: DEFAULT_STUN_SERVERS,
      });
    } catch {
      cb?.({
        ok: true,
        mode: "p2p",
        fallbackReason: "LIVEKIT_SIGN_ERROR",
        canPublish: canPublishAudio,
        identity,
        displayName,
        iceServers: DEFAULT_STUN_SERVERS,
      });
    }
  });

  socket.on("disconnect", () => {
    clearInterval(heartbeatInterval);
    const code = socket.data.roomCode;
    if (!code) return;
    removeSocketFromVoiceRelay(io, code, socket.id, getRoom);
    const room = removePlayer(code, socket.id, {
      explicitLeave: false,
      onOrphanExpire: (expiredCode) => {
        gameCtrl.clearRoomTimer(expiredCode);
        broadcastRoomsList();
      },
    });
    if (room) {
      broadcastRoom(room);
    } else {
      gameCtrl.clearRoomTimer(code);
      broadcastRoomsList();
    }
    console.log("Ngắt kết nối:", socket.id);
  });

  // ============ GAME EVENTS ============
  function withPlayer(cb) {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return null;

    let player = room.players.find((p) => p.socketId === socket.id);

    if (!player && socket.data.playerId) {
      player = room.players.find((p) => p.id === socket.data.playerId);
      if (player) {
        console.log(`[Reconnect Repair] Player ${player.name}: socketId fixed ${player.socketId} → ${socket.id}`);
        player.socketId = socket.id;
        player.connected = true;
      }
    }

    if (!player) return null;
    return cb(room, player);
  }

  socket.on("game:start", (_, cb) => {
    withPlayer((room, player) => {
      if (!player.isHost) return cb?.({ ok: false, error: "Chỉ chủ phòng mới bắt đầu được." });
      const result = gameCtrl.startGame(room);
      cb?.(result);
    });
  });

  socket.on("action:roleRevealReady", (_, cb) => {
    withPlayer((room, player) => {
      const res = gameCtrl.markRoleRevealReady(room, player.id);
      if (res.ok) gameCtrl.broadcast(room);
      cb?.(res);
    });
  });

  socket.on("room:restart", (_, cb) => {
    withPlayer((room, player) => {
      if (!player.isHost) return cb?.({ ok: false, error: "Chỉ chủ phòng mới có thể chơi lại." });
      const reopened = gameCtrl.reopenRoomLobby(room);
      cb?.({ ok: true, promotedIds: reopened.promotedIds || [] });
    });
  });

  socket.on("room:rematchReady", (_, cb) => {
    withPlayer((room, player) => {
      const res = gameCtrl.markRematchReady(room, player.id);
      cb?.(res);
    });
  });

  socket.on("action:cupidLink", ({ targetIds } = {}, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.cupidLink(room, player.id, targetIds);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:guardProtect", ({ targetId } = {}, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.guardProtect(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:wolfPick", ({ targetId } = {}, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.wolfPick(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:wolfAlphaToggle", ({ enabled } = {}, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.wolfAlphaToggle(room, player.id, enabled);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:mayorReveal", (_, cb) => {
    withPlayer((room, player) => {
      if (room.game?.winner) return cb?.({ ok: false, error: "Trò chơi đã kết thúc." });
      const result = gameCtrl.mayorReveal(room, player.id);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:hunterShoot", ({ targetId } = {}, cb) => {
    withPlayer((room, player) => {
      if (room.game?.winner) return cb?.({ ok: false, error: "Trò chơi đã kết thúc." });
      const result = gameCtrl.hunterShoot(room, player.id, targetId);
      cb?.(result);
    });
  });

  socket.on("action:wolfChat", ({ message } = {}, cb) => {
    withPlayer((room, player) => {
      if (!isWolfTeamRole(player.role) || !player.alive) return;
      if (!checkSocketCooldown(socket, "chat", 500)) return;
      const cleanMsg = sanitizeChatText(String(message || ""), MAX_CHAT_LENGTH);
      if (!cleanMsg) return cb?.({ ok: false });
      if (room.game && !room.game.winner) {
        const myTargetId = room.game.wolfPicks?.[player.id]?.targetId || null;
        gameCtrl.recordReplayEvent?.(room, {
          kind: "wolf_chat",
          actorId: player.id,
          actorRole: player.role,
          targetId: myTargetId,
          chatText: cleanMsg,
          caption: `🐺 [Mật đàm Sói] ${player.name}: "${cleanMsg.slice(0, 90)}"`,
        });
      }
      room.players.forEach((p) => {
        if (isWolfTeamRole(p.role) && p.id !== player.id && p.connected && p.socketId) {
          io.to(p.socketId).emit("wolf:chat", { senderId: player.id, message: cleanMsg });
        }
      });
      cb?.({ ok: true });
    });
  });

  socket.on("action:villageChat", ({ message } = {}, cb) => {
    withPlayer((room, player) => {
      if (!player.alive) return cb?.({ ok: false, error: "Bạn đã chết, không thể chat" });
      const curPhase = room.game?.phase || "";
      if (curPhase.startsWith("night_") || curPhase === "role_reveal") {
        return cb?.({ ok: false, error: "Ban đêm không được chat ồn ào!" });
      }
      if (!checkSocketCooldown(socket, "chat", 650)) {
        return cb?.({ ok: false, error: "Bạn nhắn tin quá nhanh!" });
      }

      const cleanMsg = sanitizeChatText(String(message || ""), MAX_CHAT_LENGTH);
      if (!cleanMsg) return cb?.({ ok: false, error: "Tin nhắn trống." });

      room.lastHumanVillageChatAt = Date.now();
      if (room.game && !room.game.winner) {
        gameCtrl.recordReplayEvent?.(room, {
          kind: "village_chat",
          actorId: player.id,
          chatText: cleanMsg,
          caption: `💬 ${player.name}: "${cleanMsg.slice(0, 90)}"`,
        });
      }

      io.to(room.code).emit("village:chat", {
        senderId: player.id,
        senderName: player.name,
        message: cleanMsg,
      });
      cb?.({ ok: true });
    });
  });

  // 👻 Kênh Trò Chuyện Cõi Âm (Ghost Chat — 100% cô lập chỉ người đã hy sinh mới thấy, 0% lộ vai người sống!)
  socket.on("action:ghostChat", ({ message } = {}, cb) => {
    withPlayer((room, player) => {
      if (player.alive) {
        return cb?.({ ok: false, error: "Người còn sống không thể nghe hay nói ở Cõi Âm!" });
      }
      if (!room.game || room.game.winner) {
        return cb?.({ ok: false, error: "Ván đấu đã kết thúc." });
      }
      if (!checkSocketCooldown(socket, "chat", 650)) {
        return cb?.({ ok: false, error: "Bạn nhắn tin quá nhanh!" });
      }
      const cleanMsg = sanitizeChatText(String(message || ""), MAX_CHAT_LENGTH);
      if (!cleanMsg) return cb?.({ ok: false, error: "Tin nhắn trống." });

      if (!Array.isArray(room.game.ghostMessages)) room.game.ghostMessages = [];
      const payload = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        senderId: player.id,
        senderName: player.name,
        message: cleanMsg,
        time: new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }),
      };
      room.game.ghostMessages.push(payload);
      if (room.game.ghostMessages.length > 40) room.game.ghostMessages.shift();

      // Chỉ gửi đích danh tới các người chơi ĐÃ CHẾT (!p.alive) — người sống & khán giả nhận 0 byte!
      room.players.forEach((p) => {
        if (!p.alive && p.connected && p.socketId) {
          io.to(p.socketId).emit("ghost:chat", payload);
        }
      });
      cb?.({ ok: true });
    });
  });

  // 👻 Dự Đoán Phe Thắng từ Cõi Âm (+35 XP thưởng vui cuối ván)
  socket.on("action:ghostBet", ({ team } = {}, cb) => {
    withPlayer((room, player) => {
      if (player.alive) {
        return cb?.({ ok: false, error: "Chỉ Linh Hồn mới được dự đoán đại cục từ Cõi Âm!" });
      }
      if (!room.game || room.game.winner) {
        return cb?.({ ok: false, error: "Ván đấu đã khép lại." });
      }
      const validTeams = ["village", "wolf", "lovers", "tanner"];
      if (!validTeams.includes(team)) {
        return cb?.({ ok: false, error: "Phe dự đoán không hợp lệ." });
      }
      if (!room.game.ghostBets) room.game.ghostBets = {};
      if (room.game.ghostBets[player.id]) {
        return cb?.({ ok: false, error: "Bạn đã chốt linh cảm Cõi Âm cho ván này rồi!" });
      }
      room.game.ghostBets[player.id] = team;
      gameCtrl.broadcast(room);
      cb?.({ ok: true, team });
    });
  });

  socket.on("action:witchDecide", (payload, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.witchDecide(room, player.id, payload);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:seerCheck", ({ targetId } = {}, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.seerCheck(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:voteExtendDiscussion", ({ wantExtend } = {}, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.voteExtendDiscussion(room, player.id, wantExtend);
      gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:skipDiscussion", (_, cb) => {
    withPlayer((room, player) => {
      if (room.game?.winner) return cb?.({ ok: false });
      const result = gameCtrl.voteSkipDiscussion(room, player.id);
      if (result.ok) {
        gameCtrl.broadcast(room);
        if (result.allSkipped) {
          gameCtrl.clearRoomTimer(room.code);
          gameCtrl.forceEndDiscussion(room);
        }
      }
      cb?.(result);
    });
  });

  socket.on("action:nominationVote", ({ targetId } = {}, cb) => {
    withPlayer((room, player) => {
      if (room.game?.winner) return cb?.({ ok: false, error: "Trò chơi đã kết thúc." });
      const result = gameCtrl.nominationVote(room, player.id, targetId);
      if (result.ok) {
        gameCtrl.broadcast(room);
        checkBotVoteConsensus(room, gameCtrl);
      }
      cb?.(result);
    });
  });

  socket.on("action:finalVote", ({ decision } = {}, cb) => {
    withPlayer((room, player) => {
      if (room.game?.winner) return cb?.({ ok: false, error: "Trò chơi đã kết thúc." });
      const result = gameCtrl.finalVote(room, player.id, decision);
      if (result.ok) {
        gameCtrl.broadcast(room);
        checkBotVoteConsensus(room, gameCtrl);
      }
      cb?.(result);
    });
  });

  // SEC-04 FIX: Khóa chặt thả biểu cảm Emoji — cấm người đã chết & cấm thả trong Ban Đêm / Nhận Vai (cooldown 2.5s)
  socket.on("reaction", ({ emoji } = {}) => {
    if (!isSafeReactionEmoji(emoji)) return;
    if (!checkSocketCooldown(socket, "reaction", 2500)) return;

    const code = socket.data.roomCode;
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;

    const sender =
      room.players.find((p) => p.socketId === socket.id) ||
      room.players.find((p) => p.id === socket.data.playerId);
    if (!sender) return;

    if (room.phase === "playing") {
      const g = room.game;
      if (!g || g.winner) return;
      if (!sender.alive) return; // Người chết không được thả emoji ra sân làng!
      if (String(g.phase || "").startsWith("night_") || g.phase === "role_reveal") {
        return; // Ban đêm cấm thả emoji lộ tín hiệu!
      }
    }

    const cleanEmoji = String(emoji).trim().slice(0, 8);
    if (room.game && !room.game.winner) {
      gameCtrl.recordReplayEvent?.(room, {
        kind: "reaction",
        actorId: sender.id,
        emoji: cleanEmoji,
        caption: `${cleanEmoji} ${sender.name} thả biểu cảm giữa vòng tròn làng.`,
      });
    }
    io.to(code).emit("reaction:broadcast", {
      emoji: cleanEmoji,
      name: sender.name,
      senderId: sender.id,
    });
  });

  // Kick player — chỉ host mới kick được, chỉ khi phase = 'lobby'
  socket.on("room:kick", ({ targetId } = {}, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Không trong phòng." });
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false, error: "Phòng không tồn tại." });

    if (room.phase !== "lobby") return cb?.({ ok: false, error: "Không thể kick khi đang chơi." });

    const kicker = room.players.find((p) => p.socketId === socket.id || p.id === socket.data.playerId);
    if (!kicker?.isHost) return cb?.({ ok: false, error: "Chỉ chủ phòng mới kick được." });

    const target = room.players.find((p) => p.id === targetId);
    if (!target) return cb?.({ ok: false, error: "Không tìm thấy người chơi." });
    if (target.isHost) return cb?.({ ok: false, error: "Không thể kick chủ phòng." });

    const targetSocket = target.socketId ? io.sockets.sockets.get(target.socketId) : null;
    if (targetSocket) {
      targetSocket.emit("room:kicked", { reason: "Bạn đã bị kick khỏi phòng bởi chủ phòng." });
      targetSocket.leave(code);
    }

    removeSocketFromVoiceRelay(io, code, target.socketId || target.id, getRoom);
    const updatedRoom = removePlayer(code, target.socketId || target.id);
    if (updatedRoom) {
      broadcastRoom(updatedRoom);
    } else {
      broadcastRoomsList();
    }
    cb?.({ ok: true });
  });

  // Báo cáo người chơi vi phạm văn minh (Ring buffer <= 200 bản ghi bảo vệ 512MB RAM Render)
  socket.on("player:report", ({ targetId, targetName, reason } = {}, cb) => {
    if (!checkSocketCooldown(socket, "player_report", 3000)) {
      return cb?.({ ok: false, error: "Bạn vừa gửi báo cáo, vui lòng đợi ít giây." });
    }
    const repLim = checkIpRateLimit("player_report", clientIp, 6, 60_000);
    if (!repLim.allowed) {
      return cb?.({
        ok: false,
        error: `Bạn gửi báo cáo quá nhanh! Vui lòng đợi ${repLim.retryAfterSec} giây.`,
      });
    }

    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Không ở trong bàn chơi." });
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false, error: "Phòng không tồn tại." });

    const reporter =
      room.players.find((p) => p.socketId === socket.id || p.id === socket.data.playerId) ||
      (room.spectators || []).find((s) => s.socketId === socket.id || s.id === socket.data.playerId);
    if (!reporter) return cb?.({ ok: false, error: "Không xác thực được người báo cáo." });

    const resolvedTarget =
      room.players.find((p) => p.id === targetId) ||
      (room.spectators || []).find((s) => s.id === targetId);
    const cleanTargetName =
      resolvedTarget?.name || String(targetName || "Ẩn danh").trim().slice(0, 24);
    const cleanReason = sanitizeChatText(String(reason || "Ngôn từ thiếu văn minh"), 120);

    const entry = recordPlayerReport({
      reporterIp: clientIp,
      roomCode: room.code,
      reporterId: reporter.id,
      reporterName: reporter.name,
      targetId: resolvedTarget?.id || String(targetId || ""),
      targetName: cleanTargetName,
      reason: cleanReason || "Ngôn từ thiếu văn minh",
    });

    cb?.({ ok: true, reportId: entry.id });
  });

  // Đăng ký trạm tín hiệu Voice P2P Mesh Zero-Leak ($0/tháng dự phòng cho LiveKit SFU)
  registerVoiceRelaySocketHandlers(io, socket, getRoom);

  // [LOCAL DEV ONLY] Đăng ký bộ công cụ DevSandbox (tự khóa cứng trên Render/Production)
  registerDevSocketHandlers(socket, gameCtrl, broadcastRoom);
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server ma sói V4.2 đang chạy tại http://localhost:${PORT}`);
});

// ── TTS Batch: Tra LRU RAM Cache + giới hạn giữ HTTP <= 18s + Bảo vệ GPU RTX 3090 (SEC-02) ──
const MAX_BATCH_WALL_MS = 18000;
const WALL_TIMEOUT_TOKEN = Symbol("TTS_BATCH_WALL_TIMEOUT");

app.post("/api/tts-batch", async (req, res) => {
  if (!isAuthorizedTtsRequest(req)) {
    return res.status(401).json({ error: "Unauthorized game session" });
  }
  const { phrases, speed, voice, urgent, cacheOnly } = req.body || {};
  const clientIp = extractClientIp(req);
  const limBucket = cacheOnly === true ? "tts_batch_cache" : "tts_batch";
  const limMax = cacheOnly === true ? 240 : 180;
  if (!checkIpRateLimit(limBucket, clientIp, limMax, 60_000).allowed) {
    return res.status(429).json({ error: "Too many TTS batch requests" });
  }

  if (!Array.isArray(phrases) || phrases.length === 0) {
    return res.status(400).json({ error: "Missing phrases array" });
  }
  if (phrases.length > 60) {
    return res.status(400).json({ error: "Too many phrases (max 60 per batch)" });
  }

  const ttsSpeed = typeof speed === "number" && speed > 0 && speed <= 2 ? speed : DEFAULT_TTS_SPEED;
  const ttsVoice =
    typeof voice === "string" && voice.trim() && voice.trim() !== "alloy"
      ? voice.trim()
      : DEFAULT_VOICE_ID;

  const results = {};
  const uncachedKeys = [];
  let cacheHits = 0;

  for (const text of phrases) {
    if (!text || typeof text !== "string" || text.trim().length === 0) continue;
    if (text.length > 550) continue;
    const rawKey = text.trim();
    if (Object.prototype.hasOwnProperty.call(results, rawKey)) continue;
    const cached = getCachedMp3ByRawText(rawKey);
    if (cached) {
      results[rawKey] = cached.toString("base64");
      cacheHits += 1;
    } else {
      uncachedKeys.push(rawKey);
    }
  }

  if (cacheOnly === true || uncachedKeys.length === 0) {
    for (const rawKey of uncachedKeys) {
      results[rawKey] = null;
    }
    const status = getVoiceEngineStatus();
    return res.json({
      ok: true,
      count: Object.keys(results).length,
      cacheHits,
      missing: uncachedKeys,
      pending: cacheOnly === true ? uncachedKeys : [],
      vsOnline: status.vsOnline !== false,
      voiceId: ttsVoice,
      results,
    });
  }

  const isOnlineNow = await checkVoiceStudioHealth(false);
  if (!isOnlineNow) {
    for (const rawKey of uncachedKeys) {
      results[rawKey] = null;
    }
    return res.json({
      ok: true,
      count: Object.keys(results).length,
      cacheHits,
      pending: [],
      vsOnline: false,
      voiceId: ttsVoice,
      results,
    });
  }

  const deadline = Date.now() + MAX_BATCH_WALL_MS;
  const pending = [];

  for (let i = 0; i < uncachedKeys.length; i += 1) {
    const rawKey = uncachedKeys[i];
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 800) {
      const rest = uncachedKeys.slice(i);
      warmPhrasesInBackground(rest, urgent ? "urgent" : "normal");
      pending.push(...rest);
      break;
    }

    const genPromise = getOrGenerateMp3(rawKey, {
      voice: ttsVoice,
      speed: ttsSpeed,
      priority: urgent ? "urgent" : "normal",
    });

    let timerId = null;
    const outcome = await Promise.race([
      genPromise,
      new Promise((resolve) => {
        timerId = setTimeout(() => resolve(WALL_TIMEOUT_TOKEN), remainingMs);
      }),
    ]);
    if (timerId) clearTimeout(timerId);

    if (outcome === WALL_TIMEOUT_TOKEN) {
      pending.push(rawKey);
      const rest = uncachedKeys.slice(i + 1);
      if (rest.length > 0) {
        warmPhrasesInBackground(rest, urgent ? "urgent" : "normal");
        pending.push(...rest);
      }
      break;
    }

    results[rawKey] = outcome ? outcome.toString("base64") : null;
  }

  const status = getVoiceEngineStatus();
  return res.json({
    ok: true,
    count: Object.keys(results).length,
    cacheHits,
    pending,
    vsOnline: status.vsOnline,
    voiceId: ttsVoice,
    results,
  });
});
