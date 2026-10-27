import "./envLoader.js";
import {
  getRoom,
  addBotsToRoom,
  clearBotsFromRoom,
  ensureRoleInLobbyConfig,
} from "./rooms.js";
import { generateDefaultRoles, isWolfTeamRole, ROLE_LABELS } from "./roles.js";

// SEC-06: Khóa cứng 100% DevSandbox trên Render/Production & chỉ mở khi ALLOW_LOCAL_STUDIO === "1"
export const IS_LOCAL_DEV =
  !process.env.RENDER &&
  process.env.NODE_ENV !== "production" &&
  process.env.ALLOW_LOCAL_STUDIO === "1";

function pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
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
  () => `Mọi người bình tĩnh suy xét kỹ trước khi chỉ tay đề cử nhé!`,
  (name) => `${name} nãy giờ hơi im lặng, có ai soi thử chưa?`,
];

const DEFENSE_BOT_LINES = [
  "Mọi người bình tĩnh! Tôi thề mình là dân lương thiện, treo nhầm tôi là Sói cười thầm đấy!",
  "Đừng nghe lời khích bác! Đêm qua tôi ngủ say, hãy tha cho tôi để ngày mai tìm đúng Sói!",
  "Tôi vô tội thật sự! Nếu treo tôi hôm nay làng sẽ mất đi một lá phiếu quan trọng!",
];

export function checkBotVoteConsensus(room, gameCtrl) {
  if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
  if (room.devAutoBot === false) return;
  if (!room.players.some((p) => p.isBot)) return;

  const g = room.game;
  const alive = room.players.filter((p) => p.alive);
  if (alive.length === 0) return;

  let everyoneVoted = false;
  let delayMs = 2200;

  if (g.phase === "day_nominate") {
    everyoneVoted = alive.every((p) => Boolean(g.nominationVotes?.[p.id]?.targetId));
    delayMs = 2600;
  } else if (g.phase === "day_final_vote") {
    everyoneVoted = alive.every((p) => Boolean(g.finalVotes?.[p.id]));
    delayMs = 2000;
  } else {
    return;
  }

  if (!everyoneVoted) return;

  const targetPhaseKey = `${g.dayNumber}:${g.phase}:${g.hotSeatIndex ?? -1}`;
  if (room.devConsensusTimer) {
    clearTimeout(room.devConsensusTimer);
    room.devConsensusTimer = null;
  }
  room.devConsensusTimer = setTimeout(() => {
    room.devConsensusTimer = null;
    if (room.phase !== "playing" || !room.game || room.game.winner) return;
    const nowKey = `${room.game.dayNumber}:${room.game.phase}:${room.game.hotSeatIndex ?? -1}`;
    if (nowKey !== targetPhaseKey) return;
    gameCtrl.advanceCurrentPhase(room);
  }, delayMs);
  room.devConsensusTimer.unref?.();
}

export function flushBotInteractionsForCurrentPhase(
  room,
  gameCtrl,
  { includeDayActions = false, io = null } = {}
) {
  if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
  const g = room.game;
  const alivePlayers = room.players.filter((p) => p.alive);
  const aliveBots = alivePlayers.filter((p) => p.isBot);

  if (g.phase === "hunter_revenge" && g.hunterPendingId) {
    const fallenHunter = room.players.find((p) => p.id === g.hunterPendingId);
    if (fallenHunter?.isBot && alivePlayers.length > 0) {
      const target = pickRandom(alivePlayers);
      if (target) gameCtrl.hunterShoot(room, fallenHunter.id, target.id);
    }
    return;
  }

  if (aliveBots.length === 0) return;

  if (g.phase === "night_cupid" && !g.lovers) {
    const botCupid = aliveBots.find((p) => p.role === "cupid");
    if (botCupid && alivePlayers.length >= 2) {
      const first = pickRandom(alivePlayers);
      const second = pickRandom(alivePlayers.filter((p) => p.id !== first.id));
      if (first && second) {
        gameCtrl.cupidLink(room, botCupid.id, [first.id, second.id]);
      }
    }
  } else if (g.phase === "night_guard" && !g.guardedIdTonight) {
    const botGuard = aliveBots.find((p) => p.role === "guard");
    if (botGuard) {
      const validTargets = alivePlayers.filter((p) => p.id !== g.lastGuardedId);
      const target = pickRandom(validTargets);
      if (target) gameCtrl.guardProtect(room, botGuard.id, target.id);
    }
  } else if (g.phase === "night_wolf" && Object.keys(g.wolfPicks || {}).length === 0) {
    const botWolves = aliveBots.filter((p) => isWolfTeamRole(p.role));
    const nonWolves = alivePlayers.filter((p) => !isWolfTeamRole(p.role));
    if (botWolves.length > 0 && nonWolves.length > 0) {
      const botAlpha = botWolves.find((p) => p.role === "alpha_wolf");
      if (botAlpha && !g.alphaUsedConvert && g.dayNumber >= 2 && Math.random() < 0.45) {
        gameCtrl.wolfAlphaToggle(room, botAlpha.id, true);
      }
      const finalTarget = pickRandom(nonWolves);
      if (nonWolves.length >= 2) {
        const decoy = nonWolves.find((p) => p.id !== finalTarget.id);
        if (decoy) {
          gameCtrl.wolfPick(room, botWolves[0].id, decoy.id);
          if (botWolves[0].id && g.replayTimeline?.length) {
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
        actorRole: botWolves[0].role,
        targetId: finalTarget.id,
        chatText: whisperText,
        caption: `🐺 [Mật đàm Sói] ${botWolves[0].name}: "${whisperText}"`,
      });
      botWolves.forEach((botWolf) => {
        gameCtrl.wolfPick(room, botWolf.id, finalTarget.id);
      });
    }
  } else if (
    g.phase === "night_witch" &&
    !g.witchSaveTonight &&
    !g.witchPoisonTargetId &&
    !g.witchDecidedPass
  ) {
    const botWitch = aliveBots.find((p) => p.role === "witch");
    if (botWitch) {
      if (!g.witchUsedSave && g.wolfVictimId && (g.dayNumber >= 2 || Math.random() < 0.55)) {
        gameCtrl.witchDecide(room, botWitch.id, { save: true, pass: true });
      } else if (!g.witchUsedPoison && g.dayNumber >= 2 && Math.random() < 0.45) {
        const candidates = alivePlayers.filter((p) => p.id !== botWitch.id && p.id !== g.wolfVictimId);
        const poisonTarget = pickRandom(candidates);
        if (poisonTarget) {
          gameCtrl.witchDecide(room, botWitch.id, { poisonTargetId: poisonTarget.id, pass: true });
        } else {
          gameCtrl.witchDecide(room, botWitch.id, { pass: true });
        }
      } else {
        gameCtrl.witchDecide(room, botWitch.id, { pass: true });
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
    const botMayor = aliveBots.find((p) => p.role === "mayor");
    if (botMayor && !g.mayorRevealedId && (g.dayNumber >= 2 || Math.random() < 0.35)) {
      gameCtrl.mayorReveal(room, botMayor.id);
    }
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
      io?.to(room.code)?.emit("village:chat", {
        senderId: speaker.id,
        senderName: speaker.name,
        message: text,
      });
    }
  } else if (includeDayActions && g.phase === "day_defense") {
    const defendantId = g.hotSeatQueue?.[g.hotSeatIndex];
    const defendant = aliveBots.find((b) => b.id === defendantId);
    if (defendant) {
      const plea = pickRandom(DEFENSE_BOT_LINES);
      gameCtrl.recordReplayEvent?.(room, {
        kind: "village_chat",
        phase: "day_defense",
        actorId: defendant.id,
        chatText: plea,
        caption: `⚖️ ${defendant.name}: "${plea}"`,
      });
      io?.to(room.code)?.emit("village:chat", {
        senderId: defendant.id,
        senderName: defendant.name,
        message: plea,
      });
    }
  } else if (includeDayActions && g.phase === "day_nominate") {
    const humanVotes = Object.entries(g.nominationVotes || {})
      .filter(([vid]) => {
        const p = room.players.find((x) => x.id === vid);
        return p && !p.isBot;
      })
      .map(([, v]) => v?.targetId)
      .filter(Boolean);

    const primarySuspect =
      (humanVotes[0] && alivePlayers.find((p) => p.id === humanVotes[0])) ||
      pickRandom(alivePlayers);

    aliveBots.forEach((b) => {
      if (g.nominationVotes?.[b.id]?.targetId) return;
      let target = null;
      if (isWolfTeamRole(b.role)) {
        const nonWolves = alivePlayers.filter((p) => p.id !== b.id && !isWolfTeamRole(p.role));
        target = pickRandom(nonWolves);
      } else {
        if (primarySuspect && primarySuspect.id !== b.id && Math.random() < 0.6) {
          target = primarySuspect;
        } else {
          target = pickRandom(alivePlayers.filter((p) => p.id !== b.id));
        }
      }
      if (target) {
        gameCtrl.nominationVote(room, b.id, target.id);
      }
    });
  } else if (includeDayActions && g.phase === "day_final_vote") {
    const defendantId = g.hotSeatQueue?.[g.hotSeatIndex];
    const defendant = room.players.find((p) => p.id === defendantId);
    aliveBots.forEach((b, idx) => {
      if (g.finalVotes?.[b.id]) return;
      if (b.id === defendantId) {
        gameCtrl.finalVote(room, b.id, "spare");
      } else if (isWolfTeamRole(b.role)) {
        const decision = isWolfTeamRole(defendant?.role) ? "spare" : "hang";
        gameCtrl.finalVote(room, b.id, decision);
      } else {
        const decision = idx % 3 === 0 ? "spare" : "hang";
        gameCtrl.finalVote(room, b.id, decision);
      }
    });
  }
}

// ============ ĐỘNG CƠ AI BOT CHÍNH THỨC (CHẠY CẢ LOCAL LẪN PRODUCTION KHI PHÒNG CÓ BOT) ============
export function setupDevPhaseHook(gameCtrl, io = null) {
  gameCtrl.setPhaseHook((room) => {
    if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
    if (room.devAutoBot === false) return;
    if (!room.players.some((p) => p.isBot)) return;

    const g = room.game;
    const nightRoleMap = {
      night_cupid: "cupid",
      night_guard: "guard",
      night_wolf: "wolf_team",
      night_witch: "witch",
      night_seer: "seer",
      hunter_revenge: "hunter_revenge",
    };
    const dayBotPhases = new Set([
      "day_discuss",
      "day_nominate",
      "day_defense",
      "day_final_vote",
    ]);

    const activeRole = nightRoleMap[g.phase];
    const isDayBotPhase = dayBotPhases.has(g.phase);
    if (!activeRole && !isDayBotPhase) return;

    const phaseKey = `${g.dayNumber}:${g.phase}:${g.hunterPendingId || ""}:${g.hotSeatIndex ?? -1}`;
    if (room.lastAutoPhaseKey === phaseKey) return;
    room.lastAutoPhaseKey = phaseKey;

    if (room.devBotTimer) {
      clearTimeout(room.devBotTimer);
      room.devBotTimer = null;
    }

    const delayMs = activeRole
      ? 1200
      : g.phase === "day_defense"
        ? 1500
        : g.phase === "day_discuss"
          ? 2200
          : 2600;

    room.devBotTimer = setTimeout(() => {
      room.devBotTimer = null;
      if (room.phase !== "playing" || !room.game || room.game.winner) return;
      if (room.devAutoBot === false) return;
      const currentKey = `${room.game.dayNumber}:${room.game.phase}:${room.game.hunterPendingId || ""}:${room.game.hotSeatIndex ?? -1}`;
      if (currentKey !== phaseKey) return;

      const alivePlayers = room.players.filter((p) => p.alive);
      const aliveHumans = alivePlayers.filter((p) => !p.isBot);

      if (activeRole === "hunter_revenge") {
        const pendingHunter = room.players.find((p) => p.id === room.game.hunterPendingId);
        if (pendingHunter?.isBot) {
          flushBotInteractionsForCurrentPhase(room, gameCtrl, { includeDayActions: false, io });
        }
        return;
      }

      if (activeRole) {
        flushBotInteractionsForCurrentPhase(room, gameCtrl, { includeDayActions: false, io });
        gameCtrl.broadcast(room);
        // Giao cho Smart Pacing + Random Jitter điều tiết thời gian chuyển pha (Solo 1 người = 1.8s; Bàn >=2 người = 5.5s-8.5s chống lộ vai!)
        gameCtrl.notifyBotNightReady?.(room);
        return;
      }

      // Ban ngày (Thảo luận / Đề cử / Biện hộ / Bỏ phiếu cuối)
      flushBotInteractionsForCurrentPhase(room, gameCtrl, { includeDayActions: true, io });
      gameCtrl.broadcast(room);

      if (g.phase === "day_discuss") {
        // Nếu người chơi thật đã hy sinh (đang xem đàn AI Bot đấu nốt ván) -> tự chuyển sang Đề cử sau 3.2s!
        if (aliveHumans.length === 0) {
          const tNext = setTimeout(() => {
            if (room.phase === "playing" && room.game?.phase === "day_discuss" && !room.game.winner) {
              gameCtrl.advanceCurrentPhase(room);
            }
          }, 3200);
          tNext.unref?.();
        }
      } else if (g.phase === "day_nominate" || g.phase === "day_final_vote") {
        if (aliveHumans.length === 0) {
          const tNext = setTimeout(() => {
            if (room.phase === "playing" && room.game?.phase === g.phase && !room.game.winner) {
              gameCtrl.advanceCurrentPhase(room);
            }
          }, 1800);
          tNext.unref?.();
        } else {
          checkBotVoteConsensus(room, gameCtrl);
        }
      }
    }, delayMs);
    room.devBotTimer.unref?.();
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
    withDevRoom((room) => {
      const needed = fillToMin ? Math.max(0, 6 - room.players.length) : Number(count) || 1;
      const res = addBotsToRoom(room.code, needed, { syncRolesMode: "classic" });
      if (res.error) return cb?.({ ok: false, error: res.error });
      broadcastRoom(room);
      cb?.({ ok: true, added: res.added, total: res.total });
    });
  });

  // 2. Xóa toàn bộ Bot khỏi sảnh chờ
  socket.on("dev:clearBots", (_, cb) => {
    withDevRoom((room) => {
      const res = clearBotsFromRoom(room.code, { syncRoles: true });
      if (res.error) return cb?.({ ok: false, error: res.error });
      broadcastRoom(room);
      cb?.({ ok: true, total: res.total });
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
          room.players.find((p) => p.alive && isWolfTeamRole(p.role) && p.id !== player.id) ||
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
