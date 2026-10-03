const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = {};

// 국어사전 검색 함수 (명사만 검색)
async function checkWordInDictionary(word) {
    const apiKey = 'A7357991EA6C47925AA3642AB714EECA'; 
    if (!apiKey || apiKey === '여기에_발급받은_API_키를_넣으세요') {
        return true; 
    }
    const url = `https://krdict.korean.go.kr/api/search?key=${apiKey}&q=${encodeURIComponent(word)}&advanced=y&method=exact&pos=1`;
    try {
        const response = await fetch(url);
        const xmlText = await response.text();
        const match = xmlText.match(/<total>(\d+)<\/total>/);
        return match && parseInt(match[1]) > 0;
    } catch (error) {
        console.error('사전 통신 에러:', error);
        return false; 
    }
}

function startTurnTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.timer) clearInterval(room.timer);

    const currentPlayer = room.players[room.currentTurn];
    // 💡 [보너스 제한 시간 적용] 이전 턴에 4글자 이상 맞췄다면 보너스 시간 부여
    const bonusSec = room.bonusTime[currentPlayer.id] || 0;
    room.timeLeft = 10 + bonusSec;
    delete room.bonusTime[currentPlayer.id]; // 보너스 사용 후 차감

    io.to(roomId).emit('timer_update', { 
        timeLeft: room.timeLeft, 
        bonusTime: bonusSec,
        currentPlayerId: currentPlayer.id 
    });

    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomId).emit('timer_update', { timeLeft: room.timeLeft, bonusTime: 0, currentPlayerId: currentPlayer.id });

        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            currentPlayer.isAlive = false; 
            nextTurn(roomId, `⏰ ${currentPlayer.nickname} 님 시간 초과로 탈락!`);
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
        message: systemMessage,
        combo: room.combo
    });

    startTurnTimer(roomId);
}

io.on('connection', (socket) => {
    socket.on('join_room', ({ roomId, nickname }) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], currentTurn: 0, lastWord: '', usedWords: new Set(),
                isStarted: false, timer: null, timeLeft: 20,
                combo: 0, lastWordTime: 0,
                bonusTime: {}, items: {} // 플레이어별 아이템 및 보너스 시간
            };
        }
        const room = rooms[roomId];
        if (room.isStarted) return socket.emit('error_msg', '이미 게임이 진행 중입니다.');
        if (room.players.length >= 4) return socket.emit('error_msg', '방이 가득 찼습니다.');

        room.players.push({ id: socket.id, nickname, isAlive: true });
        room.items[socket.id] = [];
        io.to(roomId).emit('room_update', { players: room.players });
    });

    socket.on('start_game', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.isStarted || room.players.length < 2) return;
        room.isStarted = true;
        room.combo = 0;
        room.lastWordTime = Date.now();
        
        io.to(roomId).emit('game_start', {
            players: room.players,
            currentTurnSocketId: room.players[0].id,
            currentTurnNickname: room.players[0].nickname
        });
        startTurnTimer(roomId);
    });

    socket.on('get_room_info', ({ roomId }) => {
        const room = rooms[roomId];
        if (room) socket.emit('room_update', { players: room.players });
    });

    socket.on('submit_word', async ({ roomId, word }) => {
        const room = rooms[roomId];
        if (!room || !room.isStarted) return;
        
        const currentPlayer = room.players[room.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return socket.emit('error_msg', '본인 턴이 아닙니다.');

        const trimmedWord = word.trim();
        if (trimmedWord.length < 2) return socket.emit('error_msg', '2글자 이상 입력해주세요.');
        
        if (room.lastWord) {
            const lastChar = room.lastWord.slice(-1);
            if (lastChar !== trimmedWord.charAt(0)) {
                return socket.emit('error_msg', `'${lastChar}'(으)로 시작해야 합니다.`);
            }
        }

        if (room.usedWords.has(trimmedWord)) return socket.emit('error_msg', '이미 사용된 단어입니다.');

        const isExist = await checkWordInDictionary(trimmedWord);
        if (!isExist) {
            currentPlayer.isAlive = false;
            socket.emit('error_msg', '국어사전에 없는 단어입니다! (탈락)');
            nextTurn(roomId, `💀 ${currentPlayer.nickname} 님 탈락! (사전에 없는 단어: ${trimmedWord})`);
            return;
        }

        // 💡 [실시간 콤보 시스템] 3초 이내 단어 입력 시 콤보 증가
        const now = Date.now();
        if (now - room.lastWordTime <= 3500) {
            room.combo++;
        } else {
            room.combo = 1;
        }
        room.lastWordTime = now;

        // 💡 [글자 수 보너스 & 아이템 부여]
        let earnedItem = null;
        if (trimmedWord.length >= 4) {
            room.bonusTime[socket.id] = (room.bonusTime[socket.id] || 0) + 3; // 다음 턴 +3초 보너스
        }

        // 3콤보 이상이거나 4글자 이상 단어 작성 시 무작위 아이템 지급 (최대 2개 소지)
        if ((room.combo >= 3 || trimmedWord.length >= 4) && room.items[socket.id].length < 2) {
            const itemTypes = ['SKIP', 'CHANGE_CHAR'];
            earnedItem = itemTypes[Math.floor(Math.random() * itemTypes.length)];
            room.items[socket.id].push(earnedItem);
        }

        room.usedWords.add(trimmedWord);
        room.lastWord = trimmedWord;

        io.to(roomId).emit('word_accepted', { 
            word: trimmedWord, 
            nickname: currentPlayer.nickname,
            combo: room.combo,
            earnedItem: earnedItem,
            myItems: room.items[socket.id],
            socketId: socket.id
        });

        nextTurn(roomId);
    });

    // 💡 [특수 아이템 스킬 사용 이벤트]
    socket.on('use_item', ({ roomId, itemType }) => {
        const room = rooms[roomId];
        if (!room || !room.isStarted) return;

        const currentPlayer = room.players[room.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        const userItems = room.items[socket.id] || [];
        const itemIndex = userItems.indexOf(itemType);

        if (itemIndex === -1) return; // 아이템 없음

        // 사용한 아이템 제거
        userItems.splice(itemIndex, 1);

        if (itemType === 'SKIP') {
            // 턴 건너뛰기
            io.to(roomId).emit('item_used', { 
                nickname: currentPlayer.nickname, 
                itemType: 'SKIP', 
                message: `⚡ ${currentPlayer.nickname} 님이 [턴 건너뛰기] 스킬을 사용했습니다!` 
            });
            nextTurn(roomId);
        } else if (itemType === 'CHANGE_CHAR') {
            // 한방 단어 카운터 & 제시어 강제 변경 (쉬운 글자로 전환)
            const easyChars = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하'];
            const newChar = easyChars[Math.floor(Math.random() * easyChars.length)];
            room.lastWord = newChar;

            io.to(roomId).emit('item_used', { 
                nickname: currentPlayer.nickname, 
                itemType: 'CHANGE_CHAR', 
                newWord: newChar,
                message: `🎲 ${currentPlayer.nickname} 님이 [제시어 변경] 사용! 첫 글자: '${newChar}'` 
            });

            startTurnTimer(roomId); // 타이머 리셋
        }

        socket.emit('update_my_items', { items: userItems });
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                delete room.items[socket.id];
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버가 ${PORT}번 포트에서 실행 중입니다.`);
});
