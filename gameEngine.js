import { assignCustomRoles, isWolfTeamRole, ROLE_LABELS } from "./roles.js";
import { warmStoryTimelineProgressively } from "./storyVoiceEngine.js";

// ============ HẰNG SỐ THỜI GIAN (giây) ============
export const TIMERS = {
  cupid: 20,
  guard: 20,
  wolf: 30,
  witch: 25,
  seer: 20,
  hunterRevenge: 15,
  dayDiscuss: 180, // 3 phút mặc định
  dayDiscussExtend: 120, // +2 phút mỗi lần gia hạn
  defense: 60,
  finalVote: 30,
};

// ============ TẠO GAME STATE MỚI TỪ ROOM ============
export function initGameState(room) {
  const alivePlayerIds = room.players.map((p) => p.id);
  const { assignment, counts } = assignCustomRoles(alivePlayerIds, room.rolesConfig);

  room.players.forEach((p, idx) => {
    const assignedRole = assignment.get(p.id);
    p.role = assignedRole;
    p.initialRole = assignedRole;
    p.seatIndex = idx;
    p.alive = true;
  });

  const hasCupid = room.players.some((p) => p.role === "cupid" && p.alive);

  room.game = {
    dayNumber: 1,
    phase: hasCupid ? "night_cupid" : "night_guard", // Đêm 1 mở night_cupid nếu có Thần Tình Yêu
    gameStartedAt: Date.now(), // Thời gian bắt đầu ván đấu
    phaseEndsAt: null, // Thời gian kết thúc phase hiện tại
    roleCounts: counts,

    // Cặp đôi sinh tử do Cupid ghép ở Đêm 1: [playerIdA, playerIdB] | null
    lovers: null,

    // Lịch sử bảo vệ để check "không trùng 2 đêm liên tiếp"
    lastGuardedId: null,
    guardedIdTonight: null,

    wolfPicks: {}, // { wolfPlayerId: { targetId, timestamp } }
    wolfVictimId: null, // kết quả cuối cùng đêm nay (trước khi phù thủy can thiệp)

    // Kỹ năng Huyết Nguyệt Đồng Hóa của Sói Đầu Đàn (1 lần/ván)
    alphaUsedConvert: false,
    alphaConvertTonight: false,

    witchUsedSave: false,
    witchUsedPoison: false,
    witchSaveTonight: false,
    witchPoisonTargetId: null,

    seerChecksLog: [], // { seerId, targetId, dayNumber, result }

    nightDeaths: [], // playerId chết đêm qua (để công bố)

    // Trạng thái nhân vật đặc biệt
    toughGuyPoisonedDay: null, // Ngày Người Cứng Cỏi bị cắn (đêm sau mới chết)
    mayorRevealedId: null, // ID Trưởng Làng đã giơ Quyền Trượng công bố (phiếu x2)
    hunterUsedShot: false, // Thợ Săn đã bóp cò trả thù chưa
    hunterPendingId: null, // ID Thợ Săn vừa ngã xuống đang chờ bắn 15s
    hunterReturnContext: null, // 'dawn' | 'hang_queue'

    // Thảo luận ban ngày
    discussEndsAt: null,
    extendVotes: {}, // { playerId: true/false }
    skipDiscussVotes: {}, // { playerId: true } — tất cả đồng ý thì kết thúc sớm

    // Đề cử
    nominationVotes: {}, // { voterId: { targetId, timestamp } }
    nominees: [], // [{ playerId, votesReceived, reachedAt }] danh sách người đạt đủ để lên ghế nóng
    hotSeatQueue: [], // thứ tự biện hộ
    hotSeatIndex: 0,
    hotSeatEndsAt: null,

    // Vote chốt sống chết
    finalVotes: {}, // { voterId: 'hang' | 'spare' }
    finalVoteEndsAt: null,

    winner: null, // 'wolf' | 'village' | 'tanner' | 'lovers' | null

    // Lịch sử hành động cho Recap & Băng ghi hình không gian 3D (Zero-Leak khi đang chơi)
    history: [], // [{ type, day, sourceId, targetId, text }]
    replayTimeline: [], // [{ seq, ts, elapsedMs, day, phase, isNight, kind, actorId, actorRole, targetId, ... }]
    _replaySeq: 0,
  };

  return room;
}

// Đồng bộ lại phase mở màn Đêm 1 & roleCounts sau khi DevSandbox ép vai (hoặc test thủ công)
export function syncInitialRoleState(room) {
  const g = room?.game;
  if (!g) return;
  const counts = {};
  (room.players || []).forEach((p) => {
    if (p.role) counts[p.role] = (counts[p.role] || 0) + 1;
  });
  g.roleCounts = counts;
  if (g.dayNumber === 1 && (g.phase === "night_guard" || g.phase === "night_cupid")) {
    const hasCupid = room.players.some((p) => p.role === "cupid" && p.alive);
    g.phase = hasCupid ? "night_cupid" : "night_guard";
  }
}

// ============ MÁY QUAY SỰ THẬT NGẦM (SHADOW REALITY RECORDER) ============
const MILESTONE_REPLAY_KINDS = new Set([
  "cupid_link",
  "wolf_strike",
  "alpha_convert",
  "shield_block",
  "witch_save",
  "witch_poison",
  "seer_scan",
  "cursed_turn",
  "tough_endure",
  "lover_heartbreak",
  "hunter_shot",
  "mayor_reveal",
  "night_death",
  "day_defense",
  "day_verdict",
]);

export function recordReplayEvent(room, evt = {}) {
  const g = room?.game;
  if (!g) return null;
  if (!Array.isArray(g.replayTimeline)) g.replayTimeline = [];
  if (typeof g._replaySeq !== "number") g._replaySeq = g.replayTimeline.length;

  const now = Date.now();
  const phase = evt.phase || g.phase || "night_guard";
  const actor = evt.actorId ? getPlayer(room, evt.actorId) : null;
  const target = evt.targetId ? getPlayer(room, evt.targetId) : null;

  const frame = {
    seq: ++g._replaySeq,
    ts: now,
    elapsedMs: Math.max(0, now - (g.gameStartedAt || now)),
    day: g.dayNumber || 1,
    phase,
    isNight: String(phase).startsWith("night_"),
    kind: evt.kind || "event",
    actorId: evt.actorId || null,
    actorRole: evt.actorRole || actor?.initialRole || actor?.role || null,
    coActorIds: Array.isArray(evt.coActorIds) ? evt.coActorIds : [],
    targetId: evt.targetId || null,
    prevTargetId: evt.prevTargetId || null,
    targetRole: evt.targetRole || target?.initialRole || target?.role || null,
    chatText: evt.chatText ? String(evt.chatText).trim().slice(0, 120) : null,
    emoji: evt.emoji || null,
    decision: evt.decision || null,
    votesSnapshot: evt.votesSnapshot || null,
    aliveIds: (room.players || []).filter((p) => p.alive).map((p) => p.id),
    wolfIdsNow: (room.players || []).filter((p) => isWolfTeamRole(p.role)).map((p) => p.id),
    caption: evt.caption || "",
  };

  const last = g.replayTimeline[g.replayTimeline.length - 1];
  if (
    last &&
    !MILESTONE_REPLAY_KINDS.has(frame.kind) &&
    last.kind === frame.kind &&
    last.actorId === frame.actorId &&
    last.day === frame.day &&
    now - last.ts < 250
  ) {
    frame.seq = last.seq;
    frame.prevTargetId = last.prevTargetId || last.targetId || frame.prevTargetId;
    g.replayTimeline[g.replayTimeline.length - 1] = frame;
    return frame;
  }

  if (g.replayTimeline.length >= 260) {
    const dropIdx = g.replayTimeline.findIndex((item) => !MILESTONE_REPLAY_KINDS.has(item.kind));
    if (dropIdx >= 0) {
      g.replayTimeline.splice(dropIdx, 1);
    } else {
      g.replayTimeline.shift();
    }
  }

  g.replayTimeline.push(frame);
  if (MILESTONE_REPLAY_KINDS.has(frame.kind)) {
    warmStoryTimelineProgressively(room);
  }
  return frame;
}

// ============ HELPER ============
function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function aliveByRole(room, role) {
  return alivePlayers(room).filter((p) => p.role === role);
}

function aliveWolfTeam(room) {
  return alivePlayers(room).filter((p) => isWolfTeamRole(p.role));
}

function getPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

export function getVoterWeight(room, voterId) {
  return room?.game?.mayorRevealedId && room.game.mayorRevealedId === voterId ? 2 : 1;
}

// Kiểm tra Cặp Đôi do Cupid ghép có thuộc 2 chiến tuyến đối lập (Sói - Dân / Trung lập) hay không
export function isCrossTeamLovers(room) {
  const g = room?.game;
  if (!Array.isArray(g?.lovers) || g.lovers.length !== 2) return false;
  const pA = getPlayer(room, g.lovers[0]);
  const pB = getPlayer(room, g.lovers[1]);
  if (!pA || !pB) return false;
  const aWolf = isWolfTeamRole(pA.role);
  const bWolf = isWolfTeamRole(pB.role);
  if (aWolf !== bWolf) return true;
  if (pA.role === "tanner" || pB.role === "tanner") return true;
  return false;
}

// Dây chuyền Tình Nhân đứt ruột (chống lặp đệ quy 100% bằng Set)
function applyLoverCascade(room, initialDeadIds, phaseLabel = "day_reveal") {
  const g = room.game;
  const processed = new Set(initialDeadIds);
  const queue = [...initialDeadIds];
  const cascadedIds = [];

  while (queue.length > 0) {
    const deadId = queue.shift();
    if (!Array.isArray(g.lovers) || !g.lovers.includes(deadId)) continue;
    const partnerId = g.lovers[0] === deadId ? g.lovers[1] : g.lovers[0];
    if (processed.has(partnerId)) continue;
    processed.add(partnerId);

    const deadPlayer = getPlayer(room, deadId);
    const partner = getPlayer(room, partnerId);
    if (partner && partner.alive) {
      partner.alive = false;
      cascadedIds.push(partnerId);
      queue.push(partnerId);

      const partnerRoleLabel = ROLE_LABELS[partner.role] || partner.role;
      g.history.push({
        type: "lover_heartbreak",
        day: g.dayNumber,
        sourceId: deadId,
        targetId: partnerId,
        targetName: partner.name,
        targetRole: partner.role,
        text: `💔 Vì người thương ${deadPlayer?.name || ""} ngã xuống, ${partner.name} (${partnerRoleLabel}) đau đớn quyên sinh theo!`,
      });
      recordReplayEvent(room, {
        kind: "lover_heartbreak",
        phase: phaseLabel,
        actorId: deadId,
        targetId: partnerId,
        targetRole: partner.initialRole || partner.role,
        caption: `💔 Tơ hồng đứt đoạn! ${partner.name} (${partnerRoleLabel}) gục ngã theo người thương ${deadPlayer?.name || ""}!`,
      });
    }
  }

  return cascadedIds;
}

// Kiểm tra xem trong nhóm người vừa ngã xuống có Thợ Săn chưa bắn trả thù hay không
function armHunterRevengeIfEligible(room, newlyDeadIds, returnContext) {
  const g = room.game;
  if (g.hunterUsedShot || g.hunterPendingId) return null;
  if (alivePlayers(room).length === 0) return null;

  const deadHunterId = newlyDeadIds.find((id) => {
    const p = getPlayer(room, id);
    return p && !p.alive && p.role === "hunter";
  });
  if (!deadHunterId) return null;

  g.hunterPendingId = deadHunterId;
  g.hunterReturnContext = returnContext;
  g.phase = "hunter_revenge";
  g.phaseEndsAt = Date.now() + TIMERS.hunterRevenge * 1000;
  return deadHunterId;
}

// ============ ĐÊM 1: THẦN TÌNH YÊU (CUPID) ============
export function cupidLink(room, cupidId, targetIds) {
  const g = room.game;
  const cupid = getPlayer(room, cupidId);
  if (!cupid || cupid.role !== "cupid" || !cupid.alive) {
    return { error: "Bạn không phải Thần Tình Yêu hoặc đã chết." };
  }
  if (g.phase !== "night_cupid") return { error: "Chỉ ghép đôi ở Đêm đầu tiên." };
  if (!Array.isArray(targetIds) || targetIds.length !== 2 || targetIds[0] === targetIds[1]) {
    return { error: "Hãy chọn đúng 2 người chơi khác nhau để ghép đôi." };
  }

  const pA = getPlayer(room, targetIds[0]);
  const pB = getPlayer(room, targetIds[1]);
  if (!pA?.alive || !pB?.alive) {
    return { error: "Chỉ có thể ghép đôi những người đang sống." };
  }

  g.lovers = [pA.id, pB.id];

  recordReplayEvent(room, {
    kind: "cupid_link",
    phase: "night_cupid",
    actorId: cupidId,
    actorRole: "cupid",
    targetId: pA.id,
    coActorIds: [pB.id],
    caption: `💘 ${cupid.name} giương cung vàng kết tơ hồng sinh tử giữa ${pA.name} và ${pB.name}!`,
  });

  return { ok: true, lovers: g.lovers };
}

export function endCupidPhase(room) {
  const g = room.game;
  const cupid = room.players.find((p) => p.role === "cupid");
  if (Array.isArray(g.lovers) && g.lovers.length === 2) {
    const pA = getPlayer(room, g.lovers[0]);
    const pB = getPlayer(room, g.lovers[1]);
    g.history.push({
      type: "cupid_link",
      day: g.dayNumber,
      sourceId: cupid?.id || null,
      targetId: pA?.id || null,
      partnerId: pB?.id || null,
      text: `💘 Thần Tình Yêu đã se duyên sinh tử cho ${pA?.name || ""} và ${pB?.name || ""}.`,
    });
  } else {
    g.history.push({
      type: "cupid_link",
      day: g.dayNumber,
      text: "Đêm đầu tiên Thần Tình Yêu không ghép đôi ai.",
    });
  }
  g.phase = "night_guard";
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
  // BUG F2 FIX: Không thể bảo vệ người đã chết
  const target = getPlayer(room, targetId);
  if (!target?.alive) return { error: "Người chơi này đã chết." };

  const prevTargetId = g.guardedIdTonight || null;
  g.guardedIdTonight = targetId;

  const prevName = prevTargetId ? getPlayer(room, prevTargetId)?.name : null;
  recordReplayEvent(room, {
    kind: "guard_pick",
    phase: "night_guard",
    actorId: guardId,
    actorRole: "guard",
    targetId,
    prevTargetId,
    caption:
      prevTargetId && prevTargetId !== targetId
        ? `🛡️ ${guard.name} đổi ý, chuyển khiên sang canh gác cho ${target.name} (trước đó chọn ${prevName})!`
        : `🛡️ ${guard.name} lặng lẽ giương khiên sồi che chở cho ${target.name} trong đêm.`,
  });

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

// ============ ĐÊM: SÓI & SÓI ĐẦU ĐÀN ============
export function wolfPick(room, wolfId, targetId) {
  const g = room.game;
  const wolf = getPlayer(room, wolfId);
  if (!wolf || !isWolfTeamRole(wolf.role) || !wolf.alive) {
    return { error: "Bạn không thuộc Phe Sói hoặc đã chết." };
  }
  if (g.phase !== "night_wolf") return { error: "Không phải lượt Sói." };
  // BUG F FIX: Không thể cắn người đã chết
  const target = getPlayer(room, targetId);
  if (!target?.alive) return { error: "Người chơi này đã chết." };
  // Không thể cắn đồng đội Sói
  if (isWolfTeamRole(target.role)) return { error: "Không thể cắn đồng loại." };

  const prevTargetId = g.wolfPicks[wolfId]?.targetId || null;
  g.wolfPicks[wolfId] = { targetId, timestamp: Date.now() };

  const prevName = prevTargetId ? getPlayer(room, prevTargetId)?.name : null;
  recordReplayEvent(room, {
    kind: "wolf_aim",
    phase: "night_wolf",
    actorId: wolfId,
    actorRole: wolf.role,
    targetId,
    prevTargetId,
    caption:
      prevTargetId && prevTargetId !== targetId
        ? `🐺 ${wolf.name} chần chừ rồi đổi móng vuốt từ ${prevName} sang ${target.name}!`
        : `🐺 ${wolf.name} nhe nanh chỉ móng vuốt nhắm vào ${target.name}...`,
  });

  return { ok: true };
}

export function wolfAlphaToggle(room, alphaId, enabled) {
  const g = room.game;
  const alpha = getPlayer(room, alphaId);
  if (!alpha || alpha.role !== "alpha_wolf" || !alpha.alive) {
    return { error: "Chỉ Sói Đầu Đàn còn sống mới dùng được Huyết Nguyệt." };
  }
  if (g.phase !== "night_wolf") return { error: "Chỉ kích hoạt trong lượt Sói ban đêm." };
  if (g.alphaUsedConvert) {
    return { error: "Quyền Huyết Nguyệt Đồng Hóa chỉ dùng được 1 lần duy nhất mỗi ván." };
  }
  g.alphaConvertTonight = Boolean(enabled);
  return { ok: true, alphaConvertTonight: g.alphaConvertTonight };
}

// Quyết định nạn nhân theo luật: cùng chọn 1 người -> giết người đó
// Chọn khác nhau -> giết người được pick SỚM NHẤT (theo timestamp đầu tiên mỗi mục tiêu được chọn)
export function resolveWolfVictim(room) {
  const g = room.game;
  const picks = Object.values(g.wolfPicks);
  const aliveWolves = aliveWolfTeam(room);

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
  const aliveWolves = aliveWolfTeam(room);
  const wolfIds = aliveWolves.map((w) => w.id);

  // Tìm con Sói đã chốt mục tiêu này sớm nhất (hoặc Sói đầu đàn) để làm ghế xuất phát tia VFX 3D
  const alphaAlive = aliveWolves.find((w) => w.role === "alpha_wolf");
  let leadWolfId = alphaAlive?.id || wolfIds[0] || null;
  if (g.wolfVictimId && g.wolfPicks) {
    let minTs = Infinity;
    Object.entries(g.wolfPicks).forEach(([wId, pick]) => {
      if (pick?.targetId === g.wolfVictimId && pick.timestamp < minTs) {
        minTs = pick.timestamp;
        leadWolfId = wId;
      }
    });
  }

  if (g.wolfVictimId) {
    const targetName = getPlayer(room, g.wolfVictimId)?.name;
    const leadRole = getPlayer(room, leadWolfId)?.role || "wolf";
    g.history.push({
      type: "wolf",
      day: g.dayNumber,
      sourceId: leadWolfId,
      wolfIds,
      targetId: g.wolfVictimId,
      alphaConvertAttempt: Boolean(g.alphaConvertTonight && !g.alphaUsedConvert),
      text:
        g.alphaConvertTonight && !g.alphaUsedConvert
          ? `Sói Đầu Đàn dẫn bầy nhắm Huyết Nguyệt vào ${targetName}.`
          : `Đàn sói đã thống nhất cắn ${targetName}.`,
    });
    recordReplayEvent(room, {
      kind: "wolf_strike",
      phase: "night_wolf",
      actorId: leadWolfId,
      actorRole: leadRole,
      coActorIds: wolfIds,
      targetId: g.wolfVictimId,
      caption: `🐺 Bầy Sói thống nhất lao tới tung đòn chí mạng vào ${targetName}!`,
    });
  } else {
    g.alphaConvertTonight = false;
    g.history.push({
      type: "wolf",
      day: g.dayNumber,
      sourceId: leadWolfId,
      wolfIds,
      text: "Đêm nay đàn sói không cắn ai.",
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
    const victimName = getPlayer(room, g.wolfVictimId)?.name || "nạn nhân";
    recordReplayEvent(room, {
      kind: "witch_save",
      phase: "night_witch",
      actorId: witchId,
      actorRole: "witch",
      targetId: g.wolfVictimId,
      caption: `🧪 ${witch.name} ném Bình Dược Lục Bảo cứu mạng ${victimName} ngay trước lưỡi hái tử thần!`,
    });
  }

  if (poisonTargetId) {
    if (g.witchUsedPoison) return { error: "Bạn đã dùng bình độc rồi." };
    // BUG G FIX: Không thể đầu độc người đã chết
    const poisonTarget = getPlayer(room, poisonTargetId);
    if (!poisonTarget?.alive) return { error: "Người chơi này đã chết." };
    g.witchPoisonTargetId = poisonTargetId;
    g.witchUsedPoison = true;
    recordReplayEvent(room, {
      kind: "witch_poison",
      phase: "night_witch",
      actorId: witchId,
      actorRole: "witch",
      targetId: poisonTargetId,
      caption: `☠️ ${witch.name} tung Bình Độc Dược Tím hạ sát ${poisonTarget.name} trong màn sương!`,
    });
  }

  return { ok: true };
}

export function endWitchPhase(room) {
  const g = room.game;
  const witchId = room.players.find((p) => p.role === "witch")?.id || null;
  if (g.witchSaveTonight) {
    const targetName = getPlayer(room, g.wolfVictimId)?.name;
    g.history.push({
      type: "witch_save",
      day: g.dayNumber,
      sourceId: witchId,
      targetId: g.wolfVictimId,
      text: `Phù thủy đã dùng bình cứu để cứu ${targetName}.`
    });
  }
  if (g.witchPoisonTargetId) {
    const targetName = getPlayer(room, g.witchPoisonTargetId)?.name;
    g.history.push({
      type: "witch_poison",
      day: g.dayNumber,
      sourceId: witchId,
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
  const result = isWolfTeamRole(target?.role) ? "wolf" : "not_wolf";
  g.seerChecksLog.push({ seerId, targetId, dayNumber: g.dayNumber, result });

  recordReplayEvent(room, {
    kind: "seer_scan",
    phase: "night_seer",
    actorId: seerId,
    actorRole: "seer",
    targetId,
    decision: result,
    caption: `🔮 ${seer.name} khai mở Mắt Thần soi thấu ${target?.name || ""}: ${
      result === "wolf" ? "PHÁT HIỆN MA SÓI!" : "Tâm hồn trong sạch (Phe Dân)."
    }`,
  });

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

  // Kiểm tra Người Cứng Cỏi (tough_guy) bị cắn từ đêm trước -> đến đêm nay chết
  if (g.toughGuyPoisonedDay && g.toughGuyPoisonedDay < g.dayNumber) {
    const toughGuy = room.players.find((p) => p.role === "tough_guy" && p.alive);
    if (toughGuy) {
      deaths.add(toughGuy.id);
      // BUG C FIX: KHÔNG push history ở đây vì forEach bên dưới đã xử lý.
      // Push ở đây sẽ gây duplicate "death" event trong Recap.
    }
  }

  const guardPlayer = room.players.find((p) => p.role === "guard");
  const alphaAlive = room.players.find((p) => p.role === "alpha_wolf" && p.alive);
  const leadWolfPlayer =
    alphaAlive ||
    room.players.find((p) => isWolfTeamRole(p.role) && p.alive) ||
    room.players.find((p) => isWolfTeamRole(p.role));

  if (g.wolfVictimId && g.wolfVictimId === g.guardedIdTonight) {
    const savedTarget = getPlayer(room, g.wolfVictimId);
    recordReplayEvent(room, {
      kind: "shield_block",
      phase: "night_resolve",
      actorId: guardPlayer?.id || null,
      actorRole: "guard",
      coActorIds: leadWolfPlayer ? [leadWolfPlayer.id] : [],
      targetId: g.wolfVictimId,
      caption: `🛡️ KENG!! Khiên của ${guardPlayer?.name || "Hộ Vệ"} chấn bật đòn vồ của Sói, cứu sống ${savedTarget?.name || ""}!`,
    });
  }

  const victimSaved =
    g.wolfVictimId && (g.wolfVictimId === g.guardedIdTonight || g.witchSaveTonight);

  if (g.wolfVictimId && victimSaved && g.alphaConvertTonight && !g.alphaUsedConvert) {
    // Đã tung Huyết Nguyệt nhưng bị Bảo Vệ / Phù Thủy chặn đứng
    g.alphaUsedConvert = true;
    g.alphaConvertTonight = false;
  }

  if (g.wolfVictimId && !victimSaved) {
    const victim = getPlayer(room, g.wolfVictimId);

    if (g.alphaConvertTonight && !g.alphaUsedConvert && alphaAlive && victim) {
      // Sói Đầu Đàn kích hoạt Huyết Nguyệt Đồng Hóa: biến con mồi thành Sói thay vì chết!
      g.alphaUsedConvert = true;
      g.alphaConvertTonight = false;
      victim.role = "wolf";
      g.history.push({
        type: "alpha_converted",
        day: g.dayNumber,
        sourceId: alphaAlive.id,
        targetId: victim.id,
        text: `🐺👑 Huyết Nguyệt Đồng Hóa! Sói Đầu Đàn [${alphaAlive.name}] đã biến [${victim.name}] thành Ma Sói mới!`,
      });
      recordReplayEvent(room, {
        kind: "alpha_convert",
        phase: "night_resolve",
        actorId: alphaAlive.id,
        actorRole: "alpha_wolf",
        targetId: victim.id,
        targetRole: "wolf",
        caption: `🩸 Huyết Nguyệt giáng lâm! Sói Đầu Đàn ${alphaAlive.name} khắc ấn máu biến ${victim.name} thành Ma Sói!`,
      });
    } else if (victim?.role === "cursed") {
      // Kẻ Bị Nguyền: Bị Sói cắn -> Không chết mà HÓA THÀNH SÓI!
      victim.role = "wolf";
      g.history.push({
        type: "cursed_transformed",
        day: g.dayNumber,
        targetId: victim.id,
        text: `Kẻ Bị Nguyền [${victim.name}] đã bị Sói cắn nhưng không chết, mà dòng máu Sói đã thức tỉnh!`,
      });
      recordReplayEvent(room, {
        kind: "cursed_turn",
        phase: "night_resolve",
        actorId: leadWolfPlayer?.id || null,
        actorRole: leadWolfPlayer?.role || "wolf",
        targetId: victim.id,
        targetRole: "wolf",
        caption: `🩸 Huyết nguyền bùng cháy! ${victim.name} không chết sau cú cắn mà thức tỉnh thành Ma Sói mới!`,
      });
    } else if (victim?.role === "tough_guy") {
      // Người Cứng Cỏi: Bị Sói cắn -> Không chết ngay đêm nay, đánh dấu để đêm sau chết
      if (!g.toughGuyPoisonedDay) {
        g.toughGuyPoisonedDay = g.dayNumber;
        g.history.push({
          type: "tough_guy_endured",
          day: g.dayNumber,
          targetId: victim.id,
          text: `Người Cứng Cỏi [${victim.name}] bị Sói tấn công nhưng đã kiên cường chịu đựng vết thương để sống sót qua ngày hôm nay!`,
        });
        recordReplayEvent(room, {
          kind: "tough_endure",
          phase: "night_resolve",
          actorId: leadWolfPlayer?.id || null,
          actorRole: leadWolfPlayer?.role || "wolf",
          targetId: victim.id,
          targetRole: "tough_guy",
          caption: `💪 ${victim.name} nghiến răng chịu đựng vết cắn sâu của Sói, gồng mình trụ vững đón bình minh!`,
        });
      }
    } else {
      deaths.add(g.wolfVictimId);
    }
  }

  g.alphaConvertTonight = false;

  if (g.witchPoisonTargetId) {
    deaths.add(g.witchPoisonTargetId);
  }

  const primaryDeadIds = Array.from(deaths);
  primaryDeadIds.forEach((id) => {
    const p = getPlayer(room, id);
    if (p) {
      p.alive = false;
      g.history.push({
        type: "death",
        day: g.dayNumber,
        targetId: id,
        targetName: p.name,
        targetRole: p.role,
        text: `${p.name} không qua khỏi đêm đẫm máu.`,
      });
      recordReplayEvent(room, {
        kind: "night_death",
        phase: "day_reveal",
        targetId: id,
        targetRole: p.initialRole || p.role,
        caption: `💀 Bình minh Ngày ${g.dayNumber} nhuốm máu — ${p.name} (${ROLE_LABELS[p.initialRole || p.role] || p.role}) gục ngã!`,
      });
    }
  });

  // Kích hoạt dây chuyền Tình Nhân quyên sinh nếu 1 trong 2 người bị hạ sát đêm qua
  const loverCascadedIds =
    primaryDeadIds.length > 0 ? applyLoverCascade(room, primaryDeadIds, "day_reveal") : [];
  const allNightDeaths = [...primaryDeadIds, ...loverCascadedIds];

  if (allNightDeaths.length === 0) {
    g.history.push({
      type: "peaceful_night",
      day: g.dayNumber,
      text: "Đêm qua là một đêm bình yên, không ai chết!",
    });
    recordReplayEvent(room, {
      kind: "peaceful_dawn",
      phase: "day_reveal",
      caption: `🌅 Bình minh Ngày ${g.dayNumber} thanh bình — cả ngôi làng vẫn toàn mạng!`,
    });
  }

  g.nightDeaths = allNightDeaths;
  g.phase = "day_reveal";

  // Nếu trong số người chết rạng sáng (trực tiếp hoặc vỡ tim Tình Nhân) có Thợ Săn -> mở 15s bắn trả thù!
  armHunterRevengeIfEligible(room, allNightDeaths, "dawn");

  return g.nightDeaths;
}


// ============ BAN NGÀY: THẢO LUẬN CÓ GIA HẠN ============
export function startDiscussion(room) {
  const g = room.game;
  g.phase = "day_discuss";
  g.discussEndsAt = Date.now() + TIMERS.dayDiscuss * 1000;
  g.extendVotes = {};
  g.skipDiscussVotes = {};
}

export function voteExtendDiscussion(room, playerId, wantExtend) {
  const g = room.game;
  if (g.phase !== "day_discuss") return { error: "Không phải lúc thảo luận." };
  // BUG H FIX: Chỉ người sống mới được vote gia hạn
  const voter = getPlayer(room, playerId);
  if (!voter?.alive) return { error: "Bạn đã chết, không thể vote." };

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

export function voteSkipDiscussion(room, playerId) {
  const g = room.game;
  if (g.phase !== 'day_discuss') return { ok: false, error: 'Không phải giai đoạn thảo luận.' };
  const alive = alivePlayers(room);
  const voter = alive.find(p => p.id === playerId);
  if (!voter) return { ok: false, error: 'Bạn không thể bỏ phiếu.' };

  // Toggle vote
  if (g.skipDiscussVotes[playerId]) {
    delete g.skipDiscussVotes[playerId];
  } else {
    g.skipDiscussVotes[playerId] = true;
  }

  // Hỗ trợ Chơi 1 mình / Thiếu người có AI Bot:
  // Khi TẤT CẢ người chơi thật còn sống đồng thuận Bỏ qua -> đàn AI Bot còn sống tự động đồng thuận theo ngay!
  const aliveHumans = alive.filter((p) => !p.isBot);
  const aliveBots = alive.filter((p) => p.isBot);
  if (aliveBots.length > 0 && aliveHumans.length > 0) {
    const allHumansSkipped = aliveHumans.every((p) => Boolean(g.skipDiscussVotes[p.id]));
    if (allHumansSkipped) {
      aliveBots.forEach((b) => {
        g.skipDiscussVotes[b.id] = true;
      });
    } else if (!voter.isBot && !g.skipDiscussVotes[playerId]) {
      aliveBots.forEach((b) => {
        delete g.skipDiscussVotes[b.id];
      });
    }
  }

  const skipCount = Object.keys(g.skipDiscussVotes).length;
  const totalAlive = alive.length;
  const allSkipped = skipCount >= totalAlive;

  return { ok: true, skipCount, totalAlive, allSkipped };
}

// ============ BAN NGÀY: ĐỀ CỬ (VOTE CÔNG KHAI) ============
export function startNomination(room) {
  const g = room.game;
  g.phase = "day_nominate";
  g.nominationVotes = {};
  g.nominees = [];
  g.hotSeatQueue = [];
  // BUG A FIX: Bắt đầu từ -1 để lần gọi nextDefenseOrFinalVote đầu tiên
  // tăng lên 0 → trả về đúng defendant đầu tiên (index 0)
  g.hotSeatIndex = -1;
}

// Ngưỡng để 1 người "lên ghế nóng": có nhiều phiếu nhất, xử lý hòa = cả 2 lên ghế
export function nominationVote(room, voterId, targetId) {
  const g = room.game;
  if (g.phase !== "day_nominate") return { error: "Không phải lúc đề cử." };
  const voter = getPlayer(room, voterId);
  if (!voter?.alive) return { error: "Bạn đã chết, không thể vote." };
  // BUG J FIX: Không thể đề cử người đã chết
  const target = getPlayer(room, targetId);
  if (!target?.alive) return { error: "Không thể đề cử người đã chết." };
  // Không thể tự đề cử mình
  if (voterId === targetId) return { error: "Không thể tự đề cử bản thân." };

  const prevTargetId = g.nominationVotes[voterId]?.targetId || null;
  g.nominationVotes[voterId] = { targetId, timestamp: Date.now() };

  const prevName = prevTargetId ? getPlayer(room, prevTargetId)?.name : null;
  const votesSnap = {};
  Object.entries(g.nominationVotes).forEach(([k, v]) => {
    if (v?.targetId) votesSnap[k] = v.targetId;
  });

  recordReplayEvent(room, {
    kind: "day_nominate",
    phase: "day_nominate",
    actorId: voterId,
    targetId,
    prevTargetId,
    votesSnapshot: votesSnap,
    caption:
      prevTargetId && prevTargetId !== targetId
        ? `👉 ${voter.name} quay ngoắt tay, đổi mũi dùi từ ${prevName} sang chỉ mặt ${target.name}!`
        : `👉 ${voter.name} thẳng tay chỉ mặt đề cử ${target.name} lên ghế nóng!`,
  });

  return { ok: true };
}

// ============ BAN NGÀY: TRƯỞNG LÀNG CÔNG BỐ QUYỀN TRƯỢNG (PHIẾU x2) ============
export function mayorReveal(room, mayorId) {
  const g = room.game;
  const mayor = getPlayer(room, mayorId);
  if (!mayor || mayor.role !== "mayor" || !mayor.alive) {
    return { error: "Chỉ Trưởng Làng còn sống mới có thể công bố Quyền Trượng." };
  }
  const dayPhases = ["day_reveal", "day_discuss", "day_nominate", "day_defense", "day_final_vote"];
  if (!dayPhases.includes(g.phase)) {
    return { error: "Chỉ được công bố Quyền Trượng vào ban ngày." };
  }
  if (g.mayorRevealedId) {
    return { error: "Trưởng Làng đã công bố thân phận trước đó rồi." };
  }

  g.mayorRevealedId = mayorId;
  g.history.push({
    type: "mayor_reveal",
    day: g.dayNumber,
    sourceId: mayorId,
    text: `👑 ${mayor.name} giơ cao Quyền Trượng công bố thân phận Trưởng Làng — mọi lá phiếu từ nay tính gấp đôi (x2)!`,
  });
  recordReplayEvent(room, {
    kind: "mayor_reveal",
    phase: g.phase,
    actorId: mayorId,
    actorRole: "mayor",
    caption: `👑 ${mayor.name} dậm Quyền Trượng Vàng uy quyền giữa làng, chính thức kích hoạt lá phiếu x2!`,
  });

  return { ok: true, mayorId };
}

// ============ HƠI THỞ CUỐI CÙNG CỦA THỢ SĂN (15 GIÂY BẮN TRẢ THÙ) ============
export function hunterShoot(room, hunterId, targetId) {
  const g = room.game;
  const hunter = getPlayer(room, hunterId);
  if (!hunter || hunter.role !== "hunter") {
    return { error: "Bạn không phải Thợ Săn." };
  }
  if (g.phase !== "hunter_revenge" || g.hunterPendingId !== hunterId || g.hunterUsedShot) {
    return { error: "Không trong thời gian bắn trả thù của Thợ Săn." };
  }
  const target = getPlayer(room, targetId);
  if (!target?.alive) {
    return { error: "Mục tiêu không hợp lệ hoặc đã chết." };
  }

  const returnContext = g.hunterReturnContext || "dawn";
  g.hunterUsedShot = true;
  g.hunterPendingId = null;
  g.hunterReturnContext = null;

  target.alive = false;
  const targetRoleLabel = ROLE_LABELS[target.role] || target.role;
  g.history.push({
    type: "hunter_shot",
    day: g.dayNumber,
    sourceId: hunterId,
    targetId: target.id,
    targetName: target.name,
    targetRole: target.role,
    text: `🏹 Trước lúc gục ngã, Thợ Săn ${hunter.name} bóp cò bắn gục ${target.name} (${targetRoleLabel})!`,
  });
  recordReplayEvent(room, {
    kind: "hunter_shot",
    phase: "hunter_revenge",
    actorId: hunterId,
    actorRole: "hunter",
    targetId: target.id,
    targetRole: target.initialRole || target.role,
    caption: `🏹 ĐOÀNG!! Đạn bạc cuối cùng của Thợ Săn ${hunter.name} xuyên thủng ${target.name} (${targetRoleLabel})!`,
  });

  // Nếu viên đạn bắn trúng 1 Tình Nhân còn sống -> nửa kia cũng quyên sinh theo!
  const cascadedIds = applyLoverCascade(room, [target.id], "hunter_revenge");
  const killedIds = [target.id, ...cascadedIds];

  if (returnContext === "dawn") {
    g.nightDeaths = Array.from(new Set([...(g.nightDeaths || []), ...killedIds]));
    g.phase = "day_reveal";
  } else {
    g.phase = "day_final_vote";
  }

  return { ok: true, killedIds, cascadedIds, returnContext };
}

export function skipHunterRevenge(room) {
  const g = room.game;
  const hunterId = g.hunterPendingId;
  const returnContext = g.hunterReturnContext || "dawn";
  g.hunterUsedShot = true;
  g.hunterPendingId = null;
  g.hunterReturnContext = null;

  if (hunterId) {
    const hunter = getPlayer(room, hunterId);
    g.history.push({
      type: "hunter_skip",
      day: g.dayNumber,
      sourceId: hunterId,
      text: `🏹 Thợ Săn ${hunter?.name || ""} hạ nỏ xuống mà không bắn ai.`,
    });
  }

  g.phase = returnContext === "dawn" ? "day_reveal" : "day_final_vote";
  return { ok: true, returnContext };
}

// Gọi khi hết giờ đề cử -> tính người lên ghế nóng (có tính trọng số phiếu x2 của Trưởng Làng)
export function finalizeNomination(room) {
  const g = room.game;
  const entries = Object.entries(g.nominationVotes || {});

  if (entries.length === 0) {
    g.phase = "day_no_nomination";
    return { nominees: [] };
  }

  const tally = {}; // targetId -> { count, earliestTimestamp }
  entries.forEach(([voterId, v]) => {
    if (!v?.targetId) return;
    if (!tally[v.targetId]) {
      tally[v.targetId] = { count: 0, earliestTimestamp: v.timestamp };
    }
    tally[v.targetId].count += getVoterWeight(room, voterId);
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
  g.hotSeatIndex = -1; // BUG A FIX: -1 so first nextDefenseOrFinalVote call → index 0
  g.phase = "day_defense";
  g.hotSeatEndsAt = Date.now() + TIMERS.defense * 1000;

  if (topCandidates.length > 0) {
    const candidateNames = topCandidates.map((c) => getPlayer(room, c.playerId)?.name).filter(Boolean);
    g.history.push({
      type: "nomination",
      day: g.dayNumber,
      nominees: topCandidates.map((c) => ({
        playerId: c.playerId,
        name: getPlayer(room, c.playerId)?.name,
        votes: c.votes,
      })),
      text: `Cả làng đã đề cử ${candidateNames.join(", ")} lên ghế nóng!`,
      votesDetail: { ...g.nominationVotes },
    });
    recordReplayEvent(room, {
      kind: "day_defense",
      phase: "day_defense",
      targetId: topCandidates[0].playerId,
      coActorIds: topCandidates.map((c) => c.playerId),
      caption: `⚖️ Cả làng vây quanh chất vấn ${candidateNames.join(", ")} trên Ghế Nóng!`,
    });
  }

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
  const defendantId = g.hotSeatQueue[g.hotSeatIndex] || null;
  const defendant = defendantId ? getPlayer(room, defendantId) : null;
  recordReplayEvent(room, {
    kind: "day_final_vote",
    phase: "day_final_vote",
    actorId: voterId,
    targetId: defendantId,
    decision,
    votesSnapshot: { ...g.finalVotes },
    caption: `${decision === "hang" ? "👎" : "🕊️"} ${voter.name} giơ tay chọn ${
      decision === "hang" ? "TREO CỔ" : "THA MẠNG"
    } cho ${defendant?.name || "bị cáo"}!`,
  });
  return { ok: true };
}

// Xử lý kết quả cho người đang trên ghế nóng hiện tại (có tính phiếu x2 Trưởng Làng + dây chuyền Tình Nhân & Thợ Săn)
export function resolveFinalVote(room) {
  const g = room.game;
  const defendantId = g.hotSeatQueue[g.hotSeatIndex];
  let hangCount = 0;
  let spareCount = 0;
  Object.entries(g.finalVotes || {}).forEach(([voterId, decision]) => {
    const w = getVoterWeight(room, voterId);
    if (decision === "hang") hangCount += w;
    else if (decision === "spare") spareCount += w;
  });

  const hanged = hangCount > spareCount;
  let tannerWin = false;
  let cascadedIds = [];
  let hunterPendingId = null;

  if (hanged) {
    const defendant = getPlayer(room, defendantId);
    if (defendant) {
      defendant.alive = false;
      const roleName = ROLE_LABELS[defendant.role] || defendant.role;
      g.history.push({
        type: "hang",
        day: g.dayNumber,
        targetId: defendantId,
        targetName: defendant.name,
        targetRole: defendant.role,
        hangCount,
        spareCount,
        votesDetail: { ...g.finalVotes },
        text: `${defendant.name} (${roleName}) đã bị treo cổ (${hangCount} phiếu Treo vs ${spareCount} phiếu Tha).`,
      });
      if (defendant.role === "tanner") {
        tannerWin = true;
        g.winner = "tanner";
      }
      recordReplayEvent(room, {
        kind: "day_verdict",
        phase: "day_final_vote",
        targetId: defendantId,
        targetRole: defendant.initialRole || defendant.role,
        decision: "hang",
        votesSnapshot: { ...g.finalVotes },
        caption: `🪢 Phán quyết định đoạt! ${defendant.name} (${roleName}) bị treo cổ giữa pháp trường (${hangCount} Treo vs ${spareCount} Tha)!`,
      });

      if (!tannerWin) {
        cascadedIds = applyLoverCascade(room, [defendantId], "day_final_vote");
        // Nếu người vừa chết không còn nằm trong hàng ghế nóng phía sau thì loại khỏi queue để tránh vote người chết
        if (cascadedIds.length > 0) {
          g.hotSeatQueue = g.hotSeatQueue.filter(
            (qId, idx) => idx <= g.hotSeatIndex || !cascadedIds.includes(qId)
          );
        }
        hunterPendingId = armHunterRevengeIfEligible(
          room,
          [defendantId, ...cascadedIds],
          "hang_queue"
        );
      }
    }
  } else {
    const defendant = getPlayer(room, defendantId);
    if (defendant) {
      g.history.push({
        type: "spare",
        day: g.dayNumber,
        targetId: defendantId,
        targetName: defendant.name,
        targetRole: defendant.role,
        hangCount,
        spareCount,
        votesDetail: { ...g.finalVotes },
        text: `${defendant.name} đã được tha bổng (${spareCount} phiếu Tha vs ${hangCount} phiếu Treo).`,
      });
      recordReplayEvent(room, {
        kind: "day_verdict",
        phase: "day_final_vote",
        targetId: defendantId,
        targetRole: defendant.initialRole || defendant.role,
        decision: "spare",
        votesSnapshot: { ...g.finalVotes },
        caption: `🕊️ Làng mở đường sống! ${defendant.name} được tha bổng (${spareCount} Tha vs ${hangCount} Treo).`,
      });
    }
  }

  return { defendantId, hanged, hangCount, spareCount, tannerWin, cascadedIds, hunterPendingId };
}

// ============ KIỂM TRA ĐIỀU KIỆN THẮNG ============
export function checkWinCondition(room) {
  const g = room.game;
  if (g.winner) return g.winner; // Chán Đời hoặc Phe khác đã thắng trước đó
  // Nếu Thợ Săn đang ngậm nỏ chờ bóp cò 15s thì chưa kết sổ thắng thua!
  if (g.phase === "hunter_revenge" && g.hunterPendingId) return null;

  const alive = alivePlayers(room);

  // Điều kiện thắng riêng Phe Thứ 3 của Cặp Đôi Khác Chiến Tuyến (Sói - Dân / Trung Lập): trụ lại đúng 2 người cuối cùng!
  if (alive.length === 2 && Array.isArray(g.lovers) && g.lovers.length === 2) {
    const bothLoversAlive = alive.every((p) => g.lovers.includes(p.id));
    if (bothLoversAlive && isCrossTeamLovers(room)) {
      g.winner = "lovers";
      return "lovers";
    }
  }

  const aliveWolves = aliveWolfTeam(room).length;
  const aliveOthers = alive.length - aliveWolves;

  if (aliveWolves === 0) {
    g.winner = "village";
    return "village";
  }
  if (aliveWolves >= aliveOthers) {
    // Nếu còn 1 Cặp Đôi Sói-Dân đang cùng sống nhưng vẫn còn người ngoài cuộc (alive.length > 2),
    // Sói chưa thể tự sát người thương để thắng ngay mà ván đấu tiếp diễn đến khi hạ nốt người ngoài cuộc!
    if (Array.isArray(g.lovers) && g.lovers.length === 2 && isCrossTeamLovers(room)) {
      const bothAlive = g.lovers.every((id) => getPlayer(room, id)?.alive);
      if (bothAlive && alive.length > 2 && aliveOthers === 1) {
        // Ví dụ: 2 Sói (1 Sói thường + 1 Sói Tình Nhân) vs 1 Dân Tình Nhân -> nếu Sói cắn Dân Tình Nhân thì Sói Tình Nhân chết theo -> 1 Sói thường thắng!
        // Trường hợp này Sói vẫn áp đảo hoàn toàn nên Phe Sói thắng hợp lệ.
      }
    }
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

  // Reset trạng thái đêm
  g.guardedIdTonight = null;
  g.wolfPicks = {};
  g.wolfVictimId = null;
  g.witchSaveTonight = false;
  g.witchPoisonTargetId = null;
  g.nightDeaths = [];

  // BUG 8 FIX: Reset tất cả trạng thái ban ngày để tránh state leak sang ngày tiếp theo
  g.discussEndsAt = null;
  g.extendVotes = {};
  g.skipDiscussVotes = {};
  g.nominationVotes = {};
  g.nominees = [];
  g.hotSeatQueue = [];
  g.hotSeatIndex = -1; // Consistent với startNomination
  g.hotSeatEndsAt = null;
  g.finalVotes = {};
  g.finalVoteEndsAt = null;
}

// ============ TÍNH TOÁN DANH HIỆU & MVP VÁN ĐẤU ============
export function computeMatchAwards(room) {
  const g = room.game;
  if (!g) return [];
  const players = room.players || [];
  const history = g.history || [];
  const winner = g.winner;

  const scores = {};
  const stats = {};

  players.forEach((p) => {
    scores[p.id] = 0;
    stats[p.id] = {
      saves: 0,
      seerWolvesFound: 0,
      votesToHangWolf: 0,
      totalHangVotes: 0,
      survived: p.alive,
      role: p.role,
      name: p.name,
    };
  });

  // Phân tích lịch sử sự kiện
  history.forEach((ev) => {
    if (ev.type === "guard" && ev.targetId) {
      // Bảo vệ thành công nếu cùng đêm đó Sói cắn đúng người này
      const wolfAttack = history.find(
        (h) => h.day === ev.day && h.type === "wolf" && h.targetId === ev.targetId
      );
      if (wolfAttack && ev.sourceId && scores[ev.sourceId] !== undefined) {
        scores[ev.sourceId] += 30;
        stats[ev.sourceId].saves += 1;
      }
    }

    if (ev.type === "witch_save" && ev.targetId) {
      const witch = players.find((p) => p.role === "witch");
      if (witch) {
        scores[witch.id] += 20;
        stats[witch.id].saves += 1;
      }
    }

    if (ev.type === "witch_poison" && ev.targetId) {
      const witch = players.find((p) => p.role === "witch");
      const target = players.find((p) => p.id === ev.targetId);
      if (witch && target) {
        if (isWolfTeamRole(target.role)) {
          scores[witch.id] += 25;
        } else {
          scores[witch.id] -= 10;
        }
      }
    }

    if (ev.type === "hunter_shot" && ev.sourceId && ev.targetId) {
      const target = players.find((p) => p.id === ev.targetId);
      if (scores[ev.sourceId] !== undefined && target) {
        scores[ev.sourceId] += isWolfTeamRole(target.role) ? 35 : -8;
      }
    }

    if (ev.type === "alpha_converted" && ev.sourceId) {
      if (scores[ev.sourceId] !== undefined) scores[ev.sourceId] += 28;
    }

    if (ev.type === "mayor_reveal" && ev.sourceId) {
      if (scores[ev.sourceId] !== undefined) scores[ev.sourceId] += 12;
    }

    if (ev.type === "seer" && ev.sourceId) {
      if (ev.isWolf || ev.text?.includes("là Sói")) {
        scores[ev.sourceId] += 25;
        stats[ev.sourceId].seerWolvesFound += 1;
      } else {
        scores[ev.sourceId] += 5;
      }
    }

    if (ev.type === "tough_guy_endured" && ev.targetId) {
      if (scores[ev.targetId] !== undefined) {
        scores[ev.targetId] += 20;
      }
    }

    if (ev.type === "cursed_transformed" && ev.targetId) {
      if (scores[ev.targetId] !== undefined) {
        scores[ev.targetId] += 15;
      }
    }

    if (ev.type === "hang") {
      const defendant = players.find((p) => p.id === ev.targetId);
      const isWolf = isWolfTeamRole(defendant?.role);
      if (ev.votesDetail) {
        Object.entries(ev.votesDetail).forEach(([voterId, vote]) => {
          if (vote === "hang" && scores[voterId] !== undefined) {
            stats[voterId].totalHangVotes += 1;
            if (isWolf) {
              scores[voterId] += 15;
              stats[voterId].votesToHangWolf += 1;
            }
          }
        });
      }
    }
  });

  // Cộng điểm chiến thắng và sống sót
  players.forEach((p) => {
    const isWolfTeam = isWolfTeamRole(p.role);
    const isVillageTeam = !isWolfTeam && p.role !== "tanner";
    const isTanner = p.role === "tanner";
    const isInLovers = Array.isArray(g.lovers) && g.lovers.includes(p.id);

    if (winner === "lovers" && isInLovers) {
      scores[p.id] += 42;
    } else if (winner === "wolf" && isWolfTeam) {
      scores[p.id] += 20;
    } else if (winner === "village" && isVillageTeam) {
      scores[p.id] += 15;
    } else if (winner === "tanner" && isTanner) {
      scores[p.id] += 40;
    }

    if (p.alive) {
      scores[p.id] += 10;
    }
  });

  // Tìm MVP cao điểm nhất
  let mvpPlayer = null;
  let maxScore = -999;
  players.forEach((p) => {
    const s = scores[p.id] || 0;
    if (s > maxScore) {
      maxScore = s;
      mvpPlayer = p;
    }
  });

  const awards = [];

  if (mvpPlayer) {
    let mvpReason = "Có đóng góp xuất sắc nhất trận đấu!";
    if (winner === "lovers" && Array.isArray(g.lovers) && g.lovers.includes(mvpPlayer.id)) {
      mvpReason = "Tình yêu vượt chiến tuyến! Cặp đôi định mệnh nắm tay nhau chiến thắng cả ngôi làng!";
    } else if (isWolfTeamRole(mvpPlayer.role)) {
      mvpReason = mvpPlayer.alive
        ? "Thủ lĩnh Bầy Sói tinh quái dẫn dắt thế trận và sống sót đến phút cuối!"
        : "Đóng góp chiến thuật then chốt cho chiến thắng của Bầy Sói!";
    } else if (mvpPlayer.role === "hunter") {
      mvpReason = "Xạ thủ máu lạnh với phát đạn bạc quyết định cục diện ván đấu!";
    } else if (mvpPlayer.role === "mayor") {
      mvpReason = "Quyền Trượng uy nghiêm dẫn dắt lá phiếu phán quyết của cả ngôi làng!";
    } else if (mvpPlayer.role === "cupid") {
      mvpReason = "Mũi tên Tơ Hồng tạo nên bước ngoặt định mệnh cho ván đấu!";
    } else if (mvpPlayer.role === "guard") {
      mvpReason = `Bảo vệ thần thánh với ${stats[mvpPlayer.id].saves} lần cứu người chuẩn xác!`;
    } else if (mvpPlayer.role === "seer") {
      mvpReason = `Mắt thần soi đúng ${stats[mvpPlayer.id].seerWolvesFound} Sói, định hướng cho cả làng!`;
    } else if (mvpPlayer.role === "tanner") {
      mvpReason = "Cú lừa ngoạn mục dẫn dụ cả làng treo cổ mình thành công!";
    } else {
      mvpReason = `Đóng góp ${stats[mvpPlayer.id].votesToHangWolf} phiếu treo cổ Sói chuẩn xác!`;
    }

    awards.push({
      id: "mvp",
      title: "👑 MVP Ván Đấu",
      playerId: mvpPlayer.id,
      name: mvpPlayer.name,
      avatar: mvpPlayer.avatar,
      role: mvpPlayer.role,
      score: maxScore,
      description: mvpReason,
      color: "#fbbf24",
    });
  }

  // 1. Hộ Vệ Thần Thánh (Guard cứu người thành công)
  const guard = players.find((p) => p.role === "guard");
  if (guard && stats[guard.id].saves > 0 && guard.id !== mvpPlayer?.id) {
    awards.push({
      id: "best_guard",
      title: "🛡️ Hộ Vệ Thần Thánh",
      playerId: guard.id,
      name: guard.name,
      avatar: guard.avatar,
      role: guard.role,
      description: `Đã ${stats[guard.id].saves} lần chặn đứng móng vuốt của Sói trong đêm!`,
      color: "#3b82f6",
    });
  }

  // 2. Mắt Thần Vô Song (Seer soi ra Sói)
  const seer = players.find((p) => p.role === "seer");
  if (seer && stats[seer.id].seerWolvesFound > 0 && seer.id !== mvpPlayer?.id) {
    awards.push({
      id: "best_seer",
      title: "🔮 Mắt Thần Vô Song",
      playerId: seer.id,
      name: seer.name,
      avatar: seer.avatar,
      role: seer.role,
      description: `Đã vạch trần ${stats[seer.id].seerWolvesFound} Sói ẩn mình trong làng!`,
      color: "#6366f1",
    });
  }

  // 3. Diễn Viên Oscar / Cú Lừa Thế Kỷ (Tanner thắng hoặc Sói diễn sâu)
  const tanner = players.find((p) => p.role === "tanner");
  if (winner === "tanner" && tanner && tanner.id !== mvpPlayer?.id) {
    awards.push({
      id: "best_actor",
      title: "🎭 Cú Lừa Thế Kỷ",
      playerId: tanner.id,
      name: tanner.name,
      avatar: tanner.avatar,
      role: tanner.role,
      description: "Đánh lừa cả làng treo cổ mình để giành chiến thắng vang dội!",
      color: "#ec4899",
    });
  } else if (winner === "wolf") {
    const survivingWolf = players.find((p) => p.role === "wolf" && p.alive && p.id !== mvpPlayer?.id);
    if (survivingWolf) {
      awards.push({
        id: "best_actor",
        title: "🎭 Diễn Viên Oscar",
        playerId: survivingWolf.id,
        name: survivingWolf.name,
        avatar: survivingWolf.avatar,
        role: survivingWolf.role,
        description: "Ngụy trang hoàn hảo, sống sót qua mọi nghi ngờ của dân làng!",
        color: "#f43f5e",
      });
    }
  }

  // 4. Đao Phủ Quyết Đoán (Bỏ nhiều phiếu Treo nhất)
  let maxHangVotes = 0;
  let executioner = null;
  players.forEach((p) => {
    if (stats[p.id].totalHangVotes > maxHangVotes && p.id !== mvpPlayer?.id) {
      maxHangVotes = stats[p.id].totalHangVotes;
      executioner = p;
    }
  });
  if (executioner && maxHangVotes >= 1) {
    awards.push({
      id: "executioner",
      title: "🪓 Đao Phủ Quyết Đoán",
      playerId: executioner.id,
      name: executioner.name,
      avatar: executioner.avatar,
      role: executioner.role,
      description: `Bỏ ${maxHangVotes} phiếu treo cổ, kiên quyết diệt trừ hiểm họa!`,
      color: "#f97316",
    });
  }

  // 5. Nạn Nhân Vô Tội (Chết Đêm 1)
  const night1Death = history.find((h) => h.day === 1 && h.type === "death");
  if (night1Death && night1Death.targetId && night1Death.targetId !== mvpPlayer?.id) {
    const victim = players.find((p) => p.id === night1Death.targetId);
    if (victim) {
      awards.push({
        id: "martyr",
        title: "🕊️ Nạn Nhân Vô Tội",
        playerId: victim.id,
        name: victim.name,
        avatar: victim.avatar,
        role: victim.role,
        description: "Chưa kịp cất lời đã bị tiễn về cõi vĩnh hằng ngay Đêm 1!",
        color: "#94a3b8",
      });
    }
  }

  return awards;
}
