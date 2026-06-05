const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Single game state
let game = {
  hostId: null,
  players: {},
  isGameStarted: false,
  currentQuestionIndex: -1,
  currentCorrectAnswer: null,
  timer: null,
  timeRemaining: 0,
  isRevivalLocked: false,
  hasRevivedThisRound: false
};

const QUESTION_TIME_LIMIT = 30; // 30 seconds per question

// Broadcast global status (whether a host exists)
const broadcastHostStatus = () => {
  io.emit('host_status', { hasHost: game.hostId !== null });
};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  
  // Immediately send host status to new connections
  socket.emit('host_status', { hasHost: game.hostId !== null });

  // HOST: Bấm tạo phòng / làm host
  socket.on('become_host', () => {
    if (game.hostId !== null && game.hostId !== socket.id) {
      socket.emit('host_rejected', 'Đã có Host cho game này. Bạn chỉ có thể làm Player.');
      return;
    }
    
    game.hostId = socket.id;
    socket.emit('host_accepted');
    broadcastHostStatus();
    console.log(`Host joined: ${socket.id}`);
  });

  // PLAYER: Vào game (không cần roomId)
  socket.on('join_game', ({ playerName }) => {
    game.players[socket.id] = {
      id: socket.id,
      name: playerName,
      status: 'Alive', // Mặc định là Alive (chơi offline)
      streak: 0
    };

    // Báo cho Host biết có người mới vào
    if (game.hostId) {
      io.to(game.hostId).emit('player_joined', Object.values(game.players));
    }
    
    // Báo cho Player biết đã vào thành công
    socket.emit('joined_success', { playerName, status: 'Alive', streak: 0, isRevivalLocked: game.isRevivalLocked });
    console.log(`Player ${playerName} joined game`);
  });

  // HOST: Bắt đầu game
  socket.on('start_game', () => {
    if (game.hostId === socket.id) {
      game.isGameStarted = true;
      io.emit('game_started'); // Báo cho tất cả
    }
  });

  // HOST: Khóa/Mở khóa hồi sinh (Vòng chung kết)
  socket.on('toggle_revival_lock', ({ isLocked }) => {
    if (game.hostId === socket.id) {
      game.isRevivalLocked = isLocked;
      io.emit('revival_locked_status', { isLocked });
      console.log(`Revival locked: ${isLocked}`);
    }
  });

  // HOST: Chuyển câu hỏi (Có timer)
  socket.on('next_question', ({ questionIndex, questionData, correctAnswer }) => {
    if (game.hostId === socket.id) {
      if (game.timer) clearInterval(game.timer);

      game.currentQuestionIndex = questionIndex;
      game.currentCorrectAnswer = correctAnswer;
      game.timeRemaining = QUESTION_TIME_LIMIT;
      
      // Reset player answers for the new round
      game.hasRevivedThisRound = false;
      for (let pid in game.players) {
        game.players[pid].lastAnswer = null;
      }
      
      io.emit('new_question', { questionIndex, questionData, timeLimit: QUESTION_TIME_LIMIT });

      game.timer = setInterval(() => {
        game.timeRemaining--;
        if (game.timeRemaining <= 0) {
          clearInterval(game.timer);
          game.timer = null;
          io.emit('question_timeout');
        }
      }, 1000);
    }
  });

  // HOST: Đánh dấu 1 người chơi là Dead (vì sai offline)
  socket.on('kill_player', ({ playerId }) => {
    if (game.hostId === socket.id && game.players[playerId]) {
      game.players[playerId].status = 'Dead';
      game.players[playerId].streak = 0;
      
      io.to(playerId).emit('you_are_dead');
      socket.emit('player_status_updated', Object.values(game.players));
    }
  });

  // PLAYER: Gửi câu trả lời
  socket.on('submit_answer', ({ answer }) => {
    if (game.players[socket.id]) {
      const player = game.players[socket.id];
      const isCorrect = answer === game.currentCorrectAnswer;
      player.lastAnswer = answer;
      
      // Nếu Vòng Chung Kết (isRevivalLocked = true), tất cả người chơi đều trả lời ẩn danh trên web
      if (game.isRevivalLocked) {
         socket.emit('answer_submitted_anonymous'); // Chỉ xác nhận đã nộp bài, không báo kết quả ngay
         if (game.hostId) {
             io.to(game.hostId).emit('player_status_updated', Object.values(game.players));
         }
         return;
      }

      // Vòng loại: Người chết trả lời đúng và nhanh nhất được hồi sinh
      if (player.status === 'Dead') {
        if (isCorrect) {
          socket.emit('answer_result', { isCorrect: true, streak: 0 });

          // Hồi sinh nếu là người nhanh nhất
          if (!game.hasRevivedThisRound) {
            game.hasRevivedThisRound = true;
            player.status = 'Alive';
            socket.emit('you_are_revived');
            
            if (game.hostId) {
              io.to(game.hostId).emit('player_revived', { playerId: socket.id, playerName: player.name });
            }
          }
        } else {
          socket.emit('answer_result', { isCorrect: false, streak: 0 });
        }
        
        if (game.hostId) {
          io.to(game.hostId).emit('player_status_updated', Object.values(game.players));
        }
      }
    }
  });

  // Xử lý ngắt kết nối
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (game.hostId === socket.id) {
      console.log("Host disconnected, resetting game state");
      // Reset game
      game.hostId = null;
      game.isGameStarted = false;
      if (game.timer) clearInterval(game.timer);
      game.timer = null;
      broadcastHostStatus();
      io.emit('host_disconnected'); // Báo cho người chơi biết Host đã thoát
    } else if (game.players[socket.id]) {
      delete game.players[socket.id];
      if (game.hostId) {
        io.to(game.hostId).emit('player_status_updated', Object.values(game.players));
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Quiz Backend running on port ${PORT}`);
});
