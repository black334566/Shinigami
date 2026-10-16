
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "https://black334566.github.io",
    methods: ["GET", "POST"]
  }
});

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.json({ name: "Shinigami UNO Server", status: "online" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", game: "UNO Arena" });
});

const rooms = new Map();
const COLORS = ["red", "blue", "green", "yellow"];

function makeDeck() {
  const deck = [];

  for (const color of COLORS) {
    deck.push({ id: crypto.randomUUID(), color, value: "0" });

    for (let n = 1; n <= 9; n++) {
      deck.push({ id: crypto.randomUUID(), color, value: String(n) });
      deck.push({ id: crypto.randomUUID(), color, value: String(n) });
    }

    for (const value of ["skip", "reverse", "draw2"]) {
      deck.push({ id: crypto.randomUUID(), color, value });
      deck.push({ id: crypto.randomUUID(), color, value });
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ id: crypto.randomUUID(), color: "wild", value: "wild" });
    deck.push({ id: crypto.randomUUID(), color: "wild", value: "wild4" });
  }

  return deck.sort(() => Math.random() - 0.5);
}

function playerIndex(room, socketId) {
  return room.players.findIndex(p => p.id === socketId);
}

function state(room) {
  return {
    code: room.code,
    started: room.started,
    players: room.players.map((p, index) => ({
      id: p.id,
      name: p.name,
      cardCount: p.hand.length,
      index
    })),
    topCard: room.discard.at(-1),
    currentColor: room.currentColor,
    turn: room.turn,
    direction: room.direction
  };
}

function broadcast(room) {
  io.to(room.code).emit("roomState", state(room));

  for (const p of room.players) {
    io.to(p.id).emit("yourHand", p.hand);
  }
}

function advance(room, count = 1) {
  const n = room.players.length;
  room.turn = (room.turn + room.direction * count + n * 10) % n;
}

function draw(room, player, count = 1) {
  for (let i = 0; i < count; i++) {
    if (!room.deck.length) {
      if (room.discard.length <= 1) break;
      const top = room.discard.pop();
      room.deck = room.discard.sort(() => Math.random() - 0.5);
      room.discard = [top];
    }

    if (room.deck.length) player.hand.push(room.deck.pop());
  }
}

function reply(callback, result) {
  if (typeof callback === "function") callback(result);
}

io.on("connection", socket => {
  socket.emit("connected", { id: socket.id });

  socket.on("createRoom", (data = {}, callback) => {
    const name = String(data.name || "").trim().slice(0, 20);

    if (!name) return reply(callback, { error: "Enter your name." });

    let code;
    do {
      code = crypto.randomBytes(3).toString("hex").toUpperCase();
    } while (rooms.has(code));

    const room = {
      code,
      players: [{ id: socket.id, name, hand: [] }],
      deck: [],
      discard: [],
      currentColor: null,
      turn: 0,
      direction: 1,
      started: false
    };

    rooms.set(code, room);
    socket.join(code);
    reply(callback, { code });
    broadcast(room);
  });

  socket.on("joinRoom", (data = {}, callback) => {
    const code = String(data.code || "").trim().toUpperCase();
    const name = String(data.name || "").trim().slice(0, 20);
    const room = rooms.get(code);

    if (!room) return reply(callback, { error: "Room not found." });
    if (room.started) return reply(callback, { error: "Game already started." });
    if (room.players.length >= 4) {
      return reply(callback, { error: "Room is full." });
    }
    if (!name) return reply(callback, { error: "Enter your name." });

    room.players.push({ id: socket.id, name, hand: [] });
    socket.join(code);

    reply(callback, { code });
    broadcast(room);
  });

  socket.on("startGame", (data = {}, callback) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room) return reply(callback, { error: "Room not found." });
    if (playerIndex(room, socket.id) < 0) {
      return reply(callback, { error: "Not a room member." });
    }
    if (room.started) return reply(callback, { error: "Already started." });
    if (room.players.length < 2) {
      return reply(callback, { error: "Need at least 2 players." });
    }

    room.deck = makeDeck();
    room.discard = [];
    room.turn = 0;
    room.direction = 1;

    for (const p of room.players) {
      p.hand = [];
      draw(room, p, 7);
    }

    let first = room.deck.pop();

    while (first && first.color === "wild") {
      room.deck.unshift(first);
      first = room.deck.pop();
    }

    if (!first) return reply(callback, { error: "Deck error." });

    room.discard.push(first);
    room.currentColor = first.color;
    room.started = true;

    reply(callback, { ok: true });
    broadcast(room);
  });

  socket.on("playCard", (data = {}, callback) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room || !room.started) {
      return reply(callback, { error: "Game not started." });
    }

    const index = playerIndex(room, socket.id);
    if (index < 0) return reply(callback, { error: "Not in room." });
    if (index !== room.turn) {
      return reply(callback, { error: "Not your turn." });
    }

    const player = room.players[index];
    const cardIndex = player.hand.findIndex(c => c.id === data.cardId);

    if (cardIndex < 0) return reply(callback, { error: "Card not found." });

    const card = player.hand[cardIndex];
    const top = room.discard.at(-1);

    const playable =
      card.color === "wild" ||
      card.color === room.currentColor ||
      card.value === top.value;

    if (!playable) {
      return reply(callback, { error: "Card cannot be played." });
    }

    const chosenColor = data.chosenColor;

    if (card.color === "wild" && !COLORS.includes(chosenColor)) {
      return reply(callback, { error: "Choose a valid color." });
    }

    player.hand.splice(cardIndex, 1);
    room.discard.push(card);
    room.currentColor = card.color === "wild" ? chosenColor : card.color;

    if (player.hand.length === 0) {
      room.started = false;
      io.to(room.code).emit("gameOver", { winner: player.name });
      reply(callback, { ok: true });
      broadcast(room);
      return;
    }

    if (card.value === "reverse") {
      room.direction *= -1;
      advance(room, room.players.length === 2 ? 2 : 1);
    } else if (card.value === "skip") {
      advance(room, 2);
    } else if (card.value === "draw2") {
      advance(room);
      draw(room, room.players[room.turn], 2);
      advance(room);
    } else if (card.value === "wild4") {
      advance(room);
      draw(room, room.players[room.turn], 4);
      advance(room);
    } else {
      advance(room);
    }

    reply(callback, { ok: true });
    broadcast(room);
  });

  socket.on("drawCard", (data = {}, callback) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room || !room.started) {
      return reply(callback, { error: "Game not started." });
    }

    const index = playerIndex(room, socket.id);
    if (index < 0) return reply(callback, { error: "Not in room." });
    if (index !== room.turn) {
      return reply(callback, { error: "Not your turn." });
    }

    draw(room, room.players[index], 1);
    advance(room);

    reply(callback, { ok: true });
    broadcast(room);
  });

  socket.on("chat", (data = {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());
    const index = room ? playerIndex(room, socket.id) : -1;

    if (!room || index < 0) return;

    const message = String(data.message || "").trim().slice(0, 300);
    if (!message) return;

    io.to(room.code).emit("chat", {
      name: room.players[index].name,
      message
    });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      const index = playerIndex(room, socket.id);
      if (index < 0) continue;

      if (!room.started) {
        room.players.splice(index, 1);

        if (room.players.length === 0) rooms.delete(code);
        else broadcast(room);
      } else {
        io.to(code).emit("playerDisconnected", {
          name: room.players[index].name
        });
      }

      break;
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Shinigami UNO server listening on ${PORT}`);
});
