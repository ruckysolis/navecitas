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

// Catálogo de habilidades y tiempos base (en segundos) por nivel
const SKILL_DEFS = {
  'gunnery': {
    name: "Balística Espacial",
    desc: "+10% daño en combate por nivel",
    baseTimeSec: 30, // N1: 30s, N2: 60s, N3: 120s...
    maxLevel: 5
  },
  'armor_upgrade': {
    name: "Gestión de Blindaje",
    desc: "+15 HP de casco máximo por nivel",
    baseTimeSec: 40,
    maxLevel: 5
  },
  'mining_efficiency': {
    name: "Extracción Minera",
    desc: "+2 m³ de mineral extra por ciclo por nivel",
    baseTimeSec: 25,
    maxLevel: 5
  }
};

const BLUEPRINTS = {
  'laser_t2': { name: "Láser de Pulso T2", type: 'module', oreCost: 25, fee: 100, buildTimeSec: 30 },
  'heavy_cruiser': { name: "Crucero de Asalto 'Cerberus'", type: 'ship', oreCost: 60, fee: 300, buildTimeSec: 60 }
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
let industryJobs = dbData.industryJobs;

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

// Bucle maestro del servidor (1 segundo)
setInterval(() => {
  const now = Date.now();

  // 1. Manejo del Árbol de Habilidades en tiempo real para cada piloto guardado
  for (let pilotName in dbPilots) {
    const pData = dbPilots[pilotName];
    if (pData.training && pData.training.skillKey) {
      if (now >= pData.training.finishAt) {
        const skillKey = pData.training.skillKey;
        pData.skills = pData.skills || { gunnery: 0, armor_upgrade: 0, mining_efficiency: 0 };
        pData.skills[skillKey] = (pData.skills[skillKey] || 0) + 1;

        const learnedName = SKILL_DEFS[skillKey].name;
        const newLvl = pData.skills[skillKey];
        pData.training = null; // Entrenamiento completado

        // Notificar si el piloto está conectado
        const connectedPlayer = Object.values(universe.players).find(p => p.name === pilotName);
        if (connectedPlayer) {
          connectedPlayer.skills = pData.skills;
          connectedPlayer.training = null;
          // Re-calcular bonos
          connectedPlayer.maxArmor = (connectedPlayer.baseMaxArmor || 100) + (connectedPlayer.skills.armor_upgrade * 15);
          const sock = io.sockets.sockets.get(connectedPlayer.id);
          if (sock) {
            sock.emit('chat_broadcast', {
              channel: 'local',
              sender: 'NEURO-ENLACE',
              text: `¡Entrenamiento completado! Has alcanzado [${learnedName} Nivel ${newLvl}].`
            });
          }
        }
      }
    }
  }

  // 2. Combate en Nullsec
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

  // 3. Industria
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
            text: `¡Trabajo completado! [${job.blueprintName}] listo en hangar.`
          });
        }
      }
    }
  });

  // 4. Sincronización persistente
  for (let id in universe.players) {
    const p = universe.players[id];
    if (dbPilots[p.name]) {
      dbPilots[p.name].wallet = p.wallet;
      dbPilots[p.name].ore = p.ore;
      dbPilots[p.name].armor = p.armor;
      dbPilots[p.name].shield = p.shield;
      dbPilots[p.name].corp = p.corp;
      dbPilots[p.name].baseMaxArmor = p.baseMaxArmor || 100;
      dbPilots[p.name].maxArmor = p.maxArmor;
      dbPilots[p.name].weaponBonus = p.weaponBonus || 0;
      dbPilots[p.name].skills = p.skills;
      dbPilots[p.name].training = p.training;
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
      let skillBonus = 1 + ((attacker.skills?.gunnery || 0) * 0.10); // +10% por nivel
      let rawDmg = (baseDmg + (attacker.weaponBonus || 0)) * skillBonus;
      let totalDmg = Math.round(rawDmg);

      applyDamage(target, totalDmg);
      logs.push(`[${attacker.corp}] ${attacker.name} impactó a [${target.corp}] ${target.name} (-${totalDmg} daño con Gunnery Lvl ${attacker.skills?.gunnery || 0}).`);

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
    text: `Flota de [${killer.corp}] destruyó a [${victim.corp}] ${victim.name} en Nullsec.`
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
    victimSocket.emit('ship_destroyed', "Tu nave fue destruida. Cápsula eyectada a la Estación.");
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
        baseMaxArmor: 100,
        maxArmor: 100,
        shield: 100,
        weaponBonus: 0,
        skills: { gunnery: 0, armor_upgrade: 0, mining_efficiency: 0 },
        training: null
      };
      saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
    }

    const saved = dbPilots[cleanName];
    saved.skills = saved.skills || { gunnery: 0, armor_upgrade: 0, mining_efficiency: 0 };

    const maxArmorCalculated = (saved.baseMaxArmor || 100) + (saved.skills.armor_upgrade * 15);

    universe.players[socket.id] = {
      id: socket.id,
      name: saved.name,
      corp: saved.corp || "Sin Corp",
      sector: 'station',
      shield: saved.shield,
      armor: saved.armor,
      baseMaxArmor: saved.baseMaxArmor || 100,
      maxArmor: maxArmorCalculated,
      cap: 100,
      ore: saved.ore,
      wallet: saved.wallet,
      weaponBonus: saved.weaponBonus || 0,
      skills: saved.skills,
      training: saved.training || null,
      order: 'none'
    };

    socket.join('station');
    socket.emit('login_success', universe.players[socket.id]);
    io.emit('chat_broadcast', { channel: 'galaxy', sender: 'RED', text: `${saved.name} [${saved.corp}] conectado.` });
  });

  // --- INICIAR ENTRENAMIENTO DE HABILIDAD ---
  socket.on('train_skill', (skillKey) => {
    const p = universe.players[socket.id];
    if (!p || !SKILL_DEFS[skillKey]) return;

    if (p.training) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'NEURO-ENLACE', text: "Ya tienes una habilidad en entrenamiento en tu cola neural." });
      return;
    }

    const currentLvl = p.skills[skillKey] || 0;
    if (currentLvl >= SKILL_DEFS[skillKey].maxLevel) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'NEURO-ENLACE', text: "Habilidad al nivel máximo (V)." });
      return;
    }

    const nextLvl = currentLvl + 1;
    const trainSeconds = SKILL_DEFS[skillKey].baseTimeSec * nextLvl;
    const finishAt = Date.now() + (trainSeconds * 1000);

    p.training = {
      skillKey: skillKey,
      skillName: SKILL_DEFS[skillKey].name,
      targetLevel: nextLvl,
      finishAt: finishAt
    };

    dbPilots[p.name].training = p.training;
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });

    socket.emit('chat_broadcast', {
      channel: 'local',
      sender: 'NEURO-ENLACE',
      text: `Iniciado entrenamiento de [${SKILL_DEFS[skillKey].name} Nivel ${nextLvl}]. Tiempo requerido: ${trainSeconds}s.`
    });
  });

  // Minería con bono de habilidad
  socket.on('mine_cycle', () => {
    const p = universe.players[socket.id];
    if (p && p.sector === 'mining') {
      const miningLvl = p.skills?.mining_efficiency || 0;
      const extracted = 5 + (miningLvl * 2); // 5 base + 2 por nivel

      p.ore += extracted;
      universe.sectors.mining.asteroidHp = Math.max(0, universe.sectors.mining.asteroidHp - 10);
      if (universe.sectors.mining.asteroidHp <= 0) {
        universe.sectors.mining.asteroidHp = 100;
        io.to('mining').emit('chat_broadcast', { channel: 'local', sender: 'TELEMETRÍA', text: "Asteroide fracturado. Enfocando nueva roca." });
      }
    }
  });

  socket.on('start_industry_job', (bpKey) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;
    const bp = BLUEPRINTS[bpKey];
    if (!bp || p.wallet < bp.fee || p.ore < bp.oreCost) return;

    p.wallet -= bp.fee;
    p.ore -= bp.oreCost;

    industryJobs.push({
      id: Date.now(),
      pilot: p.name,
      bpKey: bpKey,
      blueprintName: bp.name,
      completesAt: Date.now() + (bp.buildTimeSec * 1000),
      completed: false
    });
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
  });

  socket.on('claim_industry_job', (jobId) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;
    const idx = industryJobs.findIndex(j => j.id === jobId && j.pilot === p.name && j.completed);
    if (idx === -1) return;

    const bp = BLUEPRINTS[industryJobs[idx].bpKey];
    if (bp.type === 'module') {
      p.weaponBonus = Math.max(p.weaponBonus, 20);
    } else if (bp.type === 'ship') {
      p.baseMaxArmor = 150;
      p.maxArmor = 150 + ((p.skills?.armor_upgrade || 0) * 15);
      p.armor = p.maxArmor;
    }
    industryJobs.splice(idx, 1);
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
  });

  socket.on('create_sell_order', ({ amount, pricePerUnit }) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;
    amount = parseInt(amount);
    pricePerUnit = parseInt(pricePerUnit);
    if (isNaN(amount) || amount <= 0 || isNaN(pricePerUnit) || pricePerUnit <= 0 || p.ore < amount) return;

    p.ore -= amount;
    marketOrders.push({
      id: Date.now(),
      seller: p.name,
      corp: p.corp,
      amount: amount,
      pricePerUnit: pricePerUnit
    });
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
  });

  socket.on('buy_market_order', (orderId) => {
    const buyer = universe.players[socket.id];
    if (!buyer || buyer.sector !== 'station') return;
    const idx = marketOrders.findIndex(o => o.id === orderId);
    if (idx === -1) return;

    const order = marketOrders[idx];
    const total = order.amount * order.pricePerUnit;
    if (buyer.wallet < total) return;

    buyer.wallet -= total;
    buyer.ore += order.amount;

    let tax = universe.sectors.nullsec.sovereignty.ownerCorp !== "Ninguna" ? Math.round(total * 0.05) : 0;
    let net = total - tax;

    if (dbPilots[order.seller]) dbPilots[order.seller].wallet += net;
    const sellerOnline = Object.values(universe.players).find(p => p.name === order.seller);
    if (sellerOnline) sellerOnline.wallet += net;

    marketOrders.splice(idx, 1);
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
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

  socket.on('set_corp', (corpTag) => {
    const p = universe.players[socket.id];
    if (!p) return;
    const tag = corpTag.trim().toUpperCase().substring(0, 5) || "CORP";
    p.corp = tag;
    dbPilots[p.name].corp = tag;
    saveDatabase({ pilots: dbPilots, market: marketOrders, industryJobs: industryJobs });
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
        io.emit('chat_broadcast', { channel: 'galaxy', sender: 'SOBERANÍA', text: `¡[${p.corp}] conquistó Nullsec!` });
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

  socket.on('loot_wreck', (wreckId) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'nullsec') return;
    const idx = universe.sectors.nullsec.wrecks.findIndex(w => w.id === wreckId);
    if (idx !== -1) {
      const w = universe.sectors.nullsec.wrecks[idx];
      p.ore += w.ore;
      p.wallet += w.credits;
      universe.sectors.nullsec.wrecks.splice(idx, 1);
    }
  });

  socket.on('repair', () => {
    const p = universe.players[socket.id];
    if (p && p.sector === 'station' && p.wallet >= 50) {
      p.wallet -= 50;
      p.armor = p.maxArmor;
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
  console.log(`Servidor MMO con Habilidades en tiempo real corriendo en puerto ${PORT}`);
});
