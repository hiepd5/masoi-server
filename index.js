import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import {
  createRoom,
  getRoom,
  addPlayer,
  removePlayer,
  renamePlayer,
  publicRoomView,
} from "./rooms.js";
import { createGameController } from "./gameController.js";
import { AccessToken } from "livekit-server-sdk";

const LIVEKIT_URL = process.env.LIVEKIT_URL || "wss://ma-soi-online-rac6j8ri.livekit.cloud";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "APIQ2WP9w5JhSKX";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "ivTQhkkUZ3otV7XepsCnBdPmHTP6RIFhJRRsn1d28jI";

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

  socket.on("room:create", (_, cb) => {
    const room = createRoom(socket.id);
    const { room: joinedRoom, player } = addPlayer(room.code, socket.id);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    cb?.({ ok: true, roomCode: room.code, playerId: player.id });
    broadcastRoom(joinedRoom);
  });

  socket.on("room:join", ({ roomCode, name }, cb) => {
    const result = addPlayer(roomCode, socket.id, name);
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

  socket.on("room:rename", ({ newName }, cb) => {
    const code = socket.data.roomCode;
    if (!code) return cb?.({ ok: false, error: "Bạn chưa ở trong phòng." });
    const result = renamePlayer(code, socket.id, newName);
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

  socket.on("livekit:token", async (_, cb) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return cb?.({ error: "Không tìm thấy phòng." });
    const player = room.players.find((p) => p.socketId === socket.id)
                || room.players.find((p) => p.id === socket.data.playerId);
    if (!player) return cb?.({ error: "Không tìm thấy người chơi." });

    try {
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: player.id,
        name: player.name,
      });
      at.addGrant({ roomJoin: true, room: code, canPublish: true, canSubscribe: true });
      cb?.({ token: await at.toJwt(), url: LIVEKIT_URL });
    } catch (e) {
      cb?.({ error: e.message });
    }
  });

  socket.on("disconnect", () => {
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
      
      // Chỉ cho phép chat công khai ban ngày
      if (room.game.phase.startsWith("night_")) return cb?.({ ok: false, error: "Ban đêm không được chat ồn ào!" });

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

  socket.on("action:nominationVote", ({ targetId }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.nominationVote(room, player.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:finalVote", ({ decision }, cb) => {
    withPlayer((room, player) => {
      const result = gameCtrl.finalVote(room, player.id, decision);
      cb?.(result);
    });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server ma sói đang chạy tại http://localhost:${PORT}`);
});
