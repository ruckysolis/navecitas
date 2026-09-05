const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'pilots.json');

function loadDatabase() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ pilots: {}, market: [] }));
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      pilots: data.pilots || data, // compatibilidad hacia atrás
      market: data.market || []
    };
  } catch (e) {
    return { pilots: {}, market: [] };
  }
}

function saveDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let dbData = loadDatabase();
let dbPilots = dbData.pilots;
let marketOrders = dbData.market; // Órdenes activas en el mercado

const universe = {
  players: {},
  sectors: {
    'station': { name: "Estación Central Jita", type: "safe" },
    'mining': { name: "Cinturón Veldspar-4", type: "mining", asteroidHp: 100 },
    'nullsec': { 
      name: "Sector Abisal X-99", 
      type: "combat", 
      timer: 20, 
      round: 1, 
      wrecks: [],
      sovereignty: { ownerCorp: "Ninguna", progress: 0 }
    }
  }
};

// Bucle maestro del servidor
setInterval(() => {
  const nullsecCombatants = Object.values(universe.players).filter(p => p.sector === 'nullsec' && p.armor > 0);

  if (nullsecCombatants.length >= 2) {
    universe.sectors.nullsec.timer--;
    if (universe.sectors.nullsec.timer <= 0) {
      resolveCombat(nullsecCombatants);
      universe.sectors.nullsec.timer = 20;
      universe.sectors.nullsec.round++;
    }
  } else {
    universe.sectors.nullsec.timer = 20;
  }

  // Guardar estado de pilotos
  for (let id in universe.players) {
    const p = universe.players[id];
    if (dbPilots[p.name]) {
      dbPilots[p.name].wallet = p.wallet;
      dbPilots[p.name].ore = p.ore;
      dbPilots[p.name].armor = p.armor;
      dbPilots[p.name].shield = p.shield;
      dbPilots[p.name].corp = p.corp;
    }
  }
  saveDatabase({ pilots: dbPilots, market: marketOrders });

  io.emit('universe_tick', {
    sectors: universe.sectors,
    players: universe.players,
    market: marketOrders
  });
}, 1000);

function resolveCombat(combatants) {
  let logs = [];
  combatants.forEach(p => p.cap = Math.min(100, p.cap + 15));

  combatants.forEach(attacker => {
    if (attacker.armor <= 0) return;
    const target = combatants.find(p => p.id !== attacker.id && p.armor > 0 && (p.corp === "Sin Corp" || p.corp !== attacker.corp));
    if (!target) return;

    if (attacker.order === 'attack' && attacker.cap >= 25) {
      attacker.cap -= 25;
      let dmg = target.order === 'defense' ? 15 : 35;
      applyDamage(target, dmg);
      logs.push(`[${attacker.corp}] ${attacker.name} disparó a [${target.corp}] ${target.name} (-${dmg} daño).`);

      if (target.armor <= 0) {
        handleDestruction(target, attacker);
      }
    } else if (attacker.order === 'defense' && attacker.cap >= 20) {
      attacker.cap -= 20;
      attacker.shield = Math.min(100, attacker.shield + 20);
      logs.push(`${attacker.name} reforzó defensas.`);
    }
    attacker.order = 'none';
  });

  io.to('nullsec').emit('combat_log', logs);
}

function applyDamage(target, dmg) {
  let rem = dmg;
  if (target.shield > 0) {
    if (target.shield >= rem) {
      target.shield -= rem;
      rem = 0;
    } else {
      rem -= target.shield;
      target.shield = 0;
    }
  }
  if (rem > 0) {
    target.armor = Math.max(0, target.armor - rem);
  }
}

function handleDestruction(victim, killer) {
  universe.sectors.nullsec.wrecks.push({
    id: Date.now(),
    name: `Pecio de [${victim.corp}] ${victim.name}`,
    ore: victim.ore,
    credits: 120
  });

  io.emit('chat_broadcast', {
    channel: 'galaxy',
    sender: 'BAJA CONFIRMADA',
    text: `Flota de [${killer.corp}] pulverizó la fragata de [${victim.corp}] ${victim.name} en Nullsec.`
  });

  victim.ore = 0;
  victim.sector = 'station';
  victim.armor = 25;
  victim.shield = 0;
  victim.order = 'none';

  const victimSocket = io.sockets.sockets.get(victim.id);
  if (victimSocket) {
    victimSocket.leave('nullsec');
    victimSocket.join('station');
    victimSocket.emit('ship_destroyed', "Nave destruida. Cápsula de escape transferida a la Estación Central.");
  }
}

io.on('connection', (socket) => {
  socket.on('pilot_login', (pilotName) => {
    const cleanName = pilotName.trim().substring(0, 14) || `Cmdr_${socket.id.substring(0, 4)}`;

    if (!dbPilots[cleanName]) {
      dbPilots[cleanName] = {
        name: cleanName,
        corp: "Sin Corp",
        wallet: 300,
        ore: 10,
        armor: 100,
        shield: 100
      };
      saveDatabase({ pilots: dbPilots, market: marketOrders });
    }

    const saved = dbPilots[cleanName];

    universe.players[socket.id] = {
      id: socket.id,
      name: saved.name,
      corp: saved.corp || "Sin Corp",
      sector: 'station',
      shield: saved.shield,
      armor: saved.armor,
      cap: 100,
      ore: saved.ore,
      wallet: saved.wallet,
      order: 'none'
    };

    socket.join('station');
    socket.emit('login_success', universe.players[socket.id]);
    io.emit('chat_broadcast', { channel: 'galaxy', sender: 'RED', text: `${saved.name} [${saved.corp}] ha entrado al universo.` });
  });

  socket.on('set_corp', (corpTag) => {
    const p = universe.players[socket.id];
    if (!p) return;
    const tag = corpTag.trim().toUpperCase().substring(0, 5) || "CORP";
    p.corp = tag;
    dbPilots[p.name].corp = tag;
    saveDatabase({ pilots: dbPilots, market: marketOrders });
    io.emit('chat_broadcast', { channel: 'galaxy', sender: 'REGISTRO', text: `${p.name} ahora vuela para [${tag}].` });
  });

  // --- SISTEMA DE MERCADO ABIERTO ---
  // Publicar orden de venta
  socket.on('create_sell_order', ({ amount, pricePerUnit }) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;

    amount = parseInt(amount);
    pricePerUnit = parseInt(pricePerUnit);

    if (isNaN(amount) || amount <= 0 || isNaN(pricePerUnit) || pricePerUnit <= 0) return;
    if (p.ore < amount) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'MERCADO', text: "No tienes suficiente mineral en bodega para crear esta orden." });
      return;
    }

    p.ore -= amount;
    const order = {
      id: Date.now(),
      seller: p.name,
      corp: p.corp,
      amount: amount,
      pricePerUnit: pricePerUnit
    };
    marketOrders.push(order);
    saveDatabase({ pilots: dbPilots, market: marketOrders });

    io.emit('chat_broadcast', {
      channel: 'galaxy',
      sender: 'MERCADO',
      text: `NUEVA OFERTA: ${p.name} puso a la venta ${amount} m³ de mineral a ${pricePerUnit} ISK/u.`
    });
  });

  // Comprar orden del mercado
  socket.on('buy_market_order', (orderId) => {
    const buyer = universe.players[socket.id];
    if (!buyer || buyer.sector !== 'station') return;

    const idx = marketOrders.findIndex(o => o.id === orderId);
    if (idx === -1) return;

    const order = marketOrders[idx];
    const totalCost = order.amount * order.pricePerUnit;

    if (buyer.wallet < totalCost) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'MERCADO', text: "Fondos insuficientes para comprar este lote de mineral." });
      return;
    }

    // Cobrar al comprador y entregar mineral
    buyer.wallet -= totalCost;
    buyer.ore += order.amount;

    // Calcular impuesto corporativo (5% para la alianza que controla Nullsec)
    let tax = 0;
    const sovOwner = universe.sectors.nullsec.sovereignty.ownerCorp;
    if (sovOwner !== "Ninguna") {
      tax = Math.round(totalCost * 0.05);
    }
    const netSellerEarned = totalCost - tax;

    // Pagar al vendedor (esté o no conectado en esta sesión)
    if (dbPilots[order.seller]) {
      dbPilots[order.seller].wallet += netSellerEarned;
    }
    // Si está conectado en vivo, actualizar su objeto en memoria
    const sellerPlayer = Object.values(universe.players).find(p => p.name === order.seller);
    if (sellerPlayer) {
      sellerPlayer.wallet += netSellerEarned;
    }

    // Repartir dividendo de impuesto a miembros de la corp soberana en línea
    if (tax > 0) {
      Object.values(universe.players).forEach(p => {
        if (p.corp === sovOwner) {
          p.wallet += tax;
        }
      });
    }

    marketOrders.splice(idx, 1);
    saveDatabase({ pilots: dbPilots, market: marketOrders });

    io.emit('chat_broadcast', {
      channel: 'galaxy',
      sender: 'MERCADO',
      text: `${buyer.name} compró el lote de ${order.seller} (${order.amount} m³ por ${totalCost} ISK).`
    });
  });

  // Cancelar orden propia
  socket.on('cancel_market_order', (orderId) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;

    const idx = marketOrders.findIndex(o => o.id === orderId && o.seller === p.name);
    if (idx !== -1) {
      const order = marketOrders[idx];
      p.ore += order.amount;
      marketOrders.splice(idx, 1);
      saveDatabase({ pilots: dbPilots, market: marketOrders });
      socket.emit('chat_broadcast', { channel: 'local', sender: 'MERCADO', text: "Orden cancelada. Mineral devuelto a tu bodega." });
    }
  });

  socket.on('capture_sov', () => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'nullsec' || p.corp === "Sin Corp") return;

    const sov = universe.sectors.nullsec.sovereignty;
    if (sov.ownerCorp !== p.corp) {
      sov.progress += 25;
      if (sov.progress >= 100) {
        sov.ownerCorp = p.corp;
        sov.progress = 100;
        io.emit('chat_broadcast', { channel: 'galaxy', sender: 'SOBERANÍA', text: `¡[${p.corp}] ha capturado la Soberanía en Nullsec! Cobrará el 5% de impuestos de todo el mercado espacial.` });
      } else {
        io.to('nullsec').emit('chat_broadcast', { channel: 'local', sender: 'BALIZA', text: `[${p.corp}] reclamando soberanía (${sov.progress}%)...` });
      }
    }
  });

  socket.on('send_chat', ({ channel, text }) => {
    const p = universe.players[socket.id];
    if (!p || !text.trim()) return;
    const ch = channel === 'galaxy' ? 'galaxy' : 'local';
    const room = ch === 'galaxy' ? null : p.sector;

    if (room) {
      io.to(room).emit('chat_broadcast', { channel: 'local', sender: `[${p.corp}] ${p.name}`, text: text.trim() });
    } else {
      io.emit('chat_broadcast', { channel: 'galaxy', sender: `[${p.corp}] ${p.name}`, text: text.trim() });
    }
  });

  socket.on('send_sos', () => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'nullsec') return;
    io.emit('sos_alert', { pilot: `[${p.corp}] ${p.name}`, sectorId: 'nullsec', sectorName: universe.sectors.nullsec.name });
  });

  socket.on('warp_to', (newSector) => {
    const p = universe.players[socket.id];
    if (!p) return;
    socket.leave(p.sector);
    p.sector = newSector;
    socket.join(newSector);
    p.order = 'none';
  });

  socket.on('set_order', (order) => {
    if (universe.players[socket.id]) {
      universe.players[socket.id].order = order;
      socket.emit('order_ack', order);
    }
  });

  socket.on('mine_cycle', () => {
    const p = universe.players[socket.id];
    if (p && p.sector === 'mining') {
      p.ore += 5;
      universe.sectors.mining.asteroidHp = Math.max(0, universe.sectors.mining.asteroidHp - 10);
      if (universe.sectors.mining.asteroidHp <= 0) {
        universe.sectors.mining.asteroidHp = 100;
        io.to('mining').emit('chat_broadcast', { channel: 'local', sender: 'TELEMETRÍA', text: "Roca agotada. Nueva masa rocosa fijada." });
      }
    }
  });

  socket.on('loot_wreck', (wreckId) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'nullsec') return;
    const idx = universe.sectors.nullsec.wrecks.findIndex(w => w.id === wreckId);
    if (idx !== -1) {
      const w = universe.sectors.nullsec.wrecks[idx];
      p.ore += w.ore;
      p.wallet += w.credits;
      io.to('nullsec').emit('chat_broadcast', { channel: 'local', sender: 'SAQUEO', text: `${p.name} despojó el ${w.name} (+${w.ore} menas, +${w.credits} ISK).` });
      universe.sectors.nullsec.wrecks.splice(idx, 1);
    }
  });

  socket.on('repair', () => {
    const p = universe.players[socket.id];
    if (p && p.sector === 'station' && p.wallet >= 50) {
      p.wallet -= 50;
      p.armor = 100;
      p.shield = 100;
      socket.emit('chat_broadcast', { channel: 'local', sender: 'HANGAR', text: "Reparación completa." });
    }
  });

  socket.on('disconnect', () => {
    delete universe.players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor MMO con mercado libre corriendo en puerto ${PORT}`);
});
