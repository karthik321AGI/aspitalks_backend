require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
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

function findOrCreatePair(socket, data) {
  const { zone, permanentId } = data;
  logEvent('Join Request', { zone, permanentId });

  if (users.has(socket.id)) {
    const oldRoomId = users.get(socket.id);
    leaveRoom(socket, oldRoomId);
  }

  // Store permanent ID mapping
  if (permanentId) {
    permanentUsers.set(permanentId, socket.id);
    logEvent('Permanent ID Mapping', `${permanentId} -> ${socket.id}`);
  }

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

      // Create room
      rooms.set(roomId, new Set([waitingUserId, socket.id]));
      users.set(waitingUserId, roomId);
      users.set(socket.id, roomId);

      // Find permanent ID for waiting user
      let waitingUserPermanentId;
      permanentUsers.forEach((socketId, permId) => {
        if (socketId === waitingUserId) waitingUserPermanentId = permId;
      });

      if (waitingUserPermanentId && permanentId) {
        reconnectPairs.set(permanentId, waitingUserPermanentId);
        reconnectPairs.set(waitingUserPermanentId, permanentId);
        logEvent('Connection Pairs', `Stored: ${permanentId} <-> ${waitingUserPermanentId}`);
      }

      waitingSocket.join(roomId);
      socket.join(roomId);

      logEvent('Normal Connection', `${waitingUserId} <-> ${socket.id}`);

      // Send start-call events with both socket and permanent IDs
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
    logEvent('Waiting', `User ${socket.id} added to waiting list for ${zone}`);
  }
}

function handleReconnect(socket, data) {
  const { myId, targetId } = data;
  logEvent('Reconnect Attempt', `User ${myId} trying to reconnect with ${targetId}`);

  // Store the socket's permanent ID mapping
  permanentUsers.set(myId, socket.id);

  // Check saved reconnect pairs
  const targetPair = reconnectPairs.get(targetId);
  logEvent('Checking Pair', `Target ${targetId} has pair: ${targetPair}`);

  if (targetPair === myId) {
    const roomId = generateRoomId('reconnect');
    const targetSocketId = permanentUsers.get(targetId);

    if (!targetSocketId) {
      // Track reconnect attempts
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

    // Clear reconnect attempts
    reconnectAttempts.delete(myId);

    // Create room
    rooms.set(roomId, new Set([socket.id, targetSocketId]));
    users.set(socket.id, roomId);
    users.set(targetSocketId, roomId);

    socket.join(roomId);
    targetSocket.join(roomId);

    // Notify both users
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

    // Clear reconnect pairs after successful connection
    reconnectPairs.delete(myId);
    reconnectPairs.delete(targetId);

    logEvent('Reconnect Success', `Matched ${myId} <-> ${targetId}`);
  } else {
    // Store that this user wants to reconnect with target
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
      // Find permanent IDs
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

  socket.on('join-zone', (data) => {
    logEvent('Join Zone', `User ${socket.id} joining zone: ${data.zone}`);
    findOrCreatePair(socket, data);
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

    // Clean up reconnection attempts and permanent ID mapping
    if (disconnectedPermanentId) {
      reconnectAttempts.delete(disconnectedPermanentId);
      permanentUsers.delete(disconnectedPermanentId);
    }

    waitingUsers.forEach((list, zone) => {
      if (Array.isArray(list)) {
        const index = list.indexOf(socket.id);
        if (index > -1) {
          list.splice(index, 1);
        }
      }
    });
  });
});

// Error handling for server
http.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Error handling for unhandled promise rejections
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