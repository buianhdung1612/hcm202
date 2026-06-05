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

const QUESTION_TIME_LIMIT = 20; // 20 seconds per question

// Broadcast global status (whether a host exists)
const broadcastHostStatus = () => {
  io.emit('host_status', { hasHost: game.hostId !== null });
};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  
  // Immediately send host status to new connections
  socket.emit('host_status', { hasHost: game.hostId !== null });

  // HOST: Bấm tạo phòng / làm host
  socket.on('become_host', (data) => {
    const password = data?.password;
    if (password !== 'admin123') {
      socket.emit('host_rejected', 'Sai mật khẩu Host!');
      return;
    }
    if (game.hostId !== null && game.hostId !== socket.id) {
      socket.emit('host_rejected', 'Đã có Host cho game này. Bạn chỉ có thể làm Player.');
      return;
    }
    
    game.hostId = socket.id;
    socket.emit('host_accepted', { isRevivalLocked: game.isRevivalLocked });
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
      game.aliveAtStartOfTurn = [];
      for (let pid in game.players) {
        game.players[pid].lastAnswer = null;
        if (game.players[pid].status === 'Alive') {
          game.aliveAtStartOfTurn.push(pid);
        }
      }
      
      io.emit('new_question', { questionIndex, questionData, timeLimit: QUESTION_TIME_LIMIT });

      game.timer = setInterval(() => {
        game.timeRemaining--;
        io.emit('timer_tick', { timeRemaining: game.timeRemaining });
        if (game.timeRemaining <= 0) {
          clearInterval(game.timer);
          game.timer = null;
          handleEndOfQuestion(game, io);
        }
      }, 1000);
    }
  });

  function handleEndOfQuestion(game, io) {
    // Auto-kill: trong Final Round, ai còn alive mà chưa nộp bài thì chết
    if (game.isRevivalLocked) {
      for (let pid in game.players) {
        const p = game.players[pid];
        if (p.status === 'Alive' && !p.lastAnswer) {
          p.status = 'Dead';
          io.to(pid).emit('you_are_dead');
        }
      }
    }

    // Nếu tất cả người chơi đều chết trong/kết thúc lượt này, hồi sinh những người sống ở đầu lượt
    const alivePlayers = Object.values(game.players).filter(p => p.status === 'Alive');
    if (alivePlayers.length === 0 && game.aliveAtStartOfTurn && game.aliveAtStartOfTurn.length > 0) {
      game.aliveAtStartOfTurn.forEach(pid => {
        if (game.players[pid]) {
          game.players[pid].status = 'Alive';
          io.to(pid).emit('you_are_revived');
        }
      });
    }

    io.emit('question_timeout');
    if (game.hostId) {
      io.to(game.hostId).emit('player_status_updated', Object.values(game.players));
    }
  }

  // HOST: Đánh dấu 1 người chơi là Dead (vì sai offline)
  socket.on('kill_player', ({ playerId }) => {
    if (game.hostId === socket.id && game.players[playerId]) {
      game.players[playerId].status = 'Dead';
      game.players[playerId].streak = 0;
      
      io.to(playerId).emit('you_are_dead');
      socket.emit('player_status_updated', Object.values(game.players));
    }
  });

  // HOST: Kết thúc trò chơi - người alive cuối cùng thắng
  socket.on('end_game', () => {
    if (game.hostId === socket.id) {
      if (game.timer) clearInterval(game.timer);
      game.timer = null;

      const alivePlayers = Object.values(game.players).filter(p => p.status === 'Alive');
      const winners = alivePlayers; // Chết hết thì không có ai win

      io.emit('game_over', {
        winners: winners.map(p => p.name),
        players: Object.values(game.players)
      });
      console.log(`Game over! Winners: ${winners.map(p => p.name).join(', ')}`);
    }
  });

  // HOST: Tua nhanh - kết thúc timer ngay lập tức
  socket.on('skip_question', () => {
    if (game.hostId === socket.id && game.timer) {
      clearInterval(game.timer);
      game.timer = null;
      handleEndOfQuestion(game, io);
    }
  });

  // PLAYER: Gửi câu trả lời
  socket.on('submit_answer', ({ answer }) => {
    if (game.players[socket.id]) {
      const player = game.players[socket.id];
      const isCorrect = answer === game.currentCorrectAnswer;
      player.lastAnswer = answer;
      
      // Vòng Chung Kết: trả kết quả ngay, sai thì chết
      if (game.isRevivalLocked) {
        socket.emit('answer_result', { isCorrect, streak: player.streak || 0 });

        if (!isCorrect && player.status === 'Alive') {
          // Trả lời sai → chết ngay
          player.status = 'Dead';
          socket.emit('you_are_dead');
        }

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
      console.log("Host disconnected, resetting FULL game state");
      if (game.timer) clearInterval(game.timer);
      // ✅ Reset TOÀN BỘ game về trạng thái ban đầu
      game = {
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
      broadcastHostStatus();
      io.emit('revival_locked_status', { isLocked: false }); // Thông báo reset vòng chung kết cho tất cả player
      io.emit('host_disconnected');
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
