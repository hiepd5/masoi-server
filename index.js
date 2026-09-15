import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import {
  createRoom,
  getRoom,
  addPlayer,
  reconnectByToken,
  removePlayer,
  renamePlayer,
  toggleReady,
  setRolesConfig,
  addLobbyMessage,
  publicRoomView,
} from "./rooms.js";

import { createGameController } from "./gameController.js";
import { AccessToken } from "livekit-server-sdk";
import https from "https";

const LIVEKIT_URL = process.env.LIVEKIT_URL || "wss://ma-soi-online-rac6j8ri.livekit.cloud";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "APIQ2WP9w5JhSKX";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "ivTQhkkUZ3otV7XepsCnBdPmHTP6RIFhJRRsn1d28jI";

// LiveKit health check cache (60s TTL)
let livekitHealthCache = { ok: true, checkedAt: 0, message: null };
const LIVEKIT_HEALTH_TTL = 60_000;

function checkLivekitHealth() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (now - livekitHealthCache.checkedAt < LIVEKIT_HEALTH_TTL) {
      return resolve(livekitHealthCache);
    }
    const httpUrl = LIVEKIT_URL.replace(/^wss?:\/\//, "https://") + "/rtc?access_token=probe&protocol=11";
    const req = https.get(httpUrl, { timeout: 5000 }, (res) => {
      const is429 = res.statusCode === 429;
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        livekitHealthCache = { ok: !is429, checkedAt: Date.now(), message: is429 ? body.trim() : null };
        resolve(livekitHealthCache);
      });
    });
    req.on("error", () => {
      // Network error — still let client try; don't block
      livekitHealthCache = { ok: true, checkedAt: Date.now(), message: null };
      resolve(livekitHealthCache);
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: true, checkedAt: Date.now(), message: null }); });
  });
}

const app = express();
app.use(cors({ origin: "*" }));
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

function broadcastRoom(room) {
  // Mỗi client nhận view riêng (role của chính họ), nên emit riêng từng socket
  room.players.forEach((p) => {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit("room:update", publicRoomView(room, p.socketId));
    }
  });
}

const gameCtrl = createGameController(io);

io.on("connection", (socket) => {
  console.log("Kết nối mới:", socket.id);

  // Heartbeat: ping mỗi 30s, kick sau 60s không pong
  let missedPings = 0;
  const heartbeatInterval = setInterval(() => {
    if (missedPings >= 2) {
      // 2 missed pings = ~60s không phản hồi → disconnect
      clearInterval(heartbeatInterval);
      socket.disconnect(true);
      return;
    }
    missedPings++;
    socket.emit('ping:server');
  }, 30000);

  socket.on('pong:client', () => {
    missedPings = 0; // reset khi nhận pong
  });

  socket.on("room:create", (_, cb) => {
    const room = createRoom(socket.id);
    const { room: joinedRoom, player } = addPlayer(room.code, socket.id);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    cb?.({ ok: true, roomCode: room.code, playerId: player.id });
    broadcastRoom(joinedRoom);
  });

  socket.on("room:reconnect", ({ roomCode, sessionToken }, cb) => {
    const result = reconnectByToken(roomCode, sessionToken, socket.id);
    if (result.error) {
      cb?.({ ok: false, error: result.error });
      return;
    }
    socket.join(result.room.code);
    socket.data.roomCode = result.room.code;
    socket.data.playerId = result.player.id;
    cb?.({ ok: true, roomCode: result.room.code, playerId: result.player.id });
    broadcastRoom(result.room);
  });

  socket.on("room:join", ({ roomCode, name, avatarSeed, avatarUrl }, cb) => {
    const result = addPlayer(roomCode, socket.id, name, avatarSeed || null, avatarUrl || null);
    if (result.error) {
      cb?.({ ok: false, error: result.error });
      return;
    }
    socket.join(result.room.code);
    socket.data.roomCode = result.room.code;
    socket.data.playerId = result.player.id;  // ← lưu stable playerId
    cb?.({ ok: true, roomCode: result.room.code, playerId: result.player.id });
    broadcastRoom(result.room);
  });

  socket.on("room:rename", ({ newName, avatarSeed, avatarUrl }, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = renamePlayer(code, socket.id, newName, avatarSeed || null, avatarUrl || null);
    if (result.error) {
      cb?.({ ok: false, error: result.error });
      return;
    }
    cb?.({ ok: true });
    broadcastRoom(result.room);
  });

  socket.on("room:leave", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = removePlayer(code, socket.id);
    socket.leave(code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    if (room) broadcastRoom(room);
  });

  socket.on("room:toggleReady", (_, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = toggleReady(code, socket.id);
    if (result.error) return cb?.({ ok: false, error: result.error });
    broadcastRoom(result.room);
    cb?.({ ok: true, ready: result.ready });
  });

  socket.on("room:setRolesConfig", ({ rolesConfig }, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = setRolesConfig(code, socket.id, rolesConfig);
    if (result.error) return cb?.({ ok: false, error: result.error });
    broadcastRoom(result.room);
    cb?.({ ok: true });
  });

  socket.on("room:lobbyChat", ({ message }, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const msg = addLobbyMessage(code, socket.id, message);
    if (!msg) return cb?.({ ok: false, error: "Không gửi được tin nhắn." });
    io.to(code).emit("room:lobbyMessage", msg);
    cb?.({ ok: true });
  });


  socket.on("livekit:token", async (_, cb) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return cb?.({ error: "Không tìm thấy phòng." });
    const player = room.players.find((p) => p.socketId === socket.id)
                || room.players.find((p) => p.id === socket.data.playerId);
    if (!player) return cb?.({ error: "Không tìm thấy người chơi." });

    // Kiểm tra LiveKit Cloud còn hoạt động không (cached 60s)
    const health = await checkLivekitHealth();
    if (!health.ok) {
      return cb?.({ error: "LIVEKIT_QUOTA_EXCEEDED" });
    }

    try {
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: player.id,
        name: player.name,
        ttl: '2h', // OPT 5: 2h đủ cho 1 ván, giảm từ 6h
      });
      at.addGrant({ roomJoin: true, room: code, canPublish: true, canSubscribe: true });
      cb?.({ token: await at.toJwt(), url: LIVEKIT_URL });

    } catch (e) {
      cb?.({ error: e.message });
    }
  });

  socket.on("disconnect", () => {
    clearInterval(heartbeatInterval);
    const code = socket.data.roomCode;
    if (!code) return;
    const room = removePlayer(code, socket.id);
    if (room) broadcastRoom(room);
    console.log("Ngắt kết nối:", socket.id);
  });

  // ============ GAME EVENTS ============
  function withPlayer(cb) {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return null;

    // Tìm theo socketId (bình thường)
    let player = room.players.find((p) => p.socketId === socket.id);

    // Fallback: tìm theo playerId đã lưu trong socket.data (trường hợp reconnect edge case)
    if (!player && socket.data.playerId) {
      player = room.players.find((p) => p.id === socket.data.playerId);
      if (player) {
        // Tự sửa: cập nhật socketId để các lần sau hoạt động bình thường
        console.log(`[Reconnect Repair] Player ${player.name}: socketId fixed ${player.socketId} → ${socket.id}`);
        player.socketId = socket.id;
        player.connected = true;
      }
    }

    if (!player) return null;
    return cb(room, player);
  }

  socket.on("game:start", (_, cb) => {
    withPlayer((room, player) => {
      if (!player.isHost) return cb?.({ ok: false, error: "Chỉ chủ phòng mới bắt đầu được." });
      const result = gameCtrl.startGame(room);
      cb?.(result);
    });
  });

  socket.on("room:restart", (_, cb) => {
    withPlayer((room, player) => {
      if (!player.isHost) return cb?.({ ok: false, error: "Chỉ chủ phòng mới có thể chơi lại." });
      
      gameCtrl.clearRoomTimer(room.code);
      room.game = null;
      room.phase = "lobby";

      // BUG E FIX: Reset trạng thái người chơi để không lộ role/alive từ ván cũ vào lobby
      room.players.forEach((p) => {
        p.alive = true;
        p.role = null;
        p.ready = p.isHost; // Host luôn sẵn sàng, member phải bấm Ready lại
      });

      broadcastRoom(room);
      cb?.({ ok: true });
    });
  });

  socket.on("action:guardProtect", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.guardProtect(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:wolfPick", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.wolfPick(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room); // để sói khác thấy realtime ai đang chọn ai
      cb?.(result);
    });
  });

  socket.on("action:wolfChat", ({ message }, cb) => {
    withPlayer((room, player) => {
      if (player.role !== "wolf") return;
      room.players.forEach(p => {
        if (p.role === "wolf" && p.id !== player.id && p.connected && p.socketId) {
          io.to(p.socketId).emit("wolf:chat", { senderId: player.id, message });
        }
      });
      cb?.({ ok: true });
    });
  });

  socket.on("action:villageChat", ({ message }, cb) => {
    withPlayer((room, player) => {
      if (!player.alive) return cb?.({ ok: false, error: "Bạn đã chết, không thể chat" });
      
      // BUG 10 FIX: Thêm optional chaining để tránh crash khi room.game là null
      if (room.game?.phase?.startsWith("night_")) return cb?.({ ok: false, error: "Ban đêm không được chat ồn ào!" });

      io.to(room.code).emit("village:chat", { 
        senderId: player.id, 
        senderName: player.name, 
        message 
      });
      cb?.({ ok: true });
    });
  });

  socket.on("action:witchDecide", (payload, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.witchDecide(room, player.id, payload);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:seerCheck", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.seerCheck(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:voteExtendDiscussion", ({ wantExtend }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.voteExtendDiscussion(room, player.id, wantExtend);
      gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:skipDiscussion", (_, cb) => {
    withPlayer((room, player) => {
      // BUG 9 FIX: Không trigger phase mới sau khi game đã kết thúc
      if (room.game?.winner) return cb?.({ ok: false });
      const result = gameCtrl.voteSkipDiscussion(room, player.id);
      if (result.ok) {
        gameCtrl.broadcast(room);
        if (result.allSkipped) {
          // Clear timer and move to nomination
          gameCtrl.clearRoomTimer(room.code);
          gameCtrl.forceEndDiscussion(room);
        }
      }
      cb?.(result);
    });
  });


  socket.on("action:nominationVote", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      // BUG 9 FIX: Không cho vote sau khi game kết thúc
      if (room.game?.winner) return cb?.({ ok: false, error: "Trò chơi đã kết thúc." });
      const result = gameCtrl.nominationVote(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:finalVote", ({ decision }, cb) => {
    withPlayer((room, player) => {
      // BUG 9 FIX: Không cho vote sau khi game kết thúc
      if (room.game?.winner) return cb?.({ ok: false, error: "Trò chơi đã kết thúc." });
      const result = gameCtrl.finalVote(room, player.id, decision);
      // BUG 5 FIX: Broadcast để người chơi khác thấy ai đã vote real-time
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on('reaction', ({ emoji, name }) => {
    const code = socket.data.roomCode;
    if (!code) return;
    io.to(code).emit('reaction:broadcast', { emoji, name, senderId: socket.id });
  });

  // Kick player — chỉ host mới kick được, chỉ khi phase = 'lobby'
  socket.on('room:kick', ({ targetId }, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: 'Không trong phòng.' });
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false, error: 'Phòng không tồn tại.' });

    // Chỉ kick khi đang ở lobby
    if (room.phase !== 'lobby') return cb?.({ ok: false, error: 'Không thể kick khi đang chơi.' });

    // Tìm kicker
    const kicker = room.players.find(p => p.socketId === socket.id || p.id === socket.data.playerId);
    if (!kicker?.isHost) return cb?.({ ok: false, error: 'Chỉ chủ phòng mới kick được.' });

    // Tìm target
    const target = room.players.find(p => p.id === targetId);
    if (!target) return cb?.({ ok: false, error: 'Không tìm thấy người chơi.' });
    if (target.isHost) return cb?.({ ok: false, error: 'Không thể kick chủ phòng.' });

    // Gửi thông báo bị kick
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.emit('room:kicked', { reason: `Bạn đã bị kick khỏi phòng bởi chủ phòng.` });
      targetSocket.leave(code);
    }

    // Xóa khỏi room
    const updatedRoom = removePlayer(code, target.socketId || target.id);
    if (updatedRoom) broadcastRoom(updatedRoom);
    cb?.({ ok: true });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server ma sói đang chạy tại http://localhost:${PORT}`);
});
