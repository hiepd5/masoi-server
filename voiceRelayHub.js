// =============================================================================
// TRẠM ĐIỀU PHỐI VOICE WEBRTC P2P MESH ZERO-LEAK ($0/THÁNG — BẢN LỀ V4.2)
// - Tự động gánh 100% kênh đàm thoại khi LiveKit Cloud thiếu khóa hoặc hết Quota
// - Cô lập phòng tuyệt đối, giới hạn SDP <= 16KB bảo vệ 512MB RAM Render
// - Khóa Zero-Leak từ gốc Server: Chặn lộ tín hiệu Sói nói ban đêm & khóa role_reveal
// =============================================================================

import { isWolfTeamRole } from "./roles.js";
import { checkSocketCooldown } from "./securityGuard.js";

export const DEFAULT_STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const MAX_SIGNAL_BYTES = 16_384; // <= 16KB cho mỗi gói SDP / ICE
const MAX_VOICE_PEERS_PER_ROOM = 24;

// Map<roomCode, Map<identity, PeerRecord>>
const voiceRooms = new Map();

export function resolveVoiceParticipant(room, socket) {
  if (!room || !socket) return null;
  const player =
    room.players?.find((p) => p.socketId === socket.id) ||
    room.players?.find((p) => socket.data?.playerId && p.id === socket.data.playerId) ||
    null;

  if (player) {
    return {
      identity: player.id,
      displayName: player.name || "Người chơi",
      isSpectator: false,
      player,
      canPublish: Boolean(player.alive !== false),
    };
  }

  const spectator =
    (room.spectators || []).find(
      (s) => s.socketId === socket.id || (socket.data?.playerId && s.id === socket.data.playerId)
    ) || null;

  if (spectator) {
    return {
      identity: `spec_${spectator.id}`,
      displayName: `👀 ${spectator.name || "Khán giả"}`,
      isSpectator: true,
      player: null,
      canPublish: false,
    };
  }

  return null;
}

export function canListenerHearSpeakerInRoom(room, listenerActor, speakerIdentity) {
  if (!room || !speakerIdentity) return false;
  if (String(speakerIdentity).startsWith("spec_")) return false;

  // Sảnh chờ hoặc sau khi ván đấu đã có kết quả thắng thua: Kênh chung mở cho mọi người trong phòng
  if (room.phase === "lobby" || room.phase === "ended" || Boolean(room.game?.winner)) {
    return true;
  }

  const phase = String(room.game?.phase || "");
  // Khóa im lặng tuyệt đối trong 6s lật bài định mệnh (Zero-Leak chống lộ cảm thán nhận bài!)
  if (phase === "role_reveal") {
    return false;
  }

  const speakerPlayer = room.players?.find((p) => p.id === speakerIdentity);
  if (!speakerPlayer || speakerPlayer.alive === false) {
    return false;
  }

  // Ban đêm: Chỉ thành viên Bầy Sói còn sống mới nghe/thấy tín hiệu nói của nhau
  if (phase.startsWith("night_")) {
    const listenerPlayer = listenerActor?.player;
    if (!listenerPlayer || listenerPlayer.alive === false) return false;
    return Boolean(isWolfTeamRole(listenerPlayer.role) && isWolfTeamRole(speakerPlayer.role));
  }

  return true;
}

export function canSpeakerTransmitNow(room, actor) {
  if (!room || !actor || !actor.canPublish) return false;
  if (room.phase === "lobby" || room.phase === "ended" || Boolean(room.game?.winner)) {
    return true;
  }
  const phase = String(room.game?.phase || "");
  if (phase === "role_reveal") return false;
  if (phase.startsWith("night_")) {
    return Boolean(actor.player && actor.player.alive !== false && isWolfTeamRole(actor.player.role));
  }
  return Boolean(actor.player && actor.player.alive !== false);
}

function refreshRoomPeerPermissions(room, peerMap) {
  if (!room || !peerMap) return;
  for (const [identity, rec] of peerMap.entries()) {
    if (String(identity).startsWith("spec_")) {
      rec.canPublish = false;
      rec.isSpeaking = false;
      continue;
    }
    const p = room.players?.find((pl) => pl.id === identity);
    if (!p) {
      rec.canPublish = false;
      rec.isSpeaking = false;
    } else {
      rec.displayName = p.name || rec.displayName;
      rec.canPublish = Boolean(p.alive !== false);
      if (!rec.canPublish) rec.isSpeaking = false;
    }
  }
}

function serializePublicPeer(rec) {
  return {
    identity: rec.identity,
    displayName: rec.displayName,
    canPublish: Boolean(rec.canPublish),
    isSpectator: Boolean(rec.isSpectator),
  };
}

function broadcastFilteredSpeakingList(io, room, peerMap) {
  if (!io || !room || !peerMap) return;

  for (const listenerRec of peerMap.values()) {
    const listenerSocket = io.sockets?.sockets?.get?.(listenerRec.socketId) || {
      id: listenerRec.socketId,
      data: { playerId: listenerRec.rawPlayerId },
    };
    const listenerActor = resolveVoiceParticipant(room, listenerSocket);
    if (!listenerActor) continue;

    const visibleSpeakers = [];
    for (const speakerRec of peerMap.values()) {
      if (!speakerRec.isSpeaking || !speakerRec.canPublish) continue;
      if (speakerRec.identity === listenerRec.identity) {
        if (canSpeakerTransmitNow(room, listenerActor)) {
          visibleSpeakers.push(speakerRec.identity);
        }
        continue;
      }
      if (canListenerHearSpeakerInRoom(room, listenerActor, speakerRec.identity)) {
        visibleSpeakers.push(speakerRec.identity);
      }
    }
    visibleSpeakers.sort();
    io.to(listenerRec.socketId).emit("voice:speaking_update", {
      speakingIds: visibleSpeakers,
    });
  }
}

function checkSignalBurstAllowed(socket) {
  if (!socket?.data) return true;
  const now = Date.now();
  const win = socket.data._voiceSigWindow;
  if (!win || now >= win.resetAt) {
    socket.data._voiceSigWindow = { count: 1, resetAt: now + 10_000 };
    return true;
  }
  if (win.count >= 160) return false;
  win.count += 1;
  return true;
}

export function isValidSignalPayload(signal) {
  if (!signal || typeof signal !== "object") return false;
  const kind = String(signal.type || "");
  if (kind !== "offer" && kind !== "answer" && kind !== "candidate") return false;
  try {
    const encoded = JSON.stringify(signal);
    return encoded.length > 2 && encoded.length <= MAX_SIGNAL_BYTES;
  } catch {
    return false;
  }
}

export function removeSocketFromVoiceRelay(io, roomCode, socketId, getRoomFn = null) {
  if (!roomCode || !socketId) return false;
  const peerMap = voiceRooms.get(roomCode);
  if (!peerMap) return false;

  let removedIdentity = null;
  for (const [identity, rec] of peerMap.entries()) {
    if (rec.socketId === socketId || rec.identity === socketId) {
      removedIdentity = identity;
      peerMap.delete(identity);
      break;
    }
  }

  if (!removedIdentity) return false;

  if (peerMap.size === 0) {
    voiceRooms.delete(roomCode);
    return true;
  }

  for (const peer of peerMap.values()) {
    io?.to?.(peer.socketId)?.emit("voice:peer_left", { identity: removedIdentity });
  }
  const room = typeof getRoomFn === "function" ? getRoomFn(roomCode) : null;
  if (room) {
    broadcastFilteredSpeakingList(io, room, peerMap);
  }
  return true;
}

export function getVoiceRelayRuntimeStats() {
  let totalPeers = 0;
  for (const m of voiceRooms.values()) totalPeers += m.size;
  return {
    activeVoiceRooms: voiceRooms.size,
    activeP2pPeers: totalPeers,
  };
}

export function registerVoiceRelaySocketHandlers(io, socket, getRoom) {
  socket.on("voice:join", (_, cb) => {
    if (!checkSocketCooldown(socket, "voice_join", 220)) {
      return cb?.({ ok: false, error: "Thao tác kết nối thoại quá nhanh." });
    }
    const code = socket.data?.roomCode;
    const room = code ? getRoom(code) : null;
    if (!room) return cb?.({ ok: false, error: "Không tìm thấy phòng." });

    const actor = resolveVoiceParticipant(room, socket);
    if (!actor) return cb?.({ ok: false, error: "Không xác thực được người chơi." });

    let peerMap = voiceRooms.get(code);
    if (!peerMap) {
      peerMap = new Map();
      voiceRooms.set(code, peerMap);
    }

    if (!peerMap.has(actor.identity) && peerMap.size >= MAX_VOICE_PEERS_PER_ROOM) {
      return cb?.({ ok: false, error: "Kênh thoại của phòng đã đầy." });
    }

    refreshRoomPeerPermissions(room, peerMap);

    const prev = peerMap.get(actor.identity);
    if (prev && prev.socketId && prev.socketId !== socket.id) {
      io.to(prev.socketId).emit("voice:duplicate_replaced", { identity: actor.identity });
    }

    const myRecord = {
      identity: actor.identity,
      rawPlayerId: socket.data?.playerId || actor.player?.id || null,
      socketId: socket.id,
      displayName: actor.displayName,
      isSpectator: actor.isSpectator,
      canPublish: actor.canPublish,
      isSpeaking: false,
      joinedAt: Date.now(),
    };
    peerMap.set(actor.identity, myRecord);

    const otherPeers = [];
    for (const [id, rec] of peerMap.entries()) {
      if (id === actor.identity) continue;
      otherPeers.push(serializePublicPeer(rec));
      io.to(rec.socketId).emit("voice:peer_joined", {
        peer: serializePublicPeer(myRecord),
      });
    }

    cb?.({
      ok: true,
      self: serializePublicPeer(myRecord),
      peers: otherPeers,
      iceServers: DEFAULT_STUN_SERVERS,
    });
  });

  socket.on("voice:sync_peers", (_, cb) => {
    const code = socket.data?.roomCode;
    const room = code ? getRoom(code) : null;
    if (!room) return cb?.({ ok: false, error: "Không tìm thấy phòng." });

    const peerMap = voiceRooms.get(code);
    const actor = resolveVoiceParticipant(room, socket);
    if (!peerMap || !actor) return cb?.({ ok: false, peers: [] });

    refreshRoomPeerPermissions(room, peerMap);
    const existing = peerMap.get(actor.identity);
    if (existing) {
      existing.socketId = socket.id;
      existing.displayName = actor.displayName;
      existing.canPublish = actor.canPublish;
      existing.isSpectator = actor.isSpectator;
      for (const [id, rec] of peerMap.entries()) {
        if (id !== actor.identity) {
          io.to(rec.socketId).emit("voice:peer_updated", {
            peer: serializePublicPeer(existing),
          });
        }
      }
    }

    const peers = [];
    for (const [id, rec] of peerMap.entries()) {
      if (id !== actor.identity) peers.push(serializePublicPeer(rec));
    }
    cb?.({
      ok: true,
      self: existing ? serializePublicPeer(existing) : serializePublicPeer(actor),
      peers,
    });
  });

  socket.on("voice:signal", ({ targetIdentity, signal } = {}, cb) => {
    if (!checkSignalBurstAllowed(socket)) {
      return cb?.({ ok: false, error: "Quá giới hạn gói bắt tay thoại." });
    }
    const code = socket.data?.roomCode;
    const room = code ? getRoom(code) : null;
    if (!room) return cb?.({ ok: false, error: "Phòng không tồn tại." });

    const peerMap = voiceRooms.get(code);
    if (!peerMap) return cb?.({ ok: false, error: "Chưa mở kênh thoại." });

    const senderActor = resolveVoiceParticipant(room, socket);
    if (!senderActor || !peerMap.has(senderActor.identity)) {
      return cb?.({ ok: false, error: "Bạn chưa tham gia kênh thoại." });
    }

    const cleanTargetId = String(targetIdentity || "").trim().slice(0, 80);
    if (!cleanTargetId || cleanTargetId === senderActor.identity) {
      return cb?.({ ok: false, error: "Đích kết nối không hợp lệ." });
    }

    const targetRec = peerMap.get(cleanTargetId);
    if (!targetRec) {
      return cb?.({ ok: false, error: "Người nhận đã rời kênh thoại." });
    }

    if (!isValidSignalPayload(signal)) {
      return cb?.({ ok: false, error: "Gói SDP/ICE không hợp lệ hoặc vượt 16KB." });
    }

    io.to(targetRec.socketId).emit("voice:signal", {
      fromIdentity: senderActor.identity,
      fromName: senderActor.displayName,
      canPublish: senderActor.canPublish,
      signal,
    });
    cb?.({ ok: true });
  });

  socket.on("voice:speaking", ({ speaking } = {}) => {
    if (!checkSocketCooldown(socket, "voice_speaking", 80)) return;
    const code = socket.data?.roomCode;
    const room = code ? getRoom(code) : null;
    if (!room) return;
    const peerMap = voiceRooms.get(code);
    if (!peerMap) return;

    refreshRoomPeerPermissions(room, peerMap);
    const actor = resolveVoiceParticipant(room, socket);
    if (!actor) return;
    const rec = peerMap.get(actor.identity);
    if (!rec) return;

    const allowedNow = canSpeakerTransmitNow(room, actor);
    const nextSpeaking = Boolean(speaking) && allowedNow;
    if (rec.isSpeaking === nextSpeaking) return;

    rec.isSpeaking = nextSpeaking;
    broadcastFilteredSpeakingList(io, room, peerMap);
  });

  socket.on("voice:leave", (_, cb) => {
    const code = socket.data?.roomCode;
    if (code) {
      removeSocketFromVoiceRelay(io, code, socket.id, getRoom);
    }
    cb?.({ ok: true });
  });
}
