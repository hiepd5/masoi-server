import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import {
  createRoom,
  getRoom,
  addPlayer,
  reconnectByToken,
  removePlayer,
  renamePlayer,
  toggleReady,
  setRolesConfig,
  setScenePreset,
  setRoomAccess,
  setSoloPracticeRole,
  addBotsToRoom,
  clearBotsFromRoom,
  getPublicRoomsList,
  addLobbyMessage,
  publicRoomView,
} from "./rooms.js";

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

const LIVEKIT_URL = process.env.LIVEKIT_URL || "wss://ma-soi-online-rac6j8ri.livekit.cloud";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "APIQ2WP9w5JhSKX";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "ivTQhkkUZ3otV7XepsCnBdPmHTP6RIFhJRRsn1d28jI";

// LiveKit health check cache (60s TTL)
let livekitHealthCache = { ok: true, checkedAt: 0, message: null };
const LIVEKIT_HEALTH_TTL = 60_000;

function checkLivekitHealth() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (now - livekitHealthCache.checkedAt < LIVEKIT_HEALTH_TTL) {
      return resolve(livekitHealthCache);
    }
    const httpUrl = LIVEKIT_URL.replace(/^wss?:\/\//, "https://") + "/rtc?access_token=probe&protocol=11";
    const req = https.get(httpUrl, { timeout: 5000 }, (res) => {
      const is429 = res.statusCode === 429;
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        livekitHealthCache = { ok: !is429, checkedAt: Date.now(), message: is429 ? body.trim() : null };
        resolve(livekitHealthCache);
      });
    });
    req.on("error", () => {
      // Network error — still let client try; don't block
      livekitHealthCache = { ok: true, checkedAt: Date.now(), message: null };
      resolve(livekitHealthCache);
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: true, checkedAt: Date.now(), message: null }); });
  });
}

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

function isLocalDevRequest(req) {
  if (process.env.NODE_ENV === "production") return false;
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

// Health check — Render dùng để verify server alive
app.get("/", (req, res) => res.json({ status: "ok", game: "Ma Soi Online", uptime: process.uptime() }));

// Trạng thái VoiceStudio & bộ nhớ đệm StoryVoiceEngine (cho phép HUD báo chấm Online/Offline)
app.get("/api/tts-status", async (req, res) => {
  await checkVoiceStudioHealth(req.query?.force === "1");
  return res.json(getVoiceEngineStatus());
});

// ── TTS Proxy + LRU RAM Cache: Giải quyết CORS Mixed-Content & phục vụ 0ms từ Cache cuốn chiếu ──
app.post("/api/tts", async (req, res) => {
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

// API Tự động quét kho phụ kiện/tạo hình .GLB 8 Vai từ Tripo AI (0 lỗi 404 console!)
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
  } catch (err) {
    return res.json({ ok: true, roles: {} });
  }
});

// API Tự động quét Kho 9 Nhân Vật Có Xương Auto-Rig .GLB từ Tripo AI (1 Dân Làng Ẩn Danh + 8 Vai Thật — 0 lỗi 404 console!)
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
        note: "Thả 9 file char_<key>.glb có xương Auto-Rig từ Tripo AI vào thư mục này — Engine tự động gập chân ngồi ghế 0.48m và diễn hoạt Đầu/Lưng/Tay!",
        characters,
      };
      fs.writeFileSync(CHARACTER_MANIFEST_PATH, JSON.stringify(manifestDoc, null, 2) + "\n", "utf8");
    }
    return res.json({ ok: true, characters });
  } catch (err) {
    return res.json({ ok: true, characters: {} });
  }
});

// API Tự động quét Kho 6 Đạo Cụ Cầm Tay Gắn Xương .GLB từ Tripo AI (0 lỗi 404 console!)
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
  } catch (err) {
    return res.json({ ok: true, handProps: {} });
  }
});

// API Nội Bộ Dev (D5 Architect Studio): Lưu cố định bố cục cảnh quan vào client/public/config/village_layout.json
app.post("/api/dev/village-layout", (req, res) => {
  if (!isLocalDevRequest(req)) {
    return res.status(403).json({ ok: false, error: "Chỉ cho phép lưu bố cục trên máy Dev Local." });
  }
  try {
    const body = req.body;
    if (!body || !Array.isArray(body.nodes) || body.nodes.length === 0) {
      return res.status(400).json({ ok: false, error: "Dữ liệu nodes[] không hợp lệ." });
    }
    // Chặn tuyệt đối trường hợp có prop_chair lọt vào file bố cục ngoại cảnh
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

// API Nội Bộ Dev: Lưu / Tạo mới / Đổi tên / Đặt mặc định Bối Cảnh Tùy Chọn (Multi-Scene Presets)
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

// API Nội Bộ Dev: Xóa 1 Bối Cảnh Tùy Chọn (Khóa cứng bảo vệ Bản Lề V3 gốc!)
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

// API Nội Bộ Dev: Quét nóng thư mục "MODEL CONCEPT THEM" 1-Click ngay trong D5 Studio!
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
  cors: { origin: "*", methods: ["GET", "POST"] },
});

function broadcastRoomsList() {
  io.emit("lobby:roomsUpdate", getPublicRoomsList());
}

function broadcastRoom(room) {
  // Mỗi client nhận view riêng (role của chính họ), nên emit riêng từng socket
  room.players.forEach((p) => {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit("room:update", publicRoomView(room, p.socketId));
    }
  });
  broadcastRoomsList();
}

const gameCtrl = createGameController(io);
setupDevPhaseHook(gameCtrl, io);
gameCtrl.setRoomListHook(() => broadcastRoomsList());

io.on("connection", (socket) => {
  console.log("Kết nối mới:", socket.id);
  socket.emit("lobby:roomsUpdate", getPublicRoomsList());

  socket.on("lobby:getRooms", (_, cb) => {
    cb?.({ ok: true, rooms: getPublicRoomsList() });
  });

  // Heartbeat: ping mỗi 30s, kick sau 60s không pong
  let missedPings = 0;
  const heartbeatInterval = setInterval(() => {
    if (missedPings >= 2) {
      // 2 missed pings = ~60s không phản hồi → disconnect
      clearInterval(heartbeatInterval);
      socket.disconnect(true);
      return;
    }
    missedPings++;
    socket.emit('ping:server');
  }, 30000);

  socket.on('pong:client', () => {
    missedPings = 0; // reset khi nhận pong
  });

  socket.on("room:create", (payload = {}, cb) => {
    const {
      name,
      avatarSeed,
      avatarUrl,
      roomTitle,
      accessMode = "public",
      password = "",
      soloQuickStart = false,
    } = payload || {};

    if (accessMode === "password" && !String(password || "").trim()) {
      cb?.({ ok: false, error: "Vui lòng nhập mật khẩu cho phòng khóa!" });
      return;
    }

    const room = createRoom(socket.id, { roomTitle, accessMode, password });
    const { room: joinedRoom, player } = addPlayer(
      room.code,
      socket.id,
      name || null,
      avatarSeed || null,
      avatarUrl || null,
      password
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

  socket.on("room:reconnect", ({ roomCode, sessionToken }, cb) => {
    const result = reconnectByToken(roomCode, sessionToken, socket.id);
    if (result.error) {
      cb?.({ ok: false, error: result.error });
      return;
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

  socket.on("room:join", ({ roomCode, name, avatarSeed, avatarUrl, password } = {}, cb) => {
    const result = addPlayer(
      roomCode,
      socket.id,
      name,
      avatarSeed || null,
      avatarUrl || null,
      password || ""
    );
    if (result.error) {
      cb?.({
        ok: false,
        error: result.error,
        requirePassword: Boolean(result.requirePassword),
        phase: result.phase || null,
      });
      return;
    }
    socket.join(result.room.code);
    socket.data.roomCode = result.room.code;
    socket.data.playerId = result.player.id; // ← lưu stable playerId
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

  socket.on("room:rename", ({ newName, avatarSeed, avatarUrl }, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = renamePlayer(code, socket.id, newName, avatarSeed || null, avatarUrl || null);
    if (result.error) {
      cb?.({ ok: false, error: result.error });
      return;
    }
    cb?.({ ok: true });
    broadcastRoom(result.room);
  });

  socket.on("room:leave", () => {
    const code = socket.data.roomCode;
    if (!code) return;
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

  socket.on("room:setRolesConfig", ({ rolesConfig }, cb) => {
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

  socket.on("room:lobbyChat", ({ message }, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const msg = addLobbyMessage(code, socket.id, message);
    if (!msg) return cb?.({ ok: false, error: "Không gửi được tin nhắn." });
    io.to(code).emit("room:lobbyMessage", msg);
    cb?.({ ok: true });
  });


  socket.on("livekit:token", async (_, cb) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return cb?.({ error: "Không tìm thấy phòng." });
    const player = room.players.find((p) => p.socketId === socket.id)
                || room.players.find((p) => p.id === socket.data.playerId);
    if (!player) return cb?.({ error: "Không tìm thấy người chơi." });

    // Kiểm tra LiveKit Cloud còn hoạt động không (cached 60s)
    const health = await checkLivekitHealth();
    if (!health.ok) {
      return cb?.({ error: "LIVEKIT_QUOTA_EXCEEDED" });
    }

    try {
      const canPublishAudio = player.alive !== false;
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: player.id,
        name: player.name,
        ttl: '2h', // OPT 5: 2h đủ cho 1 ván, giảm từ 6h
      });
      at.addGrant({
        roomJoin: true,
        room: code,
        canPublish: canPublishAudio,
        canPublishData: false,
        canSubscribe: true,
      });
      cb?.({ token: await at.toJwt(), url: LIVEKIT_URL, canPublish: canPublishAudio });

    } catch (e) {
      cb?.({ error: e.message });
    }
  });

  socket.on("disconnect", () => {
    clearInterval(heartbeatInterval);
    const code = socket.data.roomCode;
    if (!code) return;
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

    // Tìm theo socketId (bình thường)
    let player = room.players.find((p) => p.socketId === socket.id);

    // Fallback: tìm theo playerId đã lưu trong socket.data (trường hợp reconnect edge case)
    if (!player && socket.data.playerId) {
      player = room.players.find((p) => p.id === socket.data.playerId);
      if (player) {
        // Tự sửa: cập nhật socketId để các lần sau hoạt động bình thường
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

  socket.on("room:restart", (_, cb) => {
    withPlayer((room, player) => {
      if (!player.isHost) return cb?.({ ok: false, error: "Chỉ chủ phòng mới có thể chơi lại." });
      
      gameCtrl.clearRoomTimer(room.code);
      room.game = null;
      room.phase = "lobby";

      if (room.devBotTimer) {
        clearTimeout(room.devBotTimer);
        room.devBotTimer = null;
      }
      room.lastAutoPhaseKey = null;

      // BUG E FIX: Reset trạng thái người chơi để không lộ role/alive từ ván cũ vào lobby
      room.players.forEach((p) => {
        p.alive = true;
        p.role = null;
        p.ready = p.isHost || Boolean(p.isBot); // Host & Bot luôn sẵn sàng, member thật bấm Ready lại
      });

      broadcastRoom(room);
      cb?.({ ok: true });
    });
  });

  socket.on("action:cupidLink", ({ targetIds }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.cupidLink(room, player.id, targetIds);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:guardProtect", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.guardProtect(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:wolfPick", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.wolfPick(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room); // để sói khác thấy realtime ai đang chọn ai
      cb?.(result);
    });
  });

  socket.on("action:wolfAlphaToggle", ({ enabled }, cb) => {
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

  socket.on("action:hunterShoot", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      if (room.game?.winner) return cb?.({ ok: false, error: "Trò chơi đã kết thúc." });
      const result = gameCtrl.hunterShoot(room, player.id, targetId);
      cb?.(result);
    });
  });

  socket.on("action:wolfChat", ({ message }, cb) => {
    withPlayer((room, player) => {
      if (!isWolfTeamRole(player.role)) return;
      const cleanMsg = String(message || "").trim();
      if (cleanMsg && room.game && !room.game.winner) {
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
      room.players.forEach(p => {
        if (isWolfTeamRole(p.role) && p.id !== player.id && p.connected && p.socketId) {
          io.to(p.socketId).emit("wolf:chat", { senderId: player.id, message });
        }
      });
      cb?.({ ok: true });
    });
  });

  socket.on("action:villageChat", ({ message }, cb) => {
    withPlayer((room, player) => {
      if (!player.alive) return cb?.({ ok: false, error: "Bạn đã chết, không thể chat" });
      
      // BUG 10 FIX: Thêm optional chaining để tránh crash khi room.game là null
      if (room.game?.phase?.startsWith("night_")) return cb?.({ ok: false, error: "Ban đêm không được chat ồn ào!" });

      const cleanMsg = String(message || "").trim();
      if (cleanMsg && room.game && !room.game.winner) {
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
        message 
      });
      cb?.({ ok: true });
    });
  });

  socket.on("action:witchDecide", (payload, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.witchDecide(room, player.id, payload);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:seerCheck", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.seerCheck(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:voteExtendDiscussion", ({ wantExtend }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.voteExtendDiscussion(room, player.id, wantExtend);
      gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:skipDiscussion", (_, cb) => {
    withPlayer((room, player) => {
      // BUG 9 FIX: Không trigger phase mới sau khi game đã kết thúc
      if (room.game?.winner) return cb?.({ ok: false });
      const result = gameCtrl.voteSkipDiscussion(room, player.id);
      if (result.ok) {
        gameCtrl.broadcast(room);
        if (result.allSkipped) {
          // Clear timer and move to nomination
          gameCtrl.clearRoomTimer(room.code);
          gameCtrl.forceEndDiscussion(room);
        }
      }
      cb?.(result);
    });
  });


  socket.on("action:nominationVote", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      // BUG 9 FIX: Không cho vote sau khi game kết thúc
      if (room.game?.winner) return cb?.({ ok: false, error: "Trò chơi đã kết thúc." });
      const result = gameCtrl.nominationVote(room, player.id, targetId);
      if (result.ok) {
        gameCtrl.broadcast(room);
        checkBotVoteConsensus(room, gameCtrl);
      }
      cb?.(result);
    });
  });

  socket.on("action:finalVote", ({ decision }, cb) => {
    withPlayer((room, player) => {
      // BUG 9 FIX: Không cho vote sau khi game kết thúc
      if (room.game?.winner) return cb?.({ ok: false, error: "Trò chơi đã kết thúc." });
      const result = gameCtrl.finalVote(room, player.id, decision);
      // BUG 5 FIX: Broadcast để người chơi khác thấy ai đã vote real-time
      if (result.ok) {
        gameCtrl.broadcast(room);
        checkBotVoteConsensus(room, gameCtrl);
      }
      cb?.(result);
    });
  });

  socket.on('reaction', ({ emoji, name }) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = getRoom(code);
    if (room?.game && !room.game.winner && emoji) {
      const sender =
        room.players.find((p) => p.socketId === socket.id) ||
        room.players.find((p) => p.id === socket.data.playerId);
      if (sender) {
        gameCtrl.recordReplayEvent?.(room, {
          kind: "reaction",
          actorId: sender.id,
          emoji: String(emoji).slice(0, 8),
          caption: `${emoji} ${sender.name} thả biểu cảm giữa vòng tròn làng.`,
        });
      }
    }
    io.to(code).emit('reaction:broadcast', { emoji, name, senderId: socket.id });
  });

  // Kick player — chỉ host mới kick được, chỉ khi phase = 'lobby'
  socket.on('room:kick', ({ targetId }, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: 'Không trong phòng.' });
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false, error: 'Phòng không tồn tại.' });

    // Chỉ kick khi đang ở lobby
    if (room.phase !== 'lobby') return cb?.({ ok: false, error: 'Không thể kick khi đang chơi.' });

    // Tìm kicker
    const kicker = room.players.find(p => p.socketId === socket.id || p.id === socket.data.playerId);
    if (!kicker?.isHost) return cb?.({ ok: false, error: 'Chỉ chủ phòng mới kick được.' });

    // Tìm target
    const target = room.players.find(p => p.id === targetId);
    if (!target) return cb?.({ ok: false, error: 'Không tìm thấy người chơi.' });
    if (target.isHost) return cb?.({ ok: false, error: 'Không thể kick chủ phòng.' });

    // Gửi thông báo bị kick (nếu là người thật có socket)
    const targetSocket = target.socketId ? io.sockets.sockets.get(target.socketId) : null;
    if (targetSocket) {
      targetSocket.emit('room:kicked', { reason: `Bạn đã bị kick khỏi phòng bởi chủ phòng.` });
      targetSocket.leave(code);
    }

    // Xóa khỏi room
    const updatedRoom = removePlayer(code, target.socketId || target.id);
    if (updatedRoom) {
      broadcastRoom(updatedRoom);
    } else {
      broadcastRoomsList();
    }
    cb?.({ ok: true });
  });

  // [LOCAL DEV ONLY] Đăng ký bộ công cụ DevSandbox (tự khóa cứng trên Render/Production)
  registerDevSocketHandlers(socket, gameCtrl, broadcastRoom);
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server ma sói đang chạy tại http://localhost:${PORT}`);
});

// ── TTS Batch: Tra LRU RAM Cache (~0ms nếu đã tạo cuốn chiếu trong trận) + giới hạn giữ HTTP <= 18s chống Timeout Proxy Render ──
const MAX_BATCH_WALL_MS = 18000;
const WALL_TIMEOUT_TOKEN = Symbol("TTS_BATCH_WALL_TIMEOUT");

app.post("/api/tts-batch", async (req, res) => {
  const { phrases, speed, voice, urgent } = req.body || {};
  if (!Array.isArray(phrases) || phrases.length === 0) {
    return res.status(400).json({ error: "Missing phrases array" });
  }
  if (phrases.length > 160) {
    return res.status(400).json({ error: "Too many phrases (max 160)" });
  }

  const ttsSpeed = typeof speed === "number" && speed > 0 && speed <= 2 ? speed : DEFAULT_TTS_SPEED;
  const ttsVoice =
    typeof voice === "string" && voice.trim() && voice.trim() !== "alloy"
      ? voice.trim()
      : DEFAULT_VOICE_ID;

  const results = {};
  const uncachedKeys = [];
  let cacheHits = 0;

  // Vòng 1 (0ms): Lấy toàn bộ các câu đã có sẵn trong LRU RAM Cache trước tiên
  for (const text of phrases) {
    if (!text || typeof text !== "string" || text.trim().length === 0) continue;
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

  if (uncachedKeys.length === 0) {
    const status = getVoiceEngineStatus();
    return res.json({
      ok: true,
      count: Object.keys(results).length,
      cacheHits,
      pending: [],
      vsOnline: status.vsOnline !== false,
      voiceId: ttsVoice,
      results,
    });
  }

  // Kiểm tra sức khỏe VoiceStudio thật trước khi xếp hàng GPU (trả kết quả nhanh <300ms nếu máy cá nhân đang tắt)
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
