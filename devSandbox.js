import "./envLoader.js";
import {
  getRoom,
  addBotsToRoom,
  clearBotsFromRoom,
  ensureRoleInLobbyConfig,
} from "./rooms.js";
import { generateDefaultRoles, isWolfTeamRole, ROLE_LABELS } from "./roles.js";
import { initGameState, computeMatchAwards } from "./gameEngine.js";
import { pickZeroLeakBotSpeech, isRoomFullMcPacing } from "./botVoiceCatalog.js";
import {
  adaptTextForUniverse,
  sanitizeUniverseId,
  UNIVERSE_BOT_NAMES,
  UNIVERSE_DEFAULT_SCENE_PRESET,
} from "./universeThemes.js";

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
  "Ai chỉ tay vào tôi sớm nhất mới đáng nghi! Hãy tha để tôi còn giúp làng bắt Sói thật!",
];

/**
 * Chốt #8 (100% Zero-Leak Smart Persona Bot Deduction):
 * Hàm thuần CHỈ nhận dữ liệu công khai của ván đấu (tuyệt đối KHÔNG nhận p.role của bất kỳ ai!),
 * sinh câu tranh biện khớp tính cách từng Bot (`sharp_fox` / `calm_owl` / `bold_bear` / `cautious_raven`).
 */
export function buildZeroLeakBotLine({
  personaId = "sharp_fox",
  dayNumber = 1,
  nightDeathNames = [],
  suspectName = "ai đó",
  mayorName = null,
  aliveCount = 8,
} = {}) {
  const hasVictim = Array.isArray(nightDeathNames) && nightDeathNames.length > 0;
  const victimStr = hasVictim ? nightDeathNames.join(", ") : null;

  if (personaId === "sharp_fox") {
    if (hasVictim) {
      return `Đêm ${dayNumber} mất ${victimStr} chứng tỏ Sói nhắm người tỉnh táo. Tôi đang để ý kỹ ${suspectName}!`;
    }
    return `Đêm qua bình yên không ai gục, chắc Bảo Vệ hoặc Phù Thủy đã ra tay! ${suspectName} thấy sao?`;
  }
  if (personaId === "calm_owl") {
    if (mayorName) {
      return `Đã có Trưởng Làng ${mayorName} dẫn nhịp, cả làng (${aliveCount} ghế) khoan vội treo nhầm nhé.`;
    }
    if (hasVictim) {
      return `Vụ ${victimStr} đêm qua rất có tính toán. Mọi người nghe kỹ ${suspectName} giải thích trước khi vote.`;
    }
    return `Ngày ${dayNumber} còn ${aliveCount} người sống, ai giữ thông tin soi/chặn đòn hãy lên tiếng đúng lúc!`;
  }
  if (personaId === "bold_bear") {
    if (hasVictim) {
      return `Không thể để ${victimStr} nằm xuống vô ích! Hôm nay phải đưa ${suspectName} lên ghế nóng hỏi rõ!`;
    }
    return `${suspectName} từ đầu ngày hơi kiệm lời đấy, mạnh dạn nêu quan điểm cho cả làng nghe xem!`;
  }
  // cautious_raven
  if (hasVictim) {
    return `Sương mù dày quá... sau cái chết của ${victimStr}, tôi thấy hướng nhìn của ${suspectName} khá lạ.`;
  }
  return `Đêm yên ắng coi chừng Kẻ Bị Nguyền hoặc Sói Đầu Đàn giở trò! Mọi người dè chừng ${suspectName} nhé.`;
}

function clearBotDebateTimers(room) {
  if (room && Array.isArray(room.devDebateTimers)) {
    room.devDebateTimers.forEach((t) => clearTimeout(t));
    room.devDebateTimers = [];
  }
}

function emitBotVillageBubble(room, gameCtrl, io, speaker, suspect, speech, phaseName = "day_discuss") {
  if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
  if (!speaker?.alive) return;
  const rawBubbleText = typeof speech === "string" ? speech : speech?.bubbleText || "";
  if (!rawBubbleText) return;
  const uId = sanitizeUniverseId(room.universeId);
  const bubbleText = uId === "classic" ? rawBubbleText : adaptTextForUniverse(rawBubbleText, uId);
  const spokenText =
    uId === "classic"
      ? speech?.spokenText || bubbleText
      : adaptTextForUniverse(speech?.spokenText || rawBubbleText, uId);
  const botAudioUrl = uId === "classic" ? speech?.botAudioUrl || null : null;
  gameCtrl.recordReplayEvent?.(room, {
    kind: "village_chat",
    phase: phaseName,
    actorId: speaker.id,
    targetId: suspect && suspect.id !== speaker.id ? suspect.id : null,
    chatText: bubbleText,
    caption: `${phaseName === "day_defense" ? "⚖️" : "💬"} ${speaker.name}: "${bubbleText}"`,
  });
  io?.to(room.code)?.emit("village:chat", {
    senderId: speaker.id,
    senderName: speaker.name,
    personaId: speech?.personaId || speaker.personaId || "sharp_fox",
    personaLabel: speech?.personaLabel || speaker.personaLabel || null,
    isBot: true,
    message: bubbleText,
    spokenText,
    botAudioUrl,
    durationMs: speech?.durationMs || null,
  });
}

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

  if (isRoomFullMcPacing(room)) {
    const mcFloor = gameCtrl.getRemainingMcFloorMs?.(room) || 0;
    delayMs = Math.max(delayMs + 600, mcFloor);
  }

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
      const leadWolfBot = botWolves[0];
      const wolfSpeech = pickZeroLeakBotSpeech({
        personaId: leadWolfBot.personaId || "sharp_fox",
        context: "night_wolf",
        targetName: finalTarget.name,
      });
      const uId = sanitizeUniverseId(room.universeId);
      const wolfBubbleText =
        uId === "classic" ? wolfSpeech.bubbleText : adaptTextForUniverse(wolfSpeech.bubbleText, uId);
      const wolfSpokenText =
        uId === "classic"
          ? wolfSpeech.spokenText
          : adaptTextForUniverse(wolfSpeech.spokenText || wolfSpeech.bubbleText, uId);
      const wolfBotAudioUrl = uId === "classic" ? wolfSpeech.botAudioUrl : null;
      const whisperPrefix =
        uId === "office"
          ? "👔 [Mật đàm Ban Giám Đốc]"
          : uId === "school"
            ? "👩‍🏫 [Mật đàm Giáo Viên]"
            : "🐺 [Mật đàm Sói]";
      gameCtrl.recordReplayEvent?.(room, {
        kind: "wolf_chat",
        phase: "night_wolf",
        actorId: leadWolfBot.id,
        actorRole: leadWolfBot.role,
        targetId: finalTarget.id,
        chatText: wolfBubbleText,
        caption: `${whisperPrefix} ${leadWolfBot.name}: "${wolfBubbleText}"`,
      });
      // ZERO-LEAK ABSOLUTE ISOLATION: Chỉ gửi mật đàm + file MP3 thì thầm tới socket của đồng bọn Sói NGƯỜI THẬT còn sống!
      if (io) {
        const livingHumanWolves = room.players.filter(
          (p) => !p.isBot && p.alive && p.connected && p.socketId && isWolfTeamRole(p.role)
        );
        livingHumanWolves.forEach((hw) => {
          io.to(hw.socketId).emit("wolf:chat", {
            senderId: leadWolfBot.id,
            senderName: leadWolfBot.name,
            personaId: wolfSpeech.personaId,
            personaLabel: wolfSpeech.personaLabel,
            isBot: true,
            message: wolfBubbleText,
            spokenText: wolfSpokenText,
            botAudioUrl: wolfBotAudioUrl,
            durationMs: wolfSpeech.durationMs,
          });
        });
        if (livingHumanWolves.length > 0 && isRoomFullMcPacing(room) && wolfBotAudioUrl) {
          const startAfterMc = Math.max(Date.now(), g.mcBusyUntilAt || Date.now());
          g.botAudioBusyUntilAt = startAfterMc + (wolfSpeech.durationMs || 4800) + 500;
        }
      }
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

    // Dữ liệu 100% CÔNG KHAI (tuyệt đối không đọc p.role để sinh câu chat & giọng nói!)
    const usedClipIdsToday = new Set();
    const buildPublicSpeechForBot = (speakerBot, avoidSuspectId = null, speechContext = "day_opening") => {
      const publicAlive = room.players
        .filter((p) => p.alive)
        .map((p) => ({ id: p.id, name: p.name }));
      const candidates = publicAlive.filter(
        (p) => p.id !== speakerBot.id && p.id !== avoidSuspectId
      );
      const suspect = pickRandom(candidates) || pickRandom(publicAlive) || { id: speakerBot.id, name: speakerBot.name };
      const nightDeathNames = (g.nightDeaths || [])
        .map((id) => room.players.find((p) => p.id === id)?.name)
        .filter(Boolean);
      const hasMayor = Boolean(g.mayorRevealedId);
      const speech = pickZeroLeakBotSpeech({
        personaId: speakerBot.personaId || "sharp_fox",
        context: speechContext,
        hasVictim: nightDeathNames.length > 0,
        hasMayor,
        targetName: suspect.name,
        usedClipIds: usedClipIdsToday,
      });
      return { suspect, speech };
    };

    const hasChatToday = (g.replayTimeline || []).some(
      (f) => f.day === g.dayNumber && f.kind === "village_chat"
    );
    if (!hasChatToday && aliveBots.length > 0) {
      const shuffledBots = [...aliveBots].sort(() => Math.random() - 0.5);
      const firstSpeaker = shuffledBots[0];
      const firstTurn = buildPublicSpeechForBot(firstSpeaker, null, "day_opening");
      emitBotVillageBubble(
        room,
        gameCtrl,
        io,
        firstSpeaker,
        firstTurn.suspect,
        firstTurn.speech,
        "day_discuss"
      );

      // Rải thêm 1–2 câu tranh biện có giọng đọc tự nhiên (kể cả khi người chơi thật đã hy sinh đang xem ở chế độ Đọc Trọn!)
      clearBotDebateTimers(room);
      const aliveHumansCount = alivePlayers.filter((p) => !p.isBot).length;
      const fullPacing = isRoomFullMcPacing(room);
      if ((aliveHumansCount > 0 || fullPacing) && shuffledBots.length >= 2) {
        room.devDebateTimers = [];
        const maxFollowUps = aliveHumansCount > 0 ? 2 : 1;
        const followUps = shuffledBots.slice(1, 1 + maxFollowUps);
        const scheduleOffsetsMs = fullPacing ? [8800, 17800] : [6500, 13800];
        const expectedDay = g.dayNumber;

        followUps.forEach((botSpeaker, idx) => {
          const timer = setTimeout(() => {
            if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
            if (room.game.phase !== "day_discuss" || room.game.dayNumber !== expectedDay) return;
            if (!botSpeaker.alive) return;
            // Nhường lời ngay nếu người chơi thật vừa nhắn tin trong 4.5s gần nhất!
            if (Date.now() - (room.lastHumanVillageChatAt || 0) < 4500) return;
            const nextTurn = buildPublicSpeechForBot(
              botSpeaker,
              firstTurn.suspect?.id,
              "day_followup"
            );
            emitBotVillageBubble(
              room,
              gameCtrl,
              io,
              botSpeaker,
              nextTurn.suspect,
              nextTurn.speech,
              "day_discuss"
            );
          }, scheduleOffsetsMs[idx] || 8800);
          timer.unref?.();
          room.devDebateTimers.push(timer);
        });
      }
    }
  } else if (includeDayActions && g.phase === "day_defense") {
    clearBotDebateTimers(room);
    const defendantId = g.hotSeatQueue?.[g.hotSeatIndex];
    const defendant = aliveBots.find((b) => b.id === defendantId);
    if (defendant) {
      const defenseSpeech = pickZeroLeakBotSpeech({
        personaId: defendant.personaId || "sharp_fox",
        context: "day_defense",
      });
      emitBotVillageBubble(
        room,
        gameCtrl,
        io,
        defendant,
        null,
        defenseSpeech,
        "day_defense"
      );
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

    if (room.devDeadAdvanceTimer) {
      clearTimeout(room.devDeadAdvanceTimer);
      room.devDeadAdvanceTimer = null;
    }

    const fullPacing = isRoomFullMcPacing(room);
    const mcFloorMs = fullPacing ? gameCtrl.getRemainingMcFloorMs?.(room) || 0 : 0;
    const isTiedFirstDefense =
      g.phase === "day_defense" &&
      (g.hotSeatQueue?.length || 0) >= 2 &&
      g.hotSeatIndex === 0;

    const delayMs = activeRole
      ? 1200
      : g.phase === "day_defense"
        ? fullPacing
          ? isTiedFirstDefense
            ? 5200
            : 2800
          : 1500
        : g.phase === "day_discuss"
          ? fullPacing
            ? Math.max(4200, Math.min(6800, mcFloorMs - 800))
            : 2200
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
        // Giao cho Smart Pacing + Floor MC + Random Jitter điều tiết thời gian chuyển pha
        gameCtrl.notifyBotNightReady?.(room);
        return;
      }

      // Ban ngày (Thảo luận / Đề cử / Biện hộ / Bỏ phiếu cuối)
      flushBotInteractionsForCurrentPhase(room, gameCtrl, { includeDayActions: true, io });
      gameCtrl.broadcast(room);

      if (g.phase === "day_discuss") {
        // Nếu người chơi thật đã hy sinh (đang xem đàn AI Bot đấu nốt ván):
        // Ở chế độ Đọc Trọn giữ ~16s để nghe trọn 2 AI Bot tranh biện; ở chế độ Nhanh chuyển sau 3.2s!
        if (aliveHumans.length === 0) {
          const deadDiscussWaitMs = isRoomFullMcPacing(room) ? 16000 : 3200;
          room.devDeadAdvanceTimer = setTimeout(() => {
            room.devDeadAdvanceTimer = null;
            if (room.phase === "playing" && room.game?.phase === "day_discuss" && !room.game.winner) {
              gameCtrl.advanceCurrentPhase(room);
            }
          }, deadDiscussWaitMs);
          room.devDeadAdvanceTimer.unref?.();
        }
      } else if (g.phase === "day_nominate" || g.phase === "day_final_vote") {
        if (aliveHumans.length === 0) {
          const deadVoteWaitMs = isRoomFullMcPacing(room)
            ? Math.max(5200, gameCtrl.getRemainingMcFloorMs?.(room) || 0)
            : 1800;
          room.devDeadAdvanceTimer = setTimeout(() => {
            room.devDeadAdvanceTimer = null;
            if (room.phase === "playing" && room.game?.phase === g.phase && !room.game.winner) {
              gameCtrl.advanceCurrentPhase(room);
            }
          }, deadVoteWaitMs);
          room.devDeadAdvanceTimer.unref?.();
        } else {
          checkBotVoteConsensus(room, gameCtrl);
        }
      }
    }, delayMs);
    room.devBotTimer.unref?.();
  });
}

/**
 * Chuyển nóng Vũ Trụ (`classic` | `office` | `school`) ngay lập tức ở MỌI trạng thái phòng
 * (`lobby`, `playing`, `ended`) kèm đổi tên Bot + Preset 3D + chấm lại danh hiệu `awards`!
 */
export function devSwitchUniverseLive(room, nextUniverseRaw) {
  if (!room) return { ok: false, error: "Phòng không tồn tại." };
  const uId = sanitizeUniverseId(nextUniverseRaw);
  room.universeId = uId;
  room.scenePresetId =
    UNIVERSE_DEFAULT_SCENE_PRESET[uId] || UNIVERSE_DEFAULT_SCENE_PRESET.classic;

  const botPool = UNIVERSE_BOT_NAMES[uId] || UNIVERSE_BOT_NAMES.classic;
  const usedNames = new Set(
    (room.players || []).filter((p) => !p.isBot).map((p) => p.name)
  );
  let botIdx = 0;
  (room.players || []).forEach((p) => {
    if (!p.isBot) return;
    let candidate = botPool[botIdx % botPool.length];
    botIdx += 1;
    if (usedNames.has(candidate)) candidate = `${candidate} #${botIdx}`;
    usedNames.add(candidate);
    p.name = candidate;
  });

  if (room.game?.winner) {
    room.game.awards = computeMatchAwards(room);
  }
  return { ok: true, universeId: uId, scenePresetId: room.scenePresetId };
}

/**
 * Giả lập tức thì (< 0.1s) trọn bộ Kịch Bản Kết Thúc & Phim Điện Ảnh 3D (`EndGameRecap`)
 * với đủ 15 nhịp kỹ năng cốt lõi cho cả 4 kết cục (`village`, `wolf`, `tanner`, `lovers`).
 */
export function devSimulateRecap(room, winnerType = "village", gameCtrl = null) {
  if (!room) return { ok: false, error: "Phòng không tồn tại." };
  const validWinners = new Set(["village", "wolf", "tanner", "lovers"]);
  const cleanWinner = validWinners.has(winnerType) ? winnerType : "village";
  const uId = sanitizeUniverseId(room.universeId);

  // Dọn sạch toàn bộ Timer đang chạy để tránh nhảy pha đè lên màn Recap
  gameCtrl?.clearRoomTimer?.(room.code);
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
  clearBotDebateTimers(room);
  if (room.rematchAutoTimer) {
    clearTimeout(room.rematchAutoTimer);
    room.rematchAutoTimer = null;
  }

  // Đảm bảo có tối thiểu 8 ghế với tên Bot khớp đúng Vũ Trụ hiện tại
  room.phase = "lobby";
  if ((room.players || []).length < 8) {
    addBotsToRoom(room.code, 8 - room.players.length);
  }
  devSwitchUniverseLive(room, uId);

  initGameState(room);
  const g = room.game;
  // Gắn mốc gameStartedAt duy nhất mỗi lần bấm để Room.jsx luôn mở lại Rạp Chiếu ngay tức khắc
  const baseTs = Date.now() - 180_000 - Math.floor(Math.random() * 997);
  g.gameStartedAt = baseTs;
  g.dayNumber = 2;

  const rolePlan = [
    "guard",
    "alpha_wolf",
    "witch",
    "seer",
    "hunter",
    "cupid",
    cleanWinner === "tanner" ? "tanner" : "mayor",
    "wolf",
  ];
  const counts = {};
  room.players.forEach((p, idx) => {
    const r = rolePlan[idx] || "villager";
    p.role = r;
    p.initialRole = r;
    p.seatIndex = idx;
    p.alive = true;
    counts[r] = (counts[r] || 0) + 1;
  });
  g.roleCounts = counts;

  const [pGuard, pAlpha, pWitch, pSeer, pHunter, pCupid, pSpecial, pWolf] = room.players;
  g.lovers = [pGuard.id, pWolf.id];
  g.mayorRevealedId = pSpecial.role === "mayor" ? pSpecial.id : null;

  const wolfWhisperLine =
    uId === "office"
      ? `Tối nay chốt đóng mộc cắt KPI bàn của ${pSeer.name} trước giờ họp sáng nhé!`
      : uId === "school"
        ? `Tiết tự học này kiểm tra đột xuất bàn của ${pSeer.name} trước nhé!`
        : `Đêm nay khóa chặt mục tiêu ${pSeer.name} trước bình minh nhé!`;

  const dayDebateLine =
    uId === "office"
      ? `Mình kiểm tra log mạng nội bộ thấy tài khoản của ${pSpecial.role === "tanner" ? pSpecial.name : pAlpha.name} rất đáng ngờ!`
      : uId === "school"
        ? `Tớ để ý từ đầu tiết ${pSpecial.role === "tanner" ? pSpecial.name : pAlpha.name} cứ lén nhìn sổ trực ban trên bục giảng!`
        : `Ánh mắt của ${pSpecial.role === "tanner" ? pSpecial.name : pAlpha.name} từ sáng nay cực kỳ bất thường!`;

  const verdictTarget = cleanWinner === "tanner" ? pSpecial : cleanWinner === "wolf" ? pSeer : pWolf;
  const allIds = room.players.map((p) => p.id);
  const initialWolfIds = [pAlpha.id, pWolf.id];

  const votesMap = {};
  room.players.forEach((p) => {
    if (p.id !== verdictTarget.id) {
      votesMap[p.id] = "hang";
    }
  });
  const nomVotesMap = {};
  room.players.forEach((p) => {
    if (p.id !== verdictTarget.id) {
      nomVotesMap[p.id] = { targetId: verdictTarget.id, timestamp: baseTs + 75_000 };
    }
  });

  let seq = 0;
  const pushFrame = (offsetMs, day, phase, spec) => {
    g.replayTimeline.push({
      seq: ++seq,
      ts: baseTs + offsetMs,
      elapsedMs: offsetMs,
      day,
      phase,
      isNight: String(phase).startsWith("night_"),
      aliveIds: spec.aliveIds || allIds,
      wolfIdsNow: spec.wolfIdsNow || initialWolfIds,
      coActorIds: [],
      caption: "",
      ...spec,
    });
  };

  // Đêm 1: Đủ bộ kỹ năng Đêm + Cứu + Độc + Soi + Đồng hóa
  pushFrame(4000, 1, "night_cupid", {
    kind: "cupid_link",
    actorId: pCupid.id,
    actorRole: "cupid",
    targetId: pGuard.id,
    coActorIds: [pWolf.id],
  });
  pushFrame(9000, 1, "night_guard", {
    kind: "guard_pick",
    actorId: pGuard.id,
    actorRole: "guard",
    targetId: pSeer.id,
  });
  pushFrame(15000, 1, "night_wolf", {
    kind: "wolf_aim",
    actorId: pAlpha.id,
    actorRole: "alpha_wolf",
    prevTargetId: pWitch.id,
    targetId: pSeer.id,
  });
  pushFrame(19000, 1, "night_wolf", {
    kind: "wolf_chat",
    actorId: pAlpha.id,
    actorRole: "alpha_wolf",
    targetId: pSeer.id,
    chatText: wolfWhisperLine,
  });
  pushFrame(24000, 1, "night_wolf", {
    kind: "wolf_strike",
    actorId: pAlpha.id,
    actorRole: "alpha_wolf",
    coActorIds: [pAlpha.id, pWolf.id],
    targetId: pSeer.id,
  });
  pushFrame(28000, 1, "night_wolf", {
    kind: "shield_block",
    actorId: pGuard.id,
    actorRole: "guard",
    targetId: pSeer.id,
  });
  pushFrame(34000, 1, "night_witch", {
    kind: "witch_save",
    actorId: pWitch.id,
    actorRole: "witch",
    targetId: pHunter.id,
  });
  pushFrame(39000, 1, "night_witch", {
    kind: "witch_poison",
    actorId: pWitch.id,
    actorRole: "witch",
    targetId: pCupid.id,
  });
  pushFrame(45000, 1, "night_seer", {
    kind: "seer_scan",
    actorId: pSeer.id,
    actorRole: "seer",
    targetId: pAlpha.id,
    decision: "wolf",
  });

  const aliveAfterN1 = allIds.filter((id) => id !== pCupid.id);
  pushFrame(52000, 1, "day_reveal", {
    kind: "night_death",
    targetId: pCupid.id,
    targetRole: "cupid",
    aliveIds: aliveAfterN1,
  });

  if (pSpecial.role === "mayor") {
    pushFrame(58000, 1, "day_discuss", {
      kind: "mayor_reveal",
      actorId: pSpecial.id,
      actorRole: "mayor",
      aliveIds: aliveAfterN1,
    });
  }

  pushFrame(64000, 1, "day_discuss", {
    kind: "village_chat",
    actorId: pSeer.id,
    actorRole: "seer",
    chatText: dayDebateLine,
    aliveIds: aliveAfterN1,
  });
  pushFrame(72000, 1, "day_nominate", {
    kind: "day_nominate",
    actorId: pSeer.id,
    actorRole: "seer",
    targetId: verdictTarget.id,
    votesSnapshot: nomVotesMap,
    _isCollectiveNominationSummary: true,
    aliveIds: aliveAfterN1,
  });
  pushFrame(79000, 1, "day_defense", {
    kind: "day_defense",
    targetId: verdictTarget.id,
    targetRole: verdictTarget.role,
    aliveIds: aliveAfterN1,
  });

  const aliveAfterVerdict = aliveAfterN1.filter((id) => id !== verdictTarget.id);
  pushFrame(88000, 1, "day_final_vote", {
    kind: "day_verdict",
    targetId: verdictTarget.id,
    targetRole: verdictTarget.role,
    decision: "hang",
    votesSnapshot: votesMap,
    aliveIds: aliveAfterVerdict,
  });

  if (cleanWinner === "wolf") {
    pushFrame(96000, 2, "night_wolf", {
      kind: "alpha_convert",
      actorId: pAlpha.id,
      actorRole: "alpha_wolf",
      targetId: pWitch.id,
      targetRole: "witch",
      aliveIds: aliveAfterVerdict,
      wolfIdsNow: [pAlpha.id, pWolf.id, pWitch.id],
    });
  } else if (cleanWinner === "village") {
    pushFrame(96000, 1, "hunter_revenge", {
      kind: "hunter_shot",
      actorId: pHunter.id,
      actorRole: "hunter",
      targetId: pAlpha.id,
      targetRole: "alpha_wolf",
      aliveIds: aliveAfterVerdict.filter((id) => id !== pHunter.id && id !== pAlpha.id),
    });
  }

  // Lịch sử phục vụ chấm điểm computeMatchAwards chuẩn xác
  g.history = [
    { type: "guard", day: 1, sourceId: pGuard.id, targetId: pSeer.id },
    { type: "wolf", day: 1, sourceId: pAlpha.id, targetId: pSeer.id },
    { type: "witch_save", day: 1, sourceId: pWitch.id, targetId: pHunter.id },
    { type: "witch_poison", day: 1, sourceId: pWitch.id, targetId: pCupid.id },
    { type: "seer", day: 1, sourceId: pSeer.id, targetId: pAlpha.id, isWolf: true },
    { type: "death", day: 1, targetId: pCupid.id },
    ...(pSpecial.role === "mayor" ? [{ type: "mayor_reveal", day: 1, sourceId: pSpecial.id }] : []),
    {
      type: "hang",
      day: 1,
      targetId: verdictTarget.id,
      votesDetail: votesMap,
    },
    ...(cleanWinner === "wolf"
      ? [{ type: "alpha_converted", day: 2, sourceId: pAlpha.id, targetId: pWitch.id }]
      : []),
    ...(cleanWinner === "village"
      ? [{ type: "hunter_shot", day: 1, sourceId: pHunter.id, targetId: pAlpha.id }]
      : []),
  ];
  g._replaySeq = seq;

  // Thiết lập trạng thái sống/rời bàn cuối trận khớp 100% với phe chiến thắng
  pCupid.alive = false;
  if (cleanWinner === "village") {
    pWolf.alive = false;
    pAlpha.alive = false;
    pHunter.alive = false;
  } else if (cleanWinner === "wolf") {
    pWitch.role = "wolf";
    pSeer.alive = false;
    pGuard.alive = false;
    pHunter.alive = false;
  } else if (cleanWinner === "tanner") {
    pSpecial.alive = false;
  } else if (cleanWinner === "lovers") {
    room.players.forEach((p) => {
      p.alive = g.lovers.includes(p.id);
    });
  }

  room.phase = "ended";
  g.phase = "day_final_vote";
  g.winner = cleanWinner;
  g.awards = computeMatchAwards(room);
  g.rematchReadyIds = {};
  g.rematchEndsAt = Date.now() + 300_000;

  gameCtrl?.broadcast?.(room);
  return {
    ok: true,
    winner: cleanWinner,
    universeId: uId,
    beatFrameCount: g.replayTimeline.length,
    awardsCount: g.awards.length,
  };
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

  // 7. Chuyển nóng Vũ Trụ 1-Click ở mọi màn hình (Sảnh / Đang chơi / Đang chiếu Recap)
  socket.on("dev:setUniverse", ({ universeId } = {}, cb) => {
    withDevRoom((room) => {
      const res = devSwitchUniverseLive(room, universeId);
      if (!res.ok) return cb?.(res);
      if (room.phase === "playing" || room.phase === "ended") {
        gameCtrl.broadcast(room);
      } else {
        broadcastRoom(room);
      }
      cb?.(res);
    });
  });

  // 8. Nhảy thẳng vào Phim Tổng Kết Cuối Trận (< 0.5s) để kiểm chứng Lời Kết & Danh Hiệu 3 Không Gian
  socket.on("dev:simulateRecap", ({ winner = "village" } = {}, cb) => {
    withDevRoom((room) => {
      const res = devSimulateRecap(room, winner, gameCtrl);
      if (!res.ok) return cb?.(res);
      if (!gameCtrl?.broadcast) broadcastRoom(room);
      cb?.(res);
    });
  });
}
