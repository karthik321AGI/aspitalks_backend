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

app.get('/', (req, res) => {
  res.send('AspiTalks Server is running');
});

const rooms = new Map();
const users = new Map();
const waitingUsers = new Map();
const debateWaitingUsers = new Map();
const permanentUsers = new Map();
const reconnectPairs = new Map();
const activeReconnectUsers = new Map();

function generateRoomId(baseRoom) {
  return `${baseRoom}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function logEvent(event, data) {
  console.log(`[${new Date().toISOString()}] ${event}:`, data);
}

function handleDebateRoom(socket, data) {
  const { questionId, debateChoice, permanentId } = data;
  logEvent('Debate Join Request', { questionId, debateChoice, permanentId });

  const debateRoomKey = `${questionId}_${debateChoice}`;
  const oppositeChoice = debateChoice === 'yes' ? 'no' : 'yes';
  const oppositeRoomKey = `${questionId}_${oppositeChoice}`;

  if (permanentId) {
    permanentUsers.set(permanentId, socket.id);
  }

  const oppositeWaitingList = debateWaitingUsers.get(oppositeRoomKey) || [];

  if (oppositeWaitingList.length > 0) {
    const waitingUserId = oppositeWaitingList.shift();
    if (waitingUserId && waitingUserId !== socket.id) {
      const waitingSocket = io.sockets.sockets.get(waitingUserId);

      if (!waitingSocket) {
        logEvent('Error', 'Waiting socket not found');
        socket.emit('error', 'Failed to connect with peer');
        return;
      }

      const roomId = `debate_${questionId}_${Date.now()}`;

      let waitingUserPermanentId;
      permanentUsers.forEach((socketId, permId) => {
        if (socketId === waitingUserId) waitingUserPermanentId = permId;
      });

      rooms.set(roomId, new Set([waitingUserId, socket.id]));
      users.set(waitingUserId, roomId);
      users.set(socket.id, roomId);

      if (waitingUserPermanentId && permanentId) {
        reconnectPairs.set(permanentId, waitingUserPermanentId);
        reconnectPairs.set(waitingUserPermanentId, permanentId);
        logEvent('Reconnect Pair Saved', { user1: permanentId, user2: waitingUserPermanentId });
      }

      waitingSocket.join(roomId);
      socket.join(roomId);

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
    const waitingList = debateWaitingUsers.get(debateRoomKey) || [];
    waitingList.push(socket.id);
    debateWaitingUsers.set(debateRoomKey, waitingList);
    socket.emit('waiting');
    logEvent('Waiting', `User ${socket.id} waiting for ${oppositeChoice} on question ${questionId}`);
  }
}

function handleNormalRoom(socket, data) {
  const { roomId, permanentId } = data;
  logEvent('Room Join', { roomId, permanentId });

  if (permanentId) {
    permanentUsers.set(permanentId, socket.id);
  }

  let waitingList = waitingUsers.get(roomId);
  if (!waitingList) {
    waitingList = [];
    waitingUsers.set(roomId, waitingList);
  }

  if (waitingList.length > 0) {
    const waitingUserId = waitingList.shift();
    if (waitingUserId && waitingUserId !== socket.id) {
      const waitingSocket = io.sockets.sockets.get(waitingUserId);

      if (!waitingSocket) {
        socket.emit('error', 'Failed to connect with peer');
        return;
      }

      const uniqueRoomId = `${roomId}_${Date.now()}`;

      let waitingUserPermanentId;
      permanentUsers.forEach((socketId, permId) => {
        if (socketId === waitingUserId) waitingUserPermanentId = permId;
      });

      logEvent('Connection', `Matched in ${roomId}: ${waitingUserId} <-> ${socket.id}`);

      rooms.set(uniqueRoomId, new Set([waitingUserId, socket.id]));
      users.set(waitingUserId, uniqueRoomId);
      users.set(socket.id, uniqueRoomId);

      if (waitingUserPermanentId && permanentId) {
        reconnectPairs.set(permanentId, waitingUserPermanentId);
        reconnectPairs.set(waitingUserPermanentId, permanentId);
        logEvent('Reconnect Pair Saved', { user1: permanentId, user2: waitingUserPermanentId });
      }

      waitingSocket.join(uniqueRoomId);
      socket.join(uniqueRoomId);

      io.to(waitingUserId).emit('start-call', {
        isInitiator: true,
        roomId: uniqueRoomId,
        peerId: socket.id,
        permanentId: permanentId
      });

      io.to(socket.id).emit('start-call', {
        isInitiator: false,
        roomId: uniqueRoomId,
        peerId: waitingUserId,
        permanentId: waitingUserPermanentId
      });
    }
  } else {
    waitingList.push(socket.id);
    waitingUsers.set(roomId, waitingList);
    socket.emit('waiting');
    logEvent('Waiting', `User ${socket.id} waiting in ${roomId}`);
  }
}

function handleReconnect(socket, data) {
  const { myId, targetId } = data;
  logEvent('Reconnect Attempt', `User ${myId} trying to reconnect with ${targetId}`);

  if (!myId || !targetId) return;

  // Store that this user wants to reconnect
  activeReconnectUsers.set(myId, {
    socketId: socket.id,
    targetId: targetId
  });

  permanentUsers.set(myId, socket.id);
  const targetPair = reconnectPairs.get(targetId);
  logEvent('Reconnect Check', `Target ${targetId} has pair: ${targetPair}`);

  if (targetPair === myId) {
    // Check if target user is also actively trying to reconnect
    const targetReconnectData = activeReconnectUsers.get(targetId);
    if (!targetReconnectData || targetReconnectData.targetId !== myId) {
      socket.emit('waiting');
      return;
    }

    const targetSocketId = permanentUsers.get(targetId);

    // Check if target user is in another active room
    const targetCurrentRoom = Array.from(rooms.entries()).find(([_, users]) =>
      users.has(targetSocketId)
    );
    if (targetCurrentRoom) {
      socket.emit('waiting');
      return;
    }

    if (!targetSocketId) {
      socket.emit('waiting');
      return;
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) {
      socket.emit('waiting');
      return;
    }

    const roomId = generateRoomId('reconnect');
    logEvent('Reconnect Success', { roomId, user1: myId, user2: targetId });

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

    // Clear reconnect status for both users
    activeReconnectUsers.delete(myId);
    activeReconnectUsers.delete(targetId);
    reconnectPairs.delete(myId);
    reconnectPairs.delete(targetId);
  } else {
    reconnectPairs.set(myId, targetId);
    socket.emit('waiting');
    logEvent('Reconnect Waiting', `User ${myId} waiting for ${targetId}`);
  }
}

io.on('connection', (socket) => {
  logEvent('Connection', `New user connected: ${socket.id}`);

  socket.on('join-room', (data) => {
    if (data.isDebate) {
      handleDebateRoom(socket, data);
    } else {
      handleNormalRoom(socket, data);
    }
  });

  socket.on('join-reconnect', (data) => {
    handleReconnect(socket, data);
  });

  socket.on('leave-reconnect', () => {
    permanentUsers.forEach((socketId, permanentId) => {
      if (socketId === socket.id) {
        activeReconnectUsers.delete(permanentId);
      }
    });
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

    // Clear reconnect status for disconnected user
    if (disconnectedPermanentId) {
      activeReconnectUsers.delete(disconnectedPermanentId);
    }

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
            logEvent('Reconnect Available', `${disconnectedPermanentId} <-> ${otherPermanentId}`);
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
      permanentUsers.delete(disconnectedPermanentId);
    }

    // Clean up waiting lists
    waitingUsers.forEach((list, key) => {
      const index = list.indexOf(socket.id);
      if (index > -1) {
        list.splice(index, 1);
        if (list.length === 0) {
          waitingUsers.delete(key);
        }
      }
    });

    debateWaitingUsers.forEach((list, key) => {
      const index = list.indexOf(socket.id);
      if (index > -1) {
        list.splice(index, 1);
        if (list.length === 0) {
          debateWaitingUsers.delete(key);
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

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`\n=================================`);
  console.log(`Server running on port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`=================================\n`);
});