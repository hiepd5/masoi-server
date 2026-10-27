import * as GE from "./gameEngine.js";
import { publicRoomView, getRoom, addBotsToRoom } from "./rooms.js";
import {
  warmRoomOpeningVoices,
  warmCupidLoversVoices,
  warmStoryTimelineProgressively,
  warmEndGameFinaleVoice,
  warmPhrasesInBackground,
} from "./storyVoiceEngine.js";

// timers: Map<roomCode, Timeout>
const timers = new Map();

function clearRoomTimer(code) {
  if (timers.has(code)) {
    clearTimeout(timers.get(code));
    timers.delete(code);
  }
}

function setRoomTimer(code, ms, fn) {
  clearRoomTimer(code);
  const room = getRoom(code);
  if (room && room.game) {
    room.game.phaseEndsAt = Date.now() + ms;
  }

  const t = setTimeout(() => {
    timers.delete(code);
    // BUG 3 FIX: luôn dùng fresh room, không dùng closure cũ
    const freshRoom = getRoom(code);
    if (!freshRoom || !freshRoom.game || freshRoom.game.winner) return;
    // BUG L FIX: try/catch để ngăn uncaught exception crash server
    try {
      fn(freshRoom);
    } catch (err) {
      console.error(`[Timer Error] room=${code} fn=${fn.name}:`, err);
    }
  }, ms);
  t.unref?.();
  timers.set(code, t);
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
    // PHẢI dùng p.socketId (socket hiện tại sau reconnect), KHÔNG dùng p.id (socket cũ có thể đã chết)
    room.players.forEach((p) => {
      if (p.connected && p.socketId) {
        io.to(p.socketId).emit("room:update", publicRoomView(room, p.socketId));
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

  function announce(room, message) {
    if (
      message &&
      (message.includes("AI Bot") ||
        room?.players?.some((p) => p?.name && message.includes(p.name)))
    ) {
      warmPhrasesInBackground([message], "urgent");
    }
    io.to(room.code).emit("mc:message", message);
  }

  // ============ BẮT ĐẦU GAME (HỖ TRỢ CẢ ĐỦ NGƯỜI LẪN CHƠI 1 MÌNH TỰ BÙ AI BOT) ============
  function startGame(room) {
    const humanPlayers = room.players.filter((p) => !p.isBot);
    if (humanPlayers.length < 1) {
      return { error: "Cần ít nhất 1 người chơi thật để bắt đầu." };
    }

    // Kiểm tra người chơi thật đã sẵn sàng
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

    // Tự động bù Official AI Bot nếu người chơi muốn vào test ngay mà chưa đủ ghế khớp tổng vai!
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

    // [LOCAL DEV ONLY] Áp dụng vai trò ép trước từ DevSandbox (hoán đổi giữ nguyên tổng vai)
    if (!process.env.RENDER && process.env.NODE_ENV !== "production" && room.devForcedRoles) {
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
    warmRoomOpeningVoices(room, GE.TIMERS.defense, autoAddedBots);
    if (autoAddedBots > 0) {
      announce(
        room,
        `🤖 Đã tự động triệu hồi thêm ${autoAddedBots} AI Bot lấp đủ ${room.players.length} ghế. Trò chơi bắt đầu!`
      );
    } else {
      announce(room, `Trò chơi bắt đầu với ${room.players.length} người chơi. Đêm đầu tiên buông xuống...`);
    }

    if (room.game.phase === "night_cupid") {
      const tIntro = setTimeout(() => {
        const r = getRoom(room.code);
        if (r && r.game && !r.game.winner && r.game.phase === "night_cupid") {
          announce(r, "💘 Thần Tình Yêu ơi, thức dậy! Hãy chọn 2 người để kết duyên sinh tử.");
        }
      }, 2200);
      tIntro.unref?.();
      setRoomTimer(room.code, GE.TIMERS.cupid * 1000, advanceFromCupid);
    } else {
      const tIntro = setTimeout(() => {
        const r = getRoom(room.code);
        if (r && r.game && !r.game.winner) announce(r, "Bảo Vệ ơi, thức dậy! Hãy chọn người bạn muốn bảo vệ đêm nay.");
      }, 2500);
      tIntro.unref?.();
      setRoomTimer(room.code, GE.TIMERS.guard * 1000, advanceFromGuard);
    }
    broadcast(room);
    notifyRoomList(room);
    return { ok: true, autoAddedBots };
  }

  // ============ ĐÊM 1: THẦN TÌNH YÊU ============
  function advanceFromCupid(room) {
    GE.endCupidPhase(room);
    warmCupidLoversVoices(room);
    announce(room, "Thần Tình Yêu đã ngủ lại. Bảo Vệ ơi, hãy thức dậy và chọn người bảo vệ...");
    setRoomTimer(room.code, GE.TIMERS.guard * 1000, advanceFromGuard);
    broadcast(room);
  }

  // ============ ĐÊM: BẢO VỆ ============
  function advanceFromGuard(room) {
    GE.endGuardPhase(room);
    warmStoryTimelineProgressively(room);
    announce(room, "Bảo Vệ đã ngủ lại. Sói ơi, hãy thức dậy và chọn con mồi...");
    setRoomTimer(room.code, GE.TIMERS.wolf * 1000, advanceFromWolf);
    broadcast(room);
  }

  // ============ ĐÊM: SÓI ============
  function advanceFromWolf(room) {
    GE.endWolfPhase(room);
    warmStoryTimelineProgressively(room);
    announce(room, "Sói đã ngủ lại. Phù Thủy ơi, hãy thức dậy...");
    setRoomTimer(room.code, GE.TIMERS.witch * 1000, advanceFromWitch);
    broadcast(room);
  }

  // ============ ĐÊM: PHÙ THỦY ============
  function advanceFromWitch(room) {
    GE.endWitchPhase(room);
    warmStoryTimelineProgressively(room);
    announce(room, "Phù Thủy đã ngủ lại. Tiên Tri ơi, hãy thức dậy và soi một người...");
    setRoomTimer(room.code, GE.TIMERS.seer * 1000, advanceFromSeer);
    broadcast(room);
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

    // Nếu trong số người chết có Thợ Săn chưa bắn -> mở 15s Hơi Thở Cuối trước khi xét thắng thua!
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

    setRoomTimer(room.code, 5000, beginDiscussion);
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
        g.finalVoteEndsAt = Date.now() + GE.TIMERS.finalVote * 1000;
        setRoomTimer(room.code, GE.TIMERS.finalVote * 1000, finishFinalVoteTurn);
        broadcast(room);
      } else {
        goToNextNight(room);
      }
    } else {
      setRoomTimer(room.code, 4000, beginDiscussion);
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
    resumeAfterHunterRevenge(room, res.returnContext);
    return res;
  }

  // ============ NGÀY: THẢO LUẬN ============
  function beginDiscussion(room) {
    GE.startDiscussion(room);
    announce(room, `☀️ Cả làng thảo luận trong ${GE.TIMERS.dayDiscuss} giây. Nếu tất cả đồng ý bỏ qua có thể kết thúc sớm.`);
    scheduleDiscussEnd(room);
    broadcast(room);
  }

  function scheduleDiscussEnd(room) {
    const g = room.game;
    const msLeft = g.discussEndsAt - Date.now();
    setRoomTimer(room.code, Math.max(0, msLeft), beginNomination);
  }

  // gọi khi có gia hạn để reset lại timer theo thời gian mới
  function rescheduleDiscussIfExtended(room, extended) {
    if (extended) scheduleDiscussEnd(room);
  }

  // ============ NGÀY: ĐỀ CỬ ============
  function beginNomination(room) {
    GE.startNomination(room);
    announce(room, "Hết giờ thảo luận. Mời cả làng đề cử người nghi ngờ.");
    setRoomTimer(room.code, 30000, finalizeNominationPhase);
    broadcast(room);
  }

  function finalizeNominationPhase(room) {
    const { nominees } = GE.finalizeNomination(room);
    warmStoryTimelineProgressively(room);
    if (nominees.length === 0) {
      announce(room, "Không ai bị đề cử. Đêm mới lại đến...");
      return goToNextNight(room);
    }
    // BUG B FIX: Announce TẤT CẢ người bị đề cử, sau đó announce rõ ai biện hộ đầu tiên
    const allNames = nominees.map((n) => room.players.find((p) => p.id === n.playerId)?.name).join(", ");
    announce(room, `${allNames} bị đề cử nhiều nhất. Mời lần lượt lên biện hộ.`);
    // Gọi finishDefenseTurn ngay để advance sang defendant đầu tiên (index -1 → 0)
    finishDefenseTurn(room);
  }

  function finishDefenseTurn(room) {
    const result = GE.nextDefenseOrFinalVote(room);
    if (result.phase === "day_defense") {
      // BUG B FIX: Announce tên người đang biện hộ để client hiển thị đúng
      const defendantPlayer = room.players.find((p) => p.id === result.currentDefendantId);
      const name = defendantPlayer?.name;
      // Nếu bị cáo là AI Bot -> rút ngắn biện hộ xuống 8s để người chơi test 1 mình không phải đợi 60s!
      const defenseSec = defendantPlayer?.isBot ? 8 : GE.TIMERS.defense;
      if (defendantPlayer?.isBot && room.game) {
        room.game.hotSeatEndsAt = Date.now() + defenseSec * 1000;
      }
      announce(room, `🎤 Mời ${name || "người tiếp theo"} lên biện hộ. (${defenseSec} giây)`);
      setRoomTimer(room.code, defenseSec * 1000, finishDefenseTurn);
    } else {
      // phase = day_final_vote, hotSeatIndex = 0 → defendant đầu tiên
      const defendant = room.players.find((p) => p.id === result.currentDefendantId);
      announce(room, `⚖️ Mời cả làng vote cho ${defendant?.name || "bị cáo đầu tiên"}: Treo cổ hay Tha.`);
      setRoomTimer(room.code, GE.TIMERS.finalVote * 1000, finishFinalVoteTurn);
    }
    broadcast(room);
  }

  // BUG 1 FIX: Không double-increment hotSeatIndex. Logic đúng:
  // resolveFinalVote dùng hotSeatIndex hiện tại, sau đó tăng index để sang người tiếp theo.
  function finishFinalVoteTurn(room) {
    const g = room.game;
    const result = GE.resolveFinalVote(room); // xử lý hotSeatQueue[hotSeatIndex]
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

    // Tăng index để sang defendant tiếp theo (nếu có)
    g.hotSeatIndex += 1;
    g.finalVotes = {};

    if (g.hotSeatIndex < g.hotSeatQueue.length) {
      // Còn người nữa trong queue — vote tiếp
      const nextDefendant = room.players.find((p) => p.id === g.hotSeatQueue[g.hotSeatIndex]);
      announce(room, `Tiếp theo: Mời cả làng vote cho ${nextDefendant?.name || "bị cáo tiếp theo"}: Treo cổ hay Tha.`);
      g.finalVoteEndsAt = Date.now() + GE.TIMERS.finalVote * 1000;
      setRoomTimer(room.code, GE.TIMERS.finalVote * 1000, finishFinalVoteTurn);
      broadcast(room);
    } else {
      // Hết queue — sang đêm mới
      goToNextNight(room);
    }
  }

  function goToNextNight(room) {
    GE.startNextNight(room);
    announce(room, `Đêm thứ ${room.game.dayNumber} bắt đầu. Bảo Vệ ơi, hãy thức dậy...`);
    setRoomTimer(room.code, GE.TIMERS.guard * 1000, advanceFromGuard);
    broadcast(room);
    notifyRoomList(room);
  }

  function endGame(room, winner) {
    room.phase = "ended";
    room.game.winner = winner;
    room.game.awards = GE.computeMatchAwards(room);
    warmEndGameFinaleVoice(room);
    clearRoomTimer(room.code);
    if (room.devBotTimer) {
      clearTimeout(room.devBotTimer);
      room.devBotTimer = null;
    }
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
    if (p === "night_cupid") advanceFromCupid(room);
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

  // ============ EXPORT HANDLERS CHO index.js ============
  return {
    startGame,
    broadcast,
    announce,
    setPhaseHook: (fn) => { phaseHook = fn; },
    setRoomListHook: (fn) => { roomListHook = fn; },
    advanceCurrentPhase,
    cupidLink: (room, id, targetIds) => {
      const res = GE.cupidLink(room, id, targetIds);
      if (res.ok) warmCupidLoversVoices(room);
      if (res.ok && room.game.phase === "night_cupid") {
        clearRoomTimer(room.code);
        const t = setTimeout(() => {
          const r = getRoom(room.code);
          if (r && r.game && r.game.phase === "night_cupid") advanceFromCupid(r);
        }, 1400);
        t.unref?.();
      }
      return res;
    },
    guardProtect: (room, id, targetId) => GE.guardProtect(room, id, targetId),
    wolfPick: (room, id, targetId) => GE.wolfPick(room, id, targetId),
    wolfAlphaToggle: (room, id, enabled) => GE.wolfAlphaToggle(room, id, enabled),
    witchDecide: (room, id, payload) => GE.witchDecide(room, id, payload),
    seerCheck: (room, id, targetId) => GE.seerCheck(room, id, targetId),
    mayorReveal: (room, id) => {
      const res = GE.mayorReveal(room, id);
      if (res.ok) {
        warmStoryTimelineProgressively(room);
        const mayor = room.players.find((p) => p.id === id);
        announce(
          room,
          `👑 ${mayor?.name || "Trưởng Làng"} giơ cao Quyền Trượng Vàng công bố thân phận Trưởng Làng — lá phiếu từ nay tính x2!`
        );
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
    nominationVote: (room, id, targetId) => GE.nominationVote(room, id, targetId),
    finalVote: (room, id, decision) => GE.finalVote(room, id, decision),
    recordReplayEvent: (room, evt) => GE.recordReplayEvent(room, evt),
    clearRoomTimer,
  };
}
