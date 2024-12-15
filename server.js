require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Basic route for health check
app.get('/', (req, res) => {
  res.send('AspiTalks Server is running');
});

// Track users and rooms
const rooms = new Map();  // room -> Set of socket IDs
const users = new Map();  // socket ID -> room ID
const waitingUsers = new Map(); // zone -> array of waiting users
const debateWaitingUsers = new Map(); // questionId_choice -> array of waiting users
const permanentUsers = new Map(); // permanent ID -> socket ID
const reconnectPairs = new Map(); // permanent ID -> permanent ID
const reconnectAttempts = new Map(); // permanent ID -> number of attempts

// Initialize zones
const defaultZones = ['starter_zone', 'progress_zone', 'elite_zone'];
defaultZones.forEach(zone => waitingUsers.set(zone, []));

function generateRoomId(zone) {
  return `${zone}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function logEvent(event, data) {
  console.log(`[${new Date().toISOString()}] ${event}:`, data);
}

function handleDebateRoom(socket, data) {
  const { questionId, debateChoice, permanentId } = data;
  logEvent('Debate Join Request', { questionId, debateChoice, permanentId });

  if (users.has(socket.id)) {
    const oldRoomId = users.get(socket.id);
    leaveRoom(socket, oldRoomId);
  }

  if (permanentId) {
    permanentUsers.set(permanentId, socket.id);
    logEvent('Permanent ID Mapping', `${permanentId} -> ${socket.id}`);
  }

  const debateRoomKey = `${questionId}_${debateChoice}`;
  const oppositeChoice = debateChoice === 'yes' ? 'no' : 'yes';
  const oppositeRoomKey = `${questionId}_${oppositeChoice}`;

  // Look for user with opposite choice
  const oppositeWaitingList = debateWaitingUsers.get(oppositeRoomKey) || [];

  if (oppositeWaitingList.length > 0) {
    // Found someone with opposite view - match them
    const waitingUserId = oppositeWaitingList.shift();
    if (waitingUserId && waitingUserId !== socket.id) {
      const roomId = `debate_${questionId}_${Date.now()}`;
      const waitingSocket = io.sockets.sockets.get(waitingUserId);

      if (!waitingSocket) {
        logEvent('Error', 'Waiting socket not found');
        socket.emit('error', 'Failed to connect with peer');
        return;
      }

      // Create room and connect users
      rooms.set(roomId, new Set([waitingUserId, socket.id]));
      users.set(waitingUserId, roomId);
      users.set(socket.id, roomId);

      let waitingUserPermanentId;
      permanentUsers.forEach((socketId, permId) => {
        if (socketId === waitingUserId) waitingUserPermanentId = permId;
      });

      if (waitingUserPermanentId && permanentId) {
        reconnectPairs.set(permanentId, waitingUserPermanentId);
        reconnectPairs.set(waitingUserPermanentId, permanentId);
        logEvent('Debate Connection Pairs', `Stored: ${permanentId} <-> ${waitingUserPermanentId}`);
      }

      waitingSocket.join(roomId);
      socket.join(roomId);

      logEvent('Debate Match', `${waitingUserId}(${oppositeChoice}) <-> ${socket.id}(${debateChoice})`);

      io.to(waitingUserId).emit('start-call', {
        isInitiator: true,
        roomId,
        peerId: socket.id,
        permanentId: permanentId
      });

      io.to(socket.id).emit('start-call', {
        isInitiator: false,
        roomId,
        peerId: waitingUserId,
        permanentId: waitingUserPermanentId
      });
    }
  } else {
    // Add to waiting list for their choice
    const waitingList = debateWaitingUsers.get(debateRoomKey) || [];
    waitingList.push(socket.id);
    debateWaitingUsers.set(debateRoomKey, waitingList);
    socket.emit('waiting');
    logEvent('Debate Waiting', `User ${socket.id} waiting for ${oppositeChoice} on question ${questionId}`);
  }
}

function handleNormalRoom(socket, data) {
  const { zone, permanentId } = data;
  const waitingList = waitingUsers.get(zone) || [];

  if (waitingList.length > 0) {
    const waitingUserId = waitingList.shift();
    if (waitingUserId && waitingUserId !== socket.id) {
      const roomId = generateRoomId(zone);
      const waitingSocket = io.sockets.sockets.get(waitingUserId);

      if (!waitingSocket) {
        logEvent('Error', 'Waiting socket not found');
        socket.emit('error', 'Failed to connect with peer');
        return;
      }

      rooms.set(roomId, new Set([waitingUserId, socket.id]));
      users.set(waitingUserId, roomId);
      users.set(socket.id, roomId);

      let waitingUserPermanentId;
      permanentUsers.forEach((socketId, permId) => {
        if (socketId === waitingUserId) waitingUserPermanentId = permId;
      });

      if (waitingUserPermanentId && permanentId) {
        reconnectPairs.set(permanentId, waitingUserPermanentId);
        reconnectPairs.set(waitingUserPermanentId, permanentId);
        logEvent('Normal Connection Pairs', `Stored: ${permanentId} <-> ${waitingUserPermanentId}`);
      }

      waitingSocket.join(roomId);
      socket.join(roomId);

      logEvent('Normal Connection', `${waitingUserId} <-> ${socket.id}`);

      io.to(waitingUserId).emit('start-call', {
        isInitiator: true,
        roomId,
        peerId: socket.id,
        permanentId: permanentId
      });

      io.to(socket.id).emit('start-call', {
        isInitiator: false,
        roomId,
        peerId: waitingUserId,
        permanentId: waitingUserPermanentId
      });
    }
  } else {
    waitingList.push(socket.id);
    waitingUsers.set(zone, waitingList);
    socket.emit('waiting');
    logEvent('Normal Waiting', `User ${socket.id} added to waiting list for ${zone}`);
  }
}

function handleReconnect(socket, data) {
  const { myId, targetId } = data;
  logEvent('Reconnect Attempt', `User ${myId} trying to reconnect with ${targetId}`);

  permanentUsers.set(myId, socket.id);

  const targetPair = reconnectPairs.get(targetId);
  logEvent('Checking Pair', `Target ${targetId} has pair: ${targetPair}`);

  if (targetPair === myId) {
    const roomId = generateRoomId('reconnect');
    const targetSocketId = permanentUsers.get(targetId);

    if (!targetSocketId) {
      const attempts = reconnectAttempts.get(myId) || 0;
      reconnectAttempts.set(myId, attempts + 1);
      socket.emit('waiting');
      logEvent('Reconnect Waiting', `Waiting for peer ${targetId} to connect (attempt ${attempts + 1})`);
      return;
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) {
      logEvent('Reconnect Info', 'Peer connection pending');
      socket.emit('waiting');
      return;
    }

    reconnectAttempts.delete(myId);

    rooms.set(roomId, new Set([socket.id, targetSocketId]));
    users.set(socket.id, roomId);
    users.set(targetSocketId, roomId);

    socket.join(roomId);
    targetSocket.join(roomId);

    socket.emit('reconnect-ready', {
      isInitiator: true,
      roomId,
      peerId: targetSocketId,
      permanentId: targetId
    });

    io.to(targetSocketId).emit('reconnect-ready', {
      isInitiator: false,
      roomId,
      peerId: socket.id,
      permanentId: myId
    });

    reconnectPairs.delete(myId);
    reconnectPairs.delete(targetId);

    logEvent('Reconnect Success', `Matched ${myId} <-> ${targetId}`);
  } else {
    reconnectPairs.set(myId, targetId);
    socket.emit('waiting');
    logEvent('Reconnect Waiting', `User ${myId} waiting for ${targetId}`);
  }
}

function leaveRoom(socket, roomId) {
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    const otherUser = Array.from(room).find(id => id !== socket.id);

    if (otherUser) {
      let disconnectedPermanentId, otherPermanentId;
      permanentUsers.forEach((socketId, permanentId) => {
        if (socketId === socket.id) disconnectedPermanentId = permanentId;
        if (socketId === otherUser) otherPermanentId = permanentId;
      });

      if (disconnectedPermanentId && otherPermanentId) {
        reconnectPairs.set(disconnectedPermanentId, otherPermanentId);
        reconnectPairs.set(otherPermanentId, disconnectedPermanentId);
        logEvent('Reconnect Pairs', `Stored: ${disconnectedPermanentId} <-> ${otherPermanentId}`);
      }

      io.to(otherUser).emit('user-disconnected', {
        disconnectedId: disconnectedPermanentId
      });
      users.delete(otherUser);
    }

    rooms.delete(roomId);
    users.delete(socket.id);
  }
}

// Socket connection handling
io.on('connection', (socket) => {
  logEvent('Connection', `New user connected: ${socket.id}`);

  socket.on('join-room', (data) => {
    logEvent('Join Room Request', data);
    if (data.isDebate) {
      handleDebateRoom(socket, data);
    } else {
      handleNormalRoom(socket, data);
    }
  });

  socket.on('join-reconnect', (data) => {
    logEvent('Join Reconnect', `User ${socket.id} trying to reconnect`);
    handleReconnect(socket, data);
  });

  socket.on('offer', (data) => {
    const roomId = users.get(socket.id);
    if (roomId) {
      socket.to(roomId).emit('offer', {
        sdp: data.sdp,
        from: socket.id
      });
    }
  });

  socket.on('answer', (data) => {
    const roomId = users.get(socket.id);
    if (roomId) {
      socket.to(roomId).emit('answer', {
        sdp: data.sdp,
        from: socket.id
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    const roomId = users.get(socket.id);
    if (roomId) {
      socket.to(roomId).emit('ice-candidate', {
        candidate: data.candidate,
        from: socket.id
      });
    }
  });

  socket.on('disconnect', () => {
    logEvent('Disconnection', `User disconnected: ${socket.id}`);

    let disconnectedPermanentId;
    permanentUsers.forEach((socketId, permanentId) => {
      if (socketId === socket.id) {
        disconnectedPermanentId = permanentId;
      }
    });

    const roomId = users.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        const otherUser = Array.from(room).find(id => id !== socket.id);
        if (otherUser) {
          let otherPermanentId;
          permanentUsers.forEach((socketId, permanentId) => {
            if (socketId === otherUser) {
              otherPermanentId = permanentId;
            }
          });

          if (disconnectedPermanentId && otherPermanentId) {
            reconnectPairs.set(disconnectedPermanentId, otherPermanentId);
            reconnectPairs.set(otherPermanentId, disconnectedPermanentId);
            logEvent('Reconnect Pairs', `Stored: ${disconnectedPermanentId} <-> ${otherPermanentId}`);
          }

          io.to(otherUser).emit('user-disconnected', {
            disconnectedId: disconnectedPermanentId
          });
        }
      }
      rooms.delete(roomId);
      users.delete(socket.id);
    }

    if (disconnectedPermanentId) {
      reconnectAttempts.delete(disconnectedPermanentId);
      permanentUsers.delete(disconnectedPermanentId);
    }

    // Clean up regular waiting lists
    waitingUsers.forEach((list, zone) => {
      if (Array.isArray(list)) {
        const index = list.indexOf(socket.id);
        if (index > -1) {
          list.splice(index, 1);
        }
      }
    });

    // Clean up debate waiting lists
    debateWaitingUsers.forEach((list, key) => {
      if (Array.isArray(list)) {
        const index = list.indexOf(socket.id);
        if (index > -1) {
          list.splice(index, 1);
        }
      }
    });
  });
});

// Error handling
http.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
  process.exit(1);
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`\n=================================`);
  console.log(`Server running on port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`=================================\n`);
});