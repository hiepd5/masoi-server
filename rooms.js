import { getDefaultName, getAvatarUrl } from "./defaultNames.js";

// rooms: Map<roomCode, RoomState>
// RoomState = {
//   code, hostId, phase: 'lobby'|'night'|'day'|'vote'|'ended',
//   players: [{ id, name, avatar, isHost, alive, role }]
// }
const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bỏ ký tự dễ nhầm (0,O,I,1)
  let code;
  do {
    code = Array.from({ length: 5 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

export function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    phase: "lobby",
    players: [],
  };
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

export function addPlayer(code, socketId, requestedName) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  if (room.phase !== "lobby")
    return { error: "Ván chơi đã bắt đầu, không thể vào phòng." };
  if (room.players.length >= 18)
    return { error: "Phòng đã đầy (tối đa 18 người)." };

  const existingNames = room.players.map((p) => p.name);
  let name = requestedName?.trim();
  if (!name || existingNames.includes(name)) {
    name = getDefaultName(existingNames);
  }

  const player = {
    id: socketId,
    name,
    avatar: getAvatarUrl(name + "-" + socketId.slice(0, 4)),
    isHost: room.players.length === 0,
    alive: true,
    role: null,
  };
  room.players.push(player);
  return { room, player };
}

export function removePlayer(code, socketId) {
  const room = getRoom(code);
  if (!room) return null;
  room.players = room.players.filter((p) => p.id !== socketId);

  // Nếu host rời phòng, chuyển host cho người tiếp theo
  if (room.players.length > 0 && !room.players.some((p) => p.isHost)) {
    room.players[0].isHost = true;
    room.hostId = room.players[0].id;
  }

  // Phòng trống thì dọn dẹp
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return null;
  }
  return room;
}

export function renamePlayer(code, socketId, newName) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  const trimmed = newName?.trim();
  if (!trimmed) return { error: "Tên không được để trống." };
  if (trimmed.length > 20) return { error: "Tên tối đa 20 ký tự." };

  const taken = room.players.some(
    (p) => p.id !== socketId && p.name === trimmed
  );
  if (taken) return { error: "Tên này đã có người dùng trong phòng." };

  const player = room.players.find((p) => p.id === socketId);
  if (!player) return { error: "Không tìm thấy người chơi." };
  player.name = trimmed;
  player.avatar = getAvatarUrl(trimmed + "-" + socketId.slice(0, 4));
  return { room, player };
}

// Trả về bản public của room (an toàn để gửi cho mọi client — không lộ role người khác)
export function publicRoomView(room, forSocketId) {
  const g = room.game;
  const gameOver = g?.winner;

  const base = {
    code: room.code,
    phase: room.phase, // 'lobby' | 'playing' | 'ended'
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      isHost: p.isHost,
      alive: p.alive,
      // chỉ trả về role của chính người xem, hoặc nếu game đã kết thúc, hoặc đã chết (lộ bài)
      role: p.id === forSocketId || gameOver || !p.alive ? p.role : null,
    })),
  };

  if (!g) return base;

  const me = room.players.find((p) => p.id === forSocketId);

  return {
    ...base,
    game: {
      dayNumber: g.dayNumber,
      nightDayPhase: g.phase,
      roleCounts: g.roleCounts,
      nightDeaths: ["day_reveal", "day_discuss", "day_nominate", "day_defense", "day_final_vote", "day_no_nomination"].includes(
        g.phase
      )
        ? g.nightDeaths
        : [],
      gameStartedAt: g.gameStartedAt,
      phaseEndsAt: g.phaseEndsAt,
      discussEndsAt: g.discussEndsAt,
      nominees: g.nominees,
      hotSeatQueue: g.hotSeatQueue,
      hotSeatIndex: g.hotSeatIndex,
      hotSeatEndsAt: g.hotSeatEndsAt,
      finalVoteEndsAt: g.finalVoteEndsAt,
      // vote đề cử công khai -> ai cũng thấy ai vote ai
      nominationVotes: g.phase === "day_nominate" || g.hotSeatQueue.length ? g.nominationVotes : {},
      finalVotes: g.phase === "day_final_vote" ? g.finalVotes : {},
      winner: g.winner,
      history: gameOver ? g.history : [],

      // Thông tin riêng theo vai trò của người xem
      myRole: me?.role || null,
      wolfTeammates:
        me?.role === "wolf"
          ? room.players.filter((p) => p.role === "wolf" && p.id !== me.id).map((p) => p.id)
          : [],
      wolfPicksVisible: me?.role === "wolf" ? g.wolfPicks : null,
      witchInfo:
        me?.role === "witch"
          ? {
              victimId: g.wolfVictimId,
              usedSave: g.witchUsedSave,
              usedPoison: g.witchUsedPoison,
            }
          : null,
      seerLastResult:
        me?.role === "seer"
          ? g.seerChecksLog.filter((c) => c.seerId === me.id).slice(-1)[0] || null
          : null,
    },
  };
}
