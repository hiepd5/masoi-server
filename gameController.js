import * as GE from "./gameEngine.js";
import { publicRoomView, getRoom } from "./rooms.js";

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
  
  timers.set(
    code,
    setTimeout(() => {
      timers.delete(code);
      fn();
    }, ms)
  );
}

export function createGameController(io) {
  function broadcast(room) {
    room.players.forEach((p) => {
      io.to(p.id).emit("room:update", publicRoomView(room, p.id));
    });
  }

  function announce(room, message) {
    io.to(room.code).emit("mc:message", message);
  }

  // ============ BẮT ĐẦU GAME ============
  function startGame(room) {
    if (room.players.length < 6) return { error: "Cần tối thiểu 6 người." };
    GE.initGameState(room);
    room.phase = "playing";
    announce(room, `Trò chơi bắt đầu với ${room.players.length} người chơi. Đêm đầu tiên buông xuống...`);
    setRoomTimer(room.code, GE.TIMERS.guard * 1000, () => advanceFromGuard(room));
    broadcast(room);
    return { ok: true };
  }

  // ============ ĐÊM: BẢO VỆ ============
  function advanceFromGuard(room) {
    GE.endGuardPhase(room);
    announce(room, "Bảo Vệ đã ngủ lại. Sói ơi, hãy thức dậy và chọn con mồi...");
    setRoomTimer(room.code, GE.TIMERS.wolf * 1000, () => advanceFromWolf(room));
    broadcast(room);
  }

  // ============ ĐÊM: SÓI ============
  function advanceFromWolf(room) {
    GE.endWolfPhase(room);
    announce(room, "Sói đã ngủ lại. Phù Thủy ơi, hãy thức dậy...");
    setRoomTimer(room.code, GE.TIMERS.witch * 1000, () => advanceFromWitch(room));
    broadcast(room);
  }

  // ============ ĐÊM: PHÙ THỦY ============
  function advanceFromWitch(room) {
    GE.endWitchPhase(room);
    announce(room, "Phù Thủy đã ngủ lại. Tiên Tri ơi, hãy thức dậy và soi một người...");
    setRoomTimer(room.code, GE.TIMERS.seer * 1000, () => advanceFromSeer(room));
    broadcast(room);
  }

  // ============ ĐÊM: TIÊN TRI -> RESOLVE ============
  function advanceFromSeer(room) {
    GE.endSeerPhase(room);
    const deaths = GE.resolveNightDeaths(room);
    if (deaths.length === 0) {
      announce(room, "Trời đã sáng. Đêm qua không ai chết.");
    } else {
      const names = deaths.map((id) => room.players.find((p) => p.id === id)?.name).join(", ");
      announce(room, `Trời đã sáng. Đêm qua ${names} đã không qua khỏi.`);
    }
    const winner = GE.checkWinCondition(room);
    if (winner) return endGame(room, winner);

    setRoomTimer(room.code, 5000, () => beginDiscussion(room));
    broadcast(room);
  }

  // ============ NGÀY: THẢO LUẬN ============
  function beginDiscussion(room) {
    GE.startDiscussion(room);
    announce(room, "Cả làng thảo luận. Thời gian mặc định 3 phút.");
    scheduleDiscussEnd(room);
    broadcast(room);
  }

  function scheduleDiscussEnd(room) {
    const g = room.game;
    const msLeft = g.discussEndsAt - Date.now();
    setRoomTimer(room.code, Math.max(0, msLeft), () => beginNomination(room));
  }

  // gọi khi có gia hạn để reset lại timer theo thời gian mới
  function rescheduleDiscussIfExtended(room, extended) {
    if (extended) scheduleDiscussEnd(room);
  }

  // ============ NGÀY: ĐỀ CỬ ============
  function beginNomination(room) {
    GE.startNomination(room);
    announce(room, "Hết giờ thảo luận. Mời cả làng đề cử người nghi ngờ.");
    setRoomTimer(room.code, 30000, () => finalizeNominationPhase(room));
    broadcast(room);
  }

  function finalizeNominationPhase(room) {
    const { nominees } = GE.finalizeNomination(room);
    if (nominees.length === 0) {
      announce(room, "Không ai bị đề cử. Đêm mới lại đến...");
      return goToNextNight(room);
    }
    const names = nominees.map((n) => room.players.find((p) => p.id === n.playerId)?.name).join(", ");
    announce(room, `${names} bị đề cử nhiều nhất. Mời lần lượt lên biện hộ.`);
    setRoomTimer(room.code, GE.TIMERS.defense * 1000, () => finishDefenseTurn(room));
    broadcast(room);
  }

  function finishDefenseTurn(room) {
    const result = GE.nextDefenseOrFinalVote(room);
    if (result.phase === "day_defense") {
      setRoomTimer(room.code, GE.TIMERS.defense * 1000, () => finishDefenseTurn(room));
    } else {
      announce(room, "Mời cả làng vote: Treo cổ hay Tha.");
      setRoomTimer(room.code, GE.TIMERS.finalVote * 1000, () => finishFinalVoteTurn(room));
    }
    broadcast(room);
  }

  function finishFinalVoteTurn(room) {
    const g = room.game;
    const result = GE.resolveFinalVote(room);
    const defendant = room.players.find((p) => p.id === result.defendantId);

    if (result.hanged) {
      announce(
        room,
        `${defendant?.name} bị treo cổ với ${result.hangCount} phiếu thuận / ${result.spareCount} phiếu tha.`
      );
    } else {
      announce(
        room,
        `${defendant?.name} được tha với ${result.spareCount} phiếu tha / ${result.hangCount} phiếu thuận.`
      );
    }

    if (result.tannerWin) {
      return endGame(room, "tanner", defendant?.id);
    }

    const winner = GE.checkWinCondition(room);
    if (winner) return endGame(room, winner);

    g.hotSeatIndex += 1;
    g.finalVotes = {};
    if (g.hotSeatIndex < g.hotSeatQueue.length) {
      setRoomTimer(room.code, GE.TIMERS.finalVote * 1000, () => finishFinalVoteTurn(room));
      broadcast(room);
    } else {
      goToNextNight(room);
    }
  }

  function goToNextNight(room) {
    GE.startNextNight(room);
    announce(room, `Đêm thứ ${room.game.dayNumber} bắt đầu. Bảo Vệ ơi, hãy thức dậy...`);
    setRoomTimer(room.code, GE.TIMERS.guard * 1000, () => advanceFromGuard(room));
    broadcast(room);
  }

  function endGame(room, winner, tannerWinnerId) {
    room.phase = "ended";
    room.game.winner = winner;
    clearRoomTimer(room.code);
    const label =
      winner === "wolf" ? "Phe Sói" : winner === "village" ? "Phe Dân" : "Chán Đời (thắng riêng)";
    announce(room, `Trò chơi kết thúc! ${label} chiến thắng.`);
    broadcast(room);
  }

  // ============ EXPORT HANDLERS CHO index.js ============
  return {
    startGame,
    broadcast,
    announce,
    guardProtect: (room, id, targetId) => GE.guardProtect(room, id, targetId),
    wolfPick: (room, id, targetId) => GE.wolfPick(room, id, targetId),
    witchDecide: (room, id, payload) => GE.witchDecide(room, id, payload),
    seerCheck: (room, id, targetId) => GE.seerCheck(room, id, targetId),
    voteExtendDiscussion: (room, id, wantExtend) => {
      const result = GE.voteExtendDiscussion(room, id, wantExtend);
      if (result.extended) rescheduleDiscussIfExtended(room, true);
      return result;
    },
    nominationVote: (room, id, targetId) => GE.nominationVote(room, id, targetId),
    finalVote: (room, id, decision) => GE.finalVote(room, id, decision),
    clearRoomTimer,
  };
}
