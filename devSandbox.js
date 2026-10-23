import { randomUUID } from "crypto";
import { getRoom } from "./rooms.js";
import { generateDefaultRoles, ROLE_LABELS } from "./roles.js";

export const IS_LOCAL_DEV = !process.env.RENDER && process.env.NODE_ENV !== "production";

const BOT_NAMES = [
  "🤖 Bot Sói Xám", "🤖 Bot Cáo Đỏ", "🤖 Bot Cú Đêm", "🤖 Bot Thợ Săn",
  "🤖 Bot Cổ Thụ", "🤖 Bot Ánh Trăng", "🤖 Bot Sương Mù", "🤖 Bot Hổ Phách",
  "🤖 Bot Bão Tố", "🤖 Bot Lửa Trại", "🤖 Bot Bóng Đêm", "🤖 Bot Gió Bắc",
];

const BOT_SEEDS = [
  "bot-wolf", "bot-fox", "bot-owl", "bot-hunter",
  "bot-tree", "bot-moon", "bot-mist", "bot-amber",
  "bot-storm", "bot-fire", "bot-shadow", "bot-wind",
];

function pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function ensureRoleInLobbyConfig(room, forcedRole) {
  const targetTotal = Math.max(6, room.players.length);
  const cfg = { ...(room.rolesConfig || generateDefaultRoles(targetTotal)) };
  if (!forcedRole) return cfg;

  if (!cfg[forcedRole] || cfg[forcedRole] < 1) {
    cfg[forcedRole] = 1;
    // Giảm 1 từ vai dư để giữ tổng số vai === targetTotal
    const donorOrder = ["villager", "tough_guy", "cursed", "tanner", "guard", "witch", "seer", "wolf"];
    for (const d of donorOrder) {
      if (d === forcedRole) continue;
      const minKeep = d === "wolf" ? 1 : 0;
      if ((cfg[d] || 0) > minKeep) {
        cfg[d] -= 1;
        break;
      }
    }
  }
  room.rolesConfig = cfg;
  return cfg;
}

export function setupDevPhaseHook(gameCtrl) {
  if (!IS_LOCAL_DEV) return;

  gameCtrl.setPhaseHook((room) => {
    if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
    if (room.devAutoBot === false) return;

    const g = room.game;
    const phaseRoleMap = {
      night_guard: "guard",
      night_wolf: "wolf",
      night_witch: "witch",
      night_seer: "seer",
    };
    const activeRole = phaseRoleMap[g.phase];
    if (!activeRole) return;

    const phaseKey = `${g.dayNumber}:${g.phase}`;
    if (room.lastAutoPhaseKey === phaseKey) return;
    room.lastAutoPhaseKey = phaseKey;

    if (room.devBotTimer) {
      clearTimeout(room.devBotTimer);
      room.devBotTimer = null;
    }

    room.devBotTimer = setTimeout(() => {
      room.devBotTimer = null;
      if (room.phase !== "playing" || !room.game || room.game.winner) return;
      if (room.devAutoBot === false) return;
      if (`${room.game.dayNumber}:${room.game.phase}` !== phaseKey) return;

      const alivePlayers = room.players.filter((p) => p.alive);
      const aliveBotsOfRole = alivePlayers.filter((p) => p.isBot && p.role === activeRole);
      const aliveHumansOfRole = alivePlayers.filter((p) => !p.isBot && p.role === activeRole);

      // Thực hiện hành động tự động cho các Bot cầm vai đang tới lượt
      if (g.phase === "night_guard" && aliveBotsOfRole.length > 0) {
        const validTargets = alivePlayers.filter((p) => p.id !== g.lastGuardedId);
        const target = pickRandom(validTargets);
        if (target) gameCtrl.guardProtect(room, aliveBotsOfRole[0].id, target.id);
      } else if (g.phase === "night_wolf" && aliveBotsOfRole.length > 0) {
        const nonWolves = alivePlayers.filter((p) => p.role !== "wolf");
        const target = pickRandom(nonWolves);
        if (target) {
          aliveBotsOfRole.forEach((botWolf) => {
            gameCtrl.wolfPick(room, botWolf.id, target.id);
          });
        }
      } else if (g.phase === "night_seer" && aliveBotsOfRole.length > 0) {
        const others = alivePlayers.filter((p) => p.id !== aliveBotsOfRole[0].id);
        const target = pickRandom(others);
        if (target) gameCtrl.seerCheck(room, aliveBotsOfRole[0].id, target.id);
      }

      // Nếu người thật KHÔNG cầm vai ở lượt đêm này -> tự động tua qua để đến lượt người thật / Bình Minh siêu nhanh!
      if (aliveHumansOfRole.length === 0) {
        gameCtrl.advanceCurrentPhase(room);
      } else {
        // Nếu người thật có cầm vai (VD cùng là Sói với Bot), chỉ cập nhật UI và chờ người thật thao tác
        gameCtrl.broadcast(room);
      }
    }, 1200);
  });
}

export function registerDevSocketHandlers(socket, gameCtrl, broadcastRoom) {
  if (!IS_LOCAL_DEV) return;

  function withDevRoom(cb) {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return null;
    const player =
      room.players.find((p) => p.socketId === socket.id) ||
      room.players.find((p) => p.id === socket.data.playerId);
    if (!player) return null;
    return cb(room, player);
  }

  // 1. Bơm Bot vào sảnh chờ (lấp đủ 6 người hoặc thêm +N Bot)
  socket.on("dev:addBots", ({ count = 5, fillToMin = false } = {}, cb) => {
    withDevRoom((room, player) => {
      if (room.phase !== "lobby") {
        return cb?.({ ok: false, error: "Chỉ thêm Bot khi đang ở Sảnh Chờ (Lobby)." });
      }
      const needed = fillToMin ? Math.max(0, 6 - room.players.length) : Number(count) || 1;
      const canAdd = Math.min(needed, 18 - room.players.length);
      if (canAdd <= 0) {
        return cb?.({ ok: true, added: 0, total: room.players.length });
      }

      const existingNames = new Set(room.players.map((p) => p.name));
      for (let i = 0; i < canAdd; i++) {
        const idx = room.players.filter((p) => p.isBot).length;
        let botName = BOT_NAMES[idx % BOT_NAMES.length];
        if (existingNames.has(botName)) botName = `${botName} #${idx + 1}`;
        existingNames.add(botName);

        const seed = BOT_SEEDS[idx % BOT_SEEDS.length] + "-" + idx;
        room.players.push({
          id: `bot_${randomUUID().slice(0, 8)}`,
          socketId: null,
          isBot: true,
          connected: true,
          sessionToken: null,
          disconnectedAt: null,
          name: botName,
          avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${seed}&backgroundColor=b6e3f4,c0aede,d1d4f9`,
          isHost: false,
          ready: true,
          seatIndex: room.players.length,
          alive: true,
          role: null,
        });
      }

      room.rolesConfig = generateDefaultRoles(room.players.length);
      const myForced = room.devForcedRoles?.[player.id];
      if (myForced) ensureRoleInLobbyConfig(room, myForced);

      broadcastRoom(room);
      cb?.({ ok: true, added: canAdd, total: room.players.length });
    });
  });

  // 2. Xóa toàn bộ Bot khỏi sảnh chờ
  socket.on("dev:clearBots", (_, cb) => {
    withDevRoom((room, player) => {
      if (room.phase !== "lobby") {
        return cb?.({ ok: false, error: "Hãy về Sảnh Chờ trước khi xóa Bot." });
      }
      room.players = room.players.filter((p) => !p.isBot);
      room.rolesConfig = generateDefaultRoles(Math.max(6, room.players.length));
      const myForced = room.devForcedRoles?.[player.id];
      if (myForced) ensureRoleInLobbyConfig(room, myForced);

      broadcastRoom(room);
      cb?.({ ok: true, total: room.players.length });
    });
  });

  // 3. Ép vai cho chính mình (ở cả Lobby hoặc đổi nóng ngay trong trận!)
  socket.on("dev:forceRole", ({ role }, cb) => {
    withDevRoom((room, player) => {
      if (!room.devForcedRoles) room.devForcedRoles = {};
      const validRole = role && ROLE_LABELS[role] ? role : null;
      room.devForcedRoles[player.id] = validRole;

      if (room.phase === "lobby") {
        if (validRole) ensureRoleInLobbyConfig(room, validRole);
        broadcastRoom(room);
        return cb?.({ ok: true, role: validRole });
      }

      if (room.phase === "playing" && validRole) {
        const donor =
          room.players.find((p) => p.id !== player.id && p.isBot && p.role === validRole) ||
          room.players.find((p) => p.id !== player.id && p.role === validRole);
        if (donor) {
          donor.role = player.role;
        }
        player.role = validRole;
        player.alive = true; // Hồi sinh luôn nếu đang chết để test UI ngay
        room.lastAutoPhaseKey = null;
        gameCtrl.broadcast(room);
        return cb?.({ ok: true, role: validRole, swappedLive: true });
      }

      broadcastRoom(room);
      cb?.({ ok: true, role: validRole });
    });
  });

  // 4. Bật / Tắt chế độ Bot tự động hành động đêm & tự lướt qua lượt của Bot
  socket.on("dev:toggleAutoBot", (_, cb) => {
    withDevRoom((room) => {
      room.devAutoBot = !(room.devAutoBot !== false);
      if (!room.devAutoBot && room.devBotTimer) {
        clearTimeout(room.devBotTimer);
        room.devBotTimer = null;
      }
      if (room.devAutoBot) {
        room.lastAutoPhaseKey = null;
      }
      if (room.phase === "playing") gameCtrl.broadcast(room);
      else broadcastRoom(room);
      cb?.({ ok: true, autoBot: room.devAutoBot });
    });
  });

  // 5. Tua nhanh qua Phase hiện tại ngay lập tức
  socket.on("dev:skipPhase", (_, cb) => {
    withDevRoom((room) => {
      if (room.devBotTimer) {
        clearTimeout(room.devBotTimer);
        room.devBotTimer = null;
      }
      const res = gameCtrl.advanceCurrentPhase(room);
      cb?.(res);
    });
  });

  // 6. Điều khiển đàn Bot Vote nhanh ban ngày (Skip thảo luận / Đề cử / Treo cổ / Tha)
  socket.on("dev:botVote", ({ action }, cb) => {
    withDevRoom((room, player) => {
      if (room.phase !== "playing" || !room.game) {
        return cb?.({ ok: false, error: "Chưa ở trong trận đấu." });
      }
      const g = room.game;
      const aliveBots = room.players.filter((p) => p.isBot && p.alive);

      if (action === "skip_discuss" && g.phase === "day_discuss") {
        let lastRes = null;
        aliveBots.forEach((b) => {
          if (!g.skipDiscussVotes[b.id]) {
            lastRes = gameCtrl.voteSkipDiscussion(room, b.id);
          }
        });
        gameCtrl.broadcast(room);
        if (lastRes?.allSkipped) {
          gameCtrl.clearRoomTimer(room.code);
          gameCtrl.forceEndDiscussion(room);
        }
        return cb?.({ ok: true });
      }

      if (action === "nominate_me" && g.phase === "day_nominate") {
        aliveBots.forEach((b) => {
          if (b.id !== player.id) gameCtrl.nominationVote(room, b.id, player.id);
        });
        gameCtrl.broadcast(room);
        return cb?.({ ok: true });
      }

      if (action === "nominate_wolf" && g.phase === "day_nominate") {
        const target =
          room.players.find((p) => p.alive && p.role === "wolf" && p.id !== player.id) ||
          aliveBots[0];
        if (!target) return cb?.({ ok: false, error: "Không tìm thấy mục tiêu để đề cử." });
        aliveBots.forEach((b) => {
          if (b.id !== target.id) gameCtrl.nominationVote(room, b.id, target.id);
        });
        gameCtrl.broadcast(room);
        return cb?.({ ok: true, targetName: target.name });
      }

      if (action === "vote_hang" && g.phase === "day_final_vote") {
        aliveBots.forEach((b) => gameCtrl.finalVote(room, b.id, "hang"));
        gameCtrl.broadcast(room);
        return cb?.({ ok: true });
      }

      if (action === "vote_spare" && g.phase === "day_final_vote") {
        aliveBots.forEach((b) => gameCtrl.finalVote(room, b.id, "spare"));
        gameCtrl.broadcast(room);
        return cb?.({ ok: true });
      }

      return cb?.({ ok: false, error: `Hành động '${action}' không khớp với phase hiện tại (${g.phase}).` });
    });
  });
}
