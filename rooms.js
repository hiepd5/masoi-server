import "./envLoader.js";
import { randomUUID } from "crypto";
import {
  getDefaultName,
  getAvatarUrl,
  BUILTIN_VILLAGER_IDS,
  resolveCitizenAvatarSpec,
} from "./defaultNames.js";
import {
  generateDefaultRoles,
  generateExpandedV33Roles,
  isWolfTeamRole,
  ROLE_LABELS,
} from "./roles.js";
import {
  IS_PRODUCTION_ENV,
  MAX_ACTIVE_ROOMS,
  MAX_CHAT_LENGTH,
  sanitizeAvatarUrl,
  sanitizeCitizenModelId,
  sanitizeChatText,
  sanitizeDeviceId,
} from "./securityGuard.js";
import { getVietnamGoldenHourInfo } from "./moderationAndStats.js";
import { resolveEffectiveMcPacingMode } from "./botVoiceCatalog.js";

// rooms: Map<roomCode, RoomState>
const rooms = new Map();

export function getActiveRoomCount() {
  return rooms.size;
}

export function getGlobalServerRuntimeMetrics() {
  let lobbyRoomsCount = 0;
  let playingRoomsCount = 0;
  let endedRoomsCount = 0;
  let totalConnectedHumans = 0;
  let totalBots = 0;
  let totalSpectators = 0;

  for (const r of rooms.values()) {
    if (r.phase === "lobby") lobbyRoomsCount += 1;
    else if (r.phase === "playing") playingRoomsCount += 1;
    else endedRoomsCount += 1;

    for (const p of r.players || []) {
      if (p.isBot) totalBots += 1;
      else if (p.connected) totalConnectedHumans += 1;
    }
    for (const s of r.spectators || []) {
      if (s.connected) totalSpectators += 1;
    }
  }

  return {
    activeRoomsCount: rooms.size,
    lobbyRoomsCount,
    playingRoomsCount,
    endedRoomsCount,
    totalConnectedHumans,
    totalBots,
    totalSpectators,
  };
}

export function canCreateNewRoom() {
  if (rooms.size < MAX_ACTIVE_ROOMS) return true;
  const now = Date.now();
  for (const [code, r] of rooms.entries()) {
    const connectedHumans = r.players.filter((p) => !p.isBot && p.connected).length;
    if (connectedHumans === 0 && now - (r.createdAt || 0) > 5 * 60 * 1000) {
      deleteRoom(code);
    }
  }
  return rooms.size < MAX_ACTIVE_ROOMS;
}

export function hasValidActiveSessionToken(token) {
  if (!token || typeof token !== "string" || token.length < 16) return false;
  const trimmed = token.trim();
  for (const room of rooms.values()) {
    if (room.players.some((p) => !p.isBot && p.sessionToken === trimmed)) {
      return true;
    }
    if ((room.spectators || []).some((s) => s.connected && s.sessionToken === trimmed)) {
      return true;
    }
  }
  return false;
}

export const BOT_PERSONAS = [
  { id: "sharp_fox", label: "🦊 Sắc Sảo" },
  { id: "calm_owl", label: "🦉 Điềm Đạm" },
  { id: "bold_bear", label: "🔥 Quyết Liệt" },
  { id: "cautious_raven", label: "🌙 Thận Trọng" },
];

export const BOT_NAMES = [
  "🤖 Bot Sói Xám", "🤖 Bot Cáo Đỏ", "🤖 Bot Cú Đêm", "🤖 Bot Thợ Săn",
  "🤖 Bot Cổ Thụ", "🤖 Bot Ánh Trăng", "🤖 Bot Sương Mù", "🤖 Bot Hổ Phách",
  "🤖 Bot Bão Tố", "🤖 Bot Lửa Trại", "🤖 Bot Bóng Đêm", "🤖 Bot Gió Bắc",
  "🤖 Bot Đá Ngầm", "🤖 Bot Sao Băng", "🤖 Bot Rừng Sâu", "🤖 Bot Lửa Thiêng",
];

export const BOT_SEEDS = [
  "bot-wolf", "bot-fox", "bot-owl", "bot-hunter",
  "bot-tree", "bot-moon", "bot-mist", "bot-amber",
  "bot-storm", "bot-fire", "bot-shadow", "bot-wind",
  "bot-reef", "bot-comet", "bot-forest", "bot-flame",
];

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bỏ ký tự dễ nhầm (0,O,I,1)
  let code;
  do {
    code = Array.from({ length: 5 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function clearOrphanTimer(room) {
  if (room?.orphanCleanupTimer) {
    clearTimeout(room.orphanCleanupTimer);
    room.orphanCleanupTimer = null;
  }
}

function reindexSeats(room) {
  room.players.forEach((p, idx) => {
    p.seatIndex = idx;
  });
}

function hasExpandedV33Role(cfg) {
  if (!cfg) return false;
  return Boolean(
    (Number(cfg.alpha_wolf) || 0) > 0 ||
    (Number(cfg.hunter) || 0) > 0 ||
    (Number(cfg.cupid) || 0) > 0 ||
    (Number(cfg.mayor) || 0) > 0
  );
}

export function ensureRoleInLobbyConfig(room, desiredRole) {
  const currentSum = Object.values(room.rolesConfig || {}).reduce(
    (a, b) => a + (Number(b) || 0),
    0
  );
  const targetTotal = Math.max(6, currentSum, room.players.length);
  const cfg = { ...(room.rolesConfig || generateExpandedV33Roles(targetTotal)) };
  if (!desiredRole || !ROLE_LABELS[desiredRole]) return cfg;

  if (!cfg[desiredRole] || cfg[desiredRole] < 1) {
    cfg[desiredRole] = 1;
    const donorOrder = [
      "villager",
      "tough_guy",
      "cursed",
      "tanner",
      "mayor",
      "cupid",
      "hunter",
      "guard",
      "witch",
      "seer",
      "wolf",
      "alpha_wolf",
    ];
    for (const d of donorOrder) {
      if (d === desiredRole) continue;
      const totalWolvesNow = (Number(cfg.wolf) || 0) + (Number(cfg.alpha_wolf) || 0);
      const isDonorWolf = d === "wolf" || d === "alpha_wolf";
      if (isDonorWolf && totalWolvesNow <= 1) continue;
      if ((Number(cfg[d]) || 0) > 0) {
        cfg[d] = Number(cfg[d]) - 1;
        break;
      }
    }
  }
  room.rolesConfig = cfg;
  return cfg;
}

export function createRoom(hostSocketId, options = {}) {
  const code = generateRoomCode();
  const rawMode = String(options.accessMode || "public").trim();
  const validMode = ["public", "password", "hidden"].includes(rawMode) ? rawMode : "public";
  const cleanPassword = String(options.password || "").trim().slice(0, 32);
  const accessMode = validMode === "password" && !cleanPassword ? "public" : validMode;
  const cleanTitle = sanitizeChatText(String(options.roomTitle || ""), 36);

  const room = {
    code,
    hostId: hostSocketId,
    phase: "lobby",
    roomTitle: cleanTitle,
    accessMode, // 'public' | 'password' | 'hidden'
    password: accessMode === "password" ? cleanPassword : "",
    isTurbo: Boolean(options.isTurbo),
    mcPacingMode:
      options.mcPacingMode === "full" || options.mcPacingMode === "fast"
        ? options.mcPacingMode
        : null,
    soloPracticeRole: null,
    createdAt: Date.now(),
    scenePresetId: "nordic_village_v3",
    players: [],
    spectators: [],
    rolesConfig: generateDefaultRoles(6),
    lobbyMessages: [],
    lastHumanVillageChatAt: 0,
  };
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

export function clearRoomExtraTimers(room) {
  if (!room) return;
  if (room.devBotTimer) {
    clearTimeout(room.devBotTimer);
    room.devBotTimer = null;
  }
  if (room.devConsensusTimer) {
    clearTimeout(room.devConsensusTimer);
    room.devConsensusTimer = null;
  }
  if (room.devDeadAdvanceTimer) {
    clearTimeout(room.devDeadAdvanceTimer);
    room.devDeadAdvanceTimer = null;
  }
  if (room.nominationTransitionTimer) {
    clearTimeout(room.nominationTransitionTimer);
    room.nominationTransitionTimer = null;
  }
  if (Array.isArray(room.devDebateTimers)) {
    room.devDebateTimers.forEach((t) => clearTimeout(t));
    room.devDebateTimers = [];
  }
  if (room.rematchAutoTimer) {
    clearTimeout(room.rematchAutoTimer);
    room.rematchAutoTimer = null;
  }
}

export function deleteRoom(code) {
  const room = getRoom(code);
  if (!room) return false;
  clearOrphanTimer(room);
  clearRoomExtraTimers(room);
  rooms.delete(room.code);
  return true;
}

export function addPlayer(
  code,
  socketId,
  requestedName,
  avatarSeed = null,
  avatarUrl = null,
  passwordInput = "",
  options = {}
) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại hoặc đã đóng." };

  clearOrphanTimer(room);
  let name = sanitizeChatText(String(requestedName || ""), 20);

  // SEC-03 FIX: Tuyệt đối KHÔNG cho phép cướp ghế đang chơi chỉ bằng trùng Tên hiển thị!
  // Việc kết nối lại giữa trận bắt buộc 100% phải đi qua `reconnectByToken(code, sessionToken, socketId)`.
  // Nếu khách mới muốn vào xem & đặt chỗ ván sau, Client gọi `room:spectate` (`addSpectator`).
  if (room.phase !== "lobby") {
    if (room.phase === "playing") {
      return {
        error: `Phòng đang trong ván đấu (Ngày ${room.game?.dayNumber || 1}). Vui lòng chờ hết ván hoặc bấm Vào Xem & Đặt Ghế!`,
        phase: "playing",
        canSpectate: true,
      };
    }
    return {
      error: "Ván đấu đang tổng kết, vui lòng chờ mở lại sảnh hoặc bấm Vào Xem & Đặt Ghế!",
      phase: room.phase,
      canSpectate: true,
    };
  }

  // Kiểm tra mật khẩu nếu phòng khóa mật khẩu (người tạo đầu tiên vào phòng rỗng không cần check lại)
  const realHumansBefore = room.players.filter((p) => !p.isBot);
  if (realHumansBefore.length > 0 && room.accessMode === "password") {
    const cleanInput = String(passwordInput || "").trim();
    if (!cleanInput) {
      return {
        error: "Phòng này có đặt mật khẩu. Vui lòng nhập mật khẩu để vào!",
        requirePassword: true,
      };
    }
    if (cleanInput !== room.password) {
      return {
        error: "Mật khẩu phòng không chính xác!",
        requirePassword: true,
        passwordFailed: true,
      };
    }
  }

  // SEC-07: Chống mở 2 Tab cùng trình duyệt/thiết bị tự vào 1 bàn công khai soi bài trên Production
  // (Trên localhost Dev vẫn giữ mở đa tab thoải mái để test!)
  const cleanDeviceId = sanitizeDeviceId(options?.deviceId);
  const enforceAntiMultiTab =
    options?.enforceAntiMultiTab !== undefined
      ? Boolean(options.enforceAntiMultiTab)
      : IS_PRODUCTION_ENV;
  if (
    enforceAntiMultiTab &&
    cleanDeviceId &&
    room.accessMode === "public" &&
    realHumansBefore.some((p) => p.connected && p.deviceId && p.deviceId === cleanDeviceId)
  ) {
    return {
      error: "Thiết bị này đã đang ngồi 1 ghế trong bàn công khai này! (Chống mở nhiều tab soi bài)",
    };
  }

  if (realHumansBefore.length >= 18) {
    return { error: "Phòng đã đầy (tối đa 18 người)." };
  }

  // Bot Seat Yielding: Nếu phòng chờ đã lấp sẵn AI Bot mà có người thật mới bước vào,
  // tự động nhường 1 ghế của AI Bot cho người thật để không bị báo đầy / lệch tổng vai!
  const configuredRolesCount = Object.values(room.rolesConfig || {}).reduce(
    (s, v) => s + (Number(v) || 0),
    0
  );
  const hasAnyBot = room.players.some((p) => p.isBot);
  if (
    hasAnyBot &&
    (room.players.length >= 18 ||
      (configuredRolesCount >= 6 && room.players.length >= configuredRolesCount))
  ) {
    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].isBot) {
        room.players.splice(i, 1);
        break;
      }
    }
  }

  if (room.players.length >= 18) {
    return { error: "Phòng đã đầy (tối đa 18 người)." };
  }

  const existingNames = room.players.map((p) => p.name);
  if (!name || existingNames.includes(name)) {
    name = getDefaultName(existingNames);
  }

  const safeAvatarUrl = sanitizeAvatarUrl(avatarUrl);
  const safeCitizenReq = sanitizeCitizenModelId(options?.citizenModelId);
  const citizenSpec = resolveCitizenAvatarSpec(safeCitizenReq, {
    fallbackSeed: `${name}-${String(socketId).slice(0, 4)}`,
    forBot: false,
  });
  const isFirstRealHuman = realHumansBefore.length === 0;
  const player = {
    id: socketId,
    socketId: socketId,
    deviceId: cleanDeviceId || null,
    connected: true,
    sessionToken: randomUUID(),
    disconnectedAt: null,
    name,
    citizenModelId: citizenSpec.citizenModelId,
    avatarSource: citizenSpec.avatarSource,
    avatar: safeAvatarUrl || citizenSpec.avatar,
    isHost: isFirstRealHuman,
    ready: isFirstRealHuman,
    seatIndex: room.players.length,
    alive: true,
    role: null,
  };
  room.players.push(player);
  reindexSeats(room);

  // Khóa công bằng tự động: ngay khi có từ 2 người thật trở lên -> xóa chọn vai test 1 mình, bắt buộc chia ngẫu nhiên 100%!
  const realHumansNow = room.players.filter((p) => !p.isBot);
  if (realHumansNow.length >= 2) {
    room.soloPracticeRole = null;
  }

  // Cập nhật cấu hình vai trò mặc định nếu phòng chưa có config
  if (room.phase === "lobby" && (!room.rolesConfig || Object.keys(room.rolesConfig).length === 0)) {
    room.rolesConfig = generateDefaultRoles(Math.max(6, room.players.length));
  }
  return { room, player };
}

export function reconnectByToken(code, token, newSocketId) {
  const room = getRoom(code);
  if (!room) return { error: "Token không hợp lệ hoặc đã hết hạn." };

  const player = room.players.find((p) => !p.isBot && p.sessionToken === token);
  if (!player) {
    const spec = (room.spectators || []).find((s) => s.sessionToken === token);
    if (spec) {
      clearOrphanTimer(room);
      spec.socketId = newSocketId;
      spec.connected = true;
      return { room, spectator: spec, isSpectator: true };
    }
    return { error: "Token không hợp lệ hoặc đã hết hạn." };
  }

  if (player.disconnectedAt !== null && Date.now() - player.disconnectedAt > 30 * 60 * 1000) {
    return { error: "Phiên chơi đã hết hạn (30 phút). Vui lòng tạo phòng mới." };
  }

  clearOrphanTimer(room);
  player.socketId = newSocketId;
  player.connected = true;
  player.leftExplicitly = false;
  player.disconnectedAt = null;
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }

  return { room, player };
}

export function removePlayer(code, socketId, { explicitLeave = false, onOrphanExpire = null } = {}) {
  const room = getRoom(code);
  if (!room) return null;

  const player = room.players.find((p) => p.socketId === socketId || p.id === socketId);
  if (!player) {
    if (Array.isArray(room.spectators)) {
      const beforeLen = room.spectators.length;
      room.spectators = room.spectators.filter((s) => s.socketId !== socketId && s.id !== socketId);
      if (room.spectators.length !== beforeLen) {
        return room;
      }
    }
    return room;
  }

  if (room.phase === "lobby") {
    room.players = room.players.filter((p) => p.id !== player.id);
    reindexSeats(room);
    // Chuyển host (ưu tiên người thật hơn Bot)
    if (room.players.length > 0 && !room.players.some((p) => p.isHost)) {
      const nextHost = room.players.find((p) => !p.isBot) || room.players[0];
      nextHost.isHost = true;
      nextHost.ready = true;
      room.hostId = nextHost.id;
    }
  } else {
    // Đang chơi / tổng kết: đánh dấu ngắt kết nối để giữ cơ hội F5 reconnect
    player.connected = false;
    player.disconnectedAt = Date.now();
    if (explicitLeave) player.leftExplicitly = true;
  }

  const realPlayers = room.players.filter((p) => !p.isBot);
  const connectedHumans = realPlayers.filter((p) => p.connected);
  const isLobbyEmpty = room.phase === "lobby" && realPlayers.length === 0;
  const isEndedAndEmpty = room.phase === "ended" && connectedHumans.length === 0;
  const isPlayingExplicitlyAbandoned =
    room.phase === "playing" &&
    connectedHumans.length === 0 &&
    (realPlayers.length === 0 || explicitLeave || realPlayers.every((p) => p.leftExplicitly));

  if (isLobbyEmpty || isEndedAndEmpty || isPlayingExplicitlyAbandoned) {
    deleteRoom(room.code);
    return null;
  }

  // Nếu đang chơi mà người thật cuối cùng rớt mạng / đóng tab (không bấm Rời),
  // giữ 45s ân hạn cho F5 reconnect, sau 45s tự thu dọn phòng mồ côi tránh chạy Bot vô tận!
  if (room.phase === "playing" && connectedHumans.length === 0 && !room.orphanCleanupTimer) {
    room.orphanCleanupTimer = setTimeout(() => {
      const fresh = getRoom(code);
      if (!fresh) return;
      const stillConnected = fresh.players.filter((p) => !p.isBot && p.connected);
      if (stillConnected.length === 0) {
        onOrphanExpire?.(fresh.code);
        deleteRoom(fresh.code);
      }
    }, 45000);
    room.orphanCleanupTimer.unref?.();
  }

  return room;
}

export function setRoomAccess(code, requesterSocketId, { roomTitle, accessMode, password } = {}) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  if (room.phase !== "lobby") {
    return { error: "Chỉ có thể đổi chế độ phòng khi đang ở sảnh chờ." };
  }
  const player = room.players.find(
    (p) => p.socketId === requesterSocketId || p.id === requesterSocketId
  );
  if (!player || !player.isHost) {
    return { error: "Chỉ chủ phòng mới có quyền đổi bảo mật phòng." };
  }

  if (roomTitle !== undefined) {
    room.roomTitle = String(roomTitle || "").trim().slice(0, 36);
  }

  if (accessMode !== undefined) {
    if (!["public", "password", "hidden"].includes(accessMode)) {
      return { error: "Chế độ phòng không hợp lệ." };
    }
    if (accessMode === "password") {
      const nextPwd =
        password !== undefined
          ? String(password || "").trim().slice(0, 32)
          : String(room.password || "").trim();
      if (!nextPwd) {
        return { error: "Vui lòng nhập mật khẩu (tối thiểu 1 ký tự) để khóa phòng." };
      }
      room.password = nextPwd;
    } else {
      room.password = "";
    }
    room.accessMode = accessMode;
  } else if (password !== undefined && room.accessMode === "password") {
    const nextPwd = String(password || "").trim().slice(0, 32);
    if (!nextPwd) {
      return { error: "Mật khẩu không được để trống." };
    }
    room.password = nextPwd;
  }

  return { ok: true, room };
}

export function setSoloPracticeRole(code, requesterSocketId, roleKey) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  if (room.phase !== "lobby") {
    return { error: "Chỉ chọn vai test trước khi ván đấu bắt đầu." };
  }
  const realHumans = room.players.filter((p) => !p.isBot);
  if (realHumans.length !== 1) {
    room.soloPracticeRole = null;
    return {
      error: "Chỉ chọn vai test khi chơi 1 mình. Có từ 2 người thật trở lên sẽ chia vai ngẫu nhiên công bằng!",
    };
  }
  const me = realHumans[0];
  if (me.socketId !== requesterSocketId && me.id !== requesterSocketId) {
    return { error: "Không tìm thấy người chơi." };
  }
  const validRole = roleKey && ROLE_LABELS[roleKey] ? roleKey : null;
  room.soloPracticeRole = validRole;
  if (validRole) {
    ensureRoleInLobbyConfig(room, validRole);
  }
  return { ok: true, room, role: validRole };
}

export function addBotsToRoom(code, count = 1, { syncRolesMode = null } = {}) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  if (room.phase !== "lobby") {
    return { error: "Chỉ thêm AI Bot khi đang ở sảnh chờ." };
  }

  const wanted = Math.max(0, Number(count) || 0);
  const canAdd = Math.min(wanted, 18 - room.players.length);
  const existingNames = new Set(room.players.map((p) => p.name));

  for (let i = 0; i < canAdd; i++) {
    const idx = room.players.filter((p) => p.isBot).length;
    let botName = BOT_NAMES[idx % BOT_NAMES.length];
    if (existingNames.has(botName)) botName = `${botName} #${idx + 1}`;
    existingNames.add(botName);

    const persona = BOT_PERSONAS[idx % BOT_PERSONAS.length];
    const botVillagerId = BUILTIN_VILLAGER_IDS[idx % BUILTIN_VILLAGER_IDS.length];
    const botSpec = resolveCitizenAvatarSpec(botVillagerId, { forBot: true });
    room.players.push({
      id: `bot_${randomUUID().slice(0, 8)}`,
      socketId: null,
      isBot: true,
      personaId: persona.id,
      personaLabel: persona.label,
      connected: true,
      sessionToken: null,
      disconnectedAt: null,
      name: botName,
      citizenModelId: botSpec.citizenModelId,
      avatarSource: "builtin_villager",
      avatar: botSpec.avatar,
      isHost: false,
      ready: true,
      seatIndex: room.players.length,
      alive: true,
      role: null,
    });
  }
  reindexSeats(room);

  if (syncRolesMode === "v33") {
    room.rolesConfig = generateExpandedV33Roles(Math.max(6, room.players.length));
  } else if (syncRolesMode === "classic") {
    room.rolesConfig = generateDefaultRoles(Math.max(6, room.players.length));
  } else if (syncRolesMode === "match") {
    const useV33 = hasExpandedV33Role(room.rolesConfig);
    room.rolesConfig = useV33
      ? generateExpandedV33Roles(Math.max(6, room.players.length))
      : generateDefaultRoles(Math.max(6, room.players.length));
  }

  const realHumans = room.players.filter((p) => !p.isBot);
  if (realHumans.length === 1 && room.soloPracticeRole) {
    ensureRoleInLobbyConfig(room, room.soloPracticeRole);
  }
  if (room.devForcedRoles) {
    Object.values(room.devForcedRoles).forEach((rKey) => {
      if (rKey) ensureRoleInLobbyConfig(room, rKey);
    });
  }

  return { ok: true, room, added: canAdd, total: room.players.length };
}

export function clearBotsFromRoom(code, { syncRoles = true } = {}) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  if (room.phase !== "lobby") {
    return { error: "Hãy về sảnh chờ trước khi xóa AI Bot." };
  }
  const useV33 = hasExpandedV33Role(room.rolesConfig);
  room.players = room.players.filter((p) => !p.isBot);
  reindexSeats(room);

  if (syncRoles) {
    const targetCount = Math.max(6, room.players.length);
    room.rolesConfig = useV33
      ? generateExpandedV33Roles(targetCount)
      : generateDefaultRoles(targetCount);
  }

  const realHumans = room.players.filter((p) => !p.isBot);
  if (realHumans.length === 1 && room.soloPracticeRole) {
    ensureRoleInLobbyConfig(room, room.soloPracticeRole);
  }

  return { ok: true, room, total: room.players.length };
}

export function getPublicRoomsList() {
  const list = [];
  for (const room of rooms.values()) {
    // Phòng ẩn ('hidden') tuyệt đối KHÔNG xuất hiện trên danh sách công khai (chỉ vào được bằng Mã 5 ký tự)
    if (room.accessMode === "hidden") continue;

    const realHumans = room.players.filter((p) => !p.isBot);
    const connectedHumans = realHumans.filter((p) => p.connected);
    if (realHumans.length === 0 || connectedHumans.length === 0) continue;

    const hostPlayer =
      realHumans.find((p) => p.isHost) ||
      room.players.find((p) => p.isHost) ||
      realHumans[0];
    const totalRoles = Object.values(room.rolesConfig || {}).reduce(
      (s, v) => s + (Number(v) || 0),
      0
    );
    const botCount = room.players.length - realHumans.length;
    const maxSeats = Math.min(18, Math.max(6, totalRoles, room.players.length));
    const aliveCount = room.game
      ? room.players.filter((p) => p.alive).length
      : room.players.length;

    // Zero-Leak: KHÔNG bao giờ gửi room.password hoặc vai trò của bất kỳ ai ra ngoài danh sách sảnh!
    list.push({
      code: room.code,
      roomTitle: room.roomTitle || `Bàn của ${hostPlayer?.name || "Chủ phòng"}`,
      hostName: hostPlayer?.name || "Chủ phòng",
      hostAvatar: hostPlayer?.avatar || null,
      accessMode: room.accessMode === "password" ? "password" : "public",
      hasPassword: room.accessMode === "password",
      isTurbo: Boolean(room.isTurbo),
      phase: room.phase, // 'lobby' | 'playing' | 'ended'
      humanCount: realHumans.length,
      botCount,
      spectatorCount: (room.spectators || []).filter((s) => s.connected).length,
      totalPlayers: room.players.length,
      maxSeats,
      hasExpandedRoles: hasExpandedV33Role(room.rolesConfig),
      dayNumber: room.game?.dayNumber || 0,
      nightDayPhase: room.game?.phase || null,
      aliveCount,
      createdAt: room.createdAt || 0,
    });
  }

  const phaseRank = { lobby: 0, ended: 1, playing: 2 };
  list.sort((a, b) => {
    const rankDiff = (phaseRank[a.phase] ?? 9) - (phaseRank[b.phase] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  return list;
}

export function renamePlayer(
  code,
  socketId,
  newName,
  avatarSeed = null,
  avatarUrl = null,
  citizenModelId = null
) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  const trimmed = sanitizeChatText(String(newName || ""), 20);
  if (!trimmed) return { error: "Tên không được để trống." };
  if (trimmed.length > 20) return { error: "Tên tối đa 20 ký tự." };

  const taken = room.players.some(
    (p) => p.socketId !== socketId && p.name === trimmed
  );
  if (taken) return { error: "Tên này đã có người dùng trong phòng." };

  const player = room.players.find((p) => p.socketId === socketId || p.id === socketId);
  if (!player) return { error: "Không tìm thấy người chơi." };
  const safeAvatarUrl = sanitizeAvatarUrl(avatarUrl);
  const safeCitizenReq = sanitizeCitizenModelId(citizenModelId || player.citizenModelId);
  const citizenSpec = resolveCitizenAvatarSpec(safeCitizenReq, {
    fallbackSeed: `${trimmed}-${String(player.id).slice(0, 4)}`,
    forBot: Boolean(player.isBot),
  });
  player.name = trimmed;
  player.citizenModelId = citizenSpec.citizenModelId;
  player.avatarSource = citizenSpec.avatarSource;
  player.avatar = safeAvatarUrl || citizenSpec.avatar;
  return { room, player };
}

export function setPlayerCitizenModel(code, socketId, requestedCitizenModelId) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  if (room.phase !== "lobby") {
    return { error: "Chỉ có thể đổi nhân vật 3D khi đang ở sảnh chờ." };
  }
  const player = room.players.find((p) => p.socketId === socketId || p.id === socketId);
  if (!player || player.isBot) {
    return { error: "Không tìm thấy người chơi." };
  }
  const safeCitizenReq = sanitizeCitizenModelId(requestedCitizenModelId);
  const citizenSpec = resolveCitizenAvatarSpec(safeCitizenReq, {
    fallbackSeed: `${player.name}-${String(player.id).slice(0, 4)}`,
    forBot: false,
  });
  player.citizenModelId = citizenSpec.citizenModelId;
  player.avatarSource = citizenSpec.avatarSource;
  player.avatar = citizenSpec.avatar;
  return {
    ok: true,
    room,
    player,
    citizenModelId: player.citizenModelId,
    avatar: player.avatar,
  };
}

export function setRoomTurbo(code, requesterSocketId, isTurbo) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  if (room.phase !== "lobby") {
    return { error: "Chỉ có thể bật/tắt chế độ Tốc Chiến khi đang ở sảnh chờ." };
  }
  const player = room.players.find(
    (p) => p.socketId === requesterSocketId || p.id === requesterSocketId
  );
  if (!player || !player.isHost) {
    return { error: "Chỉ chủ phòng mới có quyền đổi chế độ Tốc Chiến." };
  }
  room.isTurbo = Boolean(isTurbo);
  return { ok: true, room, isTurbo: room.isTurbo };
}

export function setRoomMcPacingMode(code, requesterSocketId, requestedMode) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  const player = room.players.find(
    (p) => p.socketId === requesterSocketId || p.id === requesterSocketId
  );
  const realHumans = room.players.filter((p) => !p.isBot);
  const isSoloHuman = realHumans.length === 1 && realHumans[0]?.id === player?.id;
  if (!player || (!player.isHost && !isSoloHuman)) {
    return { error: "Chỉ chủ phòng (hoặc người chơi Solo) mới có thể đổi nhịp đọc MC." };
  }
  const currentEffective = resolveEffectiveMcPacingMode(room);
  const nextMode =
    requestedMode === "full" || requestedMode === "fast"
      ? requestedMode
      : currentEffective === "full"
        ? "fast"
        : "full";
  room.mcPacingMode = nextMode;
  return { ok: true, room, mcPacingMode: nextMode };
}

export function toggleReady(code, socketId) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  const player = room.players.find((p) => p.socketId === socketId || p.id === socketId);
  if (!player) return { error: "Không tìm thấy người chơi." };

  if (player.isHost) {
    player.ready = true;
  } else {
    player.ready = !player.ready;
  }
  return { ok: true, room, ready: player.ready };
}

export function setRolesConfig(code, requesterSocketId, newConfig) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  const player = room.players.find(
    (p) => p.socketId === requesterSocketId || p.id === requesterSocketId
  );
  if (!player || !player.isHost) {
    return { error: "Chỉ chủ phòng mới có quyền thay đổi cấu hình vai trò." };
  }
  if (!newConfig || typeof newConfig !== "object") {
    return { error: "Cấu hình vai trò không hợp lệ." };
  }
  room.rolesConfig = newConfig;
  if (room.soloPracticeRole && !(Number(room.rolesConfig[room.soloPracticeRole]) > 0)) {
    room.soloPracticeRole = null;
  }
  return { ok: true, room };
}

export function setScenePreset(code, requesterSocketId, presetId) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  if (room.phase !== "lobby") {
    return { error: "Chỉ có thể đổi bối cảnh khi đang ở phòng chờ." };
  }
  const player = room.players.find(
    (p) => p.socketId === requesterSocketId || p.id === requesterSocketId
  );
  if (!player || !player.isHost) {
    return { error: "Chỉ chủ phòng mới có quyền chọn bối cảnh không gian." };
  }
  const safeId = String(presetId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) {
    return { error: "Mã bối cảnh không hợp lệ." };
  }
  room.scenePresetId = safeId;
  return { ok: true, room, scenePresetId: safeId };
}

export function addLobbyMessage(code, senderSocketId, text) {
  const room = getRoom(code);
  if (!room) return null;
  const player = room.players.find((p) => p.socketId === senderSocketId);
  if (!player) return null;
  const trimmed = sanitizeChatText(String(text || ""), MAX_CHAT_LENGTH);
  if (!trimmed) return null;

  const msg = {
    id: randomUUID(),
    senderId: player.id,
    senderName: player.name,
    avatar: player.avatar,
    text: trimmed,
    time: new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }),
  };

  if (!room.lobbyMessages) room.lobbyMessages = [];
  room.lobbyMessages.push(msg);
  if (room.lobbyMessages.length > 50) {
    room.lobbyMessages.shift();
  }
  return msg;
}

const MAX_SPECTATORS_PER_ROOM = 12;

/**
 * Chế Độ Vào Xem & Đặt Ghế Ván Sau (Zero-Leak Spectator Queue — V4.1):
 * - Nếu phòng đang ở 'lobby' -> tự chuyển sang addPlayer ngồi ghế thật ngay.
 * - Nếu phòng đang 'playing' hoặc 'ended' -> cho vào room.spectators (Mù Vai Trò 100%, khóa Mic & Chat ngày),
 *   và ngay khi phòng mở lại Sảnh chờ ván sau -> tự động xếp ghế chơi chính thức!
 */
export function addSpectator(
  code,
  socketId,
  requestedName,
  avatarSeed = null,
  avatarUrl = null,
  passwordInput = "",
  options = {}
) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại hoặc đã đóng." };

  if (room.phase === "lobby") {
    const joined = addPlayer(code, socketId, requestedName, avatarSeed, avatarUrl, passwordInput, options);
    if (joined.error) return joined;
    return { ...joined, ok: true, isSpectator: false };
  }

  if (room.accessMode === "password") {
    const cleanInput = String(passwordInput || "").trim();
    if (!cleanInput) {
      return {
        error: "Phòng này có đặt mật khẩu. Vui lòng nhập mật khẩu để vào xem!",
        requirePassword: true,
      };
    }
    if (cleanInput !== room.password) {
      return {
        error: "Mật khẩu phòng không chính xác!",
        requirePassword: true,
        passwordFailed: true,
      };
    }
  }

  if (!Array.isArray(room.spectators)) room.spectators = [];
  const existingSpec = room.spectators.find((s) => s.socketId === socketId);
  if (existingSpec) {
    existingSpec.connected = true;
    return { ok: true, room, spectator: existingSpec, isSpectator: true };
  }

  // SEC-07: Không cho phép 1 trình duyệt vừa ngồi ghế chơi vừa mở tab Spectator trong bàn công khai
  const cleanDeviceId = sanitizeDeviceId(options?.deviceId);
  const enforceAntiMultiTab =
    options?.enforceAntiMultiTab !== undefined
      ? Boolean(options.enforceAntiMultiTab)
      : IS_PRODUCTION_ENV;
  if (
    enforceAntiMultiTab &&
    cleanDeviceId &&
    room.accessMode === "public" &&
    room.players.some((p) => !p.isBot && p.connected && p.deviceId && p.deviceId === cleanDeviceId)
  ) {
    return {
      error: "Thiết bị này đã đang ngồi trong ván đấu! Không mở thêm tab khán giả trên cùng máy.",
    };
  }

  const activeSpecs = room.spectators.filter((s) => s.connected);
  if (activeSpecs.length >= MAX_SPECTATORS_PER_ROOM) {
    return { error: `Hàng ghế khán giả của bàn này đã đầy (${MAX_SPECTATORS_PER_ROOM} người xem).` };
  }

  let name = sanitizeChatText(String(requestedName || ""), 20);
  const usedNames = [
    ...room.players.map((p) => p.name),
    ...room.spectators.map((s) => s.name),
  ];
  if (!name || usedNames.includes(name)) {
    name = getDefaultName(usedNames);
  }

  const safeAvatarUrl = sanitizeAvatarUrl(avatarUrl);
  const safeCitizenReq = sanitizeCitizenModelId(options?.citizenModelId);
  const citizenSpec = resolveCitizenAvatarSpec(safeCitizenReq, {
    fallbackSeed: `${name}-${String(socketId).slice(0, 4)}`,
    forBot: false,
  });
  const spectator = {
    id: socketId,
    socketId,
    deviceId: cleanDeviceId || null,
    connected: true,
    isSpectator: true,
    sessionToken: randomUUID(),
    name,
    citizenModelId: citizenSpec.citizenModelId,
    avatarSource: citizenSpec.avatarSource,
    avatar: safeAvatarUrl || citizenSpec.avatar,
    joinedAt: Date.now(),
  };
  room.spectators.push(spectator);
  return { ok: true, room, spectator, isSpectator: true };
}

/**
 * Ghép Bàn Nhanh 1-Chạm (Quick Match — V4.1):
 * Ưu tiên vào bàn Công khai không mật khẩu đang chờ đông người thật nhất;
 * nếu chưa có bàn nào phù hợp thì tự tạo bàn mới kèm bộ 8 vai Mở rộng V3.3 + AI Bot sẵn sàng.
 */
export function findOrCreateQuickMatchRoom(
  socketId,
  {
    name = null,
    avatarSeed = null,
    avatarUrl = null,
    citizenModelId = null,
    preferTurbo = false,
    deviceId = null,
    enforceAntiMultiTab = undefined,
  } = {}
) {
  const cleanDeviceId = sanitizeDeviceId(deviceId);
  const shouldEnforceDevice =
    enforceAntiMultiTab !== undefined ? Boolean(enforceAntiMultiTab) : IS_PRODUCTION_ENV;

  const candidates = [];
  for (const room of rooms.values()) {
    if (room.phase !== "lobby") continue;
    if (room.accessMode !== "public") continue;
    const realHumans = room.players.filter((p) => !p.isBot);
    const connectedHumans = realHumans.filter((p) => p.connected);
    if (connectedHumans.length === 0) continue;
    if (realHumans.length >= 18) continue;
    if (
      shouldEnforceDevice &&
      cleanDeviceId &&
      realHumans.some((p) => p.connected && p.deviceId && p.deviceId === cleanDeviceId)
    ) {
      continue;
    }
    candidates.push({
      room,
      humanCount: connectedHumans.length,
      turboMatch: Boolean(room.isTurbo) === Boolean(preferTurbo) ? 1 : 0,
    });
  }

  candidates.sort((a, b) => {
    if (b.humanCount !== a.humanCount) return b.humanCount - a.humanCount;
    if (b.turboMatch !== a.turboMatch) return b.turboMatch - a.turboMatch;
    return (b.room.createdAt || 0) - (a.room.createdAt || 0);
  });

  for (const cand of candidates) {
    const joined = addPlayer(
      cand.room.code,
      socketId,
      name,
      avatarSeed,
      avatarUrl,
      "",
      { deviceId: cleanDeviceId, enforceAntiMultiTab, citizenModelId }
    );
    if (!joined.error && joined.room && joined.player) {
      return {
        ok: true,
        matchedExisting: true,
        room: joined.room,
        player: joined.player,
      };
    }
  }

  if (!canCreateNewRoom()) {
    return {
      error: "Máy chủ đang đầy bàn chơi (150 phòng). Mời bạn bấm Vào Xem một bàn đang mở!",
    };
  }

  const newRoom = createRoom(socketId, {
    roomTitle: preferTurbo ? "⚡ Bàn Ghép Nhanh (5 Phút)" : "🔥 Bàn Ghép Nhanh Sôi Động",
    accessMode: "public",
    isTurbo: Boolean(preferTurbo),
  });
  const createdJoin = addPlayer(
    newRoom.code,
    socketId,
    name,
    avatarSeed,
    avatarUrl,
    "",
    {
      deviceId: cleanDeviceId,
      enforceAntiMultiTab,
      citizenModelId,
      isNewQuickMatchRoom: true,
    }
  );
  if (createdJoin.error) {
    deleteRoom(newRoom.code);
    return createdJoin;
  }
  newRoom.rolesConfig = generateExpandedV33Roles(8);
  addBotsToRoom(newRoom.code, 5);
  return {
    ok: true,
    matchedExisting: false,
    createdNew: true,
    room: newRoom,
    player: createdJoin.player,
  };
}

/**
 * Mở lại Sảnh chờ sau khi kết thúc ván & tự động đôn Khán Giả đặt chỗ (`room.spectators`) vào ngồi ghế chính thức!
 */
export function resetRoomToLobby(room) {
  if (!room) return null;
  clearRoomExtraTimers(room);
  room.game = null;
  room.phase = "lobby";
  room.lastAutoPhaseKey = null;
  room.lastHumanVillageChatAt = 0;

  // Thu dọn những người chơi thật đã thoát hẳn giữa trận trước khi xếp lại ghế
  room.players = room.players.filter((p) => p.isBot || (p.connected && !p.leftExplicitly));

  room.players.forEach((p) => {
    p.alive = true;
    p.role = null;
    delete p.initialRole;
    p.ready = p.isHost || Boolean(p.isBot);
  });

  // Đảm bảo vẫn còn 1 Host người thật nếu Host cũ đã rời đi
  if (room.players.length > 0 && !room.players.some((p) => !p.isBot && p.isHost)) {
    room.players.forEach((p) => {
      p.isHost = false;
    });
    const nextHumanHost = room.players.find((p) => !p.isBot && p.connected);
    if (nextHumanHost) {
      nextHumanHost.isHost = true;
      nextHumanHost.ready = true;
      room.hostId = nextHumanHost.id;
    }
  }

  // Đôn toàn bộ Khán giả đang kết nối lên ngồi ghế chơi ván mới (nhường ghế AI Bot nếu cần)
  const promotedIds = [];
  const waitingSpectators = Array.isArray(room.spectators)
    ? room.spectators.filter((s) => s.connected)
    : [];
  const remainingSpectators = [];

  for (const spec of waitingSpectators) {
    const realCount = room.players.filter((p) => !p.isBot).length;
    if (realCount >= 18) {
      remainingSpectators.push(spec);
      continue;
    }
    if (room.players.length >= 18) {
      const botIdx = room.players.findLastIndex((p) => p.isBot);
      if (botIdx >= 0) room.players.splice(botIdx, 1);
    }
    if (room.players.length >= 18) {
      remainingSpectators.push(spec);
      continue;
    }

    const usedNames = room.players.map((p) => p.name);
    const finalName = usedNames.includes(spec.name) ? getDefaultName(usedNames) : spec.name;
    const becomeHost = !room.players.some((p) => !p.isBot && p.isHost);
    room.players.push({
      id: spec.id,
      socketId: spec.socketId,
      deviceId: spec.deviceId || null,
      connected: true,
      sessionToken: spec.sessionToken || randomUUID(),
      disconnectedAt: null,
      name: finalName,
      citizenModelId: spec.citizenModelId || "villager_cloak",
      avatarSource: spec.avatarSource || "builtin_villager",
      avatar: spec.avatar || "/portraits/badges/villager_cloak.webp",
      isHost: becomeHost,
      ready: becomeHost,
      seatIndex: room.players.length,
      alive: true,
      role: null,
    });
    if (becomeHost) room.hostId = spec.id;
    promotedIds.push(spec.id);
  }

  room.spectators = remainingSpectators;
  reindexSeats(room);

  const realHumansNow = room.players.filter((p) => !p.isBot);
  if (realHumansNow.length >= 2) {
    room.soloPracticeRole = null;
  }

  // Nếu tổng ghế người vượt quá tổng vai cấu hình cũ, tự bù thêm Nông Dân cho cân
  const totalRoles = Object.values(room.rolesConfig || {}).reduce(
    (s, v) => s + (Number(v) || 0),
    0
  );
  if (room.players.length > totalRoles) {
    room.rolesConfig = {
      ...(room.rolesConfig || {}),
      villager: (Number(room.rolesConfig?.villager) || 0) + (room.players.length - totalRoles),
    };
  }

  return { room, promotedIds };
}

// Trả về bản public của room (an toàn để gửi cho mọi client — không lộ role người khác & KHÔNG lộ mật khẩu)
export function publicRoomView(room, forSocketId) {
  const g = room.game;
  const gameOver = g?.winner;
  const me = room.players.find((p) => p.socketId === forSocketId);
  const realHumans = room.players.filter((p) => !p.isBot);
  const hostPlayer =
    realHumans.find((p) => p.isHost) ||
    room.players.find((p) => p.isHost) ||
    realHumans[0];

  const isLocalDev = !IS_PRODUCTION_ENV && process.env.ALLOW_LOCAL_STUDIO === "1";

  const base = {
    code: room.code,
    phase: room.phase, // 'lobby' | 'playing' | 'ended'
    roomTitle: room.roomTitle || `Bàn của ${hostPlayer?.name || "Chủ phòng"}`,
    rawRoomTitle: room.roomTitle || "",
    accessMode: room.accessMode || "public", // 'public' | 'password' | 'hidden'
    hasPassword: room.accessMode === "password",
    isTurbo: Boolean(room.isTurbo),
    mcPacingMode: resolveEffectiveMcPacingMode(room),
    canToggleMcPacing: Boolean(
      me && (me.isHost || (realHumans.length === 1 && realHumans[0]?.id === me.id))
    ),
    humanCount: realHumans.length,
    botCount: room.players.length - realHumans.length,
    spectatorCount: (room.spectators || []).filter((s) => s.connected).length,
    isSpectator: false,
    serverGoldenHour: getVietnamGoldenHourInfo(),
    soloPracticeRole: realHumans.length === 1 ? room.soloPracticeRole || null : null,
    scenePresetId: room.scenePresetId || "nordic_village_v3",
    rolesConfig: room.rolesConfig || generateDefaultRoles(Math.max(6, room.players.length)),
    lobbyMessages: room.lobbyMessages || [],
    devSandbox: isLocalDev
      ? {
          autoBot: room.devAutoBot !== false,
          forcedRole: (me && room.devForcedRoles?.[me.id]) || null,
        }
      : undefined,
    players: room.players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      citizenModelId: p.citizenModelId || "villager_cloak",
      avatarSource: p.avatarSource || "builtin_villager",
      seatIndex: typeof p.seatIndex === "number" ? p.seatIndex : idx,
      isHost: p.isHost,
      isBot: Boolean(p.isBot),
      personaId: p.isBot ? p.personaId || "sharp_fox" : undefined,
      personaLabel: p.isBot ? p.personaLabel || null : undefined,
      ready: p.isHost ? true : Boolean(p.ready),
      alive: p.alive,
      connected: p.connected,
      sessionToken: p.id === me?.id ? p.sessionToken : undefined,
      // chỉ trả về role của chính người xem, hoặc nếu game đã kết thúc, hoặc đã chết (lộ bài)
      role: p.id === me?.id || gameOver || !p.alive ? p.role : null,
      initialRole: gameOver ? (p.initialRole || p.role) : undefined,
    })),
  };


  if (!g) return base;

  return {
    ...base,
    game: {
      dayNumber: g.dayNumber,
      nightDayPhase: g.phase,
      roleCounts: g.roleCounts,
      deadWolfCount: room.players.filter((p) => !p.alive && isWolfTeamRole(p.role)).length,
      nightDeaths: [
        "hunter_revenge",
        "day_reveal",
        "day_discuss",
        "day_nominate",
        "day_defense",
        "day_final_vote",
        "day_no_nomination",
      ].includes(g.phase)
        ? g.nightDeaths
        : [],
      gameStartedAt: g.gameStartedAt,
      phaseEndsAt: g.phaseEndsAt,
      phaseDurationSec: g.phaseDurationSec || null,
      isTurbo: Boolean(room.isTurbo),
      mcPacingMode: resolveEffectiveMcPacingMode(room),
      roleRevealReadyIds: g.phase === "role_reveal" ? g.roleRevealReadyIds || {} : undefined,
      discussEndsAt: g.discussEndsAt,
      nominees: g.nominees,
      hotSeatQueue: g.hotSeatQueue,
      hotSeatIndex: g.hotSeatIndex,
      hotSeatEndsAt: g.hotSeatEndsAt,
      finalVoteEndsAt: g.finalVoteEndsAt,
      // Trạng thái công khai V3.3 (Quyền Trượng Trưởng Làng & Hơi Thở Cuối của Thợ Săn)
      mayorRevealedId: g.mayorRevealedId || null,
      hunterPendingId: g.phase === "hunter_revenge" ? g.hunterPendingId || null : null,
      loversPublic: gameOver ? g.lovers || null : null,
      // vote đề cử công khai -> ai cũng thấy ai vote ai
      nominationVotes: g.phase === "day_nominate" || (g.hotSeatQueue?.length ?? 0) > 0 ? g.nominationVotes : {},
      finalVotes: g.phase === "day_final_vote" ? g.finalVotes : {},
      winner: g.winner,
      rematchEndsAt: gameOver ? g.rematchEndsAt || null : null,
      rematchReadyCount: gameOver ? Object.keys(g.rematchReadyIds || {}).length : 0,
      rematchRequiredCount: gameOver
        ? Math.max(1, Math.ceil(realHumans.filter((p) => p.connected).length / 2))
        : 0,
      myRematchReady: Boolean(gameOver && me && g.rematchReadyIds?.[me.id]),
      myGhostBet: me && (!me.alive || gameOver) ? g.ghostBets?.[me.id] || null : null,
      ghostBetBonusXp:
        gameOver && me && g.ghostBets?.[me.id] && g.ghostBets[me.id] === g.winner ? 35 : 0,
      history: gameOver ? g.history : [],
      replayTimeline: gameOver ? g.replayTimeline || [] : [],
      awards: gameOver ? g.awards || [] : [],
      skipDiscussVotes: g.phase === "day_discuss" ? g.skipDiscussVotes : {},

      // Thông tin riêng theo vai trò của người xem (Zero-Leak)
      myRole: me?.role || null,
      myLoverPartnerId:
        me && Array.isArray(g.lovers) && g.lovers.includes(me.id)
          ? g.lovers.find((id) => id !== me.id) || null
          : null,
      cupidLinkedIds: me?.role === "cupid" ? g.lovers || null : null,
      wolfTeammates:
        isWolfTeamRole(me?.role)
          ? room.players.filter((p) => isWolfTeamRole(p.role) && p.id !== me.id).map((p) => p.id)
          : [],
      wolfPicksVisible: isWolfTeamRole(me?.role) ? g.wolfPicks : null,
      alphaWolfInfo:
        isWolfTeamRole(me?.role)
          ? {
              usedConvert: Boolean(g.alphaUsedConvert),
              convertTonight: Boolean(g.alphaConvertTonight),
              hasAliveAlpha: room.players.some((p) => p.alive && p.role === "alpha_wolf"),
              alphaWolfId: room.players.find((p) => p.role === "alpha_wolf")?.id || null,
            }
          : null,
      witchInfo:
        me?.role === "witch"
          ? {
              victimId: g.wolfVictimId,
              usedSave: g.witchUsedSave,
              usedPoison: g.witchUsedPoison,
            }
          : null,
      seerLastResult:
        me?.role === "seer"
          ? g.seerChecksLog.filter((c) => c.seerId === me.id).slice(-1)[0] || null
          : null,
    },
  };
}

/**
 * Bản xem hoàn toàn Mù Vai Trò (100% Zero-Leak) dành riêng cho Khán giả đang đặt chỗ (`room.spectators`).
 */
export function publicSpectatorView(room, forSocketId) {
  const baseView = publicRoomView(room, "__SPECTATOR_ZERO_LEAK__");
  const spec = (room.spectators || []).find((s) => s.socketId === forSocketId);
  return {
    ...baseView,
    isSpectator: true,
    mySpectatorId: spec?.id || null,
    mySpectatorName: spec?.name || "Khán giả",
    spectatorSessionToken: spec?.sessionToken || undefined,
  };
}
