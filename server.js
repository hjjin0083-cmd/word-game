const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = {};

// 💡 [수정] 업그레이드된 국어사전 검색 함수 (명사만 허용)
async function checkWordInDictionary(word) {
    // 반드시 본인이 발급받은 실제 API 키로 변경해야 작동합니다!
    const apiKey = 'A7357991EA6C47925AA3642AB714EECA'; 
    
    if (apiKey === 'A7357991EA6C47925AA3642AB714EECA') {
        console.log(`[경고] API 키가 입력되지 않아 '${word}' 단어가 무조건 통과됩니다.`);
        return true; 
    }

    // 💡 주소 맨 끝에 &pos=1 을 추가하여 '명사'만 검색하도록 강제 제한합니다.
    const url = `https://krdict.korean.go.kr/api/search?key=${apiKey}&q=${encodeURIComponent(word)}&advanced=y&method=exact&pos=1`;

    try {
        const response = await fetch(url);
        const xmlText = await response.text();

        // 검색 결과 개수 확인
        const match = xmlText.match(/<total>(\d+)<\/total>/);
        if (match && parseInt(match[1]) > 0) {
            return true; // 명사이고 사전에 존재함
        }
        return false; // 사전에 없거나 명사가 아님
    } catch (error) {
        console.error('사전 통신 에러:', error);
        return false; // 💡 에러가 발생했을 때도 억지로 통과되지 않게 막음
    }
}

function startTurnTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.timer) clearInterval(room.timer);
    room.timeLeft = 10;

    io.to(roomId).emit('timer_update', { timeLeft: room.timeLeft });

    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomId).emit('timer_update', { timeLeft: room.timeLeft });

        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            nextTurn(roomId, `${room.players[room.currentTurn].nickname} 님 시간 초과!`);
        }
    }, 1000);
}

function nextTurn(roomId, systemMessage = '') {
    const room = rooms[roomId];
    if (!room) return;

    let attempts = 0;
    do {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
        attempts++;
    } while (!room.players[room.currentTurn].isAlive && attempts < room.players.length);

    const alivePlayers = room.players.filter(p => p.isAlive);
    if (alivePlayers.length <= 1) {
        clearInterval(room.timer);
        io.to(roomId).emit('game_over', { winner: alivePlayers[0]?.nickname || '없음' });
        return;
    }

    io.to(roomId).emit('turn_changed', {
        currentTurnSocketId: room.players[room.currentTurn].id,
        currentTurnNickname: room.players[room.currentTurn].nickname,
        lastWord: room.lastWord,
        message: systemMessage
    });

    startTurnTimer(roomId);
}

io.on('connection', (socket) => {
    socket.on('join_room', ({ roomId, nickname }) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], currentTurn: 0, lastWord: '', usedWords: new Set(),
                isStarted: false, timer: null, timeLeft: 10
            };
        }
        const room = rooms[roomId];
        if (room.isStarted) {
            socket.emit('error_msg', '이미 게임이 진행 중입니다.');
            return;
        }
        if (room.players.length >= 4) {
            socket.emit('error_msg', '방이 가득 찼습니다.');
            return;
        }
        room.players.push({ id: socket.id, nickname, isAlive: true });
        io.to(roomId).emit('room_update', { players: room.players });
    });

    socket.on('start_game', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.isStarted || room.players.length < 2) return;
        room.isStarted = true;
        io.to(roomId).emit('game_start', {
            players: room.players,
            currentTurnSocketId: room.players[0].id,
            currentTurnNickname: room.players[0].nickname
        });
        startTurnTimer(roomId);
    });

    // 💡 프론트엔드의 화면 갱신 요청 처리
    socket.on('get_room_info', ({ roomId }) => {
        const room = rooms[roomId];
        if (room) {
            socket.emit('room_update', { players: room.players });
        }
    });

    socket.on('submit_word', async ({ roomId, word }) => {
        const room = rooms[roomId];
        if (!room || !room.isStarted) return;
        
        const currentPlayer = room.players[room.currentTurn];
        if (!currentPlayer) return; 

        if (currentPlayer.id !== socket.id) {
            socket.emit('error_msg', '본인 턴이 아닙니다.');
            return;
        }
        const trimmedWord = word.trim();
        if (trimmedWord.length < 2) {
            socket.emit('error_msg', '2글자 이상 입력해주세요.');
            return;
        }
        if (room.lastWord) {
            const lastChar = room.lastWord.slice(-1);
            if (lastChar !== trimmedWord.charAt(0)) {
                socket.emit('error_msg', `'${lastChar}'(으)로 시작해야 합니다.`);
                return;
            }
        }
        if (room.usedWords.has(trimmedWord)) {
            socket.emit('error_msg', '이미 사용된 단어입니다.');
            return;
        }
        const isExist = await checkWordInDictionary(trimmedWord);
        if (!isExist) {
            socket.emit('error_msg', '국어사전에 없는 단어입니다.');
            return;
        }

        room.usedWords.add(trimmedWord);
        room.lastWord = trimmedWord;
        io.to(roomId).emit('word_accepted', { word: trimmedWord, nickname: currentPlayer.nickname });
        nextTurn(roomId);
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) {
                    if (room.timer) clearInterval(room.timer);
                    delete rooms[roomId];
                } else {
                    room.currentTurn = room.currentTurn % room.players.length;
                    io.to(roomId).emit('room_update', { players: room.players });
                    if (room.isStarted && room.players.length === 1) {
                        if (room.timer) clearInterval(room.timer);
                        io.to(roomId).emit('game_over', { winner: room.players[0].nickname + ' (상대방 퇴장)' });
                    } else if (room.isStarted) {
                        io.to(roomId).emit('turn_changed', {
                            currentTurnSocketId: room.players[room.currentTurn].id,
                            currentTurnNickname: room.players[room.currentTurn].nickname,
                            lastWord: room.lastWord,
                            message: '누군가 퇴장하여 순서가 조정되었습니다.'
                        });
                    }
                }
                break;
            }
        }
    });
}); // 💡 실수로 지워지기 쉬운 io.on 닫는 괄호 복구

// 환경 변수가 주는 포트가 있으면 그걸 쓰고, 없으면 3000번을 쓴다는 의미입니다.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버가 ${PORT}번 포트에서 실행 중입니다.`);
});
