import assert from "node:assert/strict";
import * as GE from "../gameEngine.js";
import { generateDefaultRoles, assignCustomRoles } from "../roles.js";
import { createRoom, addPlayer, publicRoomView } from "../rooms.js";
import { createGameController } from "../gameController.js";
import { registerDevSocketHandlers } from "../devSandbox.js";

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
    room.players[idx].alive = true;
  });
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

  // Bot đồng loạt bấm Skip thảo luận + Host skip -> tự sang day_nominate
  handlers["dev:botVote"]({ action: "skip_discuss" }, () => {});
  const hostSkip = gameCtrl.voteSkipDiscussion(room, host.id);
  if (hostSkip.allSkipped) {
    gameCtrl.clearRoomTimer(room.code);
    gameCtrl.forceEndDiscussion(room);
  }
  assert.equal(room.game.phase, "day_nominate");

  // Bot đề cử Sói lên ghế nóng -> Tua qua Biện hộ -> Bot vote Treo cổ
  handlers["dev:botVote"]({ action: "nominate_wolf" }, () => {});
  handlers["dev:skipPhase"]({}, () => {}); // finalizeNomination -> day_defense
  assert.equal(room.game.phase, "day_defense");
  handlers["dev:skipPhase"]({}, () => {}); // finishDefenseTurn -> day_final_vote
  assert.equal(room.game.phase, "day_final_vote");
  handlers["dev:botVote"]({ action: "vote_hang" }, () => {});
  assert.equal(Object.values(room.game.finalVotes).filter((v) => v === "hang").length, 5);

  gameCtrl.clearRoomTimer(room.code);
});

const totalMs = (performance.now() - startTime).toFixed(1);
const passed = results.filter((r) => r.ok).length;
console.log("--------------------------------------------------------------");
console.log(`  📊 KẾT QUẢ: ${passed}/${results.length} KỊCH BẢN PASS (Tổng thời gian: ${totalMs}ms)`);
console.log("==============================================================");

if (passed !== results.length) {
  process.exit(1);
}
