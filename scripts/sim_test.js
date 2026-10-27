import assert from "node:assert/strict";
import * as GE from "../gameEngine.js";
import { generateDefaultRoles, generateExpandedV33Roles, assignCustomRoles } from "../roles.js";
import {
  createRoom,
  addPlayer,
  removePlayer,
  setRoomAccess,
  setSoloPracticeRole,
  addBotsToRoom,
  getPublicRoomsList,
  getRoom,
  publicRoomView,
} from "../rooms.js";
import { createGameController } from "../gameController.js";
import { registerDevSocketHandlers } from "../devSandbox.js";
import {
  normalizeTtsText,
  getTtsCacheKey,
  deriveStoryNarrationsFromRoom,
  DEFAULT_VOICE_ID,
  DEFAULT_TTS_SPEED,
} from "../storyVoiceEngine.js";

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

  // Đổi nóng sang Phù Thủy ngay trong trận + Tua qua các phase Đêm -> Thảo luận -> Đề cử
  handlers["dev:forceRole"]({ role: "witch" }, () => {});
  assert.equal(host.role, "witch");

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

const totalMs = (performance.now() - startTime).toFixed(1);
const passed = results.filter((r) => r.ok).length;
console.log("--------------------------------------------------------------");
console.log(`  📊 KẾT QUẢ: ${passed}/${results.length} KỊCH BẢN PASS (Tổng thời gian: ${totalMs}ms)`);
console.log("==============================================================");

if (passed !== results.length) {
  process.exit(1);
}
