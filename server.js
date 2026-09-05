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

// Catálogo de planos industriales disponibles en la estación
const BLUEPRINTS = {
  'laser_t2': {
    name: "Láser de Pulso T2",
    type: 'module',
    oreCost: 25,
    fee: 100,
    buildTimeSec: 30, // 30 segundos
    statDesc: "+20 daño primario"
  },
  'heavy_cruiser': {
    name: "Crucero de Asalto 'Cerberus'",
    type: 'ship',
    oreCost: 60,
    fee: 300,
    buildTimeSec: 60, // 60 segundos
    statDesc: "+50% blindaje base (150 HP)"
  }
};

function loadDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ pilots: {}, market: [], industryJobs: [] }));
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      pilots: data.pilots || data,
      market: data.market || [],
      industryJobs: data.industryJobs || []
    };
  } catch (e) {
    return { pilots: {}, market: [], industryJobs: [] };
  }
}

function saveDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let dbData = loadDatabase();
let dbPilots = dbData.pilots;
let marketOrders = dbData.market;
let industryJobs = dbData.industryJobs; // Trabajos de construcción activos

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

  // Comprobar finalización de trabajos industriales
  const now = Date.now();
  industryJobs.forEach(job => {
    if (!job.completed && now >= job.completesAt) {
      job.completed = true;
      const pilotSocket = Object.values(universe.players).find(p => p.name === job.pilot);
      if (pilotSocket) {
        const sock = io.sockets.sockets.get(pilotSocket.id);
        if (sock) {
          sock.emit('chat_broadcast', {
            channel: 'local',
            sender: 'INDUSTRIA',
            text: `¡Trabajo finalizado! Tu [${job.blueprintName}] está listo para entrega en el Hangar.`
          });
        }
      }
    }
  });

  // Guardar datos persistentes
  for (let id in universe.players) {
    const p = universe.players[id];
    if (dbPilots[p.name]) {
      dbPilots[p.name].wallet = p.wallet;
      dbPilots[p.name].ore = p.ore;
      dbPilots[p.name].armor = p.armor;
      dbPilots[p.name].shield = p.shield;
      dbPilots[p.name].corp = p.corp;
      dbPilots[p.name].maxArmor = p.maxArmor || 100;
      dbPilots[p.name].weaponBonus = p.weaponBonus || 0;
    }
  }
  saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });

  io.emit('universe_tick', {
    sectors: universe.sectors,
    players: universe.players,
    market: marketOrders,
    industryJobs: industryJobs
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
      let baseDmg = target.order === 'defense' ? 15 : 35;
      let dmg = baseDmg + (attacker.weaponBonus || 0);
      applyDamage(target, dmg);
      logs.push(`[${attacker.corp}] ${attacker.name} abrió fuego sobre [${target.corp}] ${target.name} (-${dmg} daño).`);

      if (target.armor <= 0) {
        handleDestruction(target, attacker);
      }
    } else if (attacker.order === 'defense' && attacker.cap >= 20) {
      attacker.cap -= 20;
      attacker.shield = Math.min(100, attacker.shield + 20);
      logs.push(`${attacker.name} regeneró escudos.`);
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
    text: `Flota de [${killer.corp}] aniquiló la nave de [${victim.corp}] ${victim.name} en Nullsec.`
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
    victimSocket.emit('ship_destroyed', "Nave pulverizada. Cápsula de escape transferida a la Estación.");
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
        maxArmor: 100,
        shield: 100,
        weaponBonus: 0
      };
      saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
    }

    const saved = dbPilots[cleanName];

    universe.players[socket.id] = {
      id: socket.id,
      name: saved.name,
      corp: saved.corp || "Sin Corp",
      sector: 'station',
      shield: saved.shield,
      armor: saved.armor,
      maxArmor: saved.maxArmor || 100,
      cap: 100,
      ore: saved.ore,
      wallet: saved.wallet,
      weaponBonus: saved.weaponBonus || 0,
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
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
    io.emit('chat_broadcast', { channel: 'galaxy', sender: 'REGISTRO', text: `${p.name} ahora vuela para [${tag}].` });
  });

  // --- INDUSTRIA: INICIAR TRABAJO ---
  socket.on('start_industry_job', (bpKey) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;

    const bp = BLUEPRINTS[bpKey];
    if (!bp) return;

    if (p.wallet < bp.fee) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'INDUSTRIA', text: `Créditos insuficientes para la tasa de ensamblaje (${bp.fee} ISK).` });
      return;
    }
    if (p.ore < bp.oreCost) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'INDUSTRIA', text: `Mineral insuficiente en bodega (${p.ore}/${bp.oreCost} m³).` });
      return;
    }

    // Cobrar tasa y materiales
    p.wallet -= bp.fee;
    p.ore -= bp.oreCost;

    const job = {
      id: Date.now(),
      pilot: p.name,
      bpKey: bpKey,
      blueprintName: bp.name,
      completesAt: Date.now() + (bp.buildTimeSec * 1000),
      completed: false
    };

    industryJobs.push(job);
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });

    socket.emit('chat_broadcast', {
      channel: 'local',
      sender: 'INDUSTRIA',
      text: `Trabajo de manufactura iniciado: [${bp.name}]. Tiempo estimado: ${bp.buildTimeSec}s.`
    });
  });

  // --- INDUSTRIA: ENTREGAR TRABAJO TERMINADO ---
  socket.on('claim_industry_job', (jobId) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;

    const idx = industryJobs.findIndex(j => j.id === jobId && j.pilot === p.name && j.completed);
    if (idx === -1) return;

    const job = industryJobs[idx];
    const bp = BLUEPRINTS[job.bpKey];

    if (bp.type === 'module') {
      p.weaponBonus = Math.max(p.weaponBonus, 20);
      socket.emit('chat_broadcast', { channel: 'local', sender: 'INDUSTRIA', text: `¡[${bp.name}] equipado con éxito! (+20 daño primario permanente).` });
    } else if (bp.type === 'ship') {
      p.maxArmor = 150;
      p.armor = 150;
      socket.emit('chat_broadcast', { channel: 'local', sender: 'INDUSTRIA', text: `¡Nave entregada! Has abordado el [${bp.name}] (Blindaje ampliado a 150 HP).` });
    }

    industryJobs.splice(idx, 1);
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
  });

  // Mercado libre
  socket.on('create_sell_order', ({ amount, pricePerUnit }) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;

    amount = parseInt(amount);
    pricePerUnit = parseInt(pricePerUnit);

    if (isNaN(amount) || amount <= 0 || isNaN(pricePerUnit) || pricePerUnit <= 0) return;
    if (p.ore < amount) return;

    p.ore -= amount;
    const order = {
      id: Date.now(),
      seller: p.name,
      corp: p.corp,
      amount: amount,
      pricePerUnit: pricePerUnit
    };
    marketOrders.push(order);
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });

    io.emit('chat_broadcast', {
      channel: 'galaxy',
      sender: 'MERCADO',
      text: `OFERTA: ${p.name} puso a la venta ${amount} m³ de mena a ${pricePerUnit} ISK/u.`
    });
  });

  socket.on('buy_market_order', (orderId) => {
    const buyer = universe.players[socket.id];
    if (!buyer || buyer.sector !== 'station') return;

    const idx = marketOrders.findIndex(o => o.id === orderId);
    if (idx === -1) return;

    const order = marketOrders[idx];
    const totalCost = order.amount * order.pricePerUnit;

    if (buyer.wallet < totalCost) return;

    buyer.wallet -= totalCost;
    buyer.ore += order.amount;

    let tax = 0;
    const sovOwner = universe.sectors.nullsec.sovereignty.ownerCorp;
    if (sovOwner !== "Ninguna") tax = Math.round(totalCost * 0.05);
    const net = totalCost - tax;

    if (dbPilots[order.seller]) dbPilots[order.seller].wallet += net;
    const sellerOnline = Object.values(universe.players).find(p => p.name === order.seller);
    if (sellerOnline) sellerOnline.wallet += net;

    if (tax > 0) {
      Object.values(universe.players).forEach(p => {
        if (p.corp === sovOwner) p.wallet += tax;
      });
    }

    marketOrders.splice(idx, 1);
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });

    io.emit('chat_broadcast', {
      channel: 'galaxy',
      sender: 'MERCADO',
      text: `${buyer.name} compró el lote de ${order.seller} (${order.amount} m³ por ${totalCost} ISK).`
    });
  });

  socket.on('cancel_market_order', (orderId) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;

    const idx = marketOrders.findIndex(o => o.id === orderId && o.seller === p.name);
    if (idx !== -1) {
      p.ore += marketOrders[idx].amount;
      marketOrders.splice(idx, 1);
      saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
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
        io.emit('chat_broadcast', { channel: 'galaxy', sender: 'SOBERANÍA', text: `¡[${p.corp}] conquistó Nullsec! Recibirá 5% de impuestos de todo el mercado.` });
      } else {
        io.to('nullsec').emit('chat_broadcast', { channel: 'local', sender: 'BALIZA', text: `[${p.corp}] capturando baliza (${sov.progress}%)...` });
      }
    }
  });

  socket.on('send_chat', ({ channel, text }) => {
    const p = universe.players[socket.id];
    if (!p || !text.trim()) return;
    const room = channel === 'galaxy' ? null : p.sector;
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
      p.armor = p.maxArmor || 100;
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
  console.log(`Servidor MMO con Industria activa en puerto ${PORT}`);
});
