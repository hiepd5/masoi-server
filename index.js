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

const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }, // local dev only — siết lại domain khi deploy
});

function broadcastRoom(room) {
  // Mỗi client nhận view riêng (role của chính họ), nên emit riêng từng socket
  room.players.forEach((p) => {
    io.to(p.id).emit("room:update", publicRoomView(room, p.id));
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
    if (room) broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = removePlayer(code, socket.id);
    if (room) broadcastRoom(room);
    console.log("Ngắt kết nối:", socket.id);
  });

  // ============ GAME EVENTS ============
  function withRoom(cb) {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return null;
    return cb(room);
  }

  socket.on("game:start", (_, cb) => {
    withRoom((room) => {
      const player = room.players.find((p) => p.id === socket.id);
      if (!player?.isHost) return cb?.({ ok: false, error: "Chỉ chủ phòng mới bắt đầu được." });
      const result = gameCtrl.startGame(room);
      cb?.(result);
    });
  });

  socket.on("room:restart", (_, cb) => {
    withRoom((room) => {
      const player = room.players.find((p) => p.id === socket.id);
      if (!player?.isHost) return cb?.({ ok: false, error: "Chỉ chủ phòng mới có thể chơi lại." });
      
      gameCtrl.clearRoomTimer(room.code);
      room.game = null;
      room.phase = "lobby";
      broadcastRoom(room);
      cb?.({ ok: true });
    });
  });

  socket.on("action:guardProtect", ({ targetId }, cb) => {
    withRoom((room) => {
      const result = gameCtrl.guardProtect(room, socket.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:wolfPick", ({ targetId }, cb) => {
    withRoom((room) => {
      const result = gameCtrl.wolfPick(room, socket.id, targetId);
      if (result.ok) gameCtrl.broadcast(room); // để sói khác thấy realtime ai đang chọn ai
      cb?.(result);
    });
  });

  socket.on("action:wolfChat", ({ message }, cb) => {
    withRoom((room) => {
      const sender = room.players.find(p => p.id === socket.id);
      if (sender?.role !== "wolf") return;
      room.players.forEach(p => {
        if (p.role === "wolf" && p.id !== socket.id) {
          io.to(p.id).emit("wolf:chat", { senderId: socket.id, message });
        }
      });
      cb?.({ ok: true });
    });
  });

  socket.on("action:villageChat", ({ message }, cb) => {
    withRoom((room) => {
      const sender = room.players.find(p => p.id === socket.id);
      if (!sender || !sender.alive) return cb?.({ ok: false, error: "Bạn đã chết, không thể chat" });
      
      // Chỉ cho phép chat công khai ban ngày
      if (room.game.phase.startsWith("night_")) return cb?.({ ok: false, error: "Ban đêm không được chat ồn ào!" });

      io.to(room.code).emit("village:chat", { 
        senderId: socket.id, 
        senderName: sender.name, 
        message 
      });
      cb?.({ ok: true });
    });
  });

  socket.on("action:witchDecide", (payload, cb) => {
    withRoom((room) => {
      const result = gameCtrl.witchDecide(room, socket.id, payload);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:seerCheck", ({ targetId }, cb) => {
    withRoom((room) => {
      const result = gameCtrl.seerCheck(room, socket.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:voteExtendDiscussion", ({ wantExtend }, cb) => {
    withRoom((room) => {
      const result = gameCtrl.voteExtendDiscussion(room, socket.id, wantExtend);
      gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:nominationVote", ({ targetId }, cb) => {
    withRoom((room) => {
      const result = gameCtrl.nominationVote(room, socket.id, targetId);
      if (result.ok) gameCtrl.broadcast(room);
      cb?.(result);
    });
  });

  socket.on("action:finalVote", ({ decision }, cb) => {
    withRoom((room) => {
      const result = gameCtrl.finalVote(room, socket.id, decision);
      cb?.(result);
    });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server ma sói đang chạy tại http://localhost:${PORT}`);
});
