import "./envLoader.js";
import * as GE from "./gameEngine.js";
import { isWolfTeamRole } from "./roles.js";
import {
  publicRoomView,
  publicSpectatorView,
  getRoom,
  addBotsToRoom,
  resetRoomToLobby,
} from "./rooms.js";
import {
  warmRoomOpeningVoices,
  warmExactNightVictimVoice,
  warmExactNomineesVoices,
  warmCupidLoversVoices,
  warmStoryTimelineProgressively,
  warmEndGameFinaleVoice,
  warmPhrasesInBackground,
} from "./storyVoiceEngine.js";
import { estimateMcSpeechMs, isRoomFullMcPacing } from "./botVoiceCatalog.js";
import { adaptTextForUniverse } from "./universeThemes.js";

// timers: Map<roomCode, Timeout> (Timer chính của từng phase)
const timers = new Map();
// smartTimers: Map<roomCode, Timeout> (Timer ẩn Smart Pacing + Jitter không làm nhảy đồng hồ HUD gây lộ vai!)
const smartTimers = new Map();

function clearSmartTimer(code) {
  if (smartTimers.has(code)) {
    clearTimeout(smartTimers.get(code));
    smartTimers.delete(code);
  }
}

function clearRoomTimer(code) {
  clearSmartTimer(code);
  if (timers.has(code)) {
    clearTimeout(timers.get(code));
    timers.delete(code);
  }
}

function setRoomTimer(code, ms, fn, { updateDurationSec = true } = {}) {
  clearRoomTimer(code);
  const room = getRoom(code);
  if (room && room.game) {
    room.game.phaseStartedAt = Date.now();
    room.game.phaseEndsAt = Date.now() + ms;
    room.game._activeTimerFn = fn;
    if (updateDurationSec) {
      room.game.phaseDurationSec = Math.max(1, Math.round(ms / 1000));
    }
  }

  const t = setTimeout(() => {
    timers.delete(code);
    const freshRoom = getRoom(code);
    if (!freshRoom || !freshRoom.game || freshRoom.game.winner) return;
    try {
      fn(freshRoom);
    } catch (err) {
      console.error(`[Timer Error] room=${code} fn=${fn.name}:`, err);
    }
  }, ms);
  t.unref?.();
  timers.set(code, t);
}

function setSmartTimer(code, expectedPhaseKey, delayMs, fn) {
  clearSmartTimer(code);
  const t = setTimeout(() => {
    smartTimers.delete(code);
    const freshRoom = getRoom(code);
    if (!freshRoom || freshRoom.phase !== "playing" || !freshRoom.game || freshRoom.game.winner) {
      return;
    }
    const nowKey = `${freshRoom.game.dayNumber}:${freshRoom.game.phase}:${freshRoom.game.hotSeatIndex ?? -1}`;
    if (nowKey !== expectedPhaseKey) return;
    clearRoomTimer(code);
    try {
      fn(freshRoom);
    } catch (err) {
      console.error(`[SmartTimer Error] room=${code}:`, err);
    }
  }, Math.max(150, delayMs));
  t.unref?.();
  smartTimers.set(code, t);
}

export function createGameController(io) {
  let phaseHook = null;
  let roomListHook = null;

  function notifyRoomList(room) {
    if (roomListHook) {
      try {
        roomListHook(room);
      } catch (err) {
        console.error("[RoomList Hook Error]:", err);
      }
    }
  }

  function broadcast(room) {
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
    if (phaseHook) {
      try {
        phaseHook(room);
      } catch (err) {
        console.error("[BotEngine Hook Error]:", err);
      }
    }
  }

  function getRemainingMcFloorMs(room) {
    if (!room?.game || !isRoomFullMcPacing(room)) return 0;
    return Math.max(0, (room.game.mcBusyUntilAt || 0) - Date.now());
  }

  function getRemainingBotAudioFloorMs(room) {
    if (!room?.game || !isRoomFullMcPacing(room)) return 0;
    return Math.max(0, (room.game.botAudioBusyUntilAt || 0) - Date.now());
  }

  function announce(room, message) {
    const finalMsg = adaptTextForUniverse(message, room?.universeId);
    if (room?.game && finalMsg) {
      const now = Date.now();
      const speechMs = estimateMcSpeechMs(finalMsg, {
        speed: 0.82,
        bufferMs: 1550,
        minMs: 3600,
        maxMs: 11500,
      });
      const prevRemain = Math.max(0, (room.game.mcBusyUntilAt || 0) - now);
      room.game.lastMcAnnounceAt = now;
      room.game.lastMcRequiredMs = speechMs;
      room.game.mcBusyUntilAt =
        prevRemain > 250
          ? now + Math.min(15000, prevRemain + speechMs - 700)
          : now + speechMs;
    }
    if (
      finalMsg &&
      room?.phase !== "ended" &&
      !room?.game?.winner &&
      (finalMsg.includes("AI Bot") ||
        room?.players?.some((p) => p?.name && finalMsg.includes(p.name)))
    ) {
      warmPhrasesInBackground([finalMsg], "urgent");
    }
    io.to(room.code).emit("mc:message", finalMsg);
  }

  // ============ CHỐT MẠCH GAME ĐÊM: SMART PACING + RANDOM JITTER (ZERO META-LEAK) ============
  function isNightPhaseActionComplete(room) {
    const g = room?.game;
    if (!g) return false;
    const alivePlayers = room.players.filter((p) => p.alive);
    const aliveHumans = alivePlayers.filter((p) => !p.isBot);

    switch (g.phase) {
      case "night_cupid": {
        const humanCupids = aliveHumans.filter((p) => p.role === "cupid");
        if (humanCupids.length === 0) return true;
        return Array.isArray(g.lovers) && g.lovers.length === 2;
      }
      case "night_guard": {
        const humanGuards = aliveHumans.filter((p) => p.role === "guard");
        if (humanGuards.length === 0) return true;
        return Boolean(g.guardedIdTonight);
      }
      case "night_wolf": {
        const humanWolves = aliveHumans.filter((p) => isWolfTeamRole(p.role));
        if (humanWolves.length === 0) return true;
        const allPicked = humanWolves.every((w) => Boolean(g.wolfPicks?.[w.id]?.targetId));
        if (!allPicked) return false;
        const aliveWolvesAll = alivePlayers.filter((p) => isWolfTeamRole(p.role));
        const pickedTargets = new Set(
          aliveWolvesAll.map((w) => g.wolfPicks?.[w.id]?.targetId).filter(Boolean)
        );
        return pickedTargets.size === 1;
      }
      case "night_witch": {
        const humanWitches = aliveHumans.filter((p) => p.role === "witch");
        if (humanWitches.length === 0) return true;
        if (g.witchDecidedPass) return true;
        const canStillSave = !g.witchUsedSave && Boolean(g.wolfVictimId);
        const canStillPoison = !g.witchUsedPoison;
        return !canStillSave && !canStillPoison;
      }
      case "night_seer": {
        const humanSeers = aliveHumans.filter((p) => p.role === "seer");
        if (humanSeers.length === 0) return true;
        return (g.seerChecksLog || []).some((c) => c.dayNumber === g.dayNumber);
      }
      default:
        return false;
    }
  }

  function hasPendingBotNightActor(room) {
    const g = room?.game;
    if (!g || room.devAutoBot === false) return false;
    const aliveBots = room.players.filter((p) => p.alive && p.isBot);
    if (aliveBots.length === 0) return false;
    if (g.phase === "night_cupid") return aliveBots.some((b) => b.role === "cupid") && !g.lovers;
    if (g.phase === "night_guard") return aliveBots.some((b) => b.role === "guard") && !g.guardedIdTonight;
    if (g.phase === "night_wolf") {
      return aliveBots.some((b) => isWolfTeamRole(b.role)) && Object.keys(g.wolfPicks || {}).length === 0;
    }
    if (g.phase === "night_witch") {
      return (
        aliveBots.some((b) => b.role === "witch") &&
        !g.witchSaveTonight &&
        !g.witchPoisonTargetId &&
        !g.witchDecidedPass
      );
    }
    if (g.phase === "night_seer") {
      return (
        aliveBots.some((b) => b.role === "seer") &&
        !(g.seerChecksLog || []).some((c) => c.dayNumber === g.dayNumber)
      );
    }
    return false;
  }

  function scheduleSmartNightCheck(room, { triggeredByHuman = false } = {}) {
    if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
    const g = room.game;
    const nightNextFnMap = {
      night_cupid: advanceFromCupid,
      night_guard: advanceFromGuard,
      night_wolf: advanceFromWolf,
      night_witch: advanceFromWitch,
      night_seer: advanceFromSeer,
    };
    const nextFn = nightNextFnMap[g.phase];
    if (!nextFn) return;

    // Nếu trong phòng có AI Bot cầm vai đêm này mà Bot chưa kịp chốt (chờ 1.2s ở devSandbox), đợi devSandbox gọi lại
    if (hasPendingBotNightActor(room)) return;
    if (!isNightPhaseActionComplete(room)) return;

    const realHumanCount = room.players.filter((p) => !p.isBot).length;
    const isSoloPractice = realHumanCount <= 1;
    const elapsedMs = Math.max(0, Date.now() - (g.phaseStartedAt || Date.now()));

    let waitMs;
    if (isSoloPractice) {
      if (isRoomFullMcPacing(room)) {
        // Nhịp Đọc Trọn (New-Player Friendly): Đợi MC đọc trọn câu dẫn + đệm hiểu tình huống (& câu thì thầm của đồng bọn Sói Bot nếu có)
        const baseSoloMs = triggeredByHuman ? 1900 : 2500;
        waitMs = Math.max(
          baseSoloMs,
          getRemainingMcFloorMs(room),
          getRemainingBotAudioFloorMs(room)
        );
      } else {
        // Chế độ Nhanh: lướt nhanh 1.4s - 1.8s
        waitMs = triggeredByHuman ? 1400 : 1800;
      }
    } else {
      // Bàn nhiều người chơi thật (>= 2 người):
      // Khóa Random Jitter phía Server 100% độc lập Client (0% lộ vai đó còn sống, đã chết hay là AI Bot!)
      const minSpan = isRoomFullMcPacing(room) ? 6800 : 5500;
      const jitterSpan = isRoomFullMcPacing(room) ? 2800 : 3000;
      const targetSpanMs = minSpan + Math.floor(Math.random() * jitterSpan);
      waitMs = Math.max(1900, targetSpanMs - elapsedMs);
    }

    const phaseKey = `${g.dayNumber}:${g.phase}:${g.hotSeatIndex ?? -1}`;
    setSmartTimer(room.code, phaseKey, waitMs, nextFn);
  }

  // Tự chốt sớm khi 100% người sống đã bỏ phiếu (Tôn trọng sàn thời lượng đọc câu MC ở chế độ Đọc Trọn!)
  function checkUniversalDayVoteConsensus(room) {
    if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
    const g = room.game;
    const alive = room.players.filter((p) => p.alive);
    if (alive.length === 0) return;

    const waitMs = isRoomFullMcPacing(room)
      ? Math.max(2800, getRemainingMcFloorMs(room))
      : 2000;
    const phaseKey = `${g.dayNumber}:${g.phase}:${g.hotSeatIndex ?? -1}`;
    if (g.phase === "day_nominate") {
      const allVoted = alive.every((p) => Boolean(g.nominationVotes?.[p.id]?.targetId));
      if (allVoted) {
        setSmartTimer(room.code, phaseKey, waitMs, finalizeNominationPhase);
      }
    } else if (g.phase === "day_final_vote") {
      const allVoted = alive.every((p) => Boolean(g.finalVotes?.[p.id]));
      if (allVoted) {
        setSmartTimer(room.code, phaseKey, waitMs, finishFinalVoteTurn);
      }
    }
  }

  // ============ BẮT ĐẦU GAME (MỞ PHA ROLE_REVEAL 6 GIÂY TRƯỚC ĐÊM 1) ============
  function beginFirstNightAfterReveal(room) {
    if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
    const g = room.game;
    const firstPhase = g.firstNightPhase || "night_guard";
    g.phase = firstPhase;

    if (firstPhase === "night_cupid") {
      announce(room, "💘 Đêm đầu tiên buông xuống... Thần Tình Yêu ơi, thức dậy! Hãy chọn 2 người để kết duyên sinh tử.");
      setRoomTimer(room.code, GE.getPhaseDurationSec(room, "night_cupid") * 1000, advanceFromCupid);
    } else {
      announce(room, "Đêm đầu tiên buông xuống... Bảo Vệ ơi, thức dậy! Hãy chọn người bạn muốn bảo vệ đêm nay.");
      setRoomTimer(room.code, GE.getPhaseDurationSec(room, "night_guard") * 1000, advanceFromGuard);
    }
    broadcast(room);
    scheduleSmartNightCheck(room);
  }

  function startGame(room, options = {}) {
    const humanPlayers = room.players.filter((p) => !p.isBot);
    if (humanPlayers.length < 1) {
      return { error: "Cần ít nhất 1 người chơi thật để bắt đầu." };
    }

    const notReady = humanPlayers.filter((p) => !p.isHost && !p.ready);
    if (notReady.length > 0) {
      return {
        error: `Còn ${notReady.length} người chơi chưa sẵn sàng (${notReady.map((p) => p.name).join(", ")}).`,
      };
    }

    const totalRoles = Object.values(room.rolesConfig || {}).reduce(
      (a, b) => a + (Number(b) || 0),
      0
    );
    if (totalRoles < 6) {
      return {
        error: `Tổng số vai trò phải từ 6 trở lên (hiện đang chọn ${totalRoles} vai).`,
      };
    }
    if (room.players.length > totalRoles) {
      return {
        error: `Tổng số vai trò đã chọn (${totalRoles}) đang ít hơn số người trong phòng (${room.players.length}). Hãy bấm '➕ Bù Dân' hoặc thêm vai!`,
      };
    }

    const totalWolfTeam =
      (Number(room.rolesConfig?.wolf) || 0) + (Number(room.rolesConfig?.alpha_wolf) || 0);
    if (totalWolfTeam < 1) {
      return { error: "Cần tối thiểu 1 Sói (hoặc Sói Đầu Đàn) trong ván đấu." };
    }

    let autoAddedBots = 0;
    if (room.players.length < totalRoles) {
      const missingSeats = totalRoles - room.players.length;
      const botRes = addBotsToRoom(room.code, missingSeats);
      autoAddedBots = botRes?.added || 0;
    }

    if (room.players.length < 6 || room.players.length !== totalRoles) {
      return {
        error: `Tổng số vai trò (${totalRoles}) chưa khớp với số ghế (${room.players.length}).`,
      };
    }

    GE.initGameState(room);

    // Chế độ Luyện Tập 1 Mình (Solo Practice Role — chỉ kích hoạt khi có ĐÚNG 1 người thật, công bằng 100%)
    if (humanPlayers.length === 1 && room.soloPracticeRole) {
      const soloMe = humanPlayers[0];
      const desiredRole = room.soloPracticeRole;
      if (soloMe && soloMe.role !== desiredRole) {
        const donor = room.players.find((p) => p.id !== soloMe.id && p.role === desiredRole);
        if (donor) {
          donor.role = soloMe.role;
          soloMe.role = desiredRole;
        }
        room.players.forEach((p) => {
          p.initialRole = p.role;
        });
        GE.syncInitialRoleState(room);
      }
    }

    // [LOCAL DEV ONLY] Áp dụng vai trò ép trước từ DevSandbox
    if (
      !process.env.RENDER &&
      process.env.NODE_ENV !== "production" &&
      process.env.ALLOW_LOCAL_STUDIO === "1" &&
      room.devForcedRoles
    ) {
      Object.entries(room.devForcedRoles).forEach(([pid, desiredRole]) => {
        if (!desiredRole) return;
        const me = room.players.find((p) => p.id === pid);
        if (!me || me.role === desiredRole) return;
        const donor = room.players.find((p) => p.id !== pid && p.role === desiredRole);
        if (donor) {
          donor.role = me.role;
          me.role = desiredRole;
        } else {
          me.role = desiredRole;
        }
      });
      room.players.forEach((p) => {
        p.initialRole = p.role;
      });
      GE.syncInitialRoleState(room);
    }

    room.phase = "playing";
    room.lastAutoPhaseKey = null;
    const defenseDur = GE.getPhaseDurationSec(room, "day_defense");
    warmRoomOpeningVoices(room, defenseDur, autoAddedBots);

    if (options?.skipRoleReveal) {
      beginFirstNightAfterReveal(room);
      notifyRoomList(room);
      return { ok: true, autoAddedBots };
    }

    // Pha mở màn độc lập `role_reveal` (6.0s): AI Bot đứng yên 100%, chưa gọi Bảo Vệ/Cupid để không mất giây hành động!
    room.game.phase = "role_reveal";
    room.game.roleRevealReadyIds = {};
    if (autoAddedBots > 0) {
      announce(
        room,
        `🤖 Đã triệu hồi thêm ${autoAddedBots} AI Bot lấp đủ ${room.players.length} ghế. Hãy xem kỹ lá bài định mệnh của bạn!`
      );
    } else {
      announce(
        room,
        `Trò chơi bắt đầu với ${room.players.length} người chơi${room.isTurbo ? " (Chế độ Tốc Chiến)" : ""}. Hãy bí mật xem thân phận của mình!`
      );
    }

    room.game.phaseDurationSec = GE.TIMERS.roleReveal;
    const roleRevealMs = isRoomFullMcPacing(room)
      ? Math.max(GE.TIMERS.roleReveal * 1000, getRemainingMcFloorMs(room))
      : GE.TIMERS.roleReveal * 1000;
    setRoomTimer(room.code, roleRevealMs, beginFirstNightAfterReveal, {
      updateDurationSec: false,
    });
    broadcast(room);
    notifyRoomList(room);
    return { ok: true, autoAddedBots };
  }

  function markRoleRevealReady(room, playerId) {
    if (!room || room.phase !== "playing" || room.game?.phase !== "role_reveal") {
      return { ok: false };
    }
    if (!room.game.roleRevealReadyIds) room.game.roleRevealReadyIds = {};
    room.game.roleRevealReadyIds[playerId] = true;

    const connectedHumans = room.players.filter((p) => !p.isBot && p.connected);
    const allHumansReady =
      connectedHumans.length > 0 &&
      connectedHumans.every((p) => Boolean(room.game.roleRevealReadyIds[p.id]));

    if (allHumansReady) {
      const elapsedMs = Math.max(0, Date.now() - (room.game.phaseStartedAt || Date.now()));
      const remainToMinStageMs = Math.max(350, 3500 - elapsedMs);
      const phaseKey = `${room.game.dayNumber}:role_reveal:${room.game.hotSeatIndex ?? -1}`;
      setSmartTimer(room.code, phaseKey, remainToMinStageMs, beginFirstNightAfterReveal);
    }
    return { ok: true, allHumansReady };
  }

  // ============ ĐÊM 1: THẦN TÌNH YÊU ============
  function advanceFromCupid(room) {
    GE.endCupidPhase(room);
    warmCupidLoversVoices(room);
    announce(room, "Thần Tình Yêu đã ngủ lại. Bảo Vệ ơi, hãy thức dậy và chọn người bảo vệ...");
    setRoomTimer(room.code, GE.getPhaseDurationSec(room, "night_guard") * 1000, advanceFromGuard);
    broadcast(room);
    scheduleSmartNightCheck(room);
  }

  // ============ ĐÊM: BẢO VỆ ============
  function advanceFromGuard(room) {
    GE.endGuardPhase(room);
    warmStoryTimelineProgressively(room);
    announce(room, "Bảo Vệ đã ngủ lại. Sói ơi, hãy thức dậy và chọn con mồi...");
    setRoomTimer(room.code, GE.getPhaseDurationSec(room, "night_wolf") * 1000, advanceFromWolf);
    broadcast(room);
    scheduleSmartNightCheck(room);
  }

  // ============ ĐÊM: SÓI ============
  function advanceFromWolf(room) {
    GE.endWolfPhase(room);
    warmStoryTimelineProgressively(room);
    warmExactNightVictimVoice(room);
    announce(room, "Sói đã ngủ lại. Phù Thủy ơi, hãy thức dậy...");
    setRoomTimer(room.code, GE.getPhaseDurationSec(room, "night_witch") * 1000, advanceFromWitch);
    broadcast(room);
    scheduleSmartNightCheck(room);
  }

  // ============ ĐÊM: PHÙ THỦY ============
  function advanceFromWitch(room) {
    GE.endWitchPhase(room);
    warmStoryTimelineProgressively(room);
    warmExactNightVictimVoice(room);
    announce(room, "Phù Thủy đã ngủ lại. Tiên Tri ơi, hãy thức dậy và soi một người...");
    setRoomTimer(room.code, GE.getPhaseDurationSec(room, "night_seer") * 1000, advanceFromSeer);
    broadcast(room);
    scheduleSmartNightCheck(room);
  }

  // ============ ĐÊM: TIÊN TRI -> RESOLVE ============
  function advanceFromSeer(room) {
    GE.endSeerPhase(room);
    const deaths = GE.resolveNightDeaths(room);
    warmStoryTimelineProgressively(room);
    if (deaths.length === 0) {
      announce(room, "Trời đã sáng. Đêm qua không ai chết.");
    } else {
      const names = deaths.map((id) => room.players.find((p) => p.id === id)?.name).join(", ");
      announce(room, `Trời đã sáng. Đêm qua ${names} đã không qua khỏi.`);
    }

    if (room.game.phase === "hunter_revenge" && room.game.hunterPendingId) {
      const hunter = room.players.find((p) => p.id === room.game.hunterPendingId);
      announce(
        room,
        `🏹 Khoan đã! Thợ Săn ${hunter?.name || ""} còn 15 giây hơi thở cuối để bóp cò bắn đạn bạc trả thù!`
      );
      setRoomTimer(room.code, GE.TIMERS.hunterRevenge * 1000, finishHunterRevengeTimeout);
      broadcast(room);
      return;
    }

    const winner = GE.checkWinCondition(room);
    if (winner) return endGame(room, winner);

    const dawnWaitMs = isRoomFullMcPacing(room)
      ? Math.max(5800, getRemainingMcFloorMs(room) + 600)
      : 5000;
    setRoomTimer(room.code, dawnWaitMs, beginDiscussion);
    broadcast(room);
    notifyRoomList(room);
  }

  function resumeAfterHunterRevenge(room, returnContext) {
    const g = room.game;
    const winner = GE.checkWinCondition(room);
    if (winner) return endGame(room, winner);

    if (returnContext === "hang_queue") {
      g.hotSeatIndex += 1;
      g.finalVotes = {};
      if (g.hotSeatIndex < g.hotSeatQueue.length) {
        const nextDefendant = room.players.find((p) => p.id === g.hotSeatQueue[g.hotSeatIndex]);
        announce(room, `Tiếp theo: Mời cả làng vote cho ${nextDefendant?.name || "bị cáo tiếp theo"}: Treo cổ hay Tha.`);
        g.phase = "day_final_vote";
        const finalSec = GE.getPhaseDurationSec(room, "day_final_vote");
        g.finalVoteEndsAt = Date.now() + finalSec * 1000;
        setRoomTimer(room.code, finalSec * 1000, finishFinalVoteTurn);
        broadcast(room);
      } else {
        goToNextNight(room);
      }
    } else {
      setRoomTimer(room.code, 3800, beginDiscussion);
      broadcast(room);
    }
  }

  function finishHunterRevengeTimeout(room) {
    if (!room?.game || room.game.phase !== "hunter_revenge") return;
    const { returnContext } = GE.skipHunterRevenge(room);
    announce(room, "🏹 Hết thời gian! Thợ Săn đã gục xuống mà không bóp cò.");
    resumeAfterHunterRevenge(room, returnContext);
  }

  function handleHunterShoot(room, hunterId, targetId) {
    const res = GE.hunterShoot(room, hunterId, targetId);
    if (!res.ok) return res;
    clearRoomTimer(room.code);
    warmStoryTimelineProgressively(room);
    const hunter = room.players.find((p) => p.id === hunterId);
    const killedNames = (res.killedIds || [])
      .map((id) => room.players.find((p) => p.id === id)?.name)
      .filter(Boolean)
      .join(", ");
    announce(
      room,
      `🏹 ĐOÀNG!! Đạn bạc cuối cùng của Thợ Săn ${hunter?.name || ""} đã hạ gục ${killedNames}!`
    );

    // Đệm điện ảnh để người chơi kịp nhìn trọn đường đạn bạc 3D & nghe trọn thông báo hạ gục trước khi chuyển cảnh!
    broadcast(room);
    const shotWaitMs = isRoomFullMcPacing(room)
      ? Math.max(3800, getRemainingMcFloorMs(room))
      : 2800;
    setRoomTimer(
      room.code,
      shotWaitMs,
      (freshRoom) => resumeAfterHunterRevenge(freshRoom, res.returnContext),
      { updateDurationSec: false }
    );
    return res;
  }

  // ============ NGÀY: THẢO LUẬN ============
  function beginDiscussion(room) {
    GE.startDiscussion(room);
    const discussSec = room.game.phaseDurationSec || GE.getPhaseDurationSec(room, "day_discuss");
    announce(
      room,
      `☀️ Cả làng thảo luận trong ${discussSec} giây. Nếu tất cả đồng ý bỏ qua có thể kết thúc sớm.`
    );
    scheduleDiscussEnd(room);
    broadcast(room);
  }

  function scheduleDiscussEnd(room) {
    const g = room.game;
    const msLeft = g.discussEndsAt - Date.now();
    setRoomTimer(room.code, Math.max(0, msLeft), beginNomination);
  }

  function rescheduleDiscussIfExtended(room, extended) {
    if (extended) scheduleDiscussEnd(room);
  }

  // ============ NGÀY: ĐỀ CỬ ============
  function beginNomination(room) {
    GE.startNomination(room);
    const nomSec = GE.getPhaseDurationSec(room, "day_nominate");
    announce(room, "Hết giờ thảo luận. Mời cả làng đề cử người nghi ngờ.");
    setRoomTimer(room.code, nomSec * 1000, finalizeNominationPhase);
    broadcast(room);
  }

  function finalizeNominationPhase(room) {
    const { nominees } = GE.finalizeNomination(room);
    warmStoryTimelineProgressively(room);
    if (nominees.length === 0) {
      announce(room, "Không ai bị đề cử. Đêm mới lại đến...");
      return goToNextNight(room);
    }
    warmExactNomineesVoices(room, nominees, GE.getPhaseDurationSec(room, "day_defense"));
    const allNames = nominees.map((n) => room.players.find((p) => p.id === n.playerId)?.name).join(", ");
    // Ở nhịp Đọc Trọn khi chỉ có 1 bị cáo duy nhất: không phát chồng 2 câu mời trùng nhau trong 1ms
    if (nominees.length >= 2 || !isRoomFullMcPacing(room)) {
      announce(room, `${allNames} bị đề cử nhiều nhất. Mời lần lượt lên biện hộ.`);
    }
    finishDefenseTurn(room);
  }

  function finishDefenseTurn(room) {
    const result = GE.nextDefenseOrFinalVote(room);
    if (result.phase === "day_defense") {
      const defendantPlayer = room.players.find((p) => p.id === result.currentDefendantId);
      const name = defendantPlayer?.name;
      const fullPacing = isRoomFullMcPacing(room);
      const isTiedFirstTurn =
        (room.game?.hotSeatQueue?.length || 0) >= 2 && room.game?.hotSeatIndex === 0;
      const defenseSec = defendantPlayer?.isBot
        ? fullPacing
          ? isTiedFirstTurn
            ? 18
            : 14
          : 8
        : GE.getPhaseDurationSec(room, "day_defense");
      if (room.game) {
        room.game.hotSeatEndsAt = Date.now() + defenseSec * 1000;
      }
      announce(room, `🎤 Mời ${name || "người tiếp theo"} lên biện hộ. (${defenseSec} giây)`);
      setRoomTimer(room.code, defenseSec * 1000, finishDefenseTurn);
    } else {
      const defendant = room.players.find((p) => p.id === result.currentDefendantId);
      const finalSec = GE.getPhaseDurationSec(room, "day_final_vote");
      announce(room, `⚖️ Mời cả làng vote cho ${defendant?.name || "bị cáo đầu tiên"}: Treo cổ hay Tha.`);
      setRoomTimer(room.code, finalSec * 1000, finishFinalVoteTurn);
    }
    broadcast(room);
  }

  function finishFinalVoteTurn(room) {
    const g = room.game;
    const result = GE.resolveFinalVote(room);
    warmStoryTimelineProgressively(room);
    const defendant = room.players.find((p) => p.id === result.defendantId);

    if (result.hanged) {
      announce(room, `Làng đã quyết định! ${defendant?.name || "Bị cáo"} sẽ rời khỏi ván đấu. Xin hãy giữ im lặng tuyệt đối.`);
      if (result.cascadedIds?.length > 0) {
        const loverNames = result.cascadedIds
          .map((id) => room.players.find((p) => p.id === id)?.name)
          .filter(Boolean)
          .join(", ");
        announce(room, `💔 Tơ hồng đứt đoạn! Tình Nhân ${loverNames} không chịu nổi nỗi đau đã gục ngã theo!`);
      }
    } else {
      announce(room, `Làng đã tha ${defendant?.name || "bị cáo"}! Không ai bị xử tử hôm nay.`);
    }

    if (result.tannerWin) {
      return endGame(room, "tanner");
    }

    if (room.game.phase === "hunter_revenge" && room.game.hunterPendingId) {
      const hunter = room.players.find((p) => p.id === room.game.hunterPendingId);
      announce(
        room,
        `🏹 Khoan đã! Thợ Săn ${hunter?.name || ""} còn 15 giây hơi thở cuối để bóp cò bắn đạn bạc trả thù!`
      );
      setRoomTimer(room.code, GE.TIMERS.hunterRevenge * 1000, finishHunterRevengeTimeout);
      broadcast(room);
      return;
    }

    const winner = GE.checkWinCondition(room);
    if (winner) return endGame(room, winner);

    g.hotSeatIndex += 1;
    g.finalVotes = {};

    if (g.hotSeatIndex < g.hotSeatQueue.length) {
      const nextDefendant = room.players.find((p) => p.id === g.hotSeatQueue[g.hotSeatIndex]);
      const finalSec = GE.getPhaseDurationSec(room, "day_final_vote");
      announce(room, `Tiếp theo: Mời cả làng vote cho ${nextDefendant?.name || "bị cáo tiếp theo"}: Treo cổ hay Tha.`);
      g.finalVoteEndsAt = Date.now() + finalSec * 1000;
      setRoomTimer(room.code, finalSec * 1000, finishFinalVoteTurn);
      broadcast(room);
    } else {
      goToNextNight(room);
    }
  }

  function goToNextNight(room) {
    GE.startNextNight(room);
    announce(room, `Đêm thứ ${room.game.dayNumber} bắt đầu. Bảo Vệ ơi, hãy thức dậy...`);
    setRoomTimer(room.code, GE.getPhaseDurationSec(room, "night_guard") * 1000, advanceFromGuard);
    broadcast(room);
    notifyRoomList(room);
    scheduleSmartNightCheck(room);
  }

  // Nâng trần dọn sảnh treo ngầm lên 5 phút (300_000ms) để không bao giờ ngắt ngang câu chuyện cuối game khi người chơi đang xem!
  const REMATCH_AUTO_LOBBY_MS = 300_000;

  function reopenRoomLobby(room) {
    if (!room) return { ok: false, error: "Phòng không tồn tại." };
    clearRoomTimer(room.code);
    const res = resetRoomToLobby(room);
    broadcast(room);
    notifyRoomList(room);
    return { ok: true, promotedIds: res?.promotedIds || [] };
  }

  function markRematchReady(room, playerId) {
    if (!room || room.phase !== "ended" || !room.game?.winner) {
      return { ok: false, error: "Ván đấu chưa ở màn tổng kết." };
    }
    const me = room.players.find((p) => p.id === playerId && !p.isBot);
    if (!me) {
      return { ok: false, error: "Chỉ người chơi trong bàn mới bấm sẵn sàng ván mới." };
    }
    if (!room.game.rematchReadyIds) room.game.rematchReadyIds = {};
    room.game.rematchReadyIds[me.id] = true;

    const connectedHumans = room.players.filter((p) => !p.isBot && p.connected);
    const needed = Math.max(1, Math.ceil(connectedHumans.length / 2));
    const readyCount = Object.keys(room.game.rematchReadyIds).filter((id) =>
      connectedHumans.some((p) => p.id === id)
    ).length;

    if (me.isHost || readyCount >= needed) {
      const reopened = reopenRoomLobby(room);
      return { ok: true, reopened: true, promotedIds: reopened.promotedIds };
    }

    broadcast(room);
    return { ok: true, reopened: false, readyCount, requiredCount: needed };
  }

  function endGame(room, winner) {
    room.phase = "ended";
    room.game.winner = winner;
    room.game.awards = GE.computeMatchAwards(room);
    room.game.rematchReadyIds = {};
    room.game.rematchEndsAt = Date.now() + REMATCH_AUTO_LOBBY_MS;
    warmEndGameFinaleVoice(room);
    clearRoomTimer(room.code);
    if (room.devBotTimer) {
      clearTimeout(room.devBotTimer);
      room.devBotTimer = null;
    }
    if (Array.isArray(room.devDebateTimers)) {
      room.devDebateTimers.forEach((t) => clearTimeout(t));
      room.devDebateTimers = [];
    }
    if (room.rematchAutoTimer) {
      clearTimeout(room.rematchAutoTimer);
      room.rematchAutoTimer = null;
    }
    room.rematchAutoTimer = setTimeout(() => {
      room.rematchAutoTimer = null;
      const fresh = getRoom(room.code);
      if (!fresh || fresh.phase !== "ended") return;
      const hasHumansOrSpecs =
        fresh.players.some((p) => !p.isBot && p.connected) ||
        (fresh.spectators || []).some((s) => s.connected);
      if (hasHumansOrSpecs) {
        reopenRoomLobby(fresh);
      }
    }, REMATCH_AUTO_LOBBY_MS);
    room.rematchAutoTimer.unref?.();

    if (winner === "lovers") {
      announce(room, "💘 Trò chơi kết thúc! Cặp Đôi Định Mệnh vượt qua chiến tuyến chiến thắng trọn vẹn!");
    } else if (winner === "wolf") {
      announce(room, "Trò chơi kết thúc! Phe Sói chiến thắng. Bóng tối đã nuốt chửng cả làng...");
    } else if (winner === "village") {
      announce(room, "Trò chơi kết thúc! Phe Dân chiến thắng. Ánh sáng công lý đã xua tan bóng tối!");
    } else {
      announce(room, "Trò chơi kết thúc! Chán Đời thắng riêng — người này thực sự muốn bị treo cổ!");
    }
    broadcast(room);
    notifyRoomList(room);
  }

  function advanceCurrentPhase(room) {
    if (!room?.game || room.game.winner) return { ok: false, error: "Ván đấu chưa chạy hoặc đã kết thúc." };
    clearRoomTimer(room.code);
    const p = room.game.phase;
    if (p === "role_reveal") beginFirstNightAfterReveal(room);
    else if (p === "night_cupid") advanceFromCupid(room);
    else if (p === "night_guard") advanceFromGuard(room);
    else if (p === "night_wolf") advanceFromWolf(room);
    else if (p === "night_witch") advanceFromWitch(room);
    else if (p === "night_seer") advanceFromSeer(room);
    else if (p === "hunter_revenge") finishHunterRevengeTimeout(room);
    else if (p === "day_reveal") beginDiscussion(room);
    else if (p === "day_discuss") beginNomination(room);
    else if (p === "day_nominate") finalizeNominationPhase(room);
    else if (p === "day_defense") finishDefenseTurn(room);
    else if (p === "day_final_vote") finishFinalVoteTurn(room);
    else if (p === "day_no_nomination") goToNextNight(room);
    else return { ok: false, error: `Không thể tua phase: ${p}` };
    return { ok: true, fromPhase: p, toPhase: room.game.phase };
  }

  function reapplyMcPacingLive(room) {
    if (!room || room.phase !== "playing" || !room.game || room.game.winner) return;
    const g = room.game;
    const fullPacing = isRoomFullMcPacing(room);
    if (!fullPacing) {
      g.mcBusyUntilAt = 0;
      g.botAudioBusyUntilAt = 0;
      if (room.devDeadAdvanceTimer) {
        clearTimeout(room.devDeadAdvanceTimer);
        room.devDeadAdvanceTimer = setTimeout(() => {
          room.devDeadAdvanceTimer = null;
          if (room.phase === "playing" && room.game && !room.game.winner) {
            advanceCurrentPhase(room);
          }
        }, 1600);
        room.devDeadAdvanceTimer.unref?.();
      }
      if (g.phase === "day_defense") {
        const curDefId = g.hotSeatQueue?.[g.hotSeatIndex];
        const curDef = room.players.find((p) => p.id === curDefId);
        const msLeft = (g.phaseEndsAt || 0) - Date.now();
        if (curDef?.isBot && msLeft > 4500) {
          g.hotSeatEndsAt = Date.now() + 4000;
          setRoomTimer(room.code, 4000, finishDefenseTurn);
        }
      }
    }
    if (g.phase?.startsWith("night_")) {
      scheduleSmartNightCheck(room, { triggeredByHuman: false });
    } else if (g.phase === "day_nominate" || g.phase === "day_final_vote") {
      checkUniversalDayVoteConsensus(room);
    }
  }

  // ============ EXPORT HANDLERS CHO index.js ============
  return {
    startGame,
    markRoleRevealReady,
    markRematchReady,
    reopenRoomLobby,
    reapplyMcPacingLive,
    getRemainingMcFloorMs,
    notifyBotNightReady: (room) => scheduleSmartNightCheck(room, { triggeredByHuman: false }),
    checkUniversalDayVoteConsensus,
    broadcast,
    announce,
    setPhaseHook: (fn) => { phaseHook = fn; },
    setRoomListHook: (fn) => { roomListHook = fn; },
    advanceCurrentPhase,
    cupidLink: (room, id, targetIds) => {
      const res = GE.cupidLink(room, id, targetIds);
      if (res.ok) {
        warmCupidLoversVoices(room);
        scheduleSmartNightCheck(room, { triggeredByHuman: true });
      }
      return res;
    },
    guardProtect: (room, id, targetId) => {
      const res = GE.guardProtect(room, id, targetId);
      if (res.ok) scheduleSmartNightCheck(room, { triggeredByHuman: true });
      return res;
    },
    wolfPick: (room, id, targetId) => {
      const res = GE.wolfPick(room, id, targetId);
      if (res.ok) scheduleSmartNightCheck(room, { triggeredByHuman: true });
      return res;
    },
    wolfAlphaToggle: (room, id, enabled) => GE.wolfAlphaToggle(room, id, enabled),
    witchDecide: (room, id, payload) => {
      const res = GE.witchDecide(room, id, payload);
      if (res.ok) scheduleSmartNightCheck(room, { triggeredByHuman: true });
      return res;
    },
    seerCheck: (room, id, targetId) => {
      const res = GE.seerCheck(room, id, targetId);
      if (res.ok) scheduleSmartNightCheck(room, { triggeredByHuman: true });
      return res;
    },
    mayorReveal: (room, id) => {
      const res = GE.mayorReveal(room, id);
      if (res.ok) {
        warmStoryTimelineProgressively(room);
        const mayor = room.players.find((p) => p.id === id);
        announce(
          room,
          `👑 ${mayor?.name || "Trưởng Làng"} giơ cao Quyền Trượng Vàng công bố thân phận Trưởng Làng — lá phiếu từ nay tính x2!`
        );
        // Chốt chống đánh úp giây cuối: nếu Trưởng Làng lộ diện khi vòng bỏ phiếu còn < 6s, bù thêm +5s (1 lần/pha)
        const g = room.game;
        if (g && (g.phase === "day_nominate" || g.phase === "day_final_vote")) {
          const pKey = `${g.dayNumber}:${g.phase}:${g.hotSeatIndex ?? -1}`;
          const msLeft = (g.phaseEndsAt || 0) - Date.now();
          if (msLeft > 0 && msLeft < 6000 && g.mayorTimeExtendedPhaseKey !== pKey && g._activeTimerFn) {
            g.mayorTimeExtendedPhaseKey = pKey;
            const nextMs = msLeft + 5000;
            if (g.phase === "day_final_vote") {
              g.finalVoteEndsAt = Date.now() + nextMs;
            }
            setRoomTimer(room.code, nextMs, g._activeTimerFn, { updateDurationSec: false });
          }
        }
      }
      return res;
    },
    hunterShoot: (room, id, targetId) => handleHunterShoot(room, id, targetId),
    voteExtendDiscussion: (room, id, wantExtend) => {
      const result = GE.voteExtendDiscussion(room, id, wantExtend);
      if (result.extended) rescheduleDiscussIfExtended(room, true);
      return result;
    },
    voteSkipDiscussion: (room, playerId) => GE.voteSkipDiscussion(room, playerId),
    forceEndDiscussion: (room) => { beginNomination(room); },
    nominationVote: (room, id, targetId) => {
      const res = GE.nominationVote(room, id, targetId);
      if (res.ok) checkUniversalDayVoteConsensus(room);
      return res;
    },
    finalVote: (room, id, decision) => {
      const res = GE.finalVote(room, id, decision);
      if (res.ok) checkUniversalDayVoteConsensus(room);
      return res;
    },
    recordReplayEvent: (room, evt) => GE.recordReplayEvent(room, evt),
    clearRoomTimer,
  };
}
