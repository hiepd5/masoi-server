import { randomUUID } from "crypto";
import { getDefaultName, getAvatarUrl } from "./defaultNames.js";
import { generateDefaultRoles } from "./roles.js";

// rooms: Map<roomCode, RoomState>
// RoomState = {
//   code, hostId, phase: 'lobby'|'night'|'day'|'vote'|'ended',
//   players: [{ id, name, avatar, isHost, alive, role, ready }]
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
    rolesConfig: generateDefaultRoles(6),
    lobbyMessages: [],
  };
  rooms.set(code, room);
  return room;
}


export function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

export function addPlayer(code, socketId, requestedName, avatarSeed = null, avatarUrl = null) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  
  let name = requestedName?.trim();
  
  // Reconnect logic — cho phép kể cả khi connected=true nhưng socketId khác (reconnect nhanh)
  if (room.phase !== "lobby" && name) {
    const existingPlayer = room.players.find(p => p.name === name);
    if (existingPlayer && existingPlayer.socketId !== socketId) {
      existingPlayer.socketId = socketId;
      existingPlayer.connected = true;
      if (existingPlayer.disconnectTimer) {
        clearTimeout(existingPlayer.disconnectTimer);
        existingPlayer.disconnectTimer = null;
      }
      return { room, player: existingPlayer };
    }
    // Cùng socketId — đã kết nối rồi, trả về luôn
    if (existingPlayer && existingPlayer.socketId === socketId) {
      return { room, player: existingPlayer };
    }
  }

  if (room.phase !== "lobby")
    return { error: "Ván chơi đã bắt đầu, không thể vào phòng." };
  if (room.players.length >= 18)
    return { error: "Phòng đã đầy (tối đa 18 người)." };

  const existingNames = room.players.map((p) => p.name);
  if (!name || existingNames.includes(name)) {
    name = getDefaultName(existingNames);
  }

  const player = {
    id: socketId,
    socketId: socketId,
    connected: true,
    sessionToken: randomUUID(),
    disconnectedAt: null,
    name,
    avatar: avatarUrl
      || (avatarSeed
        ? `https://api.dicebear.com/7.x/adventurer/svg?seed=${avatarSeed}&backgroundColor=b6e3f4,c0aede,d1d4f9`
        : getAvatarUrl(name + "-" + socketId.slice(0, 4))),
    isHost: room.players.length === 0,
    ready: room.players.length === 0,
    alive: true,
    role: null,
  };
  room.players.push(player);
  // Cập nhật cấu hình vai trò mặc định theo số người chơi
  if (room.phase === "lobby" && (!room.rolesConfig || Object.keys(room.rolesConfig).length === 0)) {
    room.rolesConfig = generateDefaultRoles(room.players.length);
  }
  return { room, player };
}


export function reconnectByToken(code, token, newSocketId) {
  const room = getRoom(code);
  if (!room) return { error: "Token không hợp lệ hoặc đã hết hạn." };

  const player = room.players.find((p) => p.sessionToken === token);
  if (!player) return { error: "Token không hợp lệ hoặc đã hết hạn." };

  if (player.disconnectedAt !== null && Date.now() - player.disconnectedAt > 30 * 60 * 1000) {
    return { error: "Phiên chơi đã hết hạn (30 phút). Vui lòng tạo phòng mới." };
  }

  player.socketId = newSocketId;
  player.connected = true;
  player.disconnectedAt = null;
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }

  return { room, player };
}

export function removePlayer(code, socketId) {
  const room = getRoom(code);
  if (!room) return null;
  
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return room;

  if (room.phase === "lobby") {
    room.players = room.players.filter((p) => p.id !== player.id);
    // Chuyển host
    if (room.players.length > 0 && !room.players.some((p) => p.isHost)) {
      room.players[0].isHost = true;
      room.hostId = room.players[0].id;
    }
  } else {
    // Đang chơi, chỉ set connected = false
    player.connected = false;
    player.disconnectedAt = Date.now();
    // (Tuỳ chọn: 5 phút sau xoá hẳn, nhưng trong board game nên giữ lại "cái xác" để không hỏng game)
  }

  // Dọn phòng nếu trống (trong lobby) hoặc tất cả đều rớt mạng
  if (room.players.length === 0 || room.players.every(p => !p.connected)) {
    rooms.delete(room.code);
    return null;
  }
  return room;
}

export function renamePlayer(code, socketId, newName, avatarSeed = null, avatarUrl = null) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  const trimmed = newName?.trim();
  if (!trimmed) return { error: "Tên không được để trống." };
  if (trimmed.length > 20) return { error: "Tên tối đa 20 ký tự." };

  const taken = room.players.some(
    (p) => p.socketId !== socketId && p.name === trimmed
  );
  if (taken) return { error: "Tên này đã có người dùng trong phòng." };

  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return { error: "Không tìm thấy người chơi." };
  player.name = trimmed;
  player.avatar = avatarUrl
    || (avatarSeed
      ? `https://api.dicebear.com/7.x/adventurer/svg?seed=${avatarSeed}&backgroundColor=b6e3f4,c0aede,d1d4f9`
      : getAvatarUrl(trimmed + "-" + player.id.slice(0, 4)));
  return { room, player };
}

export function toggleReady(code, socketId) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return { error: "Không tìm thấy người chơi." };

  if (player.isHost) {
    player.ready = true;
  } else {
    player.ready = !player.ready;
  }
  return { ok: true, room, ready: player.ready };
}

export function setRolesConfig(code, requesterSocketId, newConfig) {
  const room = getRoom(code);
  if (!room) return { error: "Phòng không tồn tại." };
  const player = room.players.find((p) => p.socketId === requesterSocketId);
  if (!player || !player.isHost) {
    return { error: "Chỉ chủ phòng mới có quyền thay đổi cấu hình vai trò." };
  }
  if (!newConfig || typeof newConfig !== "object") {
    return { error: "Cấu hình vai trò không hợp lệ." };
  }
  room.rolesConfig = newConfig;
  return { ok: true, room };
}

export function addLobbyMessage(code, senderSocketId, text) {
  const room = getRoom(code);
  if (!room) return null;
  const player = room.players.find((p) => p.socketId === senderSocketId);
  if (!player) return null;
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const msg = {
    id: randomUUID(),
    senderId: player.id,
    senderName: player.name,
    avatar: player.avatar,
    text: trimmed,
    time: new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }),
  };

  if (!room.lobbyMessages) room.lobbyMessages = [];
  room.lobbyMessages.push(msg);
  if (room.lobbyMessages.length > 50) {
    room.lobbyMessages.shift();
  }
  return msg;
}

// Trả về bản public của room (an toàn để gửi cho mọi client — không lộ role người khác)
export function publicRoomView(room, forSocketId) {
  const g = room.game;
  const gameOver = g?.winner;
  const me = room.players.find((p) => p.socketId === forSocketId);

  const base = {
    code: room.code,
    phase: room.phase, // 'lobby' | 'playing' | 'ended'
    rolesConfig: room.rolesConfig || generateDefaultRoles(room.players.length),
    lobbyMessages: room.lobbyMessages || [],
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      isHost: p.isHost,
      ready: p.isHost ? true : Boolean(p.ready),
      alive: p.alive,
      connected: p.connected,
      sessionToken: p.id === me?.id ? p.sessionToken : undefined,
      // chỉ trả về role của chính người xem, hoặc nếu game đã kết thúc, hoặc đã chết (lộ bài)
      role: p.id === me?.id || gameOver || !p.alive ? p.role : null,
    })),
  };


  if (!g) return base;

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
      skipDiscussVotes: g.phase === 'day_discuss' ? g.skipDiscussVotes : {},

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
