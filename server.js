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

// 🤖 국어사전에서 특정 글자로 시작하는 단어를 찾는 컴퓨터 전용 함수
async function getBotWord(startChar, usedWords) {
    const apiKey = 'A7357991EA6C47925AA3642AB714EECA';
    const url = `https://krdict.korean.go.kr/api/search?key=${apiKey}&q=${encodeURIComponent(startChar)}&advanced=y&method=start&pos=1&num=20`;

    try {
        const response = await fetch(url);
        const xmlText = await response.text();
        const matches = xmlText.match(/<word>(.*?)<\/word>/g) || [];
        const candidates = matches
            .map(m => m.replace(/<\/?word>/g, '').trim())
            .filter(w => w.length >= 2 && !w.includes('-') && !w.includes(' ') && !usedWords.has(w));

        if (candidates.length === 0) return null;
        return candidates[Math.floor(Math.random() * candidates.length)];
    } catch (error) {
        console.error('컴퓨터 단어 검색 에러:', error);
        return null;
    }
}

function startTurnTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.timer) clearInterval(room.timer);

    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer) return; // 안전장치

    const bonusSec = room.bonusTime[currentPlayer.id] || 0;
    room.timeLeft = 20 + bonusSec;
    delete room.bonusTime[currentPlayer.id];

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
    } while (!room.players[room.currentTurn]?.isAlive && attempts < room.players.length);

    const alivePlayers = room.players.filter(p => p.isAlive);
    if (alivePlayers.length <= 1) {
        clearInterval(room.timer);
        io.to(roomId).emit('game_over', { winner: alivePlayers[0]?.nickname || '없음' });
        return;
    }

    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer) return;

    io.to(roomId).emit('turn_changed', {
        currentTurnSocketId: currentPlayer.id,
        currentTurnNickname: currentPlayer.nickname,
        lastWord: room.lastWord,
        message: systemMessage,
        combo: room.combo
    });

    startTurnTimer(roomId);

    // 🤖 차례가 컴퓨터(isBot)라면 자연스럽게 생각 후 단어 제출
    if (currentPlayer.isBot) {
        handleBotTurn(roomId);
    }
}

// 🤖 컴퓨터 턴 자동 응답 처리
function handleBotTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer) return;

    const lastChar = room.lastWord ? room.lastWord.slice(-1) : '가';
    const thinkTime = Math.floor(Math.random() * 1000) + 1500; // 1.5초~2.5초 생각

    setTimeout(async () => {
        if (!rooms[roomId] || !room.isStarted) return;

        const botWord = await getBotWord(lastChar, room.usedWords);

        if (botWord) {
            room.usedWords.add(botWord);
            room.lastWord = botWord;
            io.to(roomId).emit('word_accepted', {
                word: botWord,
                nickname: currentPlayer.nickname,
                combo: 1,
                earnedItem: null,
                myItems: [],
                socketId: currentPlayer.id
            });
            nextTurn(roomId);
        } else {
            currentPlayer.isAlive = false;
            nextTurn(roomId, `🤖 ${currentPlayer.nickname}(이)가 단어를 떠올리지 못해 기권했습니다!`);
        }
    }, thinkTime);
}

io.on('connection', (socket) => {
    socket.on('join_room', ({ roomId, nickname }) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], currentTurn: 0, lastWord: '', usedWords: new Set(),
                isStarted: false, timer: null, timeLeft: 20,
                combo: 0, lastWordTime: 0,
                bonusTime: {}, items: {}
            };
        }
        const room = rooms[roomId];
        if (room.isStarted) return socket.emit('error_msg', '이미 게임이 진행 중입니다.');
        if (room.players.length >= 4) return socket.emit('error_msg', '방이 가득 찼습니다.');

        room.players.push({ id: socket.id, nickname, isAlive: true });
        room.items[socket.id] = [];
        
        io.to(roomId).emit('room_update', { players: room.players, isStarted: room.isStarted });
    });

    // 🤖 컴퓨터 대결 시작 소켓 이벤트
    socket.on('start_bot_game', ({ roomId, nickname }) => {
        socket.join(roomId);
        
        rooms[roomId] = {
            players: [
                { id: socket.id, nickname: nickname, isAlive: true },
                { id: 'BOT_PLAYER', nickname: '🤖 알파고', isAlive: true, isBot: true }
            ],
            currentTurn: 0,
            lastWord: '',
            usedWords: new Set(),
            isStarted: true,
            timer: null,
            timeLeft: 20,
            combo: 0,
            lastWordTime: Date.now(),
            bonusTime: {},
            items: { [socket.id]: [], 'BOT_PLAYER': [] }
        };

        const room = rooms[roomId];
        io.to(roomId).emit('room_update', { players: room.players, isStarted: room.isStarted });
        io.to(roomId).emit('game_start', {
            players: room.players,
            currentTurnSocketId: room.players[0].id,
            currentTurnNickname: room.players[0].nickname
        });

        startTurnTimer(roomId);
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
        if (room) socket.emit('room_update', { players: room.players, isStarted: room.isStarted });
    });

    socket.on('submit_word', async ({ roomId, word }) => {
        const room = rooms[roomId];
        if (!room || !room.isStarted) return;
        
        const currentPlayer = room.players[room.currentTurn];
        
        // 💡 플레이어가 갑자기 나가서 순서가 꼬였을 때 서버 다운 방지
        if (!currentPlayer) {
            return;
        }

        if (currentPlayer.id !== socket.id) {
            socket.emit('error_msg', '본인 턴이 아닙니다.');
            return;
        }

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

        const now = Date.now();
        if (now - room.lastWordTime <= 3500) {
            room.combo++;
        } else {
            room.combo = 1;
        }
        room.lastWordTime = now;

        let earnedItem = null;
        if (trimmedWord.length >= 4) {
            room.bonusTime[socket.id] = (room.bonusTime[socket.id] || 0) + 3;
        }

        if ((room.combo >= 3 || trimmedWord.length >= 4) && room.items[socket.id]?.length < 2) {
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

    socket.on('use_item', ({ roomId, itemType }) => {
        const room = rooms[roomId];
        if (!room || !room.isStarted) return;

        const currentPlayer = room.players[room.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        const userItems = room.items[socket.id] || [];
        const itemIndex = userItems.indexOf(itemType);

        if (itemIndex === -1) return;

        userItems.splice(itemIndex, 1);

        if (itemType === 'SKIP') {
            io.to(roomId).emit('item_used', { 
                nickname: currentPlayer.nickname, 
                itemType: 'SKIP', 
                message: `⚡ ${currentPlayer.nickname} 님이 [턴 건너뛰기] 스킬을 사용했습니다!` 
            });
            nextTurn(roomId);
        } else if (itemType === 'CHANGE_CHAR') {
            const easyChars = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하'];
            const newChar = easyChars[Math.floor(Math.random() * easyChars.length)];
            room.lastWord = newChar;

            io.to(roomId).emit('item_used', { 
                nickname: currentPlayer.nickname, 
                itemType: 'CHANGE_CHAR', 
                newWord: newChar,
                message: `🎲 ${currentPlayer.nickname} 님이 [제시어 변경] 사용! 첫 글자: '${newChar}'` 
            });

            startTurnTimer(roomId);
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
                    // 💡 남아있는 사람 수에 맞춰 턴 번호가 배열을 벗어나지 않도록 재조정
                    room.currentTurn = room.currentTurn % room.players.length;
                    
                    io.to(roomId).emit('room_update', { players: room.players, isStarted: room.isStarted });
                    
                    if (room.isStarted && room.players.length === 1) {
                        // 게임 진행 중인데 1명만 남은 경우 부전승 처리
                        if (room.timer) clearInterval(room.timer);
                        io.to(roomId).emit('game_over', { winner: room.players[0].nickname + ' (상대방 퇴장)' });
                    } else if (room.isStarted) {
                        const currentPlayer = room.players[room.currentTurn];
                        if (currentPlayer) {
                            io.to(roomId).emit('turn_changed', {
                                currentTurnSocketId: currentPlayer.id,
                                currentTurnNickname: currentPlayer.nickname,
                                lastWord: room.lastWord,
                                message: '누군가 퇴장하여 순서가 조정되었습니다.'
                            });
                            // 💡 누군가 퇴장했을 때 남은 플레이어를 위해 타이머를 다시 시작
                            startTurnTimer(roomId); 
                        }
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
