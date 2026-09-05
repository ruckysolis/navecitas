const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI || "PEGA_AQUI_TU_ENLACE_DE_MONGODB_ATLAS";

mongoose.connect(MONGO_URI)
  .then(() => console.log(">>> [BD EN LA NUBE]: Conexión exitosa a MongoDB Atlas <<<"))
  .catch(err => console.error("Error al conectar a MongoDB:", err.message));

// Catálogo de Naves
const SHIP_TYPES = {
  'frigate': { name: "Fragata 'Rifter'", cargoMax: 30, baseArmor: 100, dmgBonus: 0, cost: 0 },
  'freighter': { name: "Carguero Pesado 'Mammoth'", cargoMax: 250, baseArmor: 180, dmgBonus: -10, cost: 500 },
  'cruiser': { name: "Crucero de Asalto 'Cerberus'", cargoMax: 60, baseArmor: 150, dmgBonus: 20, cost: 1200 }
};

const PilotSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  corp: { type: String, default: "Sin Corp" },
  wallet: { type: Number, default: 300 },
  ore: { type: Number, default: 10 },
  shipKey: { type: String, default: "frigate" },
  armor: { type: Number, default: 100 },
  shield: { type: Number, default: 100 },
  skills: {
    gunnery: { type: Number, default: 0 },
    armor_upgrade: { type: Number, default: 0 },
    mining_efficiency: { type: Number, default: 0 }
  },
  training: {
    skillKey: String,
    skillName: String,
    targetLevel: Number,
    finishAt: Number
  },
  activeMission: { type: String, default: null }
});

const MarketOrderSchema = new mongoose.Schema({
  orderId: Number,
  stationId: String, // 'station' o 'outpost'
  seller: String,
  corp: String,
  amount: Number,
  pricePerUnit: Number
});

const Pilot = mongoose.model('Pilot', PilotSchema);
const MarketOrder = mongoose.model('MarketOrder', MarketOrderSchema);

const SKILL_DEFS = {
  'gunnery': { name: "Balística Espacial", desc: "+10% daño por nivel", baseTimeSec: 30, maxLevel: 5 },
  'armor_upgrade': { name: "Gestión de Blindaje", desc: "+15 HP casco por nivel", baseTimeSec: 40, maxLevel: 5 },
  'mining_efficiency': { name: "Extracción Minera", desc: "+2 m³ mineral por nivel", baseTimeSec: 25, maxLevel: 5 }
};

const universe = {
  players: {},
  sectors: {
    'station': { name: "Estación Central Jita", type: "station", npcBuyPrice: 20 },
    'mining': { name: "Cinturón Veldspar-4", type: "mining", asteroidHp: 100 },
    'nullsec': { 
      name: "Sector Abisal X-99 (Punto de Salto Crítico)", 
      type: "combat", 
      timer: 20, 
      round: 1, 
      wrecks: [],
      sovereignty: { ownerCorp: "Ninguna", progress: 0 }
    },
    'outpost': { name: "Outpost 73 (Frontera Outer Ring)", type: "station", npcBuyPrice: 55 }
  }
};

let cachedMarket = [];

async function refreshMarketCache() {
  try {
    cachedMarket = await MarketOrder.find({});
  } catch (e) {
    console.error("Error al refrescar mercado:", e.message);
  }
}
refreshMarketCache();

async function syncPilotToCloud(p) {
  if (!p || !p.name) return;
  try {
    await Pilot.findOneAndUpdate(
      { name: p.name },
      {
        corp: p.corp,
        wallet: p.wallet,
        ore: p.ore,
        shipKey: p.shipKey,
        armor: p.armor,
        shield: p.shield,
        skills: p.skills,
        training: p.training,
        activeMission: p.activeMission
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("Error sincronizando piloto:", err.message);
  }
}

// Bucle maestro del servidor
setInterval(async () => {
  const now = Date.now();

  // 1. Entrenamiento de habilidades
  for (let id in universe.players) {
    const p = universe.players[id];
    if (p.training && now >= p.training.finishAt) {
      const skKey = p.training.skillKey;
      p.skills = p.skills || { gunnery: 0, armor_upgrade: 0, mining_efficiency: 0 };
      p.skills[skKey] = (p.skills[skKey] || 0) + 1;
      const skName = SKILL_DEFS[skKey]?.name || skKey;
      const newLvl = p.skills[skKey];
      p.training = null;

      const shipBase = SHIP_TYPES[p.shipKey]?.baseArmor || 100;
      p.maxArmor = shipBase + (p.skills.armor_upgrade * 15);
      syncPilotToCloud(p);

      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        sock.emit('chat_broadcast', {
          channel: 'local',
          sender: 'NEURO-ENLACE',
          text: `¡Entrenamiento completado! [${skName} Nivel ${newLvl}].`
        });
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

  // 3. Persistencia
  for (let id in universe.players) {
    syncPilotToCloud(universe.players[id]);
  }

  io.emit('universe_tick', {
    sectors: universe.sectors,
    players: universe.players,
    market: cachedMarket,
    shipCatalog: SHIP_TYPES
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
      let shipBonus = SHIP_TYPES[attacker.shipKey]?.dmgBonus || 0;
      let baseDmg = target.order === 'defense' ? 15 : 35;
      let skillBonus = 1 + ((attacker.skills?.gunnery || 0) * 0.10);
      let totalDmg = Math.max(5, Math.round((baseDmg + shipBonus) * skillBonus));

      applyDamage(target, totalDmg);
      logs.push(`[${attacker.corp}] ${attacker.name} abrió fuego sobre [${target.corp}] ${target.name} (-${totalDmg} daño).`);

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
    name: `Pecio de [${victim.corp}] ${victim.name} (${SHIP_TYPES[victim.shipKey]?.name || 'Nave'})`,
    ore: victim.ore,
    credits: 200
  });

  io.emit('chat_broadcast', {
    channel: 'galaxy',
    sender: 'BAJA CONFIRMADA',
    text: `Flota de [${killer.corp}] pulverizó a [${victim.corp}] ${victim.name}. Toda su carga quedó en el pecio.`
  });

  victim.ore = 0;
  victim.shipKey = 'frigate'; // Regresa en la fragata básica
  victim.sector = 'station';
  victim.armor = 30;
  victim.shield = 0;
  victim.order = 'none';
  syncPilotToCloud(victim);

  const victimSocket = io.sockets.sockets.get(victim.id);
  if (victimSocket) {
    victimSocket.leave('nullsec');
    victimSocket.join('station');
    victimSocket.emit('ship_destroyed', "Tu nave y cargamento fueron aniquilados. Cápsula de escape transferida a Jita.");
  }
}

io.on('connection', (socket) => {
  socket.on('pilot_login', async (pilotName) => {
    const cleanName = pilotName.trim().substring(0, 14) || `Cmdr_${socket.id.substring(0, 4)}`;

    try {
      let saved = await Pilot.findOne({ name: cleanName });
      if (!saved) {
        saved = await Pilot.create({
          name: cleanName,
          corp: "Sin Corp",
          wallet: 300,
          ore: 10,
          shipKey: 'frigate',
          armor: 100,
          shield: 100
        });
      }

      const ship = SHIP_TYPES[saved.shipKey] || SHIP_TYPES.frigate;
      const maxArmorCalc = ship.baseArmor + ((saved.skills?.armor_upgrade || 0) * 15);

      universe.players[socket.id] = {
        id: socket.id,
        name: saved.name,
        corp: saved.corp || "Sin Corp",
        sector: 'station',
        shipKey: saved.shipKey || 'frigate',
        shield: saved.shield,
        armor: saved.armor,
        maxArmor: maxArmorCalc,
        cargoMax: ship.cargoMax,
        cap: 100,
        ore: saved.ore,
        wallet: saved.wallet,
        skills: saved.skills || { gunnery: 0, armor_upgrade: 0, mining_efficiency: 0 },
        training: saved.training || null,
        order: 'none'
      };

      socket.join('station');
      socket.emit('login_success', universe.players[socket.id]);
      io.emit('chat_broadcast', { channel: 'galaxy', sender: 'RED', text: `${saved.name} [${saved.corp}] ha entrado al universo.` });
    } catch (e) {
      console.error("Error en pilot_login:", e.message);
    }
  });

  // Comprar o cambiar de Nave en Astillero
  socket.on('purchase_ship', async (shipKey) => {
    const p = universe.players[socket.id];
    if (!p || (p.sector !== 'station' && p.sector !== 'outpost')) return;

    const ship = SHIP_TYPES[shipKey];
    if (!ship || p.wallet < ship.cost) return;

    p.wallet -= ship.cost;
    p.shipKey = shipKey;
    p.cargoMax = ship.cargoMax;
    p.maxArmor = ship.baseArmor + ((p.skills?.armor_upgrade || 0) * 15);
    p.armor = p.maxArmor;
    p.shield = 100;
    syncPilotToCloud(p);

    socket.emit('chat_broadcast', {
      channel: 'local',
      sender: 'ASTILLERO',
      text: `Adquisición autorizada: has abordado tu nueva [${ship.name}]. Capacidad de bodega: ${ship.cargoMax} m³.`
    });
  });

  // Venta directa a la estación local (Comercio Regional Asimétrico)
  socket.on('sell_ore_station', () => {
    const p = universe.players[socket.id];
    if (!p || (p.sector !== 'station' && p.sector !== 'outpost')) return;
    if (p.ore <= 0) return;

    const rate = universe.sectors[p.sector].npcBuyPrice;
    const earned = p.ore * rate;

    p.wallet += earned;
    socket.emit('chat_broadcast', {
      channel: 'local',
      sender: 'LOGÍSTICA',
      text: `Vendidos ${p.ore} m³ de mena a la estación (${rate} ISK/u). Total: +${earned} ISK.`
    });
    p.ore = 0;
    syncPilotToCloud(p);
  });

  // Reglas de Navegación por Stargates
  socket.on('warp_to', (destination) => {
    const p = universe.players[socket.id];
    if (!p || p.sector === destination) return;

    // Conexiones de ruta:
    // Station <-> Mining
    // Station <-> Nullsec
    // Nullsec <-> Outpost (Outpost solo es accesible pasando por Nullsec)
    const validJumps = {
      'station': ['mining', 'nullsec'],
      'mining': ['station'],
      'nullsec': ['station', 'outpost'],
      'outpost': ['nullsec']
    };

    if (!validJumps[p.sector]?.includes(destination)) {
      socket.emit('chat_broadcast', {
        channel: 'local',
        sender: 'NAVEGACIÓN',
        text: `Ruta directa no disponible. Debes saltar a través de las puertas intermedias.`
      });
      return;
    }

    socket.leave(p.sector);
    p.sector = destination;
    socket.join(destination);
    p.order = 'none';
  });

  socket.on('mine_cycle', () => {
    const p = universe.players[socket.id];
    if (p && p.sector === 'mining') {
      const shipCap = p.cargoMax || 30;
      if (p.ore >= shipCap) {
        socket.emit('chat_broadcast', { channel: 'local', sender: 'BODEGA', text: "¡Bodega llena! Vuelve a una estación para descargar o comerciar." });
        return;
      }
      const miningLvl = p.skills?.mining_efficiency || 0;
      const extracted = Math.min(shipCap - p.ore, 5 + (miningLvl * 2));
      p.ore += extracted;
      universe.sectors.mining.asteroidHp = Math.max(0, universe.sectors.mining.asteroidHp - 10);
      if (universe.sectors.mining.asteroidHp <= 0) universe.sectors.mining.asteroidHp = 100;
    }
  });

  socket.on('train_skill', (skillKey) => {
    const p = universe.players[socket.id];
    if (!p || !SKILL_DEFS[skillKey] || p.training) return;
    const curLvl = p.skills[skillKey] || 0;
    if (curLvl >= SKILL_DEFS[skillKey].maxLevel) return;

    const nextLvl = curLvl + 1;
    const trainSec = SKILL_DEFS[skillKey].baseTimeSec * nextLvl;
    p.training = {
      skillKey: skillKey,
      skillName: SKILL_DEFS[skillKey].name,
      targetLevel: nextLvl,
      finishAt: Date.now() + (trainSec * 1000)
    };
    syncPilotToCloud(p);
  });

  socket.on('set_order', (order) => {
    if (universe.players[socket.id]) {
      universe.players[socket.id].order = order;
      socket.emit('order_ack', order);
    }
  });

  socket.on('set_corp', (corpTag) => {
    const p = universe.players[socket.id];
    if (!p) return;
    p.corp = corpTag.trim().toUpperCase().substring(0, 5) || "CORP";
    syncPilotToCloud(p);
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
        io.emit('chat_broadcast', { channel: 'galaxy', sender: 'SOBERANÍA', text: `¡[${p.corp}] domina el paso de Nullsec!` });
      }
    }
  });

  socket.on('loot_wreck', (wreckId) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'nullsec') return;
    const idx = universe.sectors.nullsec.wrecks.findIndex(w => w.id === wreckId);
    if (idx !== -1) {
      const w = universe.sectors.nullsec.wrecks[idx];
      const spaceLeft = (p.cargoMax || 30) - p.ore;
      const takenOre = Math.min(spaceLeft, w.ore);
      p.ore += takenOre;
      p.wallet += w.credits;
      syncPilotToCloud(p);
      universe.sectors.nullsec.wrecks.splice(idx, 1);
    }
  });

  socket.on('repair', () => {
    const p = universe.players[socket.id];
    if (p && (p.sector === 'station' || p.sector === 'outpost') && p.wallet >= 50) {
      p.wallet -= 50;
      p.armor = p.maxArmor;
      p.shield = 100;
      syncPilotToCloud(p);
      socket.emit('chat_broadcast', { channel: 'local', sender: 'HANGAR', text: "Casco y escudos restablecidos." });
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

  socket.on('disconnect', async () => {
    const p = universe.players[socket.id];
    if (p) {
      await syncPilotToCloud(p);
      delete universe.players[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor MMO de Comercio y Carga corriendo en puerto ${PORT}`);
});
