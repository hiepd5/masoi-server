import { assignRoles } from "./roles.js";

// ============ HẰNG SỐ THỜI GIAN (giây) ============
export const TIMERS = {
  guard: 20,
  wolf: 30,
  witch: 25,
  seer: 20,
  dayDiscuss: 180, // 3 phút mặc định
  dayDiscussExtend: 120, // +2 phút mỗi lần gia hạn
  defense: 60,
  finalVote: 30,
};

// ============ TẠO GAME STATE MỚI TỪ ROOM ============
export function initGameState(room) {
  const alivePlayerIds = room.players.map((p) => p.id);
  const { assignment, counts } = assignRoles(alivePlayerIds);

  room.players.forEach((p) => {
    p.role = assignment.get(p.id);
    p.alive = true;
  });

  room.game = {
    dayNumber: 1,
    phase: "night_guard", // xem danh sách phase bên dưới
    gameStartedAt: Date.now(), // Thời gian bắt đầu ván đấu
    phaseEndsAt: null, // Thời gian kết thúc phase hiện tại
    roleCounts: counts,

    // Lịch sử bảo vệ để check "không trùng 2 đêm liên tiếp"
    lastGuardedId: null,
    guardedIdTonight: null,

    wolfPicks: {}, // { wolfPlayerId: { targetId, timestamp } }
    wolfVictimId: null, // kết quả cuối cùng đêm nay (trước khi phù thủy can thiệp)

    witchUsedSave: false,
    witchUsedPoison: false,
    witchSaveTonight: false,
    witchPoisonTargetId: null,

    seerChecksLog: [], // { seerId, targetId, dayNumber, result }

    nightDeaths: [], // playerId chết đêm qua (để công bố)

    // Thảo luận ban ngày
    discussEndsAt: null,
    extendVotes: {}, // { playerId: true/false }

    // Đề cử
    nominationVotes: {}, // { voterId: targetId }
    nominees: [], // [{ playerId, votesReceived, reachedAt }] danh sách người đạt đủ để lên ghế nóng
    hotSeatQueue: [], // thứ tự biện hộ
    hotSeatIndex: 0,
    hotSeatEndsAt: null,

    // Vote chốt sống chết
    finalVotes: {}, // { voterId: 'hang' | 'spare' }
    finalVoteEndsAt: null,

    winner: null, // 'wolf' | 'village' | 'tanner' | null

    // Lịch sử hành động cho Recap
    history: [], // [{ type, day, sourceId, targetId, text }]
  };

  return room;
}

// ============ HELPER ============
function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function aliveByRole(room, role) {
  return alivePlayers(room).filter((p) => p.role === role);
}

function getPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

// ============ ĐÊM: BẢO VỆ ============
export function guardProtect(room, guardId, targetId) {
  const g = room.game;
  const guard = getPlayer(room, guardId);
  if (!guard || guard.role !== "guard" || !guard.alive) {
    return { error: "Bạn không phải Bảo Vệ hoặc đã chết." };
  }
  if (g.phase !== "night_guard") return { error: "Không phải lượt Bảo Vệ." };
  if (targetId === g.lastGuardedId) {
    return { error: "Không thể bảo vệ trùng người vừa bảo vệ đêm trước." };
  }
  g.guardedIdTonight = targetId;
  return { ok: true };
}

export function endGuardPhase(room) {
  const g = room.game;
  if (g.guardedIdTonight) {
    const guardId = room.players.find(p => p.role === "guard")?.id;
    const targetName = getPlayer(room, g.guardedIdTonight)?.name;
    g.history.push({
      type: "guard",
      day: g.dayNumber,
      sourceId: guardId,
      targetId: g.guardedIdTonight,
      text: `Bảo vệ đã bảo vệ ${targetName} đêm nay.`
    });
  } else {
    g.history.push({
      type: "guard",
      day: g.dayNumber,
      text: "Đêm nay Bảo vệ không bảo vệ ai."
    });
  }
  g.lastGuardedId = g.guardedIdTonight; // cập nhật lịch sử cho đêm sau
  g.phase = "night_wolf";
  g.wolfPicks = {};
}

// ============ ĐÊM: SÓI ============
export function wolfPick(room, wolfId, targetId) {
  const g = room.game;
  const wolf = getPlayer(room, wolfId);
  if (!wolf || wolf.role !== "wolf" || !wolf.alive) {
    return { error: "Bạn không phải Sói hoặc đã chết." };
  }
  if (g.phase !== "night_wolf") return { error: "Không phải lượt Sói." };
  g.wolfPicks[wolfId] = { targetId, timestamp: Date.now() };
  return { ok: true };
}

// Quyết định nạn nhân theo luật: cùng chọn 1 người -> giết người đó
// Chọn khác nhau -> giết người được pick SỚM NHẤT (theo timestamp đầu tiên mỗi mục tiêu được chọn)
export function resolveWolfVictim(room) {
  const g = room.game;
  const picks = Object.values(g.wolfPicks);
  const aliveWolves = aliveByRole(room, "wolf");

  if (picks.length === 0) {
    g.wolfVictimId = null; // không ai cắn
    return null;
  }

  const targetCounts = {};
  picks.forEach((p) => {
    targetCounts[p.targetId] = (targetCounts[p.targetId] || 0) + 1;
  });

  const allSameTarget =
    Object.keys(targetCounts).length === 1 && picks.length === aliveWolves.length;

  if (allSameTarget) {
    g.wolfVictimId = picks[0].targetId;
  } else {
    // khác nhau -> người được pick sớm nhất (timestamp nhỏ nhất) trên toàn bộ picks
    const earliest = picks.reduce((min, p) => (p.timestamp < min.timestamp ? p : min));
    g.wolfVictimId = earliest.targetId;
  }

  return g.wolfVictimId;
}

export function endWolfPhase(room) {
  resolveWolfVictim(room);
  const g = room.game;
  if (g.wolfVictimId) {
    const targetName = getPlayer(room, g.wolfVictimId)?.name;
    g.history.push({
      type: "wolf",
      day: g.dayNumber,
      targetId: g.wolfVictimId,
      text: `Đàn sói đã thống nhất cắn ${targetName}.`
    });
  } else {
    g.history.push({
      type: "wolf",
      day: g.dayNumber,
      text: "Đêm nay đàn sói không cắn ai."
    });
  }
  room.game.phase = "night_witch";
}

// ============ ĐÊM: PHÙ THỦY ============
export function witchDecide(room, witchId, { save, poisonTargetId }) {
  const g = room.game;
  const witch = getPlayer(room, witchId);
  if (!witch || witch.role !== "witch" || !witch.alive) {
    return { error: "Bạn không phải Phù Thủy hoặc đã chết." };
  }
  if (g.phase !== "night_witch") return { error: "Không phải lượt Phù Thủy." };

  if (save) {
    if (g.witchUsedSave) return { error: "Bạn đã dùng bình cứu rồi." };
    if (!g.wolfVictimId) return { error: "Không có ai để cứu đêm nay." };
    g.witchSaveTonight = true;
    g.witchUsedSave = true;
  }

  if (poisonTargetId) {
    if (g.witchUsedPoison) return { error: "Bạn đã dùng bình độc rồi." };
    g.witchPoisonTargetId = poisonTargetId;
    g.witchUsedPoison = true;
  }

  return { ok: true };
}

export function endWitchPhase(room) {
  const g = room.game;
  if (g.witchSaveTonight) {
    const targetName = getPlayer(room, g.wolfVictimId)?.name;
    g.history.push({
      type: "witch_save",
      day: g.dayNumber,
      targetId: g.wolfVictimId,
      text: `Phù thủy đã dùng bình cứu để cứu ${targetName}.`
    });
  }
  if (g.witchPoisonTargetId) {
    const targetName = getPlayer(room, g.witchPoisonTargetId)?.name;
    g.history.push({
      type: "witch_poison",
      day: g.dayNumber,
      targetId: g.witchPoisonTargetId,
      text: `Phù thủy đã dùng bình độc để giết ${targetName}.`
    });
  }
  room.game.phase = "night_seer";
}

// ============ ĐÊM: TIÊN TRI ============
export function seerCheck(room, seerId, targetId) {
  const g = room.game;
  const seer = getPlayer(room, seerId);
  if (!seer || seer.role !== "seer" || !seer.alive) {
    return { error: "Bạn không phải Tiên Tri hoặc đã chết." };
  }
  if (g.phase !== "night_seer") return { error: "Không phải lượt Tiên Tri." };

  const target = getPlayer(room, targetId);
  const result = target?.role === "wolf" ? "wolf" : "not_wolf";
  g.seerChecksLog.push({ seerId, targetId, dayNumber: g.dayNumber, result });
  return { ok: true, result };
}

export function endSeerPhase(room) {
  const g = room.game;
  const lastCheck = g.seerChecksLog.filter(c => c.dayNumber === g.dayNumber).pop();
  if (lastCheck) {
    const targetName = getPlayer(room, lastCheck.targetId)?.name;
    const isWolf = lastCheck.result === "wolf";
    g.history.push({
      type: "seer",
      day: g.dayNumber,
      sourceId: lastCheck.seerId,
      targetId: lastCheck.targetId,
      text: `Tiên tri đã soi ${targetName} và phát hiện đây là ${isWolf ? 'Sói' : 'Dân'}.`
    });
  } else {
    g.history.push({
      type: "seer",
      day: g.dayNumber,
      text: "Đêm nay Tiên tri không soi ai."
    });
  }
  room.game.phase = "night_resolve";
}

// ============ TÍNH TOÁN NGƯỜI CHẾT CUỐI ĐÊM ============
export function resolveNightDeaths(room) {
  const g = room.game;
  const deaths = new Set();

  const victimSaved =
    g.wolfVictimId && (g.wolfVictimId === g.guardedIdTonight || g.witchSaveTonight);

  if (g.wolfVictimId && !victimSaved) {
    deaths.add(g.wolfVictimId);
  }

  if (g.witchPoisonTargetId) {
    deaths.add(g.witchPoisonTargetId);
  }

  deaths.forEach((id) => {
    const p = getPlayer(room, id);
    if (p) p.alive = false;
  });

  g.nightDeaths = Array.from(deaths);
  g.phase = "day_reveal";

  return g.nightDeaths;
}

// ============ BAN NGÀY: THẢO LUẬN CÓ GIA HẠN ============
export function startDiscussion(room) {
  const g = room.game;
  g.phase = "day_discuss";
  g.discussEndsAt = Date.now() + TIMERS.dayDiscuss * 1000;
  g.extendVotes = {};
}

export function voteExtendDiscussion(room, playerId, wantExtend) {
  const g = room.game;
  if (g.phase !== "day_discuss") return { error: "Không phải lúc thảo luận." };
  g.extendVotes[playerId] = wantExtend;

  const votes = Object.values(g.extendVotes);
  const yes = votes.filter((v) => v === true).length;
  const no = votes.filter((v) => v === false).length;

  if (yes > no && yes + no >= Math.ceil(alivePlayers(room).length / 2)) {
    g.discussEndsAt += TIMERS.dayDiscussExtend * 1000;
    g.extendVotes = {}; // reset để có thể gia hạn tiếp lần sau
    return { ok: true, extended: true, newEndsAt: g.discussEndsAt };
  }
  return { ok: true, extended: false };
}

// ============ BAN NGÀY: ĐỀ CỬ (VOTE CÔNG KHAI) ============
export function startNomination(room) {
  const g = room.game;
  g.phase = "day_nominate";
  g.nominationVotes = {};
  g.nominees = [];
  g.hotSeatQueue = [];
  g.hotSeatIndex = 0;
}

// Ngưỡng để 1 người "lên ghế nóng": có nhiều phiếu nhất, xử lý hòa = cả 2 lên ghế
export function nominationVote(room, voterId, targetId) {
  const g = room.game;
  if (g.phase !== "day_nominate") return { error: "Không phải lúc đề cử." };
  const voter = getPlayer(room, voterId);
  if (!voter?.alive) return { error: "Bạn đã chết, không thể vote." };

  g.nominationVotes[voterId] = { targetId, timestamp: Date.now() };
  return { ok: true };
}

// Gọi khi hết giờ đề cử -> tính người lên ghế nóng
export function finalizeNomination(room) {
  const g = room.game;
  const votes = Object.values(g.nominationVotes);

  if (votes.length === 0) {
    g.phase = "day_no_nomination";
    return { nominees: [] };
  }

  const tally = {}; // targetId -> { count, earliestTimestamp }
  votes.forEach((v) => {
    if (!tally[v.targetId]) {
      tally[v.targetId] = { count: 0, earliestTimestamp: v.timestamp };
    }
    tally[v.targetId].count += 1;
    tally[v.targetId].earliestTimestamp = Math.min(
      tally[v.targetId].earliestTimestamp,
      v.timestamp
    );
  });

  const maxVotes = Math.max(...Object.values(tally).map((t) => t.count));
  const topCandidates = Object.entries(tally)
    .filter(([, t]) => t.count === maxVotes)
    .map(([playerId, t]) => ({ playerId, votes: t.count, reachedAt: t.earliestTimestamp }))
    .sort((a, b) => a.reachedAt - b.reachedAt); // ai đạt đủ phiếu sớm hơn -> lên ghế trước

  g.nominees = topCandidates;
  g.hotSeatQueue = topCandidates.map((c) => c.playerId);
  g.hotSeatIndex = 0;
  g.phase = "day_defense";
  g.hotSeatEndsAt = Date.now() + TIMERS.defense * 1000;

  return { nominees: topCandidates };
}

export function nextDefenseOrFinalVote(room) {
  const g = room.game;
  g.hotSeatIndex += 1;
  if (g.hotSeatIndex < g.hotSeatQueue.length) {
    g.hotSeatEndsAt = Date.now() + TIMERS.defense * 1000;
    return { phase: "day_defense", currentDefendantId: g.hotSeatQueue[g.hotSeatIndex] };
  }
  // hết lượt biện hộ -> chuyển sang vote chốt cho từng người theo thứ tự
  g.phase = "day_final_vote";
  g.finalVotes = {};
  g.hotSeatIndex = 0;
  g.finalVoteEndsAt = Date.now() + TIMERS.finalVote * 1000;
  return { phase: "day_final_vote", currentDefendantId: g.hotSeatQueue[0] };
}

// ============ BAN NGÀY: VOTE CHỐT SỐNG/CHẾT ============
export function finalVote(room, voterId, decision) {
  const g = room.game;
  if (g.phase !== "day_final_vote") return { error: "Không phải lúc vote." };
  const voter = getPlayer(room, voterId);
  if (!voter?.alive) return { error: "Bạn đã chết, không thể vote." };
  if (!["hang", "spare"].includes(decision)) return { error: "Lựa chọn không hợp lệ." };

  g.finalVotes[voterId] = decision;
  return { ok: true };
}

// Xử lý kết quả cho người đang trên ghế nóng hiện tại
export function resolveFinalVote(room) {
  const g = room.game;
  const defendantId = g.hotSeatQueue[g.hotSeatIndex];
  const votes = Object.values(g.finalVotes);
  const hangCount = votes.filter((v) => v === "hang").length;
  const spareCount = votes.filter((v) => v === "spare").length;

  const hanged = hangCount > spareCount;
  let tannerWin = false;

  if (hanged) {
    const defendant = getPlayer(room, defendantId);
    if (defendant) {
      defendant.alive = false;
      g.history.push({
        type: "hang",
        day: g.dayNumber,
        targetId: defendantId,
        text: `${defendant.name} đã bị treo cổ với ${hangCount} phiếu thuận.`
      });
      if (defendant.role === "tanner") {
        tannerWin = true;
        g.winner = "tanner";
      }
    }
  } else {
    const defendant = getPlayer(room, defendantId);
    if (defendant) {
      g.history.push({
        type: "spare",
        day: g.dayNumber,
        targetId: defendantId,
        text: `${defendant.name} đã được tha bổng với ${spareCount} phiếu tha.`
      });
    }
  }

  return { defendantId, hanged, hangCount, spareCount, tannerWin };
}

// ============ KIỂM TRA ĐIỀU KIỆN THẮNG ============
export function checkWinCondition(room) {
  const g = room.game;
  if (g.winner) return g.winner; // Chán Đời đã thắng trước đó

  const aliveWolves = aliveByRole(room, "wolf").length;
  const aliveOthers = alivePlayers(room).length - aliveWolves;

  if (aliveWolves === 0) {
    g.winner = "village";
    return "village";
  }
  if (aliveWolves >= aliveOthers) {
    g.winner = "wolf";
    return "wolf";
  }
  return null;
}

// ============ CHUYỂN SANG ĐÊM TIẾP THEO ============
export function startNextNight(room) {
  const g = room.game;
  g.dayNumber += 1;
  g.phase = "night_guard";
  g.guardedIdTonight = null;
  g.wolfPicks = {};
  g.wolfVictimId = null;
  g.witchSaveTonight = false;
  g.witchPoisonTargetId = null;
  g.nightDeaths = [];
}
