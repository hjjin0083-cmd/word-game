const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = {};

// 랭킹 시스템 전용 유저 점수 데이터 베이스 (메모리 저장)
const userScores = {}; // { [userIdKey]: { userId: string, nickname: string, score: number } }

// 상위 5명 랭킹 추출 함수
function getTopRankings() {
    return Object.values(userScores)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
}

// 전체 클라이언트에 랭킹 정보 브로드캐스트
function broadcastRankings() {
    const topRankings = getTopRankings();
    io.emit('update_rankings', topRankings);
    io.emit('leaderboard_update', topRankings); // 호환성을 위한 하위 호환 이벤트
}

// 점수 업데이트 함수
function addPlayerScore(userKey, nickname, points) {
    if (!userKey) return;
    if (!userScores[userKey]) {
        userScores[userKey] = { userId: userKey, nickname: nickname || '익명', score: 0 };
    }
    userScores[userKey].score = Math.max(0, userScores[userKey].score + points);
    if (nickname) userScores[userKey].nickname = nickname; // 닉네임 최신화
    
    broadcastRankings();
}

// 컴퓨터 기본 백업 단어집 (API 통신 불가 시 사용)
const fallbackBotWords = {
    '가': ['가방', '가수', '가구', '가을', '가면', '가재', '가게', '가정'],
    '나': ['나비', '나무', '나팔', '나침반', '나이', '나물'],
    '다': ['다람쥐', '다리', '다리미', '다이아몬드', '다방'],
    '라': ['라면', '라디오', '라이터', '라일락', '라마'],
    '마': ['마늘', '마술', '마이크', '마스크', '마차'],
    '바': ['바다', '바나나', '바람', '바위', '바구니', '바지'],
    '사': ['사자', '사과', '사람', '사탕', '사슴', '사다리'],
    '아': ['안경', '아기', '아이스크림', '아버지', '아침', '아파트'],
    '자': ['자전거', '자동차', '자석', '자두', '자유', '자라'],
    '차': ['차량', '차표', '차나무', '차창'],
    '카': ['카메라', '카드', '카레', '카누', '카카오'],
    '타': ['타이어', '타조', '타올', '타석'],
    '파': ['파도', '파인애플', '파리', '파이프', '파랑'],
    '하': ['하늘', '하마', '하모니카', '하프', '하수구']
};

function getWaitingRooms() {
    const roomList = [];
    for (const [roomId, room] of Object.entries(rooms)) {
        const isBotRoom = room.players.some(p => p.isBot);
        if (!room.isStarted && !isBotRoom && room.players.length < 4 && room.players.length > 0) {
            roomList.push({
                roomId: roomId,
                playerCount: room.players.length
            });
        }
    }
    return roomList;
}

// HTTPS 요청 래퍼 (Fetch fallback용)
function fetchText(url) {
    return new Promise((resolve, reject) => {
        if (typeof fetch === 'function') {
            fetch(url)
                .then(res => {
                    if (!res.ok) throw new Error('API Response Error');
                    return res.text();
                })
                .then(resolve)
                .catch(reject);
            return;
        }

        https.get(url, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// 국어사전 검색 및 단어 뜻 가져오는 함수
async function checkWordInDictionary(word) {
    const apiKey = 'A7357991EA6C47925AA3642AB714EECA'; 
    if (!apiKey || apiKey === '여기에_발급받은_API_키를_넣으세요') {
        return { exists: true, definition: '테스트 모드 단어입니다.' }; 
    }
    const url = `https://krdict.korean.go.kr/api/search?key=${apiKey}&q=${encodeURIComponent(word)}&advanced=y&method=exact&pos=1`;
    try {
        const xmlText = await fetchText(url);
        const matchTotal = xmlText.match(/<total>(\d+)<\/total>/);
        const exists = matchTotal && parseInt(matchTotal[1], 10) > 0;
        
        let definition = '단어의 뜻 정보를 불러왔습니다.';
        if (exists) {
            const defMatch = xmlText.match(/<definition>(.*?)<\/definition>/);
            if (defMatch) {
                definition = defMatch[1].replace(/<[^>]+>/g, '').trim(); 
            }
        }
        return { exists, definition };
    } catch (error) {
        console.error('사전 통신 에러 (기본 정상 처리로 전환):', error);
        return { exists: true, definition: '사전 연결 상태 확인 중입니다.' }; 
    }
}

// 컴퓨터 전용 단어 검색 함수
async function getBotWord(startChar, usedWords) {
    const apiKey = 'A7357991EA6C47925AA3642AB714EECA';
    const searchChars = [startChar];
    const converted = applyDueumRule(startChar);
    if (converted !== startChar) {
        searchChars.push(converted);
    }

    let candidates = [];
    for (const char of searchChars) {
        const url = `https://krdict.korean.go.kr/api/search?key=${apiKey}&q=${encodeURIComponent(char)}&advanced=y&method=start&pos=1&num=20`;
        try {
            const xmlText = await fetchText(url);
            const matches = xmlText.match(/<word>(.*?)<\/word>/g) || [];
            const words = matches
                .map(m => m.replace(/<\/?word>/g, '').trim())
                .filter(w => w.length >= 2 && !w.includes('-') && !w.includes(' ') && !usedWords.has(w));
            candidates = candidates.concat(words);
        } catch (error) {
            console.error('컴퓨터 단어 검색 에러:', error);
        }
    }

    if (candidates.length === 0) {
        for (const char of searchChars) {
            const fallbackList = fallbackBotWords[char] || [];
            const available = fallbackList.filter(w => !usedWords.has(w));
            candidates = candidates.concat(available);
        }
    }

    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

// 두음법칙 변환 함수
function applyDueumRule(char) {
    const dueumMap = {
        '라': '나', '락': '낙', '란': '난', '랄': '날', '람': '남', '랍': '납', '랑': '낭',
        '래': '내', '랭': '냉', '랜': '낸', '랫': '냇', 
        '로': '노', '록': '녹', '론': '논', '롬': '놈', '롯': '놋',
        '뢰': '뇌', '루': '누', '룩': '눅', '룬': '눈', '룸': '눔', '룻': '눗', '룽': '눙',
        '르': '느', '른': '는', '름': '늠', '릉': '능',
        '랴': '야', '려': '여', '력': '역', '련': '년', '렬': '열', '렴': '염', '렵': '엽', '령': '영',
        '례': '예', '료': '요', '룡': '용', '류': '유', '륙': '육', '률': '율', '융': '융', '리': '이', '익': '익',
        '량': '양',
        '녀': '여', '녁': '역', '년': '연', '념': '염', '녕': '영',
        '뇨': '요', '뉴': '유', '니': '이'
    };
    
    let mapped = dueumMap[char];
    if (mapped && mapped.includes('(')) {
        return mapped.split('(')[0];
    }
    return mapped || char;
}

function removePlayerFromAllRooms(socket) {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const index = room.players.findIndex(p => p.id === socket.id);
        
        if (index !== -1) {
            socket.leave(roomId);
            room.players.splice(index, 1);
            delete room.items[socket.id];
            
            const realPlayersCount = room.players.filter(p => !p.isBot).length;
            
            if (realPlayersCount === 0) {
                if (room.timer) clearInterval(room.timer);
                delete rooms[roomId];
            } else {
                room.currentTurn = room.currentTurn % room.players.length;
                io.to(roomId).emit('room_update', { players: room.players, isStarted: room.isStarted });
                
                if (room.isStarted && realPlayersCount === 1) {
                    if (room.timer) clearInterval(room.timer);
                    const winner = room.players.find(p => !p.isBot);
                    io.to(roomId).emit('game_over', { winner: (winner ? winner.nickname : '알 수 없음') + ' (상대방 퇴장)' });
                    
                    room.isStarted = false;
                    room.usedWords.clear();
                    room.lastWord = '';
                    room.combo = 0;
                } else if (room.isStarted) {
                    const currentPlayer = room.players[room.currentTurn];
                    if (currentPlayer) {
                        io.to(roomId).emit('turn_changed', {
                            currentTurnSocketId: currentPlayer.id,
                            currentTurnNickname: currentPlayer.nickname,
                            lastWord: room.lastWord,
                            message: '누군가 퇴장하여 순서가 조정되었습니다.'
                        });
                        startTurnTimer(roomId); 
                    }
                }
            }
        }
    }
}

function startTurnTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.timer) clearInterval(room.timer);

    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer) return;

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
        const winner = alivePlayers[0];
        io.to(roomId).emit('game_over', { winner: winner?.nickname || '없음' });
        
        // 승자 승리 보너스 점수 50점 지급
        if (winner && !winner.isBot) {
            const userKey = winner.userId || winner.id;
            addPlayerScore(userKey, winner.nickname, 50);
        }

        room.isStarted = false;
        room.usedWords.clear();
        room.lastWord = '';
        room.combo = 0;
        room.players = room.players.filter(p => !p.isBot);
        
        io.emit('room_list', getWaitingRooms());
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

    if (currentPlayer.isBot) {
        handleBotTurn(roomId);
    }
}

function handleBotTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer) return;

    const lastChar = room.lastWord ? room.lastWord.slice(-1) : '가';
    const thinkTime = Math.floor(Math.random() * 1000) + 1500;

    setTimeout(async () => {
        if (!rooms[roomId] || !room.isStarted) return;

        const botWord = await getBotWord(lastChar, room.usedWords);

        if (botWord) {
            room.usedWords.add(botWord);
            room.lastWord = botWord;
            io.to(roomId).emit('word_accepted', {
                word: botWord,
                nickname: currentPlayer.nickname,
                definition: '컴퓨터가 입력한 단어입니다.',
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
    socket.emit('room_list', getWaitingRooms());
    socket.emit('update_rankings', getTopRankings());

    socket.on('register_user', ({ userId, nickname, score }) => {
        socket.userId = userId;
        socket.nickname = nickname;

        const userKey = userId || socket.id;
        if (!userScores[userKey]) {
            userScores[userKey] = { userId: userKey, nickname: nickname || '익명', score: score || 0 };
        } else {
            userScores[userKey].nickname = nickname || userScores[userKey].nickname;
            if (typeof score === 'number' && score > userScores[userKey].score) {
                userScores[userKey].score = score;
            }
        }
        broadcastRankings();
    });

    socket.on('update_score', ({ userId, nickname, score }) => {
        const userKey = userId || socket.userId || socket.id;
        if (!userScores[userKey]) {
            userScores[userKey] = { userId: userKey, nickname: nickname || '익명', score: score || 0 };
        } else {
            if (nickname) userScores[userKey].nickname = nickname;
            if (typeof score === 'number') userScores[userKey].score = score;
        }
        broadcastRankings();
    });

    socket.on('get_rankings', () => {
        socket.emit('update_rankings', getTopRankings());
    });

    socket.on('join_room', ({ roomId, nickname, userId }) => {
        if (userId) socket.userId = userId;
        if (nickname) socket.nickname = nickname;

        removePlayerFromAllRooms(socket);
        
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

        room.players.push({ id: socket.id, userId: socket.userId, nickname, isAlive: true });
        room.items[socket.id] = [];
        
        io.to(roomId).emit('room_update', { players: room.players, isStarted: room.isStarted });
        io.emit('room_list', getWaitingRooms());
    });

    socket.on('start_bot_game', ({ roomId, nickname, userId }) => {
        if (userId) socket.userId = userId;
        if (nickname) socket.nickname = nickname;

        removePlayerFromAllRooms(socket);
        
        socket.join(roomId);
        
        rooms[roomId] = {
            players: [
                { id: socket.id, userId: socket.userId, nickname: nickname, isAlive: true },
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
        io.emit('room_list', getWaitingRooms());
    });

    socket.on('start_game', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.isStarted || room.players.length < 2) return;
        room.isStarted = true;
        room.combo = 0;
        room.lastWordTime = Date.now();
        room.players.forEach(p => p.isAlive = true);
        
        io.to(roomId).emit('game_start', {
            players: room.players,
            currentTurnSocketId: room.players[0].id,
            currentTurnNickname: room.players[0].nickname
        });
        startTurnTimer(roomId);
        io.emit('room_list', getWaitingRooms());
    });

    socket.on('get_room_info', ({ roomId }) => {
        const room = rooms[roomId];
        if (room) socket.emit('room_update', { players: room.players, isStarted: room.isStarted });
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

        const trimmedWord = (word || '').trim();
        if (trimmedWord.length < 2) return socket.emit('error_msg', '2글자 이상 입력해주세요.');
        
        if (room.lastWord) {
            const lastChar = room.lastWord.slice(-1);
            const firstChar = trimmedWord.charAt(0);

            const normalMatch = (lastChar === firstChar);
            const dueumMatch = (applyDueumRule(lastChar) === firstChar);

            if (!normalMatch && !dueumMatch) {
                const convertedChar = applyDueumRule(lastChar);
                const guideText = convertedChar !== lastChar ? `' 또는 '${convertedChar}'` : '';
                return socket.emit('error_msg', `'${lastChar}'(${guideText})로 시작해야 합니다.`);
            }
        }

        if (room.usedWords.has(trimmedWord)) return socket.emit('error_msg', '이미 사용된 단어입니다.');

        const checkResult = await checkWordInDictionary(trimmedWord);
        if (!checkResult.exists) {
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

        // 점수 획득 로직: (단어 글자 수 * 10점) + (콤보 보너스 * 5점)
        const earnedPoints = (trimmedWord.length * 10) + (room.combo * 5);
        const userKey = socket.userId || socket.id;
        addPlayerScore(userKey, currentPlayer.nickname, earnedPoints);

        let earnedItem = null;
        if (trimmedWord.length >= 4) {
            room.bonusTime[socket.id] = (room.bonusTime[socket.id] || 0) + 3;
        }

        if ((room.combo >= 3 || trimmedWord.length >= 4) && (room.items[socket.id]?.length || 0) < 2) {
            const itemTypes = ['SKIP', 'CHANGE_CHAR', 'ATTACK'];
            earnedItem = itemTypes[Math.floor(Math.random() * itemTypes.length)];
            if (!room.items[socket.id]) room.items[socket.id] = [];
            room.items[socket.id].push(earnedItem);
        }

        room.usedWords.add(trimmedWord);
        room.lastWord = trimmedWord;

        io.to(roomId).emit('word_accepted', { 
            word: trimmedWord, 
            nickname: currentPlayer.nickname,
            definition: checkResult.definition, 
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
        } else if (itemType === 'CHANGE_CHAR' || itemType === 'CHANGE') {
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
        } else if (itemType === 'ATTACK') {
            room.timeLeft = Math.max(1, room.timeLeft - 5);
            io.to(roomId).emit('timer_update', { timeLeft: room.timeLeft, bonusTime: 0, currentPlayerId: currentPlayer.id });
            io.to(roomId).emit('item_used', { 
                nickname: currentPlayer.nickname, 
                itemType: 'ATTACK', 
                message: `⏱ ${currentPlayer.nickname} 님이 [시간 차감] 스킬을 사용했습니다! (-5초)` 
            });
        }

        socket.emit('update_my_items', { items: userItems });
    });

    socket.on('leave_room', () => {
        removePlayerFromAllRooms(socket);
        io.emit('room_list', getWaitingRooms());
    });

    socket.on('disconnect', () => {
        removePlayerFromAllRooms(socket);
        io.emit('room_list', getWaitingRooms());
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버가 ${PORT}번 포트에서 실행 중입니다.`);
});