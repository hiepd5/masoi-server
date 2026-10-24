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

const WOLF_BOT_WHISPERS = [
  (name) => `Đêm nay vồ gọn ${name} đi anh em!`,
  (name) => `Nhắm vào ${name} nhé, nó đang nghi tụi mình đấy!`,
  (name) => `Ê đổi sang cắn ${name} đi, ít bị Bảo Vệ canh hơn!`,
  (name) => `Suỵt... chốt hạ ${name} trước bình minh!`,
];

const VILLAGE_BOT_LINES = [
  (name) => `Tôi để ý ánh mắt của ${name} từ sáng giờ rất lạ!`,
  (name) => `Đêm qua bầy Sói hành động quá tính toán, khả nghi nhất là ${name}!`,
  (name) => `Mọi người bình tĩnh suy xét kỹ trước khi chỉ tay đề cử nhé!`,
];

export function flushBotInteractionsForCurrentPhase(room, gameCtrl, { includeDayActions = false } = {}) {
  if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
  const g = room.game;
  const alivePlayers = room.players.filter((p) => p.alive);
  const aliveBots = alivePlayers.filter((p) => p.isBot);
  if (aliveBots.length === 0) return;

  if (g.phase === "night_guard" && !g.guardedIdTonight) {
    const botGuard = aliveBots.find((p) => p.role === "guard");
    if (botGuard) {
      const validTargets = alivePlayers.filter((p) => p.id !== g.lastGuardedId);
      const target = pickRandom(validTargets);
      if (target) gameCtrl.guardProtect(room, botGuard.id, target.id);
    }
  } else if (g.phase === "night_wolf" && Object.keys(g.wolfPicks || {}).length === 0) {
    const botWolves = aliveBots.filter((p) => p.role === "wolf");
    const nonWolves = alivePlayers.filter((p) => p.role !== "wolf");
    if (botWolves.length > 0 && nonWolves.length > 0) {
      const finalTarget = pickRandom(nonWolves);
      // Nếu có >= 2 mục tiêu, Sói đầu đàn nhá thử mục tiêu phụ rồi bàn bạc đổi sang mục tiêu chốt (cực kỳ kịch tính trên băng Replay!)
      if (nonWolves.length >= 2) {
        const decoy = nonWolves.find((p) => p.id !== finalTarget.id);
        if (decoy) {
          gameCtrl.wolfPick(room, botWolves[0].id, decoy.id);
          if (botWolves[0].id && g.replayTimeline?.length) {
            // Lùi nhẹ timestamp 300ms để không bị gộp debounce với cú chốt sau đó
            g.replayTimeline[g.replayTimeline.length - 1].ts -= 320;
          }
        }
      }
      const whisperFn = pickRandom(WOLF_BOT_WHISPERS);
      const whisperText = whisperFn ? whisperFn(finalTarget.name) : `Chốt ${finalTarget.name}!`;
      gameCtrl.recordReplayEvent?.(room, {
        kind: "wolf_chat",
        phase: "night_wolf",
        actorId: botWolves[0].id,
        actorRole: "wolf",
        targetId: finalTarget.id,
        chatText: whisperText,
        caption: `🐺 [Mật đàm Sói] ${botWolves[0].name}: "${whisperText}"`,
      });
      botWolves.forEach((botWolf) => {
        gameCtrl.wolfPick(room, botWolf.id, finalTarget.id);
      });
    }
  } else if (g.phase === "night_witch" && !g.witchSaveTonight && !g.witchPoisonTargetId) {
    const botWitch = aliveBots.find((p) => p.role === "witch");
    if (botWitch) {
      if (!g.witchUsedSave && g.wolfVictimId && (g.dayNumber >= 2 || Math.random() < 0.55)) {
        gameCtrl.witchDecide(room, botWitch.id, { save: true });
      } else if (!g.witchUsedPoison && g.dayNumber >= 2 && Math.random() < 0.45) {
        const candidates = alivePlayers.filter((p) => p.id !== botWitch.id && p.id !== g.wolfVictimId);
        const poisonTarget = pickRandom(candidates);
        if (poisonTarget) {
          gameCtrl.witchDecide(room, botWitch.id, { poisonTargetId: poisonTarget.id });
        }
      }
    }
  } else if (g.phase === "night_seer") {
    const botSeer = aliveBots.find((p) => p.role === "seer");
    const alreadyCheckedTonight = (g.seerChecksLog || []).some((c) => c.dayNumber === g.dayNumber);
    if (botSeer && !alreadyCheckedTonight) {
      const others = alivePlayers.filter((p) => p.id !== botSeer.id);
      const target = pickRandom(others);
      if (target) gameCtrl.seerCheck(room, botSeer.id, target.id);
    }
  } else if (includeDayActions && g.phase === "day_discuss") {
    const hasChatToday = (g.replayTimeline || []).some(
      (f) => f.day === g.dayNumber && f.kind === "village_chat"
    );
    if (!hasChatToday && aliveBots.length > 0) {
      const speaker = pickRandom(aliveBots);
      const suspect = pickRandom(alivePlayers.filter((p) => p.id !== speaker.id)) || speaker;
      const lineFn = pickRandom(VILLAGE_BOT_LINES);
      const text = lineFn ? lineFn(suspect.name) : `Ai đang che giấu sự thật đêm qua?`;
      gameCtrl.recordReplayEvent?.(room, {
        kind: "village_chat",
        phase: "day_discuss",
        actorId: speaker.id,
        targetId: suspect.id !== speaker.id ? suspect.id : null,
        chatText: text,
        caption: `💬 ${speaker.name}: "${text}"`,
      });
    }
  } else if (includeDayActions && g.phase === "day_nominate" && Object.keys(g.nominationVotes || {}).length === 0) {
    const primarySuspect = pickRandom(alivePlayers);
    if (primarySuspect) {
      aliveBots.forEach((b) => {
        if (b.id !== primarySuspect.id) {
          gameCtrl.nominationVote(room, b.id, primarySuspect.id);
        }
      });
    }
  } else if (includeDayActions && g.phase === "day_final_vote" && Object.keys(g.finalVotes || {}).length === 0) {
    const defendantId = g.hotSeatQueue?.[g.hotSeatIndex];
    aliveBots.forEach((b, idx) => {
      if (b.id === defendantId) {
        gameCtrl.finalVote(room, b.id, "spare");
      } else {
        const decision = idx % 3 === 0 ? "spare" : "hang";
        gameCtrl.finalVote(room, b.id, decision);
      }
    });
  }
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
      const aliveHumansOfRole = alivePlayers.filter((p) => !p.isBot && p.role === activeRole);

      flushBotInteractionsForCurrentPhase(room, gameCtrl, { includeDayActions: false });

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
          donor.initialRole = donor.role;
        }
        player.role = validRole;
        player.initialRole = validRole;
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

  // 5. Tua nhanh qua Phase hiện tại ngay lập tức (Bơm trước tương tác Bot nếu chưa ai kịp thao tác để giữ trọn kịch bản Replay!)
  socket.on("dev:skipPhase", (_, cb) => {
    withDevRoom((room) => {
      if (room.devBotTimer) {
        clearTimeout(room.devBotTimer);
        room.devBotTimer = null;
      }
      if (room.devAutoBot !== false) {
        flushBotInteractionsForCurrentPhase(room, gameCtrl, { includeDayActions: true });
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
