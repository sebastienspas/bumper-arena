// ============================================================
//  BUMPER ARENA — Multiplayer Server
//  Node.js + Socket.io
// ============================================================
//
//  SETUP:
//    1. Install Node.js (https://nodejs.org)
//    2. In this folder, run:
//         npm init -y
//         npm install express socket.io
//    3. Start the server:
//         node server.js
//    4. Open https://your-server:3000 in browser
//
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// ---- Serve static files (index.html + BumperCar.glb) ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- Game state ----
const rooms = new Map(); // roomCode -> { players, state, createdAt }

// Room structure:
// {
//   players: Map<socketId, { id, name, device, color, x, z, angle, vx, vz, flags, alive }>,
//   flags: [ { x, z, collected, collectedBy } ],
//   started: false,
//   config: { ... }
// }

const COLORS = [0x00e5ff, 0xff2d7b, 0x39ff14, 0xff8800, 0xaa44ff, 0xff4444, 0x44ffcc, 0xffaa00];
const MAX_PLAYERS = 8;
const WIN_FLAGS = 5;

function createRoom(code) {
  const room = {
    players: new Map(),
    flags: [],
    started: false,
    config: {
      arenaRadius: 2.5,
      flagCount: 3,
      winFlags: WIN_FLAGS,
    },
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function spawnFlags(room) {
  room.flags = [];
  for (let i = 0; i < room.config.flagCount; i++) {
    const r = Math.random() * (room.config.arenaRadius * 0.8);
    const a = Math.random() * Math.PI * 2;
    room.flags.push({
      id: i,
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      collected: false,
      collectedBy: null,
    });
  }
}

function getPlayerColor(room) {
  const usedColors = new Set();
  room.players.forEach(p => usedColors.add(p.color));
  for (const c of COLORS) {
    if (!usedColors.has(c)) return c;
  }
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function getSpawnPosition(index, total, radius) {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2;
  return {
    x: Math.cos(angle) * radius * 0.5,
    z: Math.sin(angle) * radius * 0.5,
  };
}

function getRoomSummary(room) {
  const players = [];
  room.players.forEach((p, sid) => {
    players.push({
      id: p.id,
      name: p.name,
      device: p.device,
      color: p.color,
      flags: p.flags,
      alive: p.alive,
    });
  });
  return { players, started: room.started };
}

// ---- Cleanup old rooms every 5 minutes ----
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    // Remove rooms older than 2 hours with no players
    if (room.players.size === 0 && now - room.createdAt > 2 * 60 * 60 * 1000) {
      rooms.delete(code);
      console.log(`[cleanup] Removed empty room ${code}`);
    }
  });
}, 5 * 60 * 1000);


// ============================================================
//  SOCKET.IO EVENTS
// ============================================================

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  let currentRoom = null;

  // ---- JOIN ROOM ----
  socket.on('join-room', ({ roomCode, playerName, device }) => {
    let room = rooms.get(roomCode);
    if (!room) {
      room = createRoom(roomCode);
      console.log(`[room] Created room ${roomCode}`);
    }

    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('room-full', { message: 'Salle pleine (max 8 joueurs)' });
      return;
    }

    currentRoom = roomCode;
    socket.join(roomCode);

    const spawn = getSpawnPosition(room.players.size, room.players.size + 1, room.config.arenaRadius);
    const player = {
      id: socket.id,
      name: playerName || 'Joueur',
      device: device || 'desktop',
      color: getPlayerColor(room),
      x: spawn.x,
      z: spawn.z,
      angle: 0,
      vx: 0,
      vz: 0,
      flags: 0,
      alive: true,
    };

    room.players.set(socket.id, player);

    // Send current state to the joining player
    socket.emit('room-joined', {
      roomCode,
      yourId: socket.id,
      player,
      room: getRoomSummary(room),
      flags: room.flags,
      config: room.config,
    });

    // Notify others
    socket.to(roomCode).emit('player-joined', { player });

    console.log(`[join] ${playerName} joined room ${roomCode} (${room.players.size} players)`);
  });

  // ---- START GAME ----
  socket.on('start-game', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.started = true;
    spawnFlags(room);

    // Reassign spawn positions
    let idx = 0;
    room.players.forEach((player) => {
      const spawn = getSpawnPosition(idx, room.players.size, room.config.arenaRadius);
      player.x = spawn.x;
      player.z = spawn.z;
      player.angle = 0;
      player.flags = 0;
      player.alive = true;
      idx++;
    });

    io.to(currentRoom).emit('game-started', {
      players: Array.from(room.players.values()),
      flags: room.flags,
      config: room.config,
    });

    console.log(`[start] Room ${currentRoom} started with ${room.players.size} players`);
  });

  // ---- PLAYER POSITION UPDATE (sent ~20 times/sec by each client) ----
  socket.on('update', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    // Update server state
    player.x = data.x;
    player.z = data.z;
    player.angle = data.angle;
    player.vx = data.vx || 0;
    player.vz = data.vz || 0;
    player.alive = data.alive !== false;

    // Broadcast to other players in the room
    socket.to(currentRoom).emit('player-update', {
      id: socket.id,
      x: player.x,
      z: player.z,
      angle: player.angle,
      vx: player.vx,
      vz: player.vz,
      alive: player.alive,
    });
  });

  // ---- FLAG COLLECTED ----
  socket.on('flag-collected', ({ flagId }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const flag = room.flags.find(f => f.id === flagId);
    if (!flag || flag.collected) return; // Already taken

    const player = room.players.get(socket.id);
    if (!player) return;

    // Server validates the collection
    flag.collected = true;
    flag.collectedBy = socket.id;
    player.flags++;

    // Broadcast to all
    io.to(currentRoom).emit('flag-taken', {
      flagId,
      playerId: socket.id,
      playerFlags: player.flags,
    });

    console.log(`[flag] ${player.name} collected flag ${flagId} (total: ${player.flags})`);

    // Check win condition
    if (player.flags >= room.config.winFlags) {
      io.to(currentRoom).emit('game-over', {
        winnerId: socket.id,
        winnerName: player.name,
      });
      console.log(`[win] ${player.name} wins in room ${currentRoom}!`);
    }

    // Respawn flag after delay
    setTimeout(() => {
      if (!rooms.has(currentRoom)) return;
      const r = Math.random() * (room.config.arenaRadius * 0.8);
      const a = Math.random() * Math.PI * 2;
      flag.x = Math.cos(a) * r;
      flag.z = Math.sin(a) * r;
      flag.collected = false;
      flag.collectedBy = null;

      io.to(currentRoom).emit('flag-respawned', {
        flagId,
        x: flag.x,
        z: flag.z,
      });
    }, 1500);
  });

  // ---- BUMP EVENT (validated server-side) ----
  socket.on('bump', ({ targetId, impulseX, impulseZ }) => {
    if (!currentRoom) return;
    // Forward bump to the target player
    io.to(targetId).emit('bumped', {
      byId: socket.id,
      impulseX,
      impulseZ,
    });
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        const player = room.players.get(socket.id);
        room.players.delete(socket.id);

        socket.to(currentRoom).emit('player-left', {
          id: socket.id,
          name: player ? player.name : '?',
        });

        console.log(`[leave] ${player?.name} left room ${currentRoom} (${room.players.size} remaining)`);

        // Clean up empty rooms
        if (room.players.size === 0) {
          rooms.delete(currentRoom);
          console.log(`[room] Deleted empty room ${currentRoom}`);
        }
      }
    }
  });
});


// ---- START SERVER ----
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║       BUMPER ARENA — Server Started       ║
  ║                                           ║
  ║   Local:   http://localhost:${PORT}          ║
  ║                                           ║
  ║   Put index.html + BumperCar.glb          ║
  ║   in the /public folder                   ║
  ║                                           ║
  ║   Players connect to your server URL      ║
  ║   and enter the same room code            ║
  ╚═══════════════════════════════════════════╝
  `);
});
