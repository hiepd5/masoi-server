import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as GE from "../gameEngine.js";
import { generateDefaultRoles, generateExpandedV33Roles, assignCustomRoles } from "../roles.js";
import {
  createRoom,
  addPlayer,
  addSpectator,
  findOrCreateQuickMatchRoom,
  resetRoomToLobby,
  publicSpectatorView,
  BOT_PERSONAS,
  removePlayer,
  reconnectByToken,
  setRoomAccess,
  setRoomTurbo,
  setRoomUniverse,
  setRoomMcPacingMode,
  setSoloPracticeRole,
  setPlayerCitizenModel,
  setRolesConfig,
  addBotsToRoom,
  removeBotsFromRoom,
  clearBotsFromRoom,
  getPublicRoomsList,
  getRoom,
  deleteRoom,
  hasValidActiveSessionToken,
  publicRoomView,
  getGlobalServerRuntimeMetrics,
} from "../rooms.js";
import {
  filterVietnameseProfanity,
  getVietnamGoldenHourInfo,
  recordPlayerReport,
  getModerationStats,
} from "../moderationAndStats.js";
import {
  TEEN_ACADEMY_SPECS,
  UNIVERSE_ANIME_SPECS,
  BUILTIN_VILLAGER_IDS,
  resolveCitizenAvatarSpec,
} from "../defaultNames.js";
import {
  getUniverseOnboardingAvatars,
  resolveAlignedCitizenModelForUniverse,
  ANIME_AVATAR_3D_LOOKS,
} from "../../client/src/config/citizenAvatars.config.js";
import { adaptTextForUniverse, normalizeUniverseId } from "../universeThemes.js";
import {
  isOriginAllowed,
  checkIpRateLimit,
  recordPasswordFailure,
  getPasswordLockRemainingSec,
  clearPasswordFailures,
  sanitizeAvatarUrl,
  sanitizeCitizenModelId,
  sanitizeChatText,
  isSafeReactionEmoji,
} from "../securityGuard.js";
import { createGameController } from "../gameController.js";
import {
  registerDevSocketHandlers,
  buildZeroLeakBotLine,
  flushBotInteractionsForCurrentPhase,
  devSimulateRecap,
  devSwitchUniverseLive,
} from "../devSandbox.js";
import { UNIVERSE_THEMES } from "../../client/src/config/universeThemes.config.js";
import {
  UNIVERSE_RECAP_WINNER_CONFIG,
  UNIVERSE_RECAP_UI_LABELS,
  formatUniverseRecapBeat,
  localizeBeatForUniverse,
} from "../../client/src/config/universeRecapScripts.js";
import {
  FORBIDDEN_MC_VOICE_ID,
  BOT_VOICE_CATALOG,
  estimateMcSpeechMs,
  resolveEffectiveMcPacingMode,
  pickZeroLeakBotSpeech,
} from "../botVoiceCatalog.js";
import {
  normalizeTtsText,
  getTtsCacheKey,
  deriveStoryNarrationsFromRoom,
  buildOpeningVoicePlan,
  getVoiceEngineStatus,
  DEFAULT_VOICE_ID,
  DEFAULT_TTS_SPEED,
} from "../storyVoiceEngine.js";
import {
  DEFAULT_STUN_SERVERS,
  resolveVoiceParticipant,
  canListenerHearSpeakerInRoom,
  canSpeakerTransmitNow,
  isValidSignalPayload,
  registerVoiceRelaySocketHandlers,
  removeSocketFromVoiceRelay,
  getVoiceRelayRuntimeStats,
} from "../voiceRelayHub.js";

const startTime = performance.now();
const results = [];

function runScenario(name, fn) {
  const t0 = performance.now();
  try {
    fn();
    const ms = (performance.now() - t0).toFixed(1);
    results.push({ ok: true, name, ms });
    console.log(`  ✅ PASS [${ms}ms] — ${name}`);
  } catch (err) {
    const ms = (performance.now() - t0).toFixed(1);
    results.push({ ok: false, name, ms, error: err.message });
    console.error(`  ❌ FAIL [${ms}ms] — ${name}\n     ↳ ${err.message}`);
  }
}

function makeTestRoom(roleMap) {
  const entries = Object.entries(roleMap);
  const room = createRoom("host_sock");
  entries.forEach(([key, role], idx) => {
    const sock = `sock_${key}_${idx}`;
    const { player } = addPlayer(room.code, sock, `Player_${key}`);
    player.ready = true;
  });
  const counts = {};
  entries.forEach(([, role]) => {
    counts[role] = (counts[role] || 0) + 1;
  });
  room.rolesConfig = counts;
  GE.initGameState(room);
  // Ép đúng vai cố định để kiểm thử tất định 100%
  entries.forEach(([, role], idx) => {
    room.players[idx].role = role;
    room.players[idx].initialRole = role;
    room.players[idx].alive = true;
  });
  GE.syncInitialRoleState(room);
  return room;
}

console.log("==============================================================");
console.log("  🐺 MA SOI ONLINE — TIER-1 HEADLESS AUTO-SIMULATION SUITE");
console.log("==============================================================");

// 1. Chia đủ 8 vai & bảo mật ẩn vai trong publicRoomView
runScenario("01. Chia đủ 8 vai chuẩn & ẩn vai người sống trong publicRoomView", () => {
  const cfg = generateDefaultRoles(9);
  const ids = Array.from({ length: 9 }, (_, i) => `p${i}`);
  const { assignment } = assignCustomRoles(ids, cfg);
  assert.equal(assignment.size, 9);

  const room = makeTestRoom({
    w1: "wolf", w2: "wolf", g1: "guard", wt: "witch",
    sr: "seer", tg: "tough_guy", cs: "cursed", tn: "tanner", vl: "villager"
  });
  const villager = room.players.find((p) => p.role === "villager");
  const view = publicRoomView(room, villager.socketId);
  const seenRoles = view.players.filter((p) => p.role !== null);
  assert.equal(seenRoles.length, 1, "Người sống chỉ được thấy duy nhất vai của chính mình");
  assert.equal(seenRoles[0].id, villager.id);
});

// 2. Bảo Vệ chặn bảo vệ trùng 2 đêm liên tiếp & chặn người chết
runScenario("02. Bảo Vệ chặn trùng 2 đêm liên tiếp & chặn bảo vệ người chết", () => {
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager", v2: "villager"
  });
  const guard = room.players.find((p) => p.role === "guard");
  const v1 = room.players.find((p) => p.name === "Player_v1");
  const v2 = room.players.find((p) => p.name === "Player_v2");

  assert.equal(GE.guardProtect(room, guard.id, v1.id).ok, true);
  GE.endGuardPhase(room);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  GE.endSeerPhase(room);
  GE.resolveNightDeaths(room);
  GE.startNextNight(room);

  // Đêm 2: cố tình bảo vệ trùng v1 -> phải bị chặn
  const dup = GE.guardProtect(room, guard.id, v1.id);
  assert.ok(dup.error, "Phải chặn bảo vệ trùng người đêm trước");

  // Bảo vệ người chết -> phải bị chặn
  v2.alive = false;
  const deadProtect = GE.guardProtect(room, guard.id, v2.id);
  assert.ok(deadProtect.error, "Phải chặn bảo vệ người đã chết");
});

// 3. Sói cắn trúng người được Bảo Vệ gác -> Đêm bình yên
runScenario("03. Sói cắn trúng người Bảo Vệ đang gác -> Không ai chết", () => {
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager", v2: "villager"
  });
  const guard = room.players.find((p) => p.role === "guard");
  const wolf = room.players.find((p) => p.role === "wolf");
  const v1 = room.players.find((p) => p.name === "Player_v1");

  GE.guardProtect(room, guard.id, v1.id);
  GE.endGuardPhase(room);
  GE.wolfPick(room, wolf.id, v1.id);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  GE.endSeerPhase(room);
  const deaths = GE.resolveNightDeaths(room);

  assert.equal(deaths.length, 0);
  assert.equal(v1.alive, true);
});

// 4. Phù Thủy dùng bình Cứu & bình Độc (chặn dùng lần 2)
runScenario("04. Phù Thủy cứu người bị cắn & quăng độc giết Sói (chặn dùng lần 2)", () => {
  const room = makeTestRoom({
    w1: "wolf", w2: "wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager"
  });
  const w1 = room.players.find((p) => p.name === "Player_w1");
  const witch = room.players.find((p) => p.role === "witch");
  const v1 = room.players.find((p) => p.name === "Player_v1");

  GE.endGuardPhase(room);
  GE.wolfPick(room, w1.id, v1.id);
  GE.endWolfPhase(room);

  const act = GE.witchDecide(room, witch.id, { save: true, poisonTargetId: w1.id });
  assert.equal(act.ok, true);
  // Cố tình dùng lại bình cứu ngay lập tức -> phải báo lỗi
  const reuse = GE.witchDecide(room, witch.id, { save: true });
  assert.ok(reuse.error);

  GE.endWitchPhase(room);
  GE.endSeerPhase(room);
  const deaths = GE.resolveNightDeaths(room);

  assert.equal(v1.alive, true, "Nạn nhân được Phù Thủy cứu phải sống");
  assert.equal(w1.alive, false, "Sói bị trúng độc phải chết");
  assert.deepEqual(deaths, [w1.id]);
});

// 5. Người Cứng Cỏi (tough_guy) sống qua ngày bị cắn, chết ở đêm kế tiếp & không trùng log
runScenario("05. Người Cứng Cỏi chịu đòn sống thêm 1 ngày, đêm sau chết (không lặp log)", () => {
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", tg: "tough_guy", v1: "villager"
  });
  const wolf = room.players.find((p) => p.role === "wolf");
  const tg = room.players.find((p) => p.role === "tough_guy");

  GE.endGuardPhase(room);
  GE.wolfPick(room, wolf.id, tg.id);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  GE.endSeerPhase(room);
  const deathsNight1 = GE.resolveNightDeaths(room);

  assert.equal(deathsNight1.length, 0, "Đêm 1 Người Cứng Cỏi chưa chết ngay");
  assert.equal(tg.alive, true);

  // Sang Đêm 2: Sói không cắn ai, Người Cứng Cỏi tự gục vì vết thương cũ
  GE.startNextNight(room);
  GE.endGuardPhase(room);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  GE.endSeerPhase(room);
  const deathsNight2 = GE.resolveNightDeaths(room);

  assert.deepEqual(deathsNight2, [tg.id]);
  assert.equal(tg.alive, false);
  const tgDeathEvents = room.game.history.filter((h) => h.type === "death" && h.targetId === tg.id);
  assert.equal(tgDeathEvents.length, 1, "Không được trùng lặp sự kiện death trong Recap");
});

// 6 & 7. Kẻ Bị Nguyền hóa Sói + Tiên Tri soi đổi từ Dân sang Sói
runScenario("06. Kẻ Bị Nguyền bị Sói cắn -> Hóa thành Sói thay vì chết", () => {
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", cs: "cursed", v1: "villager", v2: "villager"
  });
  const wolf = room.players.find((p) => p.role === "wolf");
  const cursed = room.players.find((p) => p.role === "cursed");

  GE.endGuardPhase(room);
  GE.wolfPick(room, wolf.id, cursed.id);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  GE.endSeerPhase(room);
  const deaths = GE.resolveNightDeaths(room);

  assert.equal(deaths.length, 0);
  assert.equal(cursed.alive, true);
  assert.equal(cursed.role, "wolf", "Kẻ Bị Nguyền phải chuyển role sang wolf");
});

runScenario("07. Tiên Tri soi chuẩn Dân (not_wolf) và soi chuẩn Sói (wolf)", () => {
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", cs: "cursed", v1: "villager"
  });
  const wolf = room.players.find((p) => p.role === "wolf");
  const seer = room.players.find((p) => p.role === "seer");
  const cursed = room.players.find((p) => p.role === "cursed");

  // Đêm 1: Tiên tri soi Kẻ Bị Nguyền trước khi bị cắn -> not_wolf
  GE.endGuardPhase(room);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  const res1 = GE.seerCheck(room, seer.id, cursed.id);
  assert.equal(res1.result, "not_wolf");
  GE.endSeerPhase(room);
  GE.resolveNightDeaths(room);

  // Đêm 2: Sói cắn Kẻ Bị Nguyền -> hóa Sói; Đêm 3 Tiên Tri soi lại -> wolf
  GE.startNextNight(room);
  GE.endGuardPhase(room);
  GE.wolfPick(room, wolf.id, cursed.id);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  GE.endSeerPhase(room);
  GE.resolveNightDeaths(room);

  GE.startNextNight(room);
  GE.endGuardPhase(room);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  const res2 = GE.seerCheck(room, seer.id, cursed.id);
  assert.equal(res2.result, "wolf");
});

// 8. Đề cử đồng phiếu & Ghế Nóng Biện Hộ tuần tự (hotSeatIndex -1 -> 0 -> 1)
runScenario("08. Đề cử đồng phiếu đưa cả 2 lên Ghế Nóng biện hộ đúng thứ tự (không nhảy cóc)", () => {
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager", v2: "villager"
  });
  const [p0, p1, p2, p3] = room.players;
  GE.startNomination(room);
  assert.equal(room.game.hotSeatIndex, -1);

  GE.nominationVote(room, p0.id, p2.id); // 1 phiếu cho p2
  GE.nominationVote(room, p1.id, p3.id); // 1 phiếu cho p3 (hòa 1-1)

  const { nominees } = GE.finalizeNomination(room);
  assert.equal(nominees.length, 2);

  const turn1 = GE.nextDefenseOrFinalVote(room);
  assert.equal(turn1.phase, "day_defense");
  assert.equal(turn1.currentDefendantId, nominees[0].playerId);

  const turn2 = GE.nextDefenseOrFinalVote(room);
  assert.equal(turn2.phase, "day_defense");
  assert.equal(turn2.currentDefendantId, nominees[1].playerId);

  const voteTurn = GE.nextDefenseOrFinalVote(room);
  assert.equal(voteTurn.phase, "day_final_vote");
  assert.equal(voteTurn.currentDefendantId, nominees[0].playerId);
});

// 9. Treo cổ Chán Đời (tanner) -> Thắng riêng ngay lập tức + tính Awards chuẩn
runScenario("09. Treo cổ Chán Đời (tanner) kích hoạt thắng riêng & xuất bảng Awards MVP", () => {
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", tn: "tanner", v1: "villager"
  });
  const tanner = room.players.find((p) => p.role === "tanner");
  const others = room.players.filter((p) => p.id !== tanner.id);

  GE.startNomination(room);
  GE.nominationVote(room, others[0].id, tanner.id);
  GE.finalizeNomination(room);
  GE.nextDefenseOrFinalVote(room); // biện hộ
  GE.nextDefenseOrFinalVote(room); // chuyển sang day_final_vote

  others.forEach((p) => GE.finalVote(room, p.id, "hang"));
  const verdict = GE.resolveFinalVote(room);

  assert.equal(verdict.hanged, true);
  assert.equal(verdict.tannerWin, true);
  assert.equal(room.game.winner, "tanner");

  const awards = GE.computeMatchAwards(room);
  assert.ok(awards.length >= 1, "Phải tính được danh hiệu MVP cuối ván");
});

// 10. Điều kiện thắng Phe Dân / Phe Sói
runScenario("10. Điều kiện thắng Phe Dân (hết Sói) & Phe Sói (Sói >= Dân)", () => {
  const roomVillage = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager", v2: "villager"
  });
  roomVillage.players.find((p) => p.role === "wolf").alive = false;
  assert.equal(GE.checkWinCondition(roomVillage), "village");

  const roomWolf = makeTestRoom({
    w1: "wolf", w2: "wolf", g1: "guard", wt: "witch", v1: "villager", v2: "villager"
  });
  // Cho chết 2 dân -> còn 2 Sói vs 2 Dân -> Sói thắng ngay
  roomWolf.players.find((p) => p.role === "guard").alive = false;
  roomWolf.players.find((p) => p.role === "witch").alive = false;
  assert.equal(GE.checkWinCondition(roomWolf), "wolf");
});

// 11. Kiểm chứng DevSandbox 1-Tab Solo: Bơm Bot đủ 6 người + Ép vai + Tua Phase + Bot Vote
runScenario("11. DevSandbox Solo: +5 Bot tự Ready, Ép vai Phù Thủy, Tua Phase & Bot Vote", () => {
  const fakeIo = { to: () => ({ emit: () => {} }) };
  const gameCtrl = createGameController(fakeIo);
  const room = createRoom("host_dev");
  const { player: host } = addPlayer(room.code, "host_dev", "HostSolo");

  const handlers = {};
  const mockSocket = {
    id: "host_dev",
    data: { roomCode: room.code, playerId: host.id },
    on: (ev, fn) => { handlers[ev] = fn; },
  };
  registerDevSocketHandlers(mockSocket, gameCtrl, () => {});

  // Bơm đủ 6 người (thêm 5 Bot)
  let addRes;
  handlers["dev:addBots"]({ fillToMin: true }, (r) => { addRes = r; });
  assert.equal(addRes.total, 6);
  assert.equal(room.players.filter((p) => p.isBot && p.ready).length, 5);

  // Ép vai Chán Đời (tanner — mặc định phòng 6 người có tanner=0, phải tự cân bằng rolesConfig!)
  handlers["dev:forceRole"]({ role: "tanner" }, () => {});
  const startRes = gameCtrl.startGame(room);
  assert.equal(startRes.ok, true, "Bắt đầu game với vai ép tanner ở phòng 6 người phải thành công");
  assert.equal(host.role, "tanner", "Host phải nhận đúng vai Chán Đời đã ép");

  // Đổi nóng sang Phù Thủy ngay trong trận + Tua qua các phase Mở màn -> Đêm -> Thảo luận -> Đề cử
  assert.equal(room.game.phase, "role_reveal", "Ván đấu mới phải mở màn ở pha độc lập role_reveal (6.0s)");
  handlers["dev:forceRole"]({ role: "witch" }, () => {});
  assert.equal(host.role, "witch");

  handlers["dev:skipPhase"]({}, () => {}); // role_reveal -> night_guard
  handlers["dev:skipPhase"]({}, () => {}); // night_guard -> night_wolf
  handlers["dev:skipPhase"]({}, () => {}); // night_wolf -> night_witch
  handlers["dev:skipPhase"]({}, () => {}); // night_witch -> night_seer
  handlers["dev:skipPhase"]({}, () => {}); // night_seer -> day_reveal
  handlers["dev:skipPhase"]({}, () => {}); // day_reveal -> day_discuss
  assert.equal(room.game.phase, "day_discuss");

  // Bot đồng loạt bấm Skip thảo luận + Host skip (nếu còn sống sau đêm Sói săn) -> tự sang day_nominate
  handlers["dev:botVote"]({ action: "skip_discuss" }, () => {});
  if (host.alive && room.game.phase === "day_discuss") {
    const hostSkip = gameCtrl.voteSkipDiscussion(room, host.id);
    if (hostSkip.allSkipped) {
      gameCtrl.clearRoomTimer(room.code);
      gameCtrl.forceEndDiscussion(room);
    }
  }
  assert.equal(room.game.phase, "day_nominate");

  // Bot đề cử Sói lên ghế nóng -> Tua qua Biện hộ -> Bot vote Treo cổ
  handlers["dev:botVote"]({ action: "nominate_wolf" }, () => {});
  handlers["dev:skipPhase"]({}, () => {}); // finalizeNomination -> day_defense
  assert.equal(room.game.phase, "day_defense");
  handlers["dev:skipPhase"]({}, () => {}); // finishDefenseTurn -> day_final_vote
  assert.equal(room.game.phase, "day_final_vote");
  handlers["dev:botVote"]({ action: "vote_hang" }, () => {});
  const expectedAliveBots = room.players.filter((p) => p.isBot && p.alive).length;
  assert.equal(Object.values(room.game.finalVotes).filter((v) => v === "hang").length, expectedAliveBots);
  assert.ok(
    room.game.replayTimeline.length >= 4,
    "Khi bấm Tua Nhanh Phase (dev:skipPhase), hệ thống vẫn phải ghi đầy đủ băng Replay tương tác Bot"
  );

  gameCtrl.clearRoomTimer(room.code);
});

// 12. Kiểm chứng Ngày 1 3D: Cố định seatIndex khi Reconnect, deadWolfCount chuẩn & bảo mật initialRole
runScenario("12. 3D Stage Ready: seatIndex cố định, deadWolfCount chuẩn & ẩn initialRole trước cuối trận", () => {
  const room = makeTestRoom({
    w1: "wolf", w2: "wolf", g1: "guard", wt: "witch", cs: "cursed", v1: "villager"
  });
  const villager = room.players.find((p) => p.role === "villager");
  const w1 = room.players.find((p) => p.name === "Player_w1");

  // Kiểm tra seatIndex 0..5 liên tục & initialRole bị ẩn khi đang chơi
  const viewStart = publicRoomView(room, villager.socketId);
  assert.deepEqual(
    viewStart.players.map((p) => p.seatIndex),
    [0, 1, 2, 3, 4, 5],
    "seatIndex phải tuần tự 0..5 cho vòng ghế 3D"
  );
  assert.equal(viewStart.players[0].initialRole, undefined, "Không lộ initialRole khi trận chưa kết thúc");
  assert.equal(viewStart.game.deadWolfCount, 0);

  // Khi 1 Sói chết -> deadWolfCount tăng lên 1 để HUD Phe Dân đếm chuẩn Sói còn lại
  w1.alive = false;
  const viewMid = publicRoomView(room, villager.socketId);
  assert.equal(viewMid.game.deadWolfCount, 1, "deadWolfCount phải tăng lên 1 khi 1 Sói chết");
});

// 13. Kiểm chứng Shadow Reality Recorder & Khóa Bảo Mật Zero-Leak Kết Game 100vw
runScenario("13. Shadow Reality Recorder: ghi trọn tương tác Đêm/Ngày (kể cả đổi ý) & khóa Zero-Leak 100%", () => {
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager", v2: "villager"
  });
  const wolf = room.players.find((p) => p.role === "wolf");
  const guard = room.players.find((p) => p.role === "guard");
  const witch = room.players.find((p) => p.role === "witch");
  const seer = room.players.find((p) => p.role === "seer");
  const v1 = room.players.find((p) => p.name === "Player_v1");
  const v2 = room.players.find((p) => p.name === "Player_v2");

  // Đêm 1: Bảo vệ gác v1; Sói nhắm v1 rồi đổi ý sang v2; Phù thủy cứu v2; Tiên tri soi trúng Sói
  GE.guardProtect(room, guard.id, v1.id);
  GE.endGuardPhase(room);

  GE.wolfPick(room, wolf.id, v1.id);
  room.game.replayTimeline[room.game.replayTimeline.length - 1].ts -= 400; // mô phỏng cách nhau >250ms
  GE.recordReplayEvent(room, {
    kind: "wolf_chat",
    phase: "night_wolf",
    actorId: wolf.id,
    actorRole: "wolf",
    targetId: v2.id,
    chatText: "Khoan, v1 có Bảo Vệ gác rồi, chuyển sang cắn v2 đi!",
  });
  GE.wolfPick(room, wolf.id, v2.id);
  GE.endWolfPhase(room);

  GE.witchDecide(room, witch.id, { save: true });
  GE.endWitchPhase(room);

  GE.seerCheck(room, seer.id, wolf.id);
  GE.endSeerPhase(room);
  GE.resolveNightDeaths(room);

  // KIỂM TRA BẢO MẬT ZERO-LEAK GIỮA VÁN: Người chơi tuyệt đối nhận replayTimeline = []
  const midLiveView = publicRoomView(room, v1.socketId);
  assert.deepEqual(
    midLiveView.game.replayTimeline,
    [],
    "Zero-Leak: cấm rò rỉ dù chỉ 1 byte replayTimeline khi ván đấu chưa kết thúc!"
  );

  // Ban ngày: Dân làng chat + v1 chỉ tay v2 rồi quay ngoắt đổi sang chỉ mặt Sói -> Treo cổ Sói -> Phe Dân thắng!
  GE.startDiscussion(room);
  GE.recordReplayEvent(room, {
    kind: "village_chat",
    phase: "day_discuss",
    actorId: seer.id,
    chatText: "Đêm qua tôi đã soi thấy Sói rồi, mọi người theo tôi!",
  });
  GE.startNomination(room);
  GE.nominationVote(room, v1.id, v2.id);
  room.game.replayTimeline[room.game.replayTimeline.length - 1].ts -= 400;
  GE.nominationVote(room, v1.id, wolf.id);
  GE.nominationVote(room, seer.id, wolf.id);
  GE.finalizeNomination(room);
  GE.nextDefenseOrFinalVote(room); // day_defense
  GE.nextDefenseOrFinalVote(room); // day_final_vote
  GE.finalVote(room, v1.id, "hang");
  GE.finalVote(room, seer.id, "hang");
  GE.finalVote(room, guard.id, "hang");
  GE.resolveFinalVote(room);
  const win = GE.checkWinCondition(room);
  assert.equal(win, "village");

  // KIỂM TRA SAU KHI CÓ WINNER: publicRoomView mở khóa toàn bộ băng ghi hình không gian thật!
  const endGameView = publicRoomView(room, v1.socketId);
  const tl = endGameView.game.replayTimeline;
  assert.ok(tl.length >= 10, `Phải ghi lại đầy đủ >=10 cảnh tương tác thật (thực tế: ${tl.length})`);

  const kinds = new Set(tl.map((f) => f.kind));
  for (const requiredKind of [
    "guard_pick",
    "wolf_aim",
    "wolf_chat",
    "wolf_strike",
    "witch_save",
    "seer_scan",
    "peaceful_dawn",
    "village_chat",
    "day_nominate",
    "day_defense",
    "day_final_vote",
    "day_verdict",
  ]) {
    assert.ok(kinds.has(requiredKind), `Thiếu loại khung hình Replay bắt buộc: ${requiredKind}`);
  }

  // Kiểm tra bắt trọn khoảnh khắc Sói đổi ý & Dân đổi mũi dùi chỉ tay (prevTargetId)
  const wolfSwitchFrame = tl.find((f) => f.kind === "wolf_aim" && f.prevTargetId === v1.id && f.targetId === v2.id);
  assert.ok(wolfSwitchFrame, "Phải ghi lại đúng khoảnh khắc Sói đổi móng vuốt từ v1 sang v2");

  const daySwitchFrame = tl.find((f) => f.kind === "day_nominate" && f.prevTargetId === v2.id && f.targetId === wolf.id);
  assert.ok(daySwitchFrame, "Phải ghi lại đúng khoảnh khắc người chơi đổi tay đề cử từ v2 sang Sói");
});

// 14. V3.3 — Preset Mở Rộng & Sói Đầu Đàn (alpha_wolf) Huyết Nguyệt Đồng Hóa + Tiên Tri soi đúng
runScenario("14. V3.3: Preset Mở Rộng cân bằng (6..16p) & Sói Đầu Đàn đồng hóa nạn nhân thành Sói", () => {
  for (const n of [6, 7, 8, 9, 10, 12, 16]) {
    const exp = generateExpandedV33Roles(n);
    const sum = Object.values(exp).reduce((a, b) => a + b, 0);
    assert.equal(sum, n, `Preset Mở Rộng V3.3 với ${n} người phải khớp tổng vai (${sum})`);
    assert.equal(exp.alpha_wolf, 1);
    assert.equal(exp.hunter, 1);
    assert.equal(exp.cupid, 1);
    assert.equal(exp.mayor, 1);
  }

  const room = makeTestRoom({
    aw: "alpha_wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager", v2: "villager"
  });
  const alpha = room.players.find((p) => p.role === "alpha_wolf");
  const seer = room.players.find((p) => p.role === "seer");
  const v1 = room.players.find((p) => p.name === "Player_v1");

  GE.endGuardPhase(room);
  assert.equal(GE.wolfAlphaToggle(room, alpha.id, true).ok, true);
  assert.equal(GE.wolfPick(room, alpha.id, v1.id).ok, true);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  const scanAlpha = GE.seerCheck(room, seer.id, alpha.id);
  assert.equal(scanAlpha.result, "wolf", "Tiên Tri soi Sói Đầu Đàn phải trả về 'wolf'");
  GE.endSeerPhase(room);

  const deaths = GE.resolveNightDeaths(room);
  assert.equal(deaths.length, 0, "Nạn nhân bị Huyết Nguyệt Đồng Hóa không chết lúc bình minh");
  assert.equal(v1.alive, true);
  assert.equal(v1.role, "wolf", "Nạn nhân phải hóa thành Sói");
  assert.equal(room.game.alphaUsedConvert, true);

  // Đêm 2: Sói Đầu Đàn cố bật lại Huyết Nguyệt -> phải bị chặn (chỉ 1 lần/ván)
  GE.startNextNight(room);
  GE.endGuardPhase(room);
  assert.ok(GE.wolfAlphaToggle(room, alpha.id, true).error, "Chỉ dùng Huyết Nguyệt 1 lần mỗi ván");
});

// 15. V3.3 — Dây chuyền kép: Cupid ghép đôi -> Tình Nhân chết kéo Thợ Săn chết theo -> Mở 15s bắn hạ Sói!
runScenario("15. V3.3: Tình Nhân chết kéo Thợ Săn gục theo -> Kích hoạt 15s bắn đạn bạc hạ gục Sói", () => {
  const room = makeTestRoom({
    w1: "wolf", cp: "cupid", ht: "hunter", g1: "guard", sr: "seer", v1: "villager"
  });
  const wolf = room.players.find((p) => p.role === "wolf");
  const cupid = room.players.find((p) => p.role === "cupid");
  const hunter = room.players.find((p) => p.role === "hunter");
  const v1 = room.players.find((p) => p.name === "Player_v1");
  const seer = room.players.find((p) => p.role === "seer");

  // Có Cupid nên Đêm 1 phải bắt đầu ở night_cupid
  assert.equal(room.game.phase, "night_cupid");
  assert.equal(GE.cupidLink(room, cupid.id, [v1.id, hunter.id]).ok, true);

  // Kiểm chứng Zero-Leak: v1 biết hunter là người thương, nhưng seer ngoài cuộc KHÔNG được biết!
  const v1View = publicRoomView(room, v1.socketId);
  const seerView = publicRoomView(room, seer.socketId);
  assert.equal(v1View.game.myLoverPartnerId, hunter.id);
  assert.equal(seerView.game.myLoverPartnerId, null);

  GE.endCupidPhase(room);
  assert.equal(room.game.phase, "night_guard");
  GE.endGuardPhase(room);
  GE.wolfPick(room, wolf.id, v1.id); // Sói cắn v1 (nửa kia của Thợ Săn!)
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  GE.endSeerPhase(room);

  const dawnDeaths = GE.resolveNightDeaths(room);
  assert.equal(dawnDeaths.length, 2, "Cả v1 và Thợ Săn phải cùng ngã xuống do dây chuyền Tơ Hồng");
  assert.equal(hunter.alive, false);
  assert.equal(room.game.phase, "hunter_revenge", "Dù chết theo Tình Nhân, Thợ Săn vẫn mở pha 15s bắn trả thù");
  assert.equal(room.game.hunterPendingId, hunter.id);
  assert.equal(GE.checkWinCondition(room), null, "Chưa được xử thắng thua khi Thợ Săn chưa bóp cò");

  // Thợ Săn bóp cò bắn trúng Sói -> Phe Dân lật kèo chiến thắng!
  const shot = GE.hunterShoot(room, hunter.id, wolf.id);
  assert.equal(shot.ok, true);
  assert.equal(wolf.alive, false);
  assert.equal(GE.checkWinCondition(room), "village");
});

// 16. V3.3 — Cặp Đôi Khác Chiến Tuyến (Sói - Dân) trụ lại 2 người cuối -> Thắng riêng Phe Cặp Đôi ('lovers')
runScenario("16. V3.3: Cặp Đôi Khác Chiến Tuyến (Sói - Dân) trụ lại 2 người cuối kích hoạt thắng 'lovers'", () => {
  const room = makeTestRoom({
    w1: "wolf", cp: "cupid", g1: "guard", wt: "witch", sr: "seer", v1: "villager"
  });
  const wolf = room.players.find((p) => p.role === "wolf");
  const cupid = room.players.find((p) => p.role === "cupid");
  const v1 = room.players.find((p) => p.name === "Player_v1");

  GE.cupidLink(room, cupid.id, [wolf.id, v1.id]);
  GE.endCupidPhase(room);

  // Giả lập các người chơi ngoài cuộc đã ngã xuống, chỉ còn đúng cặp đôi Sói (w1) & Dân (v1)
  room.players.forEach((p) => {
    if (p.id !== wolf.id && p.id !== v1.id) p.alive = false;
  });

  const winner = GE.checkWinCondition(room);
  assert.equal(winner, "lovers", "Cặp đôi Sói - Dân sống sót 2 người cuối phải thắng với tư cách 'lovers'");
});

// 17. V3.3 — Trưởng Làng (mayor) công bố Quyền Trượng ban ngày -> Lá phiếu tính x2 cả Đề Cử & Pháp Trường
runScenario("17. V3.3: Trưởng Làng công bố Quyền Trượng kích hoạt lá phiếu x2 ở Đề Cử & Treo Cổ", () => {
  const room = makeTestRoom({
    w1: "wolf", my: "mayor", g1: "guard", wt: "witch", sr: "seer", v1: "villager"
  });
  const wolf = room.players.find((p) => p.role === "wolf");
  const mayor = room.players.find((p) => p.role === "mayor");
  const guard = room.players.find((p) => p.role === "guard");
  const witch = room.players.find((p) => p.role === "witch");

  GE.startDiscussion(room);
  assert.equal(GE.mayorReveal(room, mayor.id).ok, true);
  assert.equal(room.game.mayorRevealedId, mayor.id);

  // Đề cử: Mayor chỉ tay vào Sói (2 phiếu) vs Sói + Witch chỉ tay vào Guard (2 phiếu -> nhưng Mayor đề cử trước nên Sói lên trước, hoặc Mayor 2 phiếu thắng đứt 1 phiếu!)
  GE.startNomination(room);
  GE.nominationVote(room, mayor.id, wolf.id); // tính 2 phiếu!
  GE.nominationVote(room, wolf.id, guard.id); // tính 1 phiếu
  const { nominees } = GE.finalizeNomination(room);
  assert.equal(nominees.length, 1);
  assert.equal(nominees[0].playerId, wolf.id, "Lá phiếu x2 của Trưởng Làng phải áp đảo 2 vs 1 ở vòng Đề Cử");
  assert.equal(nominees[0].votes, 2);

  // Biện hộ -> Pháp trường: Mayor bỏ 'hang' (2 phiếu) vs Witch bỏ 'spare' (1 phiếu) -> Treo cổ Sói (2 vs 1)!
  GE.nextDefenseOrFinalVote(room);
  GE.nextDefenseOrFinalVote(room);
  GE.finalVote(room, mayor.id, "hang");
  GE.finalVote(room, witch.id, "spare");
  const verdict = GE.resolveFinalVote(room);
  assert.equal(verdict.hangCount, 2);
  assert.equal(verdict.spareCount, 1);
  assert.equal(verdict.hanged, true);
  assert.equal(wolf.alive, false);
});

// 18. V3.4 — 3 chế độ bảo mật phòng (Công khai / Mật khẩu / Phòng ẩn cần mã) & Zero-Leak mật khẩu
runScenario("18. V3.4: Phòng Công khai / Mật khẩu / Phòng ẩn cần mã & Zero-Leak password", () => {
  const pubRoom = createRoom("host_pub", { roomTitle: "Làng Mở Tự Do", accessMode: "public" });
  addPlayer(pubRoom.code, "host_pub", "Chủ Công Khai");

  const pwdRoom = createRoom("host_pwd", {
    roomTitle: "Hội Kín Đêm Trăng",
    accessMode: "password",
    password: "7788",
  });
  addPlayer(pwdRoom.code, "host_pwd", "Chủ Mật Khẩu", null, null, "7788");

  const hiddenRoom = createRoom("host_hid", {
    roomTitle: "Phòng Bí Mật Nội Bộ",
    accessMode: "hidden",
  });
  addPlayer(hiddenRoom.code, "host_hid", "Chủ Ẩn Danh");

  const list = getPublicRoomsList();
  const codesInBrowser = list.map((r) => r.code);
  assert.ok(codesInBrowser.includes(pubRoom.code), "Phòng Công khai phải hiện trên Sảnh ngoài");
  assert.ok(codesInBrowser.includes(pwdRoom.code), "Phòng Mật khẩu phải hiện trên Sảnh ngoài kèm cờ khóa");
  assert.ok(!codesInBrowser.includes(hiddenRoom.code), "Phòng Ẩn tuyệt đối KHÔNG hiện trên danh sách công khai");

  // Kiểm tra Zero-Leak password trong danh sách sảnh & publicRoomView
  const pwdEntry = list.find((r) => r.code === pwdRoom.code);
  assert.equal(pwdEntry.hasPassword, true);
  assert.equal("password" in pwdEntry, false, "Cấm rò rỉ chuỗi password ra danh sách phòng công khai");
  const pwdView = publicRoomView(pwdRoom, "host_pwd");
  assert.equal("password" in pwdView, false, "Cấm rò rỉ chuỗi password trong publicRoomView");

  // Khách vào phòng mật khẩu: không nhập / nhập sai phải bị chặn, nhập đúng vào ngay
  const missingPwd = addPlayer(pwdRoom.code, "guest_1", "Khách Lạ");
  assert.equal(missingPwd.requirePassword, true);
  const wrongPwd = addPlayer(pwdRoom.code, "guest_1", "Khách Lạ", null, null, "0000");
  assert.equal(wrongPwd.requirePassword, true);
  const rightPwd = addPlayer(pwdRoom.code, "guest_1", "Khách Lạ", null, null, "7788");
  assert.ok(rightPwd.player, "Nhập đúng mật khẩu phải vào phòng thành công");

  // Khách có Mã 5 ký tự của phòng Ẩn vẫn vào bình thường
  const joinHiddenByCode = addPlayer(hiddenRoom.code, "friend_1", "Bạn Thân");
  assert.ok(joinHiddenByCode.player, "Có Mã phòng 5 ký tự phải vào được phòng Ẩn");

  // Đổi chế độ nóng từ chủ phòng sang hidden
  const accessRes = setRoomAccess(pubRoom.code, "host_pub", { accessMode: "hidden" });
  assert.equal(accessRes.ok, true);
  assert.ok(!getPublicRoomsList().some((r) => r.code === pubRoom.code));
});

// 19. V3.4 — Chơi 1 mình không cần đủ 6 người (Tự bù AI Bot + Chọn vai Test + Tự khóa công bằng khi có người thứ 2)
runScenario("19. V3.4: Vào ván 1 mình tự bù AI Bot khớp 8 vai V3.3 & Khóa chọn vai khi có người thứ 2", () => {
  const ioStub = { to: () => ({ emit: () => {} }) };
  const ctrl = createGameController(ioStub);

  // Kịch bản A: Đúng 1 người thật chọn vai Thợ Săn & bấm Start với bộ 8 vai V3.3 (chưa bấm thêm Bot trước)
  const soloRoom = createRoom("solo_host");
  const { player: soloPlayer } = addPlayer(soloRoom.code, "solo_host", "Tester Solo");
  soloRoom.rolesConfig = generateExpandedV33Roles(8);
  const pickRes = setSoloPracticeRole(soloRoom.code, "solo_host", "hunter");
  assert.equal(pickRes.ok, true);
  assert.equal(soloRoom.soloPracticeRole, "hunter");

  const startRes = ctrl.startGame(soloRoom);
  ctrl.clearRoomTimer(soloRoom.code);
  assert.equal(startRes.ok, true, "Chỉ 1 người thật cũng phải bắt đầu ván đấu thành công");
  assert.equal(startRes.autoAddedBots, 7, "Hệ thống phải tự động bù đúng +7 AI Bot cho đủ 8 vai V3.3");
  assert.equal(soloRoom.players.length, 8);
  assert.equal(soloPlayer.role, "hunter", "Chơi 1 mình phải được nhận đúng vai Thợ Săn đã chọn để test");

  // Kịch bản B: Đang ở sảnh có 1 người chọn trước Sói Đầu Đàn, người thật thứ 2 bước vào -> tự xóa chọn vai để công bằng!
  const fairRoom = createRoom("fair_host");
  addPlayer(fairRoom.code, "fair_host", "Chủ Phòng");
  setSoloPracticeRole(fairRoom.code, "fair_host", "alpha_wolf");
  assert.equal(fairRoom.soloPracticeRole, "alpha_wolf");

  addPlayer(fairRoom.code, "second_human", "Người Chơi 2");
  assert.equal(fairRoom.soloPracticeRole, null, "Có người thật thứ 2 vào phòng phải tự động khóa chọn vai test");
  const tryForceAgain = setSoloPracticeRole(fairRoom.code, "fair_host", "seer");
  assert.ok(tryForceAgain.error, "Phải chặn chọn vai test khi phòng có >= 2 người thật");
});

// 20. V3.4 — Nhường ghế Bot khi người thật vào + Bot tự đồng thuận Skip thảo luận + Tự dọn phòng mồ côi khi rời trận
runScenario("20. V3.4: Bot tự nhường ghế ở Sảnh + Đồng thuận Skip thảo luận + Dọn sạch phòng Bot khi rời trận", () => {
  const ioStub = { to: () => ({ emit: () => {} }) };
  const ctrl = createGameController(ioStub);

  const room = createRoom("host_solo2");
  const { player: host } = addPlayer(room.code, "host_solo2", "Chủ Bàn");
  room.rolesConfig = generateExpandedV33Roles(8);
  addBotsToRoom(room.code, 7);
  assert.equal(room.players.length, 8);

  // Người thật thứ 2 vào bàn đang có 1 Người + 7 Bot (8/8) -> 1 Bot tự nhường ghế, giữ tổng 8/8 khớp 8 vai!
  const join2 = addPlayer(room.code, "human_2", "Bạn Mới");
  assert.ok(join2.player, "Người thật phải vào được bàn đang lấp sẵn Bot nhờ cơ chế Bot nhường ghế");
  join2.player.ready = true;
  assert.equal(room.players.length, 8, "Tổng số ghế phải giữ chuẩn 8/8 khớp bộ vai");
  assert.equal(room.players.filter((p) => !p.isBot).length, 2);
  assert.equal(room.players.filter((p) => p.isBot).length, 6);

  // Bắt đầu trận & sang Thảo luận ban ngày: khi cả 2 người thật bấm Skip -> 6 AI Bot tự đồng thuận Skip ngay!
  assert.equal(ctrl.startGame(room).ok, true);
  ctrl.clearRoomTimer(room.code);
  GE.startDiscussion(room);

  const skip1 = GE.voteSkipDiscussion(room, host.id);
  assert.equal(skip1.allSkipped, false, "Mới 1/2 người thật bấm Skip thì chưa được tự qua lượt");
  const skip2 = GE.voteSkipDiscussion(room, join2.player.id);
  assert.equal(skip2.allSkipped, true, "Đủ 2/2 người thật bấm Skip thì toàn bộ AI Bot phải đồng thuận Skip ngay");

  // Cả 2 người thật bấm Rời phòng giữa trận -> Phòng chỉ còn Bot phải bị xóa sạch ngay lập tức!
  const afterLeave1 = removePlayer(room.code, "host_solo2", { explicitLeave: true });
  assert.ok(afterLeave1, "Còn 1 người thật đang chơi thì phòng vẫn chạy");
  const afterLeave2 = removePlayer(room.code, "human_2", { explicitLeave: true });
  assert.equal(afterLeave2, null, "Người thật cuối cùng bấm Rời thì phòng Bot phải tự hủy ngay");
  assert.equal(getRoom(room.code), undefined);
});

// 21. V3.4 — Phòng Đang Chơi hiện tiến độ trực tiếp trên Sảnh Ngoài & chặn vào ngang giữa trận
runScenario("21. V3.4: Phòng 'playing' hiện tiến độ Ngày/Số người sống trên Sảnh & chặn khách vào giữa trận", () => {
  const ioStub = { to: () => ({ emit: () => {} }) };
  const ctrl = createGameController(ioStub);

  const liveRoom = createRoom("live_host", { roomTitle: "Trận Đấu Đỉnh Cao", accessMode: "public" });
  addPlayer(liveRoom.code, "live_host", "MC Trưởng");
  liveRoom.rolesConfig = generateDefaultRoles(6);
  assert.equal(ctrl.startGame(liveRoom).ok, true);
  ctrl.clearRoomTimer(liveRoom.code);

  const browserEntry = getPublicRoomsList().find((r) => r.code === liveRoom.code);
  assert.ok(browserEntry, "Phòng đang chơi công khai phải hiển thị trên danh sách Sảnh ngoài");
  assert.equal(browserEntry.phase, "playing");
  assert.equal(browserEntry.dayNumber, 1);
  assert.equal(browserEntry.aliveCount, 6);

  const midJoin = addPlayer(liveRoom.code, "late_guest", "Khách Đến Muộn");
  assert.ok(midJoin.error, "Phải chặn vào ngang khi ván đấu đang diễn ra");
  assert.equal(midJoin.phase, "playing");

  removePlayer(liveRoom.code, "live_host", { explicitLeave: true });
});

// 22. V3.5 — Story Voice Engine: Lọc sạch Emoji/Tiếng Anh 100%, khớp Cache Key 1:1 & bỏ qua Chat người chơi trong Replay
runScenario("22. V3.5: Story Voice Engine lọc sạch Emoji/English, khớp Cache 1:1 & bỏ qua Chat trong Replay", () => {
  assert.equal(DEFAULT_VOICE_ID, "b5d182f3");
  assert.equal(DEFAULT_TTS_SPEED, 0.82);

  const rawSample = "👑 [🤖 Bot Sói Xám] đạt MVP sau màn vote x2 vs AI Bot!!";
  const cleaned = normalizeTtsText(rawSample);
  assert.equal(
    cleaned,
    "Sói Xám đạt ngôi vương xuất sắc nhất sau màn bỏ phiếu nhân hai đối đầu người máy!",
    "Phải lọc sạch Emoji, bỏ tiền tố 🤖 Bot và Việt hóa 100% MVP/vote/x2/vs/AI Bot"
  );
  assert.equal(
    getTtsCacheKey("🎤 Mời 🤖 Bot Cáo Đỏ lên biện hộ. (8 giây)"),
    getTtsCacheKey("Mời [Cáo Đỏ] lên biện hộ. (8 giây)")
  );

  // Mô phỏng ván đấu có cả hành động thật và cảnh chat tự do (wolf_chat, village_chat)
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager", v2: "villager"
  });
  room.players[0].name = "🤖 Bot Sói Xám";
  const wolf = room.players[0];
  const guard = room.players.find((p) => p.role === "guard");
  const v1 = room.players.find((p) => p.name === "Player_v1");

  GE.guardProtect(room, guard.id, v1.id);
  GE.endGuardPhase(room);
  GE.recordReplayEvent(room, {
    kind: "wolf_chat",
    phase: "night_wolf",
    actorId: wolf.id,
    actorRole: "wolf",
    chatText: "Hello bro let's attack v1 tonight!",
  });
  GE.wolfPick(room, wolf.id, v1.id);
  GE.endWolfPhase(room);
  GE.endWitchPhase(room);
  GE.endSeerPhase(room);
  GE.resolveNightDeaths(room);
  GE.startDiscussion(room);
  GE.recordReplayEvent(room, {
    kind: "village_chat",
    phase: "day_discuss",
    actorId: v1.id,
    chatText: "Skip vote fast guys!",
  });

  const narrations = deriveStoryNarrationsFromRoom(room);
  assert.ok(narrations.length >= 3, "Phải trích xuất đầy đủ các nhịp kể chuyện hành động");
  assert.ok(
    narrations.every((line) => !line.includes("Hello bro") && !line.includes("Skip vote")),
    "Tuyệt đối KHÔNG đưa nội dung wolf_chat / village_chat vào giọng đọc MC"
  );
  for (const line of narrations) {
    const norm = normalizeTtsText(line);
    assert.equal(/\b(Bot|MVP|vote|x2)\b/i.test(norm), false, `Không còn từ tiếng Anh lọt vào TTS: ${norm}`);
  }
});

// 23. SEC-03 — Chặn cướp ghế giữa trận bằng trùng tên & chỉ cho phép reconnectByToken hợp lệ
runScenario("23. SEC-03: Chặn cướp ghế giữa trận bằng trùng tên; bắt buộc dùng sessionToken", () => {
  const ioStub = { to: () => ({ emit: () => {} }) };
  const ctrl = createGameController(ioStub);
  const room = createRoom("sec_host");
  const { player: host } = addPlayer(room.code, "sec_host", "HiepChuPhong");
  addBotsToRoom(room.code, 5);
  assert.equal(ctrl.startGame(room).ok, true);
  ctrl.clearRoomTimer(room.code);

  // Giả lập chủ phòng rớt mạng giữa trận, hacker cố vào phòng gõ trùng tên "HiepChuPhong"
  removePlayer(room.code, "sec_host", { explicitLeave: false });
  assert.equal(host.connected, false);

  const spoofAttempt = addPlayer(room.code, "attacker_sock", "HiepChuPhong");
  assert.ok(spoofAttempt.error, "Phải chặn đứng kẻ lạ mạo danh tên để cướp ghế đang chơi");
  assert.equal(host.socketId, "sec_host", "Socket ghế chủ phòng không được bị ghi đè bởi hacker");

  // Token giả mạo -> bị từ chối
  const fakeTokenRes = reconnectByToken(room.code, "00000000-fake-token-999999", "attacker_sock");
  assert.ok(fakeTokenRes.error, "Token giả mạo phải bị chặn");

  // Token thật của chủ phòng -> khôi phục ghế thành công!
  const validReconnect = reconnectByToken(room.code, host.sessionToken, "new_host_sock");
  assert.equal(validReconnect.player.id, host.id);
  assert.equal(host.connected, true);
  assert.equal(host.socketId, "new_host_sock");
  deleteRoom(room.code);
});

// 24. SEC-07 — Chống mở 2 Tab cùng deviceId soi bài trên bàn công khai (enforceAntiMultiTab)
runScenario("24. SEC-07: Chặn mở 2 Tab cùng deviceId vào bàn công khai khi bật enforceAntiMultiTab", () => {
  const room = createRoom("tab1_sock", { accessMode: "public" });
  const join1 = addPlayer(room.code, "tab1_sock", "Người Chơi A", null, null, "", {
    deviceId: "dev_abc123456",
    enforceAntiMultiTab: true,
  });
  assert.ok(join1.player);

  const dupTab = addPlayer(room.code, "tab2_sock", "Clone Soi Bài", null, null, "", {
    deviceId: "dev_abc123456",
    enforceAntiMultiTab: true,
  });
  assert.ok(dupTab.error, "Phải chặn Tab thứ 2 cùng deviceId nhảy vào bàn công khai");

  const diffDevice = addPlayer(room.code, "phone_sock", "Bạn Khác Máy", null, null, "", {
    deviceId: "dev_xyz987654",
    enforceAntiMultiTab: true,
  });
  assert.ok(diffDevice.player, "Thiết bị khác deviceId vào bàn bình thường");
  deleteRoom(room.code);
});

// 25. SEC-05 — Whitelist Avatar URL: Chặn XSS javascript:, link lạ, path traversal '..'
runScenario("25. SEC-05: sanitizeAvatarUrl chặn XSS/link lạ & chỉ nhận tài nguyên hợp lệ", () => {
  assert.equal(sanitizeAvatarUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeAvatarUrl("https://evil-tracker.com/pixel.png"), null);
  assert.equal(sanitizeAvatarUrl("/avatars/../../etc/passwd"), null);
  assert.equal(sanitizeAvatarUrl("x".repeat(500)), null);
  assert.equal(sanitizeAvatarUrl("/portraits/wolf_1x1.webp"), "/portraits/wolf_1x1.webp");
  assert.equal(sanitizeAvatarUrl("/avatars/villager_cloak.webp"), "/avatars/villager_cloak.webp");
  assert.equal(
    sanitizeAvatarUrl("https://api.dicebear.com/7.x/adventurer/svg?seed=test"),
    null
  );
});

// 26. SEC-04 & SEC-05 — Rate-limit IP, khóa dò mật khẩu 5 lần -> 15s, cắt Chat <= 240 ký tự & lọc Emoji an toàn
runScenario("26. SEC-04/05: Rate-limit IP, khóa sai mật khẩu 5 lần (15s), cắt Chat <= 240 ký tự", () => {
  const testIp = "203.0.113.77";
  assert.equal(checkIpRateLimit("unit_test_bucket", testIp, 2, 10_000).allowed, true);
  assert.equal(checkIpRateLimit("unit_test_bucket", testIp, 2, 10_000).allowed, true);
  const thirdHit = checkIpRateLimit("unit_test_bucket", testIp, 2, 10_000);
  assert.equal(thirdHit.allowed, false, "Lần gọi vượt ngưỡng Rate-limit phải bị chặn");
  assert.ok(thirdHit.retryAfterSec >= 1);

  clearPasswordFailures(testIp);
  for (let i = 0; i < 4; i++) {
    assert.equal(recordPasswordFailure(testIp), 0);
  }
  assert.equal(recordPasswordFailure(testIp), 15, "Sai mật khẩu lần thứ 5 phải khóa IP 15 giây");
  assert.ok(getPasswordLockRemainingSec(testIp) > 0);
  clearPasswordFailures(testIp);

  const giantText = "Sói kìa! ".repeat(80);
  const cleanChat = sanitizeChatText(giantText);
  assert.equal(cleanChat.length, 240, "Tin nhắn quá dài phải bị cắt gọn đúng 240 ký tự");

  assert.equal(isSafeReactionEmoji("🔥"), true);
  assert.equal(isSafeReactionEmoji("🐺"), true);
  assert.equal(isSafeReactionEmoji("<script>"), false);
  assert.equal(isSafeReactionEmoji("HACKED123"), false);
});

// 27. SEC-02 — Xác thực X-Game-Session cho cổng /api/tts chống leech GPU VoiceStudio
runScenario("27. SEC-02: hasValidActiveSessionToken xác thực người chơi thật & chặn token giả", () => {
  const room = createRoom("tts_host");
  const { player } = addPlayer(room.code, "tts_host", "MC Listener");
  addBotsToRoom(room.code, 2);

  assert.equal(hasValidActiveSessionToken(player.sessionToken), true);
  assert.equal(hasValidActiveSessionToken(""), false);
  assert.equal(hasValidActiveSessionToken("short_tok"), false);
  assert.equal(hasValidActiveSessionToken("11111111-2222-3333-4444-555555555555"), false);
  deleteRoom(room.code);
});

// 28. SEC-04 — Khóa CORS Whitelist cho Web chính thức, Preview Vercel & App CapacitorJS
runScenario("28. SEC-04: isOriginAllowed mở cho masoi.hiepd5.com + CapacitorJS & chặn miền lạ", () => {
  assert.equal(isOriginAllowed("https://masoi.hiepd5.com"), true);
  assert.equal(isOriginAllowed("capacitor://localhost"), true);
  assert.equal(isOriginAllowed("https://masoi-client-git-main.vercel.app"), true);
  assert.equal(isOriginAllowed("https://evil-hacker-site.com"), false);
  assert.equal(isOriginAllowed("https://masoi.hiepd5.com.evil.org"), false);
});

// 29. V4.1 — Pha mở màn độc lập role_reveal (6.0s) bảo toàn trọn vẹn thời gian Đêm 1 & hỗ trợ Sẵn sàng sớm
runScenario("29. V4.1: Pha mở màn role_reveal (6.0s) độc lập trước Đêm 1 & Sẵn sàng sớm", () => {
  const ioStub = { to: () => ({ emit: () => {} }) };
  const ctrl = createGameController(ioStub);
  const room = createRoom("rr_host");
  const { player: p1 } = addPlayer(room.code, "rr_host", "Người Thật 1");
  const { player: p2 } = addPlayer(room.code, "rr_guest", "Người Thật 2");
  p2.ready = true;
  room.rolesConfig = generateExpandedV33Roles(6); // Có Cupid -> sau role_reveal phải vào night_cupid đủ 25s!

  assert.equal(ctrl.startGame(room).ok, true);
  assert.equal(room.game.phase, "role_reveal");
  assert.equal(room.game.phaseDurationSec, 6);

  const r1 = ctrl.markRoleRevealReady(room, p1.id);
  assert.equal(r1.allHumansReady, false, "Mới 1/2 người bấm Sẵn sàng thì chưa chuyển sớm");
  const r2 = ctrl.markRoleRevealReady(room, p2.id);
  assert.equal(r2.allHumansReady, true, "Đủ 2/2 người thật bấm Sẵn sàng -> kích hoạt vào Đêm 1 sớm");

  ctrl.advanceCurrentPhase(room);
  assert.equal(room.game.phase, "night_cupid", "Hết role_reveal phải vào đúng night_cupid mà không mất 1 giây nào");
  assert.equal(room.game.phaseDurationSec, GE.TIMERS.cupid);
  ctrl.clearRoomTimer(room.code);
  deleteRoom(room.code);
});

// 30. V4.1 — Chế độ Tốc Chiến 5 Phút (Turbo Mode) rút gọn đồng bộ Thảo luận / Đề cử / Biện hộ / Bỏ phiếu
runScenario("30. V4.1: Chế độ Tốc Chiến (Turbo 5 Phút) áp dụng đúng bộ đếm 75s/20s/35s/20s", () => {
  const room = createRoom("turbo_host");
  const { player: host } = addPlayer(room.code, "turbo_host", "Chủ Tốc Chiến");
  for (let i = 1; i <= 5; i++) {
    const { player } = addPlayer(room.code, `tb_${i}`, `Dân ${i}`);
    player.ready = true;
  }

  const toggleRes = setRoomTurbo(room.code, host.socketId, true);
  assert.equal(toggleRes.ok, true);
  assert.equal(room.isTurbo, true);

  GE.initGameState(room);
  assert.equal(GE.getPhaseDurationSec(room, "day_discuss"), 75);
  assert.equal(GE.getPhaseDurationSec(room, "day_nominate"), 20);
  assert.equal(GE.getPhaseDurationSec(room, "day_defense"), 35);
  assert.equal(GE.getPhaseDurationSec(room, "day_final_vote"), 20);

  GE.startDiscussion(room);
  const view = publicRoomView(room, host.socketId);
  assert.equal(view.isTurbo, true);
  assert.equal(view.game.isTurbo, true);
  assert.equal(view.game.phaseDurationSec, 75, "publicRoomView phải truyền phaseDurationSec=75s xuống thanh tiến trình Client");
  deleteRoom(room.code);
});

// 31. V4.1 — Thảo luận ban ngày co giãn thông minh: 60s khi Solo+Bot & 120s khi tàn cuộc <= 4 người
runScenario("31. V4.1: Thảo luận co giãn thông minh (60s Solo+Bot | 120s khi còn <= 4 người sống)", () => {
  const soloRoom = createRoom("solo_d");
  addPlayer(soloRoom.code, "solo_d", "Solo Tester");
  addBotsToRoom(soloRoom.code, 5);
  GE.initGameState(soloRoom);
  assert.equal(GE.getPhaseDurationSec(soloRoom, "day_discuss"), 60, "Chơi 1 mình với Bot chỉ thảo luận 60s");
  deleteRoom(soloRoom.code);

  const endGameRoom = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager", v2: "villager"
  });
  assert.equal(GE.getPhaseDurationSec(endGameRoom, "day_discuss"), 180, "Đầu ván 6 người thật giữ 180s");
  endGameRoom.players[4].alive = false;
  endGameRoom.players[5].alive = false;
  assert.equal(GE.getPhaseDurationSec(endGameRoom, "day_discuss"), 120, "Tàn cuộc <= 4 người sống co gọn còn 120s");
  deleteRoom(endGameRoom.code);
});

// 32. V4.1 — Phù Thủy bấm Bỏ qua ({ pass: true }) & Smart Pacing không làm nhảy phaseEndsAt công khai (Zero Meta-Leak)
runScenario("32. V4.1: Phù Thủy { pass: true } & Smart Pacing giữ nguyên phaseEndsAt chống lộ vai", () => {
  const ioStub = { to: () => ({ emit: () => {} }) };
  const ctrl = createGameController(ioStub);
  const room = createRoom("mp_host");
  addPlayer(room.code, "mp_host", "Chủ Bàn");
  for (let i = 1; i <= 5; i++) {
    const { player } = addPlayer(room.code, `mp_${i}`, `Người ${i}`);
    player.ready = true;
  }
  ctrl.startGame(room, { skipRoleReveal: true });
  // Ép vai để test Phù Thủy
  const roles = ["wolf", "guard", "witch", "seer", "villager", "villager"];
  room.players.forEach((p, idx) => { p.role = roles[idx]; p.initialRole = roles[idx]; });
  GE.syncInitialRoleState(room);

  const guard = room.players.find((p) => p.role === "guard");
  const phaseEndsBeforeClick = room.game.phaseEndsAt;
  assert.equal(ctrl.guardProtect(room, guard.id, guard.id).ok, true);
  assert.equal(
    room.game.phaseEndsAt,
    phaseEndsBeforeClick,
    "Zero Meta-Timing Leak: Bấm kỹ năng sớm KHÔNG ĐƯỢC làm giật lùi đồng hồ phaseEndsAt của người đang ngủ!"
  );

  ctrl.advanceCurrentPhase(room); // sang night_wolf
  ctrl.advanceCurrentPhase(room); // sang night_witch
  const witch = room.players.find((p) => p.role === "witch");
  const passRes = ctrl.witchDecide(room, witch.id, { pass: true });
  assert.equal(passRes.ok, true);
  assert.equal(room.game.witchDecidedPass, true, "Phù Thủy bấm Ngủ lại / Bỏ qua phải ghi nhận witchDecidedPass=true");

  ctrl.clearRoomTimer(room.code);
  deleteRoom(room.code);
});

// 33. V4.1 — Trưởng Làng lộ diện ở 5 giây cuối vòng bỏ phiếu tự động bù +5s chống đánh úp (1 lần/pha)
runScenario("33. V4.1: Trưởng Làng lộ diện lúc < 6s cuối tự bù +5s chống đánh úp (chỉ 1 lần)", () => {
  const ioStub = { to: () => ({ emit: () => {} }) };
  const ctrl = createGameController(ioStub);
  const room = createRoom("my_host");
  addPlayer(room.code, "my_host", "Trưởng Làng Test");
  for (let i = 1; i <= 5; i++) {
    const { player } = addPlayer(room.code, `my_${i}`, `Dân ${i}`);
    player.ready = true;
  }
  room.rolesConfig = generateExpandedV33Roles(6);
  ctrl.startGame(room, { skipRoleReveal: true });
  const roles = ["wolf", "mayor", "guard", "witch", "seer", "hunter"];
  room.players.forEach((p, idx) => { p.role = roles[idx]; p.initialRole = roles[idx]; });
  GE.syncInitialRoleState(room);

  // Đưa tới vòng Đề cử & giả lập đồng hồ chỉ còn 3.0 giây cuối
  room.game.phase = "day_reveal";
  ctrl.advanceCurrentPhase(room); // day_discuss
  ctrl.advanceCurrentPhase(room); // day_nominate
  assert.equal(room.game.phase, "day_nominate");

  room.game.phaseEndsAt = Date.now() + 3000;
  const beforeRevealEnd = room.game.phaseEndsAt;
  const mayor = room.players.find((p) => p.role === "mayor");
  assert.equal(ctrl.mayorReveal(room, mayor.id).ok, true);
  assert.ok(
    room.game.phaseEndsAt >= beforeRevealEnd + 4500,
    "Trưởng Làng lật bài khi còn 3s phải được bù thêm +5s để cả làng kịp xoay phiếu"
  );

  ctrl.clearRoomTimer(room.code);
  deleteRoom(room.code);
});

// 34. V4.1 — Thợ Săn bóp cò kích hoạt đệm điện ảnh 2.8s trước khi chuyển cảnh / kết ván
runScenario("34. V4.1: Thợ Săn bắn đạn bạc giữ đệm điện ảnh 2.8s không cắt cảnh đột ngột", () => {
  const ioStub = { to: () => ({ emit: () => {} }) };
  const ctrl = createGameController(ioStub);
  const room = createRoom("ht_host");
  addPlayer(room.code, "ht_host", "Thợ Săn Test");
  for (let i = 1; i <= 5; i++) {
    const { player } = addPlayer(room.code, `ht_${i}`, `Dân ${i}`);
    player.ready = true;
  }
  room.rolesConfig = generateExpandedV33Roles(6);
  ctrl.startGame(room, { skipRoleReveal: true });
  const roles = ["wolf", "hunter", "guard", "witch", "seer", "mayor"];
  room.players.forEach((p, idx) => { p.role = roles[idx]; p.initialRole = roles[idx]; });
  GE.syncInitialRoleState(room);

  const wolf = room.players.find((p) => p.role === "wolf");
  const hunter = room.players.find((p) => p.role === "hunter");

  // Sói cắn Thợ Săn trong đêm -> Bình minh mở pha hunter_revenge
  room.game.phase = "night_wolf";
  ctrl.wolfPick(room, wolf.id, hunter.id);
  ctrl.advanceCurrentPhase(room); // night_witch
  ctrl.advanceCurrentPhase(room); // night_seer
  ctrl.advanceCurrentPhase(room); // resolve -> hunter_revenge
  assert.equal(room.game.phase, "hunter_revenge");

  const shotRes = ctrl.hunterShoot(room, hunter.id, wolf.id);
  assert.equal(shotRes.ok, true);
  assert.equal(wolf.alive, false);
  assert.equal(room.phase, "playing", "Trong 2.8s đệm đạn bạc, phòng vẫn ở trạng thái playing để diễn trọn VFX 3D");
  const bufferMs = room.game.phaseEndsAt - Date.now();
  assert.ok(bufferMs >= 2200 && bufferMs <= 3000, `Đệm điện ảnh phải ~2.8s (thực tế: ${bufferMs}ms)`);

  ctrl.clearRoomTimer(room.code);
  deleteRoom(room.code);
});

// 35. V3.5.2 / V4.1 — Instant End-Game Voice: Zero-Waste (cắt 100% 51 câu giả định) + Hàng đợi 3 làn ưu tiên GPU RTX 3090
runScenario("35. Instant End-Game Voice: Zero-Waste (0 câu giả định đầu ván) + Hàng đợi 3 làn ưu tiên GPU", () => {
  const room = createRoom("vc_host");
  addPlayer(room.code, "vc_host", "Hiệp MC");
  addBotsToRoom(room.code, 7);

  const plan = buildOpeningVoicePlan(room, 7);
  assert.equal(
    plan.urgent.length,
    1,
    "Đầu ván chỉ được xếp 1 câu mở màn Phim Kể Chuyện vào làn urgent (cắt sạch 51 câu giả định gây tắc GPU!)"
  );
  assert.equal(plan.liveHint.length, 4, "Làn liveHint đầu ván chỉ giữ 4 câu kết cuộc chung");

  const status = getVoiceEngineStatus();
  assert.ok(status.lanes && typeof status.lanes.urgent === "number", "Phải phơi bày đủ 3 làn ưu tiên urgent/story/liveHint");

  GE.initGameState(room);
  const p0 = room.players[0];
  const p1 = room.players[1];
  GE.recordReplayEvent(room, { kind: "guard_pick", actorId: p0.id, targetId: p1.id });
  GE.recordReplayEvent(room, { kind: "wolf_aim", actorId: p1.id, targetId: p0.id });
  GE.recordReplayEvent(room, { kind: "wolf_chat", actorId: p1.id, chatText: "Cắn ghế 1 đi" });
  GE.recordReplayEvent(room, { kind: "peaceful_dawn" });
  GE.recordReplayEvent(room, { kind: "day_nominate", actorId: p0.id, targetId: p1.id });
  GE.recordReplayEvent(room, { kind: "village_chat", actorId: p0.id, chatText: "Treo cổ ghế 2!" });

  const narrations = deriveStoryNarrationsFromRoom(room);
  assert.equal(
    narrations.length,
    5,
    "Phải sinh đủ 5 câu kể chuyện (Mở màn + Bảo Vệ + Sói ngắm + Bình minh yên ả + Đề cử) và bỏ qua 100% chat người chơi"
  );

  deleteRoom(room.code);
});

// 36. V3.5.3 — EndGameRecap 0-Abort Lock: Chống tự hủy fetch 280ms, chống trôi Cảnh 0 ở Render #1 & bảo toàn CORS x-game-session
runScenario("36. V3.5.3: EndGameRecap 0-Abort Lock (EMPTY_ARRAY + storyVoicePlanKey + Render #1 Wait + CORS)", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");
  const playingViewSrc = fs.readFileSync(path.join(rootDir, "client/src/components/PlayingView.jsx"), "utf8");
  const endGameSrc = fs.readFileSync(path.join(rootDir, "client/src/components/EndGameRecap.jsx"), "utf8");
  const serverIndexSrc = fs.readFileSync(path.join(rootDir, "server/index.js"), "utf8");

  assert.ok(
    playingViewSrc.includes("const EMPTY_ARRAY = Object.freeze([]);") &&
      !playingViewSrc.includes("loversPublic={g.loversPublic || []}"),
    "PlayingView.jsx phải dùng EMPTY_ARRAY bất biến thay vì inline || [] gây hủy fetch mỗi 280ms"
  );
  assert.ok(
    playingViewSrc.includes("sessionToken={liveSessionToken}"),
    "PlayingView.jsx phải truyền thẳng liveSessionToken sống sang EndGameRecap"
  );
  assert.ok(
    endGameSrc.includes("const [storyVoiceLoading, setStoryVoiceLoading] = useState(() => mcVoiceEnabled !== false);"),
    "EndGameRecap.jsx phải khóa storyVoiceLoading=true ngay từ Render #1 để Cảnh 0 không bị trôi sớm"
  );
  assert.ok(
    endGameSrc.includes("}, [orderedVoicePlan.planKey, speechEnabled, voiceRecheckTick, autoRetryTick]);"),
    "useEffect nạp Voice chỉ phụ thuộc chữ ký chuỗi orderedVoicePlan.planKey bất biến (0% tự abort khi 3D re-render)"
  );
  assert.ok(
    serverIndexSrc.includes('allowedHeaders: ["Content-Type", "Authorization", "x-game-session"'),
    "server/index.js phải khai báo tường minh allowedHeaders cho x-game-session"
  );
});

// 37. V4.1 — Ghép Bàn Nhanh 1-Chạm (Quick Match): tự tạo bàn V3.3 + 5 Bot AI nhường ghế & ghép người sau vào chung phòng
runScenario("37. V4.1: Quick Match 1-Chạm tự tạo phòng 8 vai V3.3 + 5 Bot & ưu tiên ghép chung phòng đông người thật", () => {
  // Dọn sạch các phòng test còn sót lại từ kịch bản 01..24 trước khi test tạo phòng mới
  getPublicRoomsList().forEach((r) => deleteRoom(r.code));

  const q1 = findOrCreateQuickMatchRoom("qm_sock_1", {
    name: "Chiến Binh 1",
    avatarUrl: "/icon-192.png",
  });
  assert.equal(q1.createdNew, true, "Chưa có phòng công khai mở -> tạo phòng Quick Match mới");
  assert.equal(q1.room.players.length, 6, "1 người thật + 5 Bot AI mồi bàn (sẵn sàng 6 ghế)");

  const q2 = findOrCreateQuickMatchRoom("qm_sock_2", {
    name: "Chiến Binh 2",
    avatarUrl: "/icon-192.png",
  });
  assert.equal(q2.matchedExisting, true, "Người thứ 2 bấm Chơi Ngay phải được ghép thẳng vào phòng đang mở");
  assert.equal(q2.room.code, q1.room.code);
  const humanCount = q2.room.players.filter((p) => !p.isBot).length;
  assert.equal(humanCount, 2, "Phòng phải có 2 người thật cùng bàn");

  // Đẩy thêm người thật vượt ngưỡng 8 vai -> Bot tự động nhường ghế!
  findOrCreateQuickMatchRoom("qm_sock_3", { name: "Chiến Binh 3" });
  const q4 = findOrCreateQuickMatchRoom("qm_sock_4", { name: "Chiến Binh 4" });
  assert.equal(q4.room.players.filter((p) => !p.isBot).length, 4);
  assert.equal(q4.room.players.filter((p) => p.isBot).length, 4, "Bot tự nhường ghế khi bàn chạm ngưỡng cấu hình 8 vai");

  deleteRoom(q1.room.code);
});

// 38. V4.1 — Hàng Đợi Khán Giả Zero-Leak & Tự Động Lên Ghế Chơi Ván Sau
runScenario("38. V4.1: Khán giả vào phòng đang đấu (Zero-Leak 100%) & tự lên ghế chính khi mở lại Sảnh", () => {
  const room = createRoom("sp_host");
  addPlayer(room.code, "sp_host", "Chủ Phòng");
  addBotsToRoom(room.code, 5);
  GE.initGameState(room);
  room.phase = "playing";

  const joinPlaying = addPlayer(room.code, "late_sock", "Khách Trễ");
  assert.equal(joinPlaying.canSpectate, true, "addPlayer giữ nguyên lỗi + cờ canSpectate:true cho phòng đang chơi");

  const specRes = addSpectator(room.code, "late_sock", "Khán Giả A", null, "/icon-192.png");
  assert.ok(specRes.spectator, "Phải thêm vào hàng chờ khán giả thành công");
  assert.equal(hasValidActiveSessionToken(specRes.spectator.sessionToken), true, "Token khán giả được phép nghe giọng MC /api/tts");

  const specView = publicSpectatorView(room, "late_sock");
  assert.equal(specView.isSpectator, true);
  assert.equal(specView.spectatorCount, 1);
  assert.equal(specView.game.myRole, null, "Zero-Leak: Khán giả tuyệt đối không thấy myRole");
  assert.equal(specView.game.wolfPicksVisible, null, "Zero-Leak: Khán giả tuyệt đối không thấy mục tiêu Sói cắn");
  assert.equal(
    specView.players.every((p) => p.role === null && !p.sessionToken),
    true,
    "Zero-Leak: Toàn bộ vai trò người còn sống & sessionToken bị ẩn sạch khỏi gói tin Khán giả"
  );

  resetRoomToLobby(room);
  assert.equal(room.phase, "lobby");
  assert.equal(room.spectators.length, 0, "Hàng chờ khán giả đã được dọn sạch lên ghế");
  const promoted = room.players.find((p) => p.socketId === "late_sock");
  assert.ok(promoted, "Khán Giả A phải tự động được xếp vào ghế người chơi thật ở ván mới!");
  assert.equal(promoted.name, "Khán Giả A");

  deleteRoom(room.code);
});

// 39. V4.1 — 4 Tính Cách Bot AI Tranh Biện Sống Động (100% Zero-Leak từ dữ liệu công khai)
runScenario("39. V4.1: BOT_PERSONAS & buildZeroLeakBotLine sinh thoại tiếng Việt đa tính cách 0% lộ vai", () => {
  const room = createRoom("bp_host");
  addPlayer(room.code, "bp_host", "Hiệp Test");
  addBotsToRoom(room.code, 4);
  const bots = room.players.filter((p) => p.isBot);
  assert.equal(bots.length, 4);
  assert.ok(bots.every((b) => b.personaId && BOT_PERSONAS.some((bp) => bp.id === b.personaId)), "Mỗi Bot phải mang 1 cá tính tranh biện");

  const lines = BOT_PERSONAS.map((bp) =>
    buildZeroLeakBotLine({
      personaId: bp.id,
      dayNumber: 2,
      nightDeathNames: ["Minh"],
      suspectName: "Hùng",
      mayorName: "Lan",
      aliveCount: 5,
    })
  );
  assert.equal(lines.every((l) => typeof l === "string" && l.length >= 15), true, "Mọi câu thoại Bot đều giàu ngữ cảnh tiếng Việt");
  assert.ok(new Set(lines).size >= 3, "Các cá tính Bot khác nhau phải tạo góc nhìn phản biện khác nhau");

  deleteRoom(room.code);
});

// 40. V4.1 — Đồng Thuận Mở Sảnh Ván Mới (Rematch Consensus) không bị kẹt chờ Host thụ động
runScenario("40. V4.1: markRematchReady đủ >= 50% người thật tự mở lại Sảnh ngay không cần chờ Host", () => {
  const ioStub = { to: () => ({ emit: () => {} }) };
  const ctrl = createGameController(ioStub);
  const room = createRoom("rm_host");
  const { player: host } = addPlayer(room.code, "rm_host", "Host AFK");
  const { player: g1 } = addPlayer(room.code, "rm_g1", "Khách 1");
  const { player: g2 } = addPlayer(room.code, "rm_g2", "Khách 2");
  g1.ready = true;
  g2.ready = true;
  addBotsToRoom(room.code, 3);

  ctrl.startGame(room, { skipRoleReveal: true });
  // Giả lập kết thúc đêm (chỉ còn Sói sống -> Phe Sói thắng -> endGame)
  room.players.forEach((p, idx) => {
    p.role = idx === 0 ? "wolf" : "villager";
    p.alive = idx === 0;
  });
  room.game.phase = "night_seer";
  ctrl.advanceCurrentPhase(room);
  assert.equal(room.phase, "ended");
  assert.ok(
    room.game.rematchEndsAt >= Date.now() + 250_000,
    "Kết ván phải khởi tạo trần dọn phòng ngầm 300s (không cắt ngang phim 45s)"
  );

  // Có 3 người thật -> cần ceil(3/2) = 2 người bấm Ván Mới
  const r1 = ctrl.markRematchReady(room, g1.id);
  assert.equal(r1.reopened, false, "1/2 người đồng thuận chưa mở sảnh");
  const r2 = ctrl.markRematchReady(room, g2.id);
  assert.equal(r2.reopened, true, "2/2 người đồng thuận (>= 50% người thật) tự mở Sảnh ngay dù Host AFK!");
  assert.equal(room.phase, "lobby");
  assert.ok(host.id && room.players.length >= 3);

  ctrl.clearRoomTimer(room.code);
  deleteRoom(room.code);
});

// 41. V4.1 — Dự Đoán Cõi Âm (+35 XP Zero-Leak) & Kiểm Chứng 32 Chân Dung 3D Studio WebP
runScenario("41. V4.1: Dự đoán Cõi Âm (+35 XP khi đoán trúng, ẩn khỏi người sống) & đủ 32 ảnh WebP Studio", () => {
  const room = makeTestRoom({
    w1: "wolf", g1: "guard", wt: "witch", sr: "seer", v1: "villager", v2: "villager"
  });
  const deadVillager = room.players[4];
  const aliveVillager = room.players[5];
  deadVillager.alive = false;
  room.game.ghostBets = { [deadVillager.id]: "village" };

  const aliveView = publicRoomView(room, aliveVillager.socketId);
  assert.equal(aliveView.game.myGhostBet, null, "Người sống không thấy kèo dự đoán của Cõi Âm");

  const deadViewDuring = publicRoomView(room, deadVillager.socketId);
  assert.equal(deadViewDuring.game.myGhostBet, "village");
  assert.equal(deadViewDuring.game.ghostBetBonusXp, 0, "Chưa hết ván chưa cộng XP");

  room.phase = "ended";
  room.game.winner = "village";
  const deadViewEnded = publicRoomView(room, deadVillager.socketId);
  assert.equal(deadViewEnded.game.ghostBetBonusXp, 35, "Đoán trúng phe thắng được thưởng +35 XP Tiên Tri Âm Giới");
  deleteRoom(room.code);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const badgesDir = path.resolve(__dirname, "../../client/public/portraits/badges");
  const cardsDir = path.resolve(__dirname, "../../client/public/portraits/cards");
  const badgeFiles = fs.readdirSync(badgesDir).filter((f) => f.endsWith(".webp"));
  const cardFiles = fs.readdirSync(cardsDir).filter((f) => f.endsWith(".webp"));
  assert.equal(badgeFiles.length, 16, "Phải có đủ 16/16 huy hiệu 3D WebP 1:1");
  assert.equal(cardFiles.length, 16, "Phải có đủ 16/16 thẻ bài Tarot 3D WebP 2:3");
});

// 42. V3.5.4 — Rạp Chiếu Cá Nhân Không Hẫng + Nút Về Sảnh 2 Giai Đoạn + Tốc Độ Mặc Định 1.5x (1x/1.5x/2x/3x Giữ Âm Sắc)
runScenario("42. V3.5.4: Rạp cá nhân không hẫng, nút Về Sảnh 2 giai đoạn (0 đếm ngược) & tốc độ 1.5x mặc định [1x/1.5x/2x/3x] giữ pitch", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const roomSrc = fs.readFileSync(
    path.resolve(__dirname, "../../client/src/components/Room.jsx"),
    "utf8"
  );
  const recapSrc = fs.readFileSync(
    path.resolve(__dirname, "../../client/src/components/EndGameRecap.jsx"),
    "utf8"
  );
  const recorderSrc = fs.readFileSync(
    path.resolve(__dirname, "../../client/src/utils/cinemaVideoRecorder.js"),
    "utf8"
  );

  // 1. Tách rạp cá nhân (frozenRecapSnapshot + dismissedRecapKey + freshSessionToken)
  assert.ok(roomSrc.includes("frozenRecapSnapshot"), "Room.jsx phải giữ bản chụp rạp cá nhân frozenRecapSnapshot");
  assert.ok(roomSrc.includes("dismissedRecapKey"), "Room.jsx phải cho phép từng máy thoát sảnh độc lập qua dismissedRecapKey");
  assert.ok(roomSrc.includes("freshSessionToken"), "Room.jsx phải truyền freshSessionToken sống cho /api/tts-batch");

  // 2. Hai giai đoạn nút Về Sảnh Chờ (ẩn đếm ngược giây, mở khóa sau khi hết truyện hoặc tua tới MVP)
  assert.ok(recapSrc.includes("hasCompletedStoryOnce"), "EndGameRecap.jsx phải khóa trạng thái hasCompletedStoryOnce");
  assert.ok(recapSrc.includes("⏭️ Về sảnh chờ sớm"), "Khi chưa hết truyện phải hiện nút phụ '⏭️ Về sảnh chờ sớm'");
  assert.ok(recapSrc.includes("🏰 Về Sảnh Chờ"), "Khi hết truyện phải bung nút chính '🏰 Về Sảnh Chờ'");
  assert.ok(!recapSrc.includes("rematchSecLeft"), "Tuyệt đối không hiển thị số giây đếm ngược hối thúc trên nút về sảnh");

  // 3. Tốc độ mặc định 1.5x + bộ chọn [1, 1.5, 2, 3] + preservesPitch = true chống méo giọng
  assert.ok(recapSrc.includes("useState(1.5)"), "Tốc độ xem mặc định phải là 1.5x");
  assert.ok(recapSrc.includes("[1, 1.5, 2, 3]"), "Bộ chọn tốc độ phải đủ 4 mức 1x, 1.5x, 2x, 3x");
  assert.ok(recorderSrc.includes("preservesPitch = true"), "cinemaVideoRecorder.js phải bật preservesPitch = true giữ giọng Clone trầm ấm");
  assert.ok(recorderSrc.includes("Math.min(3.0"), "cinemaVideoRecorder.js phải mở trần tốc độ lên 3.0x");
  assert.ok(recorderSrc.includes("setPlaybackRate"), "cinemaVideoRecorder.js phải hỗ trợ đổi tốc độ trực tiếp giữa câu không ngắt lời");
});

// 43. V4.1 — Hệ Nhân Vật Dân Làng 3D Ngồi Ghế, Đổi Nhân Vật Trong Phòng & Gỡ Sạch Avatar 2D Cũ / Dicebear
runScenario("43. V4.1: Đồng bộ citizenModelId qua Join/QuickMatch/Spectator/setPlayerCitizenModel & 0% Dicebear/Avatar 2D cũ", () => {
  assert.equal(sanitizeCitizenModelId("villager_female"), "villager_female");
  assert.equal(sanitizeCitizenModelId("../evil_hack"), null);

  const room = createRoom("cit_host");
  const { player: host } = addPlayer(room.code, "cit_host", "Chủ Làng", null, null, "", {
    citizenModelId: "villager_elder",
  });
  assert.equal(host.citizenModelId, "villager_elder");
  assert.equal(host.avatar, "/portraits/badges/villager_elder.webp");
  assert.ok(!host.avatar.includes("dicebear.com"));

  const changeRes = setPlayerCitizenModel(room.code, "cit_host", "villager_female");
  assert.equal(changeRes.ok, true, "Người chơi đổi Nhân vật 3D ngay trong sảnh chờ phải thành công");
  assert.equal(host.citizenModelId, "villager_female");
  assert.equal(host.avatar, "/portraits/badges/villager_female.webp");

  const pubView = publicRoomView(room, "cit_host");
  assert.equal(pubView.players[0].citizenModelId, "villager_female");

  // Kiểm tra Khán giả giữ nguyên citizenModelId khi đôn lên ghế ván mới
  addBotsToRoom(room.code, 5);
  GE.initGameState(room);
  room.phase = "playing";
  const specRes = addSpectator(room.code, "cit_spec", "Khách Mời", null, null, "", {
    citizenModelId: "villager_true",
  });
  assert.equal(specRes.spectator.citizenModelId, "villager_true");
  resetRoomToLobby(room);
  const promoted = room.players.find((p) => p.socketId === "cit_spec");
  assert.equal(promoted.citizenModelId, "villager_true");
  deleteRoom(room.code);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const legacyCustomDir = path.resolve(__dirname, "../../client/public/avatars/custom");
  assert.equal(fs.existsSync(legacyCustomDir), false, "Thư mục ảnh mặt thật 2D cũ phải được gỡ khỏi public web");
  const lobbySrc = fs.readFileSync(path.resolve(__dirname, "../../client/src/components/Lobby.jsx"), "utf8");
  assert.equal(lobbySrc.includes("dicebear.com"), false, "Lobby.jsx phải gỡ sạch 100% api.dicebear.com");
});

// 44. V4.1 — Kho Ô Chờ Avatar 3D Người Thật (DB-Ready) & Khóa Độc Quyền Không Cấp Cho AI Bot
runScenario("44. V4.1: Kho 12+ Ô Chờ Avatar 3D Người Thật (DB-Ready) & AI Bot khóa cứng 4 Dân Làng Bắc Âu", () => {
  const botAttemptCustom = resolveCitizenAvatarSpec("avatar_real_01", {
    fallbackSeed: "bot2",
    forBot: true,
  });
  assert.ok(
    BUILTIN_VILLAGER_IDS.includes(botAttemptCustom.citizenModelId),
    "AI Bot tuyệt đối không được mượn avatar_real_* của người thật"
  );
  assert.equal(botAttemptCustom.avatarSource, "builtin_villager");

  const room = createRoom("bot_lock_host");
  addPlayer(room.code, "bot_lock_host", "Người Thật");
  addBotsToRoom(room.code, 7);
  const bots = room.players.filter((p) => p.isBot);
  assert.equal(bots.length, 7);
  assert.equal(
    bots.every((b) => BUILTIN_VILLAGER_IDS.includes(b.citizenModelId) && !b.avatar.includes("dicebear.com")),
    true,
    "100% AI Bot phải xoay vòng 4 Nhân vật Dân Làng 3D nội bộ"
  );
  deleteRoom(room.code);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const manifestDoc = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../client/public/models/avatars/avatars_manifest.json"), "utf8")
  );
  assert.equal(manifestDoc.builtinVillagers.length, 4, "Phải có đúng 4 Dân Làng 3D mặc định");
  assert.ok(manifestDoc.customHumanAvatars.length >= 12, "Phải có tối thiểu 12 Ô Chờ Avatar 3D Người Thật");
  assert.equal(manifestDoc.dbReadySchema.column, "citizen_model_id", "Sẵn sàng cột citizen_model_id cho DB User");
  assert.equal(
    manifestDoc.customHumanAvatars.every((item) => item.botAllowed === false && item.tintableCloak === false),
    true,
    "Mọi Avatar 3D Người Thật phải khóa botAllowed=false & tintableCloak=false (giữ nguyên màu da/áo gốc)"
  );
});

// 45. V4.1 — Lá Chắn Văn Minh Tiếng Việt, Giới Hạn Ring Buffer Báo Cáo (<= 200) & Chỉ Số Vận Hành Server
runScenario("45. V4.1: sanitizeChatText che từ tục tiếng Việt (giữ nguyên từ bình thường), Ring Buffer <= 200 & Runtime Metrics", () => {
  const dirtyCleaned = sanitizeChatText("đm con sói vcl cắn bậy fuck thật");
  assert.equal(dirtyCleaned.includes("đm"), false, "Phải che từ tục có dấu tiếng Việt đầu câu");
  assert.equal(dirtyCleaned.includes("vcl"), false, "Phải che từ viết tắt tục tĩu");
  assert.equal(dirtyCleaned.includes("fuck"), false, "Phải che từ tục tiếng Anh");
  assert.ok(dirtyCleaned.includes("**"), "Từ vi phạm phải được thay bằng ký tự sao (*)");

  const cleanVietnamese = "Đêm nay dân làng cùng chức năng bảo vệ công cụ thảo luận văn minh!";
  assert.equal(
    filterVietnameseProfanity(cleanVietnamese),
    cleanVietnamese,
    "Tuyệt đối không làm hỏng các từ tiếng Việt bình thường (đêm, làng, chức, công cụ)"
  );

  for (let i = 0; i < 215; i++) {
    recordPlayerReport({
      reporterIp: "198.51.100.42",
      roomCode: "V41RM",
      reporterId: `rep_${i}`,
      reporterName: "Dân Làng",
      targetId: "bad_actor",
      targetName: "Kẻ Quấy Rối",
      reason: "Chửi thề trên bàn thảo luận",
    });
  }
  const modStats = getModerationStats();
  assert.ok(modStats.totalReportsCount >= 215);
  assert.equal(
    modStats.recentReportsCount,
    200,
    "Ring Buffer báo cáo phải khóa cứng trần <= 200 bản ghi bảo vệ 512MB RAM Render"
  );

  const metrics = getGlobalServerRuntimeMetrics();
  assert.equal(typeof metrics.activeRoomsCount, "number");
  assert.equal(typeof metrics.totalConnectedHumans, "number");
});

// 46. V4.1 — Chốt #9: Khung Giờ Vàng Đêm Huyết Nguyệt (20:00 – 23:00 UTC+7) Xác Thực 100% Bằng Đồng Hồ Server
runScenario("46. V4.1 (Chốt #9): getVietnamGoldenHourInfo tính chuẩn 20:00–23:00 UTC+7 & xuất kèm publicRoomView", () => {
  // 19:59 UTC+7 = 12:59 UTC -> Chưa mở Giờ Vàng
  const beforeWindow = getVietnamGoldenHourInfo(Date.UTC(2026, 9, 28, 12, 59, 0));
  assert.equal(beforeWindow.active, false);
  assert.equal(beforeWindow.multiplier, 1);
  assert.equal(beforeWindow.utc7Hour, 19);
  assert.equal(beforeWindow.serverDateKey, "2026-10-28");

  // 20:30 UTC+7 = 13:30 UTC -> ĐANG TRONG ĐÊM HUYẾT NGUYỆT X2 XP!
  const insideWindow = getVietnamGoldenHourInfo(Date.UTC(2026, 9, 28, 13, 30, 0));
  assert.equal(insideWindow.active, true);
  assert.equal(insideWindow.multiplier, 2);
  assert.equal(insideWindow.utc7Hour, 20);

  // 23:00 UTC+7 = 16:00 UTC -> Đã khép lại khung 20:00 - 22:59
  const afterWindow = getVietnamGoldenHourInfo(Date.UTC(2026, 9, 28, 16, 0, 0));
  assert.equal(afterWindow.active, false);
  assert.equal(afterWindow.multiplier, 1);
  assert.equal(afterWindow.utc7Hour, 23);

  const room = createRoom("gh_host");
  addPlayer(room.code, "gh_host", "Thợ Săn Đêm");
  const view = publicRoomView(room, "gh_host");
  assert.ok(view.serverGoldenHour && typeof view.serverGoldenHour.multiplier === "number");
  deleteRoom(room.code);
});

// 47. V4.1 — Viral Clip Dọc 9:16 TikTok, Thẻ MVP PNG, Zero-Leak Haptics (Chốt #7/#13) & Sói Đầu Đàn Voice
runScenario("47. V4.1: Clip dọc 9:16 + Watermark masoi.hiepd5.com, Thẻ MVP PNG, Haptics Zero-Leak & Alpha Wolf Voice", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");

  const recorderSrc = fs.readFileSync(path.join(rootDir, "client/src/utils/cinemaVideoRecorder.js"), "utf8");
  assert.ok(recorderSrc.includes('aspectMode === "9:16"'), "cinemaVideoRecorder.js phải hỗ trợ chế độ dọc 9:16 TikTok/Reels");
  assert.ok(recorderSrc.includes("masoi.hiepd5.com"), "Video xuất ra phải đóng dấu thương hiệu masoi.hiepd5.com");

  const mvpCardSrc = fs.readFileSync(path.join(rootDir, "client/src/utils/mvpShareCard.js"), "utf8");
  assert.ok(mvpCardSrc.includes("generateMvpShareCardBlob") && mvpCardSrc.includes("1080") && mvpCardSrc.includes("1350"));

  const hapticsSrc = fs.readFileSync(path.join(rootDir, "client/src/utils/hapticsAndSound.js"), "utf8");
  assert.ok(
    hapticsSrc.includes("ALLOWED_HAPTIC_PATTERNS") && !hapticsSrc.includes("wolf_bite"),
    "Chốt #7: Bảng rung xúc giác chỉ cho phép sự kiện công khai/cá nhân hợp lệ, cấm sự kiện đêm lộ bài"
  );

  const voiceRoomSrc = fs.readFileSync(path.join(rootDir, "client/src/components/VoiceRoom.jsx"), "utf8");
  assert.ok(
    voiceRoomSrc.includes("isWolfTeamRole(myRole)") && !voiceRoomSrc.includes('myRole === "wolf"'),
    "Sói Đầu Đàn (alpha_wolf) phải nghe & nói được kênh LiveKit Bầy Sói ban đêm"
  );
});

// 48. V4.1 — Tối Ưu HUD 1 Lớp Phẳng (0 Drei Html Root), Draco Nội Bộ 100%, PWA Split-Cache (Chốt #14) & Capacitor App Store
runScenario("48. V4.1: SeatHudBatchOverlay 1 lớp DOM, Draco nội bộ '/draco/', Service Worker Chốt #14 & Capacitor Config", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");

  const hudOverlayPath = path.join(rootDir, "client/src/3d/components/SeatHudBatchOverlay.jsx");
  assert.equal(fs.existsSync(hudOverlayPath), true, "Phải có module SeatHudBatchOverlay.jsx gộp HUD ghế về 1 lớp DOM phẳng");

  const loaderFiles = [
    "client/src/3d/props/SmartPropGLB.jsx",
    "client/src/3d/actors/SkinnedCharacterGLB.jsx",
    "client/src/3d/actors/RoleSocketAttachment3D.jsx",
  ];
  for (const rel of loaderFiles) {
    const src = fs.readFileSync(path.join(rootDir, rel), "utf8");
    assert.ok(src.includes('setDecoderPath("/draco/")'), `${rel} phải trỏ tới bộ giải mã Draco nội bộ /draco/`);
    assert.equal(src.includes("gstatic.com/draco"), false, `${rel} phải gỡ sạch phụ thuộc CDN gstatic.com`);
  }

  assert.equal(
    fs.existsSync(path.join(rootDir, "client/public/draco/draco_decoder.wasm")),
    true,
    "Thư mục client/public/draco/ phải có đủ draco_decoder.wasm nội bộ"
  );

  const swSrc = fs.readFileSync(path.join(rootDir, "client/public/sw.js"), "utf8");
  assert.ok(
    swSrc.includes("masoi-assets-v4.3") && swSrc.includes("masoi-shell-v4.3") && swSrc.includes("/socket.io/"),
    "Chốt #14: Service Worker phải tách bạch Cache-First cho GLB/WebP/Audio (v4.3) và Network-First cho HTML/JS"
  );

  const capConfig = JSON.parse(fs.readFileSync(path.join(rootDir, "client/capacitor.config.json"), "utf8"));
  assert.equal(capConfig.appId, "com.hiepd5.masoi3d");
  assert.equal(capConfig.webDir, "dist");

  const runtimeEnvSrc = fs.readFileSync(path.join(rootDir, "client/src/config/runtimeEnv.js"), "utf8");
  assert.ok(runtimeEnvSrc.includes("isNativeCapacitor") && runtimeEnvSrc.includes("GRAPHICS_PRESETS"));
});

// 49. V4.2 — Trạm Tín Hiệu P2P Mesh Zero-Leak (Khóa role_reveal, Cô Lập Sói Ban Đêm, Trần SDP <= 16KB & /api/voice-status 0 Lộ Khóa)
runScenario("49. V4.2: voiceRelayHub P2P Zero-Leak (khóa role_reveal, cô lập Bầy Sói ban đêm, trần SDP <= 16KB & /api/voice-status)", () => {
  assert.ok(Array.isArray(DEFAULT_STUN_SERVERS) && DEFAULT_STUN_SERVERS.length >= 2);
  assert.equal(isValidSignalPayload({ type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" }), true);
  assert.equal(isValidSignalPayload({ type: "evil", sdp: "x" }), false);
  assert.equal(isValidSignalPayload({ type: "offer", sdp: "A".repeat(17_000) }), false, "Phải chặn gói SDP vượt 16KB");

  const room = createRoom("vr_wolf_sock");
  const { player: pWolf } = addPlayer(room.code, "vr_wolf_sock", "Sói Một");
  const { player: pAlpha } = addPlayer(room.code, "vr_alpha_sock", "Sói Đầu Đàn");
  const { player: pVil } = addPlayer(room.code, "vr_vil_sock", "Dân Làng");
  addBotsToRoom(room.code, 3);

  const makeMockSocket = (id, playerId) => {
    const handlers = {};
    return {
      id,
      data: { roomCode: room.code, playerId },
      handlers,
      on(ev, fn) {
        handlers[ev] = fn;
      },
    };
  };

  const emitted = new Map();
  const mockSocketsMap = new Map();
  const sWolf = makeMockSocket("vr_wolf_sock", pWolf.id);
  const sAlpha = makeMockSocket("vr_alpha_sock", pAlpha.id);
  const sVil = makeMockSocket("vr_vil_sock", pVil.id);
  mockSocketsMap.set(sWolf.id, sWolf);
  mockSocketsMap.set(sAlpha.id, sAlpha);
  mockSocketsMap.set(sVil.id, sVil);

  const mockIo = {
    sockets: { sockets: mockSocketsMap },
    to(sockId) {
      return {
        emit(ev, payload) {
          if (!emitted.has(sockId)) emitted.set(sockId, []);
          emitted.get(sockId).push({ ev, payload });
        },
      };
    },
  };

  registerVoiceRelaySocketHandlers(mockIo, sWolf, getRoom);
  registerVoiceRelaySocketHandlers(mockIo, sAlpha, getRoom);
  registerVoiceRelaySocketHandlers(mockIo, sVil, getRoom);

  let joinWolfRes = null;
  sWolf.handlers["voice:join"]({}, (r) => (joinWolfRes = r));
  sAlpha.handlers["voice:join"]({}, () => {});
  sVil.handlers["voice:join"]({}, () => {});
  assert.equal(joinWolfRes?.ok, true);
  assert.equal(getVoiceRelayRuntimeStats().activeP2pPeers, 3);

  // Vào trận: gán vai Sói, Sói Đầu Đàn & Dân Làng
  GE.initGameState(room);
  room.phase = "playing";
  pWolf.role = "wolf";
  pAlpha.role = "alpha_wolf";
  pVil.role = "villager";

  // 1) Pha role_reveal (6s lật bài): khóa im lặng 100%
  room.game.phase = "role_reveal";
  const wolfActor = resolveVoiceParticipant(room, sWolf);
  const alphaActor = resolveVoiceParticipant(room, sAlpha);
  const vilActor = resolveVoiceParticipant(room, sVil);
  assert.equal(canSpeakerTransmitNow(room, wolfActor), false, "role_reveal phải khóa Mic cả Sói");
  assert.equal(canListenerHearSpeakerInRoom(room, alphaActor, pWolf.id), false, "role_reveal phải chặn nghe 100%");

  // 2) Pha night_wolf: Sói nói -> Sói Đầu Đàn nhận speakingIds, Dân Làng nhận mảng rỗng [] (Zero-Leak!)
  room.game.phase = "night_wolf";
  assert.equal(canSpeakerTransmitNow(room, wolfActor), true);
  assert.equal(canSpeakerTransmitNow(room, vilActor), false);
  assert.equal(canListenerHearSpeakerInRoom(room, alphaActor, pWolf.id), true);
  assert.equal(canListenerHearSpeakerInRoom(room, vilActor, pWolf.id), false);

  emitted.clear();
  sWolf.handlers["voice:speaking"]({ speaking: true });
  const alphaUpdates = (emitted.get(sAlpha.id) || []).filter((e) => e.ev === "voice:speaking_update");
  const vilUpdates = (emitted.get(sVil.id) || []).filter((e) => e.ev === "voice:speaking_update");
  assert.deepEqual(alphaUpdates.at(-1)?.payload?.speakingIds, [pWolf.id], "Đồng bọn Sói Đầu Đàn phải thấy Sói đang nói");
  assert.deepEqual(vilUpdates.at(-1)?.payload?.speakingIds, [], "Dân làng tuyệt đối nhận 0% ID Sói đang nói ban đêm");

  // 3) Khi người chơi chết vào ban ngày: canPublish = false nhưng vẫn nghe được bàn thảo luận (Chỉ Nghe)
  room.game.phase = "day_discuss";
  pVil.alive = false;
  const deadVilActor = resolveVoiceParticipant(room, sVil);
  assert.equal(deadVilActor.canPublish, false, "Người chết phải hạ canPublish=false");
  assert.equal(canSpeakerTransmitNow(room, deadVilActor), false);
  assert.equal(canListenerHearSpeakerInRoom(room, deadVilActor, pWolf.id), true, "Người chết vẫn nghe được thảo luận ban ngày");

  // Dọn dẹp 100% RAM khi rời phòng
  removeSocketFromVoiceRelay(mockIo, room.code, sWolf.id, getRoom);
  removeSocketFromVoiceRelay(mockIo, room.code, sAlpha.id, getRoom);
  removeSocketFromVoiceRelay(mockIo, room.code, sVil.id, getRoom);
  assert.equal(getVoiceRelayRuntimeStats().activeVoiceRooms, 0);
  deleteRoom(room.code);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const serverIndexSrc = fs.readFileSync(path.resolve(__dirname, "../index.js"), "utf8");
  assert.ok(serverIndexSrc.includes('app.get("/api/voice-status"'), "Server phải có cổng chẩn đoán /api/voice-status");
  assert.ok(serverIndexSrc.includes("/rtc/validate?access_token="), "checkLivekitHealth phải xác thực qua /rtc/validate");
});

// 50. V4.3.2 — Thuần LiveKit SFU Cấp Phòng (Sảnh <-> Trận <-> Ván Mới), Khóa Cứng Bộ Đàm Giữ-Để-Nói (PTT 14kbps + 0 kbps nhả tay) & Auto-Ducking 0.6x
runScenario("50. Thuần LiveKit SFU: VoiceSessionProvider liên thông, Khóa Bộ Đàm PTT (14kbps / 0kbps nhả tay), Auto-Ducking 0.6x & Tạm nghỉ Recap", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");

  const roomSrc = fs.readFileSync(path.join(rootDir, "client/src/components/Room.jsx"), "utf8");
  const playingSrc = fs.readFileSync(path.join(rootDir, "client/src/components/PlayingView.jsx"), "utf8");
  const voiceRoomSrc = fs.readFileSync(path.join(rootDir, "client/src/components/VoiceRoom.jsx"), "utf8");
  const serverIndexSrc = fs.readFileSync(path.join(rootDir, "server/index.js"), "utf8");

  assert.ok(roomSrc.includes("<VoiceSessionProvider"), "Room.jsx phải bọc VoiceSessionProvider ở gốc giữ kết nối Sảnh <-> Trận");
  assert.ok(roomSrc.includes("mcDuckingActive={isMcSpeakingNow}"), "Room.jsx phải truyền trạng thái MC đang đọc để Auto-Ducking");
  assert.ok(roomSrc.includes("isSuppressedForRecap={isWatchingPersonalRecap}"), "Room.jsx phải tạm ngắt thoại khi đang xem Phim Kể Chuyện");

  assert.ok(playingSrc.includes("<VoiceQuickMicPill"), "PlayingView.jsx phải gắn nút nổi VoiceQuickMicPill trên sân khấu 3D");
  assert.ok(playingSrc.includes("voice-stage-floating-anchor"), "Nút nổi Voice phải neo ở góc sân khấu không che nút Camera");

  assert.ok(voiceRoomSrc.includes("audio={false}"), "LiveKitRoom phải truyền audio={false} để máy không cắm Mic vẫn vào Chỉ Nghe mượt mà");
  assert.ok(voiceRoomSrc.includes("connect={!isSuppressedForRecap && !isSoloBotMatch}"), "LiveKitRoom phải tạm ngắt kết nối SFU khi xem Phim Kể Chuyện & Đấu Solo Bot để tiết kiệm phút Quota");
  assert.ok(voiceRoomSrc.includes("key={roomInstanceKey}"), "LiveKitRoom phải gắn key làm mới phiên khi nâng quyền nói sang ván mới");
  assert.ok(voiceRoomSrc.includes('nightDayPhase === "role_reveal"'), "VoiceRoom phải khóa Mic trong 6s nhận vai định mệnh");
  assert.ok(voiceRoomSrc.includes("mcDuckingActive ? 0.6 : 1"), "VoiceRoom phải tự động hạ âm lượng về 0.6x (-40%) khi MC đọc");
  assert.ok(voiceRoomSrc.includes('const inputMode = "ptt"'), "VoiceRoom phải khóa cứng chế độ Bộ Đàm Giữ-Để-Nói (PTT)");
  assert.ok(voiceRoomSrc.includes("maxBitrate: 14_000") && voiceRoomSrc.includes("dtx: true"), "VoiceRoom phải ép chuẩn nén Opus 14kbps Mono + DTX 0 kbps");
  assert.equal(voiceRoomSrc.includes("useP2PVoiceMesh"), false, "VoiceRoom thuần LiveKit không được gọi nhảy sang P2P Mesh");
  assert.ok(serverIndexSrc.includes('inputPolicy: "ptt_only"'), "Server /api/voice-status & livekit:token phải khai báo chính sách ptt_only");
});

// 51. V4.3 — Nhịp Đọc Trọn MC (Full-Read Pacing) Cho Người Mới, Ghế Nóng Bot 14s/18s Không Đè Câu & Đổi Nóng Giữa Trận
runScenario("51. V4.3: Nhịp Đọc Trọn MC không cắt lời cho người mới, Ghế Nóng Bot 14s/18s & đổi nóng room:setMcPacing (kể cả khi đã chết)", () => {
  const wakeEstimate = estimateMcSpeechMs(
    "Đêm đầu tiên buông xuống... Bảo Vệ ơi, thức dậy! Hãy chọn người bạn muốn bảo vệ đêm nay."
  );
  assert.ok(wakeEstimate >= 5800 && wakeEstimate <= 11500, `estimateMcSpeechMs phải >= 5.8s (đo được ${wakeEstimate}ms)`);

  const mcEmitted = [];
  const ioStub = {
    to: () => ({
      emit: (ev, payload) => {
        if (ev === "mc:message") mcEmitted.push(payload);
      },
    }),
  };
  const ctrl = createGameController(ioStub);

  // Phòng thường có Bot -> tự mặc định 'full'; phòng Turbo -> mặc định 'fast'
  const botRoom = createRoom("pacing_host", { isTurbo: false });
  const { player: host } = addPlayer(botRoom.code, "pacing_host", "Người Mới");
  addBotsToRoom(botRoom.code, 5);
  assert.equal(resolveEffectiveMcPacingMode(botRoom), "full", "Phòng có Bot không Turbo phải tự bật Nhịp Đọc Trọn");

  const turboRoom = createRoom("turbo_host", { isTurbo: true });
  addPlayer(turboRoom.code, "turbo_host", "Tốc Chiến");
  addBotsToRoom(turboRoom.code, 5);
  assert.equal(resolveEffectiveMcPacingMode(turboRoom), "fast", "Phòng Turbo mặc định Nhịp Nhanh");
  deleteRoom(turboRoom.code);

  // Bắt đầu Đêm 1: kiểm tra sàn thời lượng đọc câu MC > 5s (chống cắt cụt 2.6s)
  ctrl.startGame(botRoom, { skipRoleReveal: true });
  assert.ok(
    ctrl.getRemainingMcFloorMs(botRoom) >= 5000,
    "Đêm Solo phải giữ sàn thời lượng MC >= 5s để đọc hết câu gọi dậy"
  );

  // Kiểm tra Đề cử 1 Bot duy nhất ở chế độ 'full' -> Không phát trùng 2 câu, ghế nóng Bot 14 giây!
  const bots = botRoom.players.filter((p) => p.isBot);
  GE.startNomination(botRoom);
  GE.nominationVote(botRoom, host.id, bots[0].id);
  mcEmitted.length = 0;
  ctrl.advanceCurrentPhase(botRoom); // day_nominate -> day_defense
  assert.equal(botRoom.game.phase, "day_defense");
  assert.equal(botRoom.game.phaseDurationSec, 14, "1 Bot bị đề cử ở chế độ Đọc Trọn phải có 14s (MC mời + Bot biện hộ trọn câu)");
  assert.equal(
    mcEmitted.length,
    1,
    "Khi chỉ có 1 bị cáo ở chế độ Đọc Trọn, không được bắn chồng 2 câu thông báo MC liên tiếp trong 1ms"
  );

  // Kiểm tra Hòa phiếu 2 Bot bị đề cử -> Bị cáo đầu 18s (2 câu MC + câu Bot), bị cáo hai 14s
  GE.startNomination(botRoom);
  GE.nominationVote(botRoom, host.id, bots[0].id);
  GE.nominationVote(botRoom, bots[1].id, bots[2].id);
  ctrl.advanceCurrentPhase(botRoom);
  assert.equal(botRoom.game.phase, "day_defense");
  assert.equal(botRoom.game.phaseDurationSec, 18, "Đồng phiếu 2 Bot: lượt đầu cần 18s để nghe trọn 2 câu MC + lời biện hộ Bot");
  ctrl.advanceCurrentPhase(botRoom);
  assert.equal(botRoom.game.phase, "day_defense");
  assert.equal(botRoom.game.phaseDurationSec, 14, "Lượt Bot thứ 2 cần 14s");

  // Người chơi Solo dù đã chết (alive = false) vẫn đổi nóng từ 'full' -> 'fast' ngay giữa trận thành công!
  host.alive = false;
  const toggleFast = setRoomMcPacingMode(botRoom.code, "pacing_host", "fast");
  assert.equal(toggleFast.ok, true);
  assert.equal(toggleFast.mcPacingMode, "fast");
  ctrl.reapplyMcPacingLive(botRoom);
  assert.equal(ctrl.getRemainingMcFloorMs(botRoom), 0, "Gạt sang Nhanh phải giải phóng sàn chờ MC ngay lập tức (0ms)");

  ctrl.clearRoomTimer(botRoom.code);
  deleteRoom(botRoom.code);
});

// 52. V4.3 — Bộ 48 File MP3 Giọng Nói 4 AI Bot (0% Trùng MC b5d182f3), Khớp Chữ-Tiếng 1:1 & Cô Lập Zero-Leak Sói Đêm
runScenario("52. V4.3: Đủ 48/48 MP3 4 AI Bot (0% trùng MC b5d182f3), khớp chữ-tiếng 1:1 & cô lập Zero-Leak thì thầm Sói đêm", () => {
  assert.equal(FORBIDDEN_MC_VOICE_ID, "b5d182f3");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");

  const manifestPath = path.join(rootDir, "client/public/audio/bots/bot_voices_manifest.json");
  const durationsPath = path.join(rootDir, "server/botVoiceDurations.json");
  assert.equal(fs.existsSync(manifestPath), true, "Phải có bot_voices_manifest.json");
  assert.equal(fs.existsSync(durationsPath), true, "Phải có server/botVoiceDurations.json cho Render");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const durations = JSON.parse(fs.readFileSync(durationsPath, "utf8"));
  assert.equal(manifest.totalClips, 48, "Manifest phải có đúng 48 câu thoại thu sẵn");
  assert.equal(Object.keys(durations).length, 48, "Bảng thời lượng Server phải có đủ 48 khóa");

  const personaIds = ["sharp_fox", "calm_owl", "bold_bear", "cautious_raven"];
  for (const pid of personaIds) {
    assert.ok(manifest.personas[pid], `Thiếu nhân cách ${pid}`);
    assert.equal(manifest.personas[pid].voiceSource, "omnivoice_voice_design_non_mc");
    const clipKeys = Object.keys(BOT_VOICE_CATALOG[pid].clips);
    assert.equal(clipKeys.length, 12, `Mỗi nhân cách phải có đúng 12 câu (${pid})`);
    for (const cid of clipKeys) {
      const mp3DiskPath = path.join(rootDir, `client/public/audio/bots/${pid}/${cid}.mp3`);
      assert.equal(fs.existsSync(mp3DiskPath), true, `Thiếu file vật lý ${pid}/${cid}.mp3`);
      const stat = fs.statSync(mp3DiskPath);
      assert.ok(stat.size > 40_000, `File ${pid}/${cid}.mp3 phải có âm thanh thật (> 40KB)`);
      assert.equal(
        manifest.personas[pid].clips[cid].text,
        BOT_VOICE_CATALOG[pid].clips[cid].text,
        `Nội dung chữ của ${pid}/${cid} phải khớp 100% giữa Manifest MP3 và Server Catalog`
      );
      assert.ok(durations[`${pid}/${cid}`] >= 3500, `Thời lượng đo thật của ${pid}/${cid} phải >= 3.5s`);
    }
  }

  // Kiểm tra tiền tố @Tên trên bóng thoại 3D trong khi spokenText giữ nguyên 100% chữ thu sẵn
  const sampleSpeech = pickZeroLeakBotSpeech({
    personaId: "sharp_fox",
    context: "day_followup",
    hasVictim: true,
    targetName: "Minh Tuấn",
  });
  assert.ok(sampleSpeech.botAudioUrl.startsWith("/audio/bots/sharp_fox/"));
  assert.equal(sampleSpeech.botAudioUrl.includes("b5d182f3"), false);
  if (sampleSpeech.bubbleText.startsWith("👉 @")) {
    assert.ok(sampleSpeech.bubbleText.startsWith("👉 @Minh Tuấn: "));
    assert.equal(sampleSpeech.bubbleText.endsWith(sampleSpeech.spokenText), true);
  }

  // KIỂM ĐỊNH CÔ LẬP ZERO-LEAK BAN ĐÊM: Bot Sói thì thầm CHỈ gửi tới Sói người thật còn sống!
  const emittedByTarget = new Map();
  const mockIo = {
    to(target) {
      return {
        emit(ev, payload) {
          if (!emittedByTarget.has(target)) emittedByTarget.set(target, []);
          emittedByTarget.get(target).push({ ev, payload });
        },
      };
    },
  };
  const ctrl = createGameController(mockIo);
  const room = createRoom("sock_human_wolf");
  const { player: pHumanWolf } = addPlayer(room.code, "sock_human_wolf", "Sói Người Sống");
  const { player: pDeadWolf } = addPlayer(room.code, "sock_dead_wolf", "Sói Đã Chết");
  const { player: pVillager } = addPlayer(room.code, "sock_villager", "Dân Thường");
  pDeadWolf.ready = true;
  pVillager.ready = true;
  addBotsToRoom(room.code, 3);
  GE.initGameState(room);
  room.phase = "playing";
  addSpectator(room.code, "sock_spectator", "Khán Giả Xem");

  const botSeats = room.players.filter((p) => p.isBot);
  pHumanWolf.role = "wolf";
  pHumanWolf.alive = true;
  pDeadWolf.role = "alpha_wolf";
  pDeadWolf.alive = false;
  pVillager.role = "villager";
  pVillager.alive = true;
  botSeats[0].role = "wolf";
  botSeats[0].personaId = "cautious_raven";
  botSeats[1].role = "seer";
  botSeats[2].role = "guard";
  room.game.phase = "night_wolf";
  room.game.wolfPicks = {};

  flushBotInteractionsForCurrentPhase(room, ctrl, { includeDayActions: false, io: mockIo });

  const hwWolfChats = (emittedByTarget.get("sock_human_wolf") || []).filter((e) => e.ev === "wolf:chat");
  const vilWolfChats = (emittedByTarget.get("sock_villager") || []).filter((e) => e.ev === "wolf:chat");
  const deadWolfChats = (emittedByTarget.get("sock_dead_wolf") || []).filter((e) => e.ev === "wolf:chat");
  const specWolfChats = (emittedByTarget.get("sock_spectator") || []).filter((e) => e.ev === "wolf:chat");
  const roomBroadcastWolfChats = (emittedByTarget.get(room.code) || []).filter((e) => e.ev === "wolf:chat");

  assert.equal(hwWolfChats.length, 1, "Đồng bọn Sói người thật còn sống phải nhận được mật đàm + giọng thì thầm của Bot Sói");
  assert.ok(hwWolfChats[0].payload.botAudioUrl.startsWith("/audio/bots/cautious_raven/wolf_"));
  assert.equal(vilWolfChats.length, 0, "ZERO-LEAK: Dân làng tuyệt đối nhận 0 sự kiện wolf:chat");
  assert.equal(deadWolfChats.length, 0, "ZERO-LEAK: Người đã chết nhận 0 sự kiện wolf:chat trực tiếp");
  assert.equal(specWolfChats.length, 0, "ZERO-LEAK: Khán giả nhận 0 sự kiện wolf:chat");
  assert.equal(roomBroadcastWolfChats.length, 0, "ZERO-LEAK: Tuyệt đối cấm broadcast wolf:chat ra room.code");

  // Kiểm tra tích hợp Client Queue Ưu tiên 3 tầng & Nút Gạt HUD
  const roomSrc = fs.readFileSync(path.join(rootDir, "client/src/components/Room.jsx"), "utf8");
  const playingSrc = fs.readFileSync(path.join(rootDir, "client/src/components/PlayingView.jsx"), "utf8");
  const botPlayerSrc = fs.readFileSync(path.join(rootDir, "client/src/utils/botVoicePlayer.js"), "utf8");
  assert.ok(roomSrc.includes("mcPlayQueueRef") && roomSrc.includes("drainMcQueue"), "Room.jsx phải tuần tự hóa hàng đợi đọc MC không tự ngắt câu");
  assert.ok(playingSrc.includes("useBotVoicePlayer") && playingSrc.includes("🐢 Đọc Trọn") && playingSrc.includes("🤖🔊"));
  assert.ok(botPlayerSrc.includes("POST_MC_BREATH_MS") && !botPlayerSrc.includes("speechSynthesis"));

  ctrl.clearRoomTimer(room.code);
  deleteRoom(room.code);
});

// 53. LEVEL 3.4 — Mở Khóa Chọn Sói/Người Không Ghi Đè Khi Thêm/Xóa Bot, Đa Tough Guy, Reset Ván Mới & Cổng mySessionToken
runScenario("53. Level 3.4: Bảo toàn cấu hình Sói khi thêm/bớt/xóa Bot, đa Tough Guy (>=2), Reset state ván 2 & mySessionToken", () => {
  // 1) Kiểm tra bảo toàn cấu hình Sói & Vai đặc biệt khi thêm / bớt / xóa Bot + mySessionToken
  const room = createRoom("host_lvl34");
  const { player: host } = addPlayer(room.code, "host_lvl34", "Chủ Phòng Test");

  const customCfg = {
    wolf: 2,
    alpha_wolf: 1,
    seer: 1,
    guard: 1,
    witch: 1,
    hunter: 0,
    cupid: 1,
    mayor: 0,
    tanner: 1,
    cursed: 0,
    tough_guy: 2,
    villager: 0, // Tổng = 10 vai (3 Sói, 2 Tough Guy)
  };
  const cfgRes = setRolesConfig(room.code, "host_lvl34", customCfg);
  assert.equal(cfgRes.ok, true);
  assert.equal(room.rolesConfig.wolf, 2);
  assert.equal(room.rolesConfig.alpha_wolf, 1);
  assert.equal(room.rolesConfig.tough_guy, 2);

  // Bấm +1 Bot liên tiếp & thêm đủ 9 Bot -> giữ nguyên 100% số Sói (2 + 1 = 3) và 2 Tough Guy!
  addBotsToRoom(room.code, 1);
  assert.equal(room.rolesConfig.wolf, 2, "Thêm +1 Bot không được xóa đè số Sói tùy chỉnh");
  assert.equal(room.rolesConfig.alpha_wolf, 1, "Thêm +1 Bot không được xóa đè Sói Đầu Đàn");
  assert.equal(room.rolesConfig.tough_guy, 2);

  addBotsToRoom(room.code, 8); // Tổng ghế = 10
  assert.equal(room.players.length, 10);
  assert.equal(room.rolesConfig.villager, 0, "Khi ghế <= tổng vai (10), không tự cộng thừa Nông Dân");

  // Thêm vượt lên ghế 11 -> tự bù đúng +1 Nông Dân, bảo toàn nguyên vẹn 3 Sói!
  addBotsToRoom(room.code, 1);
  assert.equal(room.players.length, 11);
  assert.equal(room.rolesConfig.wolf, 2);
  assert.equal(room.rolesConfig.alpha_wolf, 1);
  assert.equal(room.rolesConfig.villager, 1, "Khi thêm Bot vượt số bài (11 > 10), chỉ tự bù đúng +1 Nông Dân");

  // Bấm -1 Bot & Xóa toàn bộ Bot -> cấu hình 3 Sói vẫn giữ nguyên 100%!
  const rmOne = removeBotsFromRoom(room.code, 1);
  assert.equal(rmOne.ok, true);
  assert.equal(room.players.length, 10);
  assert.equal(room.rolesConfig.wolf, 2);
  assert.equal(room.rolesConfig.alpha_wolf, 1);

  const clrRes = clearBotsFromRoom(room.code);
  assert.equal(clrRes.ok, true);
  assert.equal(room.players.length, 1);
  assert.equal(room.rolesConfig.wolf, 2, "Xóa Bot phải bảo toàn cấu hình Sói của Chủ phòng");
  assert.equal(room.rolesConfig.alpha_wolf, 1);

  // Chặn đặt 0 Sói
  const zeroWolfRes = setRolesConfig(room.code, "host_lvl34", { ...customCfg, wolf: 0, alpha_wolf: 0, villager: 5 });
  assert.ok(zeroWolfRes.error, "setRolesConfig phải từ chối cấu hình 0 Sói");

  // Kiểm tra mySessionToken cấp gốc trong publicRoomView
  const pubView = publicRoomView(room, "host_lvl34");
  assert.equal(pubView.mySessionToken, host.sessionToken, "publicRoomView phải có mySessionToken cấp gốc cho /api/tts");

  // 2) Kiểm tra Đa Tough Guy (2 Người Cứng Cỏi bị Sói cắn ở 2 đêm liên tiếp)
  addBotsToRoom(room.code, 9);
  GE.initGameState(room);
  room.phase = "playing";
  const allP = room.players;
  allP.forEach((p, idx) => {
    p.alive = true;
    p.role = idx === 0 ? "wolf" : idx === 1 ? "tough_guy" : idx === 2 ? "tough_guy" : "villager";
  });
  const tg1 = allP[1];
  const tg2 = allP[2];

  // Đêm 1: Sói cắn tg1 -> tg1 gồng mình sống qua Đêm 1
  room.game.dayNumber = 1;
  room.game.wolfVictimId = tg1.id;
  GE.resolveNightDeaths(room);
  assert.equal(tg1.alive, true, "Đêm 1: Tough Guy #1 phải sống sót nhờ nội tại");
  assert.equal(tg2.alive, true);

  // Đêm 2: tg1 gục ngã do vết thương Đêm 1, ĐỒNG THỜI Sói cắn sang tg2 -> tg2 vẫn phải kích hoạt nội tại sống qua Đêm 2!
  room.game.dayNumber = 2;
  room.game.wolfVictimId = tg2.id;
  GE.resolveNightDeaths(room);
  assert.equal(tg1.alive, false, "Đêm 2: Tough Guy #1 phải hy sinh do vết thương từ Đêm 1");
  assert.equal(tg2.alive, true, "Đêm 2: Tough Guy #2 bị cắn lần đầu vẫn phải sống sót nhờ theo dõi riêng theo ID!");

  // Đêm 3: tg2 hy sinh đúng hẹn
  room.game.dayNumber = 3;
  room.game.wolfVictimId = null;
  GE.resolveNightDeaths(room);
  assert.equal(tg2.alive, false, "Đêm 3: Tough Guy #2 phải hy sinh do vết thương từ Đêm 2");

  deleteRoom(room.code);

  // 3) Kiểm tra mã nguồn Room.jsx & PlayingView.jsx
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");
  const roomSrc = fs.readFileSync(path.join(rootDir, "client/src/components/Room.jsx"), "utf8");
  const playingSrc = fs.readFileSync(path.join(rootDir, "client/src/components/PlayingView.jsx"), "utf8");
  assert.ok(roomSrc.includes("handleSetTableScale") && roomSrc.includes("handleChangeTotalWolves"), "Room.jsx phải có bộ chỉnh nhanh Quy Mô Bàn & Số Sói");
  assert.equal(roomSrc.includes("else {\n    const me ="), false, "Room.jsx tuyệt đối không được khai báo lùi const me trong nhánh else");
  assert.ok(playingSrc.includes("setSeerHistory([])") && playingSrc.includes('handleGhostBet("lovers")'), "PlayingView.jsx phải reset sạch state ván mới và mở đủ 4 phe Cược Cõi Âm");
});

// 54. V4.4 — UI "Quy Tắc 3 Giây", 36 Tài Sản 3D UE5 Chân Thật, PBR Normal/Rim-Light & Bối Cảnh Rừng Huyết Nguyệt
runScenario("54. V4.4: Giao diện Quy Tắc 3 Giây, 36 ảnh 3D UE5 PBR, Normal/Roughness Map & Bản đồ 3D Rừng Huyết Nguyệt", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");

  // 1) Kiểm tra 4 ảnh bối cảnh 3D UE5 Widescreen
  const bgDir = path.join(rootDir, "client/public/backgrounds");
  const expectedBgs = [
    "home_bloodmoon_village.webp",
    "preset_nordic_mist.webp",
    "preset_blood_moon.webp",
    "preset_stone_arena.webp",
  ];
  for (const fn of expectedBgs) {
    const full = path.join(bgDir, fn);
    assert.ok(fs.existsSync(full), `Thiếu ảnh bối cảnh 3D UE5: ${fn}`);
    assert.ok(fs.statSync(full).size > 5000, `Ảnh bối cảnh ${fn} dung lượng bất thường`);
  }

  // 2) Kiểm tra Scene Presets Index & Vùng Cấm Ghế R >= 6.2m trên Rừng Huyết Nguyệt
  const presetsIdx = JSON.parse(
    fs.readFileSync(path.join(rootDir, "client/public/config/scene_presets_index.json"), "utf8")
  );
  assert.ok(presetsIdx.presets.some((p) => p.id === "blood_moon_sanctuary" && p.thumbnailUrl), "Phải có bản đồ 3D Rừng Huyết Nguyệt kèm thumbnail");

  const bloodMoonLayout = JSON.parse(
    fs.readFileSync(path.join(rootDir, "client/public/config/presets/preset_blood_moon_forest.json"), "utf8")
  );
  assert.ok(Array.isArray(bloodMoonLayout.nodes) && bloodMoonLayout.nodes.length >= 25);
  for (const node of bloodMoonLayout.nodes) {
    if (node.allowCenterZone) continue;
    const dist = Math.hypot(Number(node.position?.[0] || 0), Number(node.position?.[2] || 0));
    assert.ok(dist >= 6.2, `Thực thể ${node.id} vi phạm vùng cấm ghế 3D (${dist.toFixed(2)}m < 6.2m)`);
  }

  // 3) Khóa bố cục 2 cột thiêng liêng + UI Quy tắc 3 Giây + Shader 3D PBR
  const lobbyCss = fs.readFileSync(path.join(rootDir, "client/src/components/Lobby.css"), "utf8");
  const playingCss = fs.readFileSync(path.join(rootDir, "client/src/components/PlayingView.css"), "utf8");
  const lobbySrc = fs.readFileSync(path.join(rootDir, "client/src/components/Lobby.jsx"), "utf8");
  const roomSrc = fs.readFileSync(path.join(rootDir, "client/src/components/Room.jsx"), "utf8");
  const pbrSrc = fs.readFileSync(path.join(rootDir, "client/src/3d/utils/proceduralGroundPBR.js"), "utf8");
  const char3dSrc = fs.readFileSync(path.join(rootDir, "client/src/3d/actors/SkinnedCharacterGLB.jsx"), "utf8");

  assert.ok(lobbyCss.includes("400px minmax(0, 1fr)"), "Lobby.css phải giữ chuẩn bố cục 2 cột 400px | 1fr");
  assert.ok(playingCss.includes("1fr 380px"), "PlayingView.css phải giữ chuẩn bố cục 2 cột 1fr | 380px");
  assert.ok(lobbySrc.includes("showCreatePanel") && lobbySrc.includes("home-arcane-keyart"), "Lobby.jsx phải áp dụng Progressive Disclosure & nền Làng 3D UE5");
  assert.ok(roomSrc.includes("scene-map-cards-grid") && roomSrc.includes("showRoomSettings"), "Room.jsx phải có bộ chọn 3 Bản đồ 3D trực quan & Popover Cài đặt ⚙️");
  assert.ok(pbrSrc.includes("cobbleNormalMap") && pbrSrc.includes("cobbleRoughnessMap"), "proceduralGroundPBR.js phải xuất Normal Map & Roughness Map thật");
  assert.ok(char3dSrc.includes("enhanceCharacterMaterialPBR"), "SkinnedCharacterGLB.jsx phải tiêm Fresnel Rim-Light & Bonfire Bounce PBR");
});

// 55. V4.5 — Học Viện Huyết Nguyệt (8 Socket Box-Blockout 0 Lỗi 404), 6 Cổng Chờ Nhân Vật Teen 3D, Vá Lỗi UI Thực Tế & Pipeline Tripo->Blender->Web
runScenario("55. V4.5: Map Học Viện Huyết Nguyệt (8 Socket Box->GLB, R>=6.2m), 6 Cổng Chờ Teen 3D, Vá UI RoleReveal/DevSandbox & Pipeline Blender", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");

  // 1) Kiểm tra 6 Cổng Chờ Nhân Vật Teen 3D (chỉ cấp cho Người thật, AI Bot vẫn khóa cứng 4 Dân Làng Bắc Âu)
  const expectedTeenSlots = [
    "teen_detective",
    "teen_occult",
    "teen_idol",
    "teen_hacker",
    "teen_varsity",
    "teen_rebel",
  ];
  const charManifestSrc = fs.readFileSync(
    path.join(rootDir, "client/src/3d/config/characterManifest.js"),
    "utf8"
  );
  const citizenCfgSrc = fs.readFileSync(
    path.join(rootDir, "client/src/config/citizenAvatars.config.js"),
    "utf8"
  );
  for (const tid of expectedTeenSlots) {
    assert.ok(TEEN_ACADEMY_SPECS[tid], `Server defaultNames.js thiếu cổng Teen ${tid}`);
    assert.ok(charManifestSrc.includes(`${tid}:`), `characterManifest.js thiếu cổng Teen ${tid}`);
    assert.ok(citizenCfgSrc.includes(`id: "${tid}"`), `citizenAvatars.config.js thiếu cổng Teen ${tid}`);
  }
  const humanPickTeen = resolveCitizenAvatarSpec("teen_detective", { forBot: false });
  assert.equal(humanPickTeen.citizenModelId, "teen_detective");
  assert.equal(humanPickTeen.avatarSource, "teen_academy_3d");
  const botTryTeen = resolveCitizenAvatarSpec("teen_detective", { forBot: true, fallbackSeed: "bot9" });
  assert.ok(BUILTIN_VILLAGER_IDS.includes(botTryTeen.citizenModelId), "AI Bot không được chiếm cổng chờ Teen của người thật");

  // 2) Kiểm tra Map Box-Blockout Học Viện Huyết Nguyệt & 8 Socket Kiến Trúc Hot-Swap .GLB (R >= 6.2m)
  const presetsIdx = JSON.parse(
    fs.readFileSync(path.join(rootDir, "client/public/config/scene_presets_index.json"), "utf8")
  );
  assert.ok(
    presetsIdx.presets.some((p) => p.id === "dark_academia_courtyard" && p.slotMode === "blockout_ready"),
    "scene_presets_index.json phải có bản đồ Học Viện Huyết Nguyệt (dark_academia_courtyard)"
  );

  const acadLayout = JSON.parse(
    fs.readFileSync(path.join(rootDir, "client/public/config/presets/preset_dark_academia_teen.json"), "utf8")
  );
  assert.ok(Array.isArray(acadLayout.nodes) && acadLayout.nodes.length >= 28);
  for (const node of acadLayout.nodes) {
    if (node.allowCenterZone) continue;
    const dist = Math.hypot(Number(node.position?.[0] || 0), Number(node.position?.[2] || 0));
    assert.ok(dist >= 6.2, `Node Học Viện ${node.id} vi phạm vùng cấm ghế 3D (${dist.toFixed(2)}m < 6.2m)`);
  }

  const expectedAcadProps = [
    "acad_clocktower",
    "acad_cloister_wing",
    "acad_iron_gate",
    "acad_owl_statue",
    "acad_floating_candles",
    "acad_alchemy_brazier",
    "acad_stone_bench",
    "acad_cypress_tree",
  ];
  const propManifestSrc = fs.readFileSync(path.join(rootDir, "client/src/3d/config/propManifest.js"), "utf8");
  const blockoutSrc = fs.readFileSync(path.join(rootDir, "client/src/3d/props/DarkAcademiaBlockout3D.jsx"), "utf8");
  for (const pk of expectedAcadProps) {
    assert.ok(propManifestSrc.includes(`${pk}:`), `propManifest.js thiếu socket ${pk}`);
    assert.ok(blockoutSrc.includes(`"${pk}"`), `DarkAcademiaBlockout3D.jsx thiếu khối Box ${pk}`);
  }
  assert.ok(
    fs.existsSync(path.join(rootDir, "client/public/backgrounds/preset_dark_academia.webp")) &&
      fs.existsSync(path.join(rootDir, "client/public/backgrounds/preset_neon_market_slot.webp")),
    "Phải có đủ 2 ảnh thumbnail WebP cho Học Viện Huyết Nguyệt & Cổng Chờ Phố Đêm"
  );

  // 3) Kiểm tra Vá lỗi UI Thực tế + Hybrid Blender Animation + Pipeline Tripo->Blender->Web
  const mainJsx = fs.readFileSync(path.join(rootDir, "client/src/main.jsx"), "utf8");
  assert.ok(
    mainJsx.indexOf('import "./index.css"') < mainJsx.indexOf('import App from "./App.jsx"'),
    "main.jsx phải nạp index.css trước App.jsx để không đè trắng nút component"
  );
  const arcaneCss = fs.readFileSync(path.join(rootDir, "client/src/arcane-theme.css"), "utf8");
  assert.ok(arcaneCss.includes("width: auto !important;"), "role-reveal-ready-cta phải khóa width: auto chống ép chữ dọc");
  const devSandboxCss = fs.readFileSync(path.join(rootDir, "client/src/components/DevSandbox.css"), "utf8");
  assert.ok(devSandboxCss.includes(".in-room-lobby"), "DevSandbox phải né nút Bắt Đầu Ván Đấu ở sảnh phòng");
  const skinnedSrc = fs.readFileSync(path.join(rootDir, "client/src/3d/actors/SkinnedCharacterGLB.jsx"), "utf8");
  assert.ok(
    skinnedSrc.includes("hasNativeSitClip") && skinnedSrc.includes("seatStyle"),
    "SkinnedCharacterGLB.jsx phải hỗ trợ Hybrid Blender Sit Clip & Organic Teen Idle V4.5"
  );
  assert.ok(
    fs.existsSync(path.join(rootDir, "tools/blender_tripo_to_web.py")) &&
      fs.existsSync(path.join(rootDir, "OPTIMIZE_TRIPO_BLENDER.bat")),
    "Phải có đủ bộ công cụ tự động hóa Tripo -> Blender -> Web (.py + .bat)"
  );
});

runScenario("56. V4.6: Hệ 3 Vũ Trụ (Classic/Công Sở/Học Đường), 36 Vai Zero-Drama, BossKey & Full 3D Anime Stage", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");

  // 1) Đồng bộ Room Universe + QuickMatch cô lập theo từng Vũ Trụ
  assert.equal(normalizeUniverseId("office"), "office");
  assert.equal(normalizeUniverseId("school"), "school");
  assert.equal(normalizeUniverseId("unknown_xyz"), "classic");

  const officeRoom = createRoom("sock_off_1", { universeId: "office" });
  addPlayer(officeRoom.code, "sock_off_1", "HostCongSo");
  assert.equal(officeRoom.universeId, "office");
  assert.equal(officeRoom.scenePresetId, "preset_office_penthouse_3d");

  const qmSchool = findOrCreateQuickMatchRoom("sock_sch_1", {
    name: "HsBanCuoi",
    universeId: "school",
  });
  assert.equal(qmSchool.room.universeId, "school");
  assert.notEqual(qmSchool.room.code, officeRoom.code, "QuickMatch Học Đường không được ghép nhầm vào phòng Công Sở");

  const switched = setRoomUniverse(officeRoom.code, "sock_off_1", "school");
  assert.equal(switched.ok, true);
  assert.equal(officeRoom.universeId, "school");
  assert.equal(officeRoom.scenePresetId, "preset_school_sunset_3d");
  assert.equal(publicRoomView(officeRoom).universeId, "school");

  const pubList = getPublicRoomsList();
  assert.ok(pubList.some((r) => r.code === officeRoom.code && r.universeId === "school"));

  deleteRoom(officeRoom.code);
  deleteRoom(qmSchool.room.code);

  // 2) Bộ chuyển ngữ MC Zero-Drama (Bảo toàn 100% Classic, hài hước văn minh cho Office & School)
  const rawMc = "Bầy Ma Sói thức dậy cắn người! Phù Thủy dùng Bình Độc, Tiên Tri soi ra Sói, làng bỏ phiếu treo cổ.";
  assert.equal(adaptTextForUniverse(rawMc, "classic"), rawMc);
  const officeMc = adaptTextForUniverse(rawMc, "office");
  assert.ok(!officeMc.includes("Ma Sói") && !officeMc.includes("treo cổ"), "Công Sở phải xóa sạch từ ngữ bạo lực/Ma Sói");
  assert.ok(officeMc.includes("Sếp") && officeMc.includes("Kế Toán"), "Công Sở phải chuyển sang Sếp & Kế Toán");
  const schoolMc = adaptTextForUniverse(rawMc, "school");
  assert.ok(!schoolMc.includes("Ma Sói") && !schoolMc.includes("treo cổ"), "Học Đường phải xóa sạch từ ngữ bạo lực/Ma Sói");
  assert.ok(schoolMc.includes("Chủ Nhiệm") && schoolMc.includes("Sổ Đầu Bài"), "Học Đường phải chuyển sang Chủ Nhiệm & Sổ Đầu Bài");

  // 3) Kiểm tra Sân Khấu 3D Anime Zero-Clipping, BossKey Stealth & Pipeline VRoid J_Bip_*
  const presetsIdx = JSON.parse(
    fs.readFileSync(path.join(rootDir, "client/public/config/scene_presets_index.json"), "utf8")
  );
  assert.ok(presetsIdx.presets.some((p) => p.id === "preset_office_penthouse_3d"));
  assert.ok(presetsIdx.presets.some((p) => p.id === "preset_school_sunset_3d"));
  assert.ok(fs.existsSync(path.join(rootDir, "client/src/3d/environment/OfficePenthouseStage3D.jsx")));
  assert.ok(fs.existsSync(path.join(rootDir, "client/src/components/StealthCamouflageOverlay.jsx")));
  assert.ok(fs.existsSync(path.join(rootDir, "OPTIMIZE_VROID_ANIME.bat")));

  const skinnedSrc = fs.readFileSync(path.join(rootDir, "client/src/3d/actors/SkinnedCharacterGLB.jsx"), "utf8");
  assert.ok(skinnedSrc.includes("j_bip_c_hips") && skinnedSrc.includes("faceMorphTargets"), "Phải hỗ trợ xương VRoid J_Bip_* & Blink/LipSync");
});

// 57. V4.6.1 — Kỹ Năng 3D Độc Lập, Lời Kết & Danh Hiệu 0% Lẫn Ma Sói, Âm Thanh Mặc Định BẬT & Phòng Thí Nghiệm Dev Kép
runScenario("57. V4.6.1: Kỹ năng 3D độc lập, Lời kết/Danh hiệu 0% từ Ma Sói (Office/School), Âm thanh BẬT mặc định & Dual Dev Test Lab", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");

  // 1) Âm thanh mặc định BẬT bình thường ở cả 3 Không Gian (ai thích im lặng bấm nút 🔇)
  assert.equal(UNIVERSE_THEMES.classic.silentByDefault, false);
  assert.equal(UNIVERSE_THEMES.office.silentByDefault, false, "Công Sở phải bật tiếng bình thường mặc định");
  assert.equal(UNIVERSE_THEMES.school.silentByDefault, false, "Học Đường phải bật tiếng bình thường mặc định");

  // 2) Quét 100% Từ Điển Lời Kết, 22 Nhịp Phim Recap, Danh Hiệu Server & 4 Kết Cục Giả Lập (0% lọt từ kinh dị/Ma Sói!)
  const FORBIDDEN_HORROR_RE =
    /(?<![\p{L}\p{N}])(ma sói|bầy sói|đàn sói|sói|cắn|nanh vuốt|móng vuốt|máu|treo cổ|pháp trường|lửa trại|cõi chết|hấp hối|lìa đời|tử nạn|quyên sinh|đao phủ|cõi vĩnh hằng|đạn bạc)(?![\p{L}\p{N}])/iu;

  const ALL_BEAT_KEYS = [
    "opening_reveal",
    "guard_pick",
    "wolf_aim",
    "wolf_chat",
    "wolf_strike",
    "shield_block",
    "witch_save",
    "witch_poison",
    "seer_scan",
    "cursed_turn",
    "tough_endure",
    "night_death",
    "peaceful_dawn",
    "village_chat",
    "day_nominate",
    "day_defense",
    "day_verdict",
    "cupid_link",
    "alpha_convert",
    "lover_heartbreak",
    "hunter_shot",
    "mayor_reveal",
    "mvp_finale",
  ];

  // Classic giữ nguyên 100% (trả về null để không chạm vào Ma Sói gốc)
  assert.equal(formatUniverseRecapBeat("classic", "wolf_strike", {}), null);

  for (const uId of ["office", "school"]) {
    // Quét Winner Config & UI Labels
    const winTable = UNIVERSE_RECAP_WINNER_CONFIG[uId];
    for (const wKey of ["village", "wolf", "tanner", "lovers"]) {
      const wInfo = winTable[wKey];
      assert.ok(wInfo?.title && wInfo?.subtitle, `Thiếu cấu hình thắng ${uId}.${wKey}`);
      assert.equal(
        FORBIDDEN_HORROR_RE.test(`${wInfo.title} ${wInfo.subtitle}`),
        false,
        `Winner ${uId}.${wKey} còn lọt từ Ma Sói: ${wInfo.title} | ${wInfo.subtitle}`
      );
    }
    const uiPack = UNIVERSE_RECAP_UI_LABELS[uId];
    assert.equal(
      FORBIDDEN_HORROR_RE.test(Object.values(uiPack).join(" ")),
      false,
      `UI Labels của ${uId} còn lọt từ Ma Sói`
    );

    // Quét đủ 23 khóa kịch bản Beat với mọi biến thể boolean (switched, isWolfResult, isHanged, isTannerWin)
    for (const bKey of ALL_BEAT_KEYS) {
      for (const flag of [false, true]) {
        const localized = formatUniverseRecapBeat(uId, bKey, {
          dayNum: 2,
          actorName: "Minh Anh",
          targetName: "Hoàng Khoa",
          prevName: "Thảo Vy",
          partnerName: "Tuấn Kiệt",
          chatText: "Mọi người kiểm tra kỹ lịch trình ca tối nhé!",
          switched: flag,
          isWolfResult: flag,
          isWolfSpeaker: flag,
          isCollectiveVote: flag,
          isHanged: flag,
          isTannerWin: flag,
          roleLabel: uId === "office" ? "Sếp Vi Hành" : "Cô Chủ Nhiệm",
          mvpName: "Minh Anh",
          mvpDescription: "Đóng góp xuất sắc!",
        });
        assert.ok(localized, `Thiếu kịch bản ${bKey} cho không gian ${uId}`);
        const joinedText = Object.values(localized).filter(Boolean).join(" | ");
        assert.equal(
          FORBIDDEN_HORROR_RE.test(joinedText),
          false,
          `Beat ${uId}.${bKey} (flag=${flag}) còn lọt từ Ma Sói: ${joinedText}`
        );
      }
    }

    // Giả lập thật 4 kết cục qua devSimulateRecap & kiểm tra computeMatchAwards + localizeBeatForUniverse
    const testRoom = createRoom(`sock_v461_${uId}`, { universeId: uId });
    addPlayer(testRoom.code, `sock_v461_${uId}`, "TesterDev");
    for (const wType of ["village", "wolf", "tanner", "lovers"]) {
      const simRes = devSimulateRecap(testRoom, wType, null);
      assert.equal(simRes.ok, true);
      assert.equal(testRoom.phase, "ended");
      assert.equal(testRoom.game.winner, wType);
      assert.ok(testRoom.game.replayTimeline.length >= 12, "Phải sinh >= 12 khung hình kỹ năng cho Dev test");
      assert.ok(testRoom.game.awards.length >= 2, "Phải sinh đầy đủ bảng danh hiệu cuối ván");

      for (const aw of testRoom.game.awards) {
        const awStr = `${aw.title} ${aw.description}`;
        assert.equal(
          FORBIDDEN_HORROR_RE.test(awStr),
          false,
          `Danh hiệu ${uId}/${wType} (${aw.id}) còn lọt từ Ma Sói: ${awStr}`
        );
      }

      // Kiểm chứng localizeBeatForUniverse biến đổi sạch cả câu chuyện lẫn nhãn 3D trên đầu nhân vật
      const sampleRawBeat = {
        id: "rf_5_wolf_strike",
        kind: "night",
        day: 1,
        tag: "🌙 ĐÊM 1 • ĐẠI CẢNH ĐÀN SÓI CẮN",
        title: "Cả Đàn Sói Đồng Loạt Lao Ra Tấn Công!",
        narration: "Cả đàn Sói phóng móng vuốt đỏ rực chụp xuống!",
        vfxCue: {
          vfxType: "wolf_attack",
          sourceId: testRoom.players[1].id,
          coActorIds: [testRoom.players[1].id, testRoom.players[7].id],
          targetId: testRoom.players[3].id,
        },
        actorStates: {
          [testRoom.players[1].id]: { badgeText: "🐺 ĐÀN SÓI VỒ MỒI!" },
          [testRoom.players[3].id]: { badgeText: "🩸 TRÚNG NANH ĐÀN SÓI!" },
        },
      };
      const cleanBeat = localizeBeatForUniverse(sampleRawBeat, {
        universeId: uId,
        players: testRoom.players,
        awards: testRoom.game.awards,
        winner: wType,
      });
      const beatDump = [
        cleanBeat.tag,
        cleanBeat.title,
        cleanBeat.narration,
        ...Object.values(cleanBeat.actorStates).map((s) => s.badgeText || ""),
      ].join(" | ");
      assert.equal(
        FORBIDDEN_HORROR_RE.test(beatDump),
        false,
        `localizeBeatForUniverse (${uId}) còn sót chữ Ma Sói: ${beatDump}`
      );
    }

    // Kiểm tra devSwitchUniverseLive đổi nóng sang không gian khác và tự chấm lại danh hiệu
    const nextU = uId === "office" ? "school" : "office";
    const swRes = devSwitchUniverseLive(testRoom, nextU);
    assert.equal(swRes.ok, true);
    assert.equal(testRoom.universeId, nextU);
    for (const aw of testRoom.game.awards) {
      assert.equal(FORBIDDEN_HORROR_RE.test(`${aw.title} ${aw.description}`), false);
    }
    deleteRoom(testRoom.code);
  }

  // 3) Kiểm tra mã nguồn 3D Choreography, 3D VFX, Studio /?choreo=1 & DevSandbox
  const choreoSrc = fs.readFileSync(
    path.join(rootDir, "client/src/3d/animation/actorChoreography3D.js"),
    "utf8"
  );
  const vfxSrc = fs.readFileSync(
    path.join(rootDir, "client/src/3d/actors/ActionChoreoVfx3D.jsx"),
    "utf8"
  );
  const sceneSrc = fs.readFileSync(
    path.join(rootDir, "client/src/3d/scene/WerewolfScene3D.jsx"),
    "utf8"
  );
  const devSandboxSrc = fs.readFileSync(
    path.join(rootDir, "client/src/components/DevSandbox.jsx"),
    "utf8"
  );
  assert.ok(choreoSrc.includes("getChoreoScenariosForUniverse"), "Phải có bộ kịch bản Studio 3 không gian");
  assert.ok(vfxSrc.includes('universeId === "office"') && vfxSrc.includes('universeId === "school"'), "3D VFX phải tách nhánh đạo cụ riêng cho Công Sở & Học Đường");
  assert.ok(sceneSrc.includes("ws:dev-preview-choreo") && sceneSrc.includes("handleChangeStudioUniverse"), "WerewolfScene3D phải hỗ trợ 1-Click Preview & chuyển nóng 3 không gian trong Studio");
  assert.ok(devSandboxSrc.includes("dev:simulateRecap") && devSandboxSrc.includes("dev:setUniverse"), "DevSandbox phải có bộ nút test 4 lời kết & chuyển nóng không gian");
});

// 58. V4.6.2 — Giao Diện Mở Đầu Mobile-First Tối Giản 4 Bước, 18 Avatar 3 Không Gian 1:1 Ghế 3D & Chống Tràn iOS
runScenario("58. V4.6.2: Wizard mở đầu Mobile 4 bước (Không gian -> Tên -> Avatar -> Sảnh), đồng bộ 1:1 Avatar 3D & chống zoom iOS 16px", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "../..");

  // 1) Kiểm tra 6 Avatar riêng cho từng Không Gian (0% lọt chữ Bắc Âu/Bô Lão vào Công Sở & Học Đường)
  const classicSet = getUniverseOnboardingAvatars("classic");
  const officeSet = getUniverseOnboardingAvatars("office");
  const schoolSet = getUniverseOnboardingAvatars("school");
  assert.equal(classicSet.length, 6);
  assert.equal(officeSet.length, 6);
  assert.equal(schoolSet.length, 6);

  const NORDIC_LEAK_RE = /(bắc âu|bô lão|thôn nữ|nông dân|áo choàng)/i;
  for (const item of [...officeSet, ...schoolSet]) {
    assert.equal(
      NORDIC_LEAK_RE.test(`${item.label} ${item.shortLabel} ${item.desc}`),
      false,
      `Avatar ${item.id} bị lẫn nhãn cổ trang Bắc Âu: ${item.label}`
    );
    assert.ok(UNIVERSE_ANIME_SPECS[item.id], `Server defaultNames.js thiếu cấu hình ${item.id}`);
    assert.ok(ANIME_AVATAR_3D_LOOKS[item.id], `Thiếu bảng màu/tóc 3D Anime cho ${item.id}`);
    assert.equal(sanitizeCitizenModelId(item.id), item.id);
    assert.equal(sanitizeAvatarUrl(item.portraitBadge), item.portraitBadge);

    const svgFull = path.join(rootDir, "client/public", item.portraitBadge.replace(/^\//, ""));
    assert.ok(fs.existsSync(svgFull), `Thiếu file ảnh chân dung SVG cho ${item.id}: ${svgFull}`);

    // Người chơi thật nhận đúng Avatar 1:1; AI Bot vẫn khóa cứng 4 Dân Làng gốc
    const humanSpec = resolveCitizenAvatarSpec(item.id, { forBot: false });
    assert.equal(humanSpec.citizenModelId, item.id);
    assert.equal(humanSpec.avatar, item.portraitBadge);

    const botSpec = resolveCitizenAvatarSpec(item.id, { forBot: true, fallbackSeed: "bot_test" });
    assert.ok(BUILTIN_VILLAGER_IDS.includes(botSpec.citizenModelId));
  }

  // Tự căn chỉnh Avatar mặc định khi chuyển Không Gian ở Bước 1
  assert.equal(resolveAlignedCitizenModelForUniverse("office", "villager_cloak"), "office_suit_m");
  assert.equal(resolveAlignedCitizenModelForUniverse("school", "villager_cloak"), "school_boy_blazer");
  assert.equal(resolveAlignedCitizenModelForUniverse("office", "office_blazer_f"), "office_blazer_f");

  // Phòng Chơi Cùng BOT AI (hidden) không được làm rác Danh sách phòng công khai đang online
  const soloHiddenRoom = createRoom("sock_solo_v462", {
    universeId: "office",
    accessMode: "hidden",
  });
  addPlayer(soloHiddenRoom.code, "sock_solo_v462", "Minh Công Sở", null, null, "", {
    citizenModelId: "office_blazer_f",
  });
  addBotsToRoom(soloHiddenRoom.code, 7);
  assert.equal(soloHiddenRoom.players[0].citizenModelId, "office_blazer_f");
  assert.equal(soloHiddenRoom.players[0].avatar, "/portraits/universe/office_blazer_f.svg");
  assert.equal(
    getPublicRoomsList().some((r) => r.code === soloHiddenRoom.code),
    false,
    "Phòng Chơi Cùng BOT AI không được làm rác danh sách phòng online công khai"
  );
  deleteRoom(soloHiddenRoom.code);

  // 2) Kiểm tra cấu trúc mã nguồn Lobby.jsx & Lobby.css (4 bước tuần tự + iOS 16px + 2 nút chủ lực + mã phòng)
  const lobbySrc = fs.readFileSync(path.join(rootDir, "client/src/components/Lobby.jsx"), "utf8");
  const lobbyCss = fs.readFileSync(path.join(rootDir, "client/src/components/Lobby.css"), "utf8");
  assert.ok(
    lobbySrc.includes('onboardingStep === "universe"') &&
      lobbySrc.includes('onboardingStep === "name"') &&
      lobbySrc.includes('onboardingStep === "avatar"') &&
      lobbySrc.includes("VÀO CHƠI NHANH") &&
      lobbySrc.includes("VÀO CHƠI CÙNG BOT AI") &&
      lobbySrc.includes("Phòng đang online"),
    "Lobby.jsx phải có đủ 4 bước tuần tự và 2 nút Vào Chơi Nhanh / Vào Chơi Cùng BOT AI + Phòng đang online"
  );
  assert.ok(
    lobbyCss.includes("font-size: 16px !important") &&
      lobbyCss.includes("100dvh") &&
      /\.mobile-onboard-shell\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s.test(lobbyCss),
    "Lobby.css phải khóa font-size: 16px chống zoom iOS Safari, 100dvh và z-index: 1 nổi trên .home-arcane-backdrop"
  );
  const runtimeEnvSrc = fs.readFileSync(path.join(rootDir, "client/src/config/runtimeEnv.js"), "utf8");
  assert.ok(
    runtimeEnvSrc.includes("resolveLocalDevServerUrl") && runtimeEnvSrc.includes("192\\.168"),
    "runtimeEnv.js phải hỗ trợ tự động nối cổng :3001 cho cả localhost lẫn IP LAN điện thoại"
  );
});

const totalMs = (performance.now() - startTime).toFixed(1);
const passed = results.filter((r) => r.ok).length;
console.log("--------------------------------------------------------------");
console.log(`  📊 KẾT QUẢ: ${passed}/${results.length} KỊCH BẢN PASS (Tổng thời gian: ${totalMs}ms)`);
console.log("==============================================================");

if (passed !== results.length) {
  process.exit(1);
}
