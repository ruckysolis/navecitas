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

// Catálogos globales
const SHIP_TYPES = {
  'frigate': { name: "Fragata 'Rifter'", cargoMax: 30, baseArmor: 100, dmgBonus: 0, cost: 0 },
  'freighter': { name: "Carguero Pesado 'Mammoth'", cargoMax: 250, baseArmor: 180, dmgBonus: -10, cost: 500 },
  'cruiser': { name: "Crucero de Asalto 'Cerberus'", cargoMax: 60, baseArmor: 150, dmgBonus: 20, cost: 1200 }
};

const SKILL_DEFS = {
  'gunnery': { name: "Balística Espacial", desc: "+10% daño por nivel", baseTimeSec: 30, maxLevel: 5 },
  'armor_upgrade': { name: "Gestión de Blindaje", desc: "+15 HP casco por nivel", baseTimeSec: 40, maxLevel: 5 },
  'mining_efficiency': { name: "Extracción Minera", desc: "+2 m³ menas por nivel", baseTimeSec: 25, maxLevel: 5 }
};

const BLUEPRINTS = {
  'laser_t2': { name: "Láser de Pulso T2", type: 'module', oreCost: 25, fee: 100, buildTimeSec: 30 },
  'heavy_cruiser': { name: "Crucero de Asalto 'Cerberus'", type: 'ship', oreCost: 60, fee: 300, buildTimeSec: 60 }
};

const MISSIONS_CATALOG = {
  'pirate_scout': { id: 'pirate_scout', title: "Caza: Explorador Pirata", targetName: "Fragata Corsaria 'Bloodhound'", hp: 80, dmg: 18, bounty: 150, lootOre: 10 },
  'pirate_commander': { id: 'pirate_commander', title: "Caza Mayor: Comandante", targetName: "Crucero Pirata 'Vindicator'", hp: 160, dmg: 28, bounty: 450, lootOre: 30 }
};

// Esquemas de MongoDB
const PilotSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  corp: { type: String, default: "Sin Corp" },
  wallet: { type: Number, default: 300 },
  ore: { type: Number, default: 10 },
  shipKey: { type: String, default: "frigate" },
  armor: { type: Number, default: 100 },
  shield: { type: Number, default: 100 },
  weaponBonus: { type: Number, default: 0 },
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
  seller: String,
  corp: String,
  amount: Number,
  pricePerUnit: Number
});

const IndustryJobSchema = new mongoose.Schema({
  jobId: Number,
  pilot: String,
  bpKey: String,
  blueprintName: String,
  completesAt: Number,
  completed: { type: Boolean, default: false }
});

const Pilot = mongoose.model('Pilot', PilotSchema);
const MarketOrder = mongoose.model('MarketOrder', MarketOrderSchema);
const IndustryJob = mongoose.model('IndustryJob', IndustryJobSchema);

const universe = {
  players: {},
  sectors: {
    'station': { name: "Estación Central Jita", type: "station", npcBuyPrice: 20 },
    'mining': { name: "Cinturón Veldspar-4", type: "mining", asteroidHp: 100 },
    'nullsec': { 
      name: "Sector Abisal X-99 (Punto Crítico)", 
      type: "combat", 
      timer: 20, 
      round: 1, 
      wrecks: [],
      sovereignty: { ownerCorp: "Ninguna", progress: 0 }
    },
    'outpost': { name: "Outpost 73 (Frontera Outer Ring)", type: "station", npcBuyPrice: 55 }
  },
  pveEncounters: {}
};

let cachedMarket = [];
let cachedJobs = [];

async function refreshCaches() {
  try {
    cachedMarket = await MarketOrder.find({});
    cachedJobs = await IndustryJob.find({});
  } catch (e) {
    console.error("Error cache BD:", e.message);
  }
}
refreshCaches();

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
        weaponBonus: p.weaponBonus,
        skills: p.skills,
        training: p.training,
        activeMission: p.activeMission
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("Error persistiendo piloto:", err.message);
  }
}

// Bucle maestro (1 segundo)
setInterval(async () => {
  const now = Date.now();

  // 1. Entrenamiento de habilidades en tiempo real
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
        sock.emit('chat_broadcast', { channel: 'local', sender: 'NEURO-ENLACE', text: `¡Entrenamiento completado! [${skName} Nivel ${newLvl}].` });
      }
    }
  }

  // 2. Combate PvP en Nullsec
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

  // 3. Combate PvE por turnos
  for (let pilotName in universe.pveEncounters) {
    const enc = universe.pveEncounters[pilotName];
    const player = Object.values(universe.players).find(p => p.name === pilotName && p.sector === 'pve');
    if (!player) continue;

    enc.timer--;
    if (enc.timer <= 0) {
      resolvePveTurn(player, enc);
      enc.timer = 15;
      enc.round++;
    }
  }

  // 4. Cola de Industria
  cachedJobs.forEach(async (job) => {
    if (!job.completed && now >= job.completesAt) {
      job.completed = true;
      await IndustryJob.updateOne({ jobId: job.jobId }, { completed: true });
      const p = Object.values(universe.players).find(p => p.name === job.pilot);
      if (p) {
        const sock = io.sockets.sockets.get(p.id);
        if (sock) sock.emit('chat_broadcast', { channel: 'local', sender: 'INDUSTRIA', text: `¡[${job.blueprintName}] listo para entrega!` });
      }
    }
  });

  // Guardado periódico
  for (let id in universe.players) {
    syncPilotToCloud(universe.players[id]);
  }

  io.emit('universe_tick', {
    sectors: universe.sectors,
    players: universe.players,
    market: cachedMarket,
    industryJobs: cachedJobs,
    pveEncounters: universe.pveEncounters,
    shipCatalog: SHIP_TYPES
  });
}, 1000);

function resolvePveTurn(player, enc) {
  player.cap = Math.min(100, player.cap + 15);
  let logs = [];

  if (player.order === 'attack' && player.cap >= 25) {
    player.cap -= 25;
    let shipBonus = SHIP_TYPES[player.shipKey]?.dmgBonus || 0;
    let baseDmg = 30 + shipBonus + (player.weaponBonus || 0);
    let skillBonus = 1 + ((player.skills?.gunnery || 0) * 0.10);
    let totalDmg = Math.max(5, Math.round(baseDmg * skillBonus));

    enc.npcArmor = Math.max(0, enc.npcArmor - totalDmg);
    logs.push(`Disparaste salva contra ${enc.targetName} (-${totalDmg} daño).`);
  } else if (player.order === 'defense' && player.cap >= 20) {
    player.cap -= 20;
    player.shield = Math.min(100, player.shield + 25);
    logs.push("Regeneraste escudos (+25%).");
  } else {
    logs.push("Sistemas en reposo.");
  }
  player.order = 'none';

  if (enc.npcArmor <= 0) {
    player.wallet += enc.bounty;
    const spaceLeft = (player.cargoMax || 30) - player.ore;
    const takenOre = Math.min(spaceLeft, enc.lootOre);
    player.ore += takenOre;
    player.activeMission = null;
    delete universe.pveEncounters[player.name];
    player.sector = 'station';
    syncPilotToCloud(player);

    const sock = io.sockets.sockets.get(player.id);
    if (sock) {
      sock.leave('pve');
      sock.join('station');
      sock.emit('chat_broadcast', {
        channel: 'local',
        sender: 'AGENCIA',
        text: `¡OBJETIVO DESTRUIDO! Recompensa cobrada: +${enc.bounty} ISK y +${takenOre} m³ de mineral.`
      });
    }
    return;
  }

  let npcDmg = enc.dmg;
  if (player.order === 'defense') npcDmg = Math.round(npcDmg * 0.6);
  applyDamage(player, npcDmg);
  logs.push(`${enc.targetName} respondió fuego (-${npcDmg} daño).`);

  if (player.armor <= 0) {
    delete universe.pveEncounters[player.name];
    player.activeMission = null;
    player.ore = 0;
    player.sector = 'station';
    player.armor = 25;
    player.shield = 0;
    syncPilotToCloud(player);

    const sock = io.sockets.sockets.get(player.id);
    if (sock) {
      sock.leave('pve');
      sock.join('station');
      sock.emit('ship_destroyed', `Tu nave fue destruida por ${enc.targetName}. Cápsula eyectada a Jita.`);
    }
    return;
  }

  const sock = io.sockets.sockets.get(player.id);
  if (sock) sock.emit('combat_log', logs);
}

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
      let totalDmg = Math.max(5, Math.round((baseDmg + shipBonus + (attacker.weaponBonus || 0)) * skillBonus));

      applyDamage(target, totalDmg);
      logs.push(`[${attacker.corp}] ${attacker.name} impactó a [${target.corp}] ${target.name} (-${totalDmg} daño).`);

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
    name: `Pecio de [${victim.corp}] ${victim.name} (${SHIP_TYPES[victim.shipKey]?.name || 'Nave'})`,
    ore: victim.ore,
    credits: 200
  });

  io.emit('chat_broadcast', {
    channel: 'galaxy',
    sender: 'BAJA CONFIRMADA',
    text: `Flota de [${killer.corp}] destruyó a [${victim.corp}] ${victim.name} en Nullsec.`
  });

  victim.ore = 0;
  victim.shipKey = 'frigate';
  victim.sector = 'station';
  victim.armor = 30;
  victim.shield = 0;
  victim.order = 'none';
  syncPilotToCloud(victim);

  const victimSocket = io.sockets.sockets.get(victim.id);
  if (victimSocket) {
    victimSocket.leave('nullsec');
    victimSocket.join('station');
    victimSocket.emit('ship_destroyed', "Tu nave fue destruida. Cápsula eyectada a la Estación.");
  }
}

// Eventos de red
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
        weaponBonus: saved.weaponBonus || 0,
        skills: saved.skills || { gunnery: 0, armor_upgrade: 0, mining_efficiency: 0 },
        training: saved.training || null,
        activeMission: saved.activeMission || null,
        order: 'none'
      };

      socket.join('station');
      socket.emit('login_success', universe.players[socket.id]);
      io.emit('chat_broadcast', { channel: 'galaxy', sender: 'RED', text: `${saved.name} [${saved.corp}] ha entrado al universo.` });
    } catch (e) {
      console.error("Error login:", e.message);
    }
  });

  // Stargates con navegación restringida
  socket.on('warp_to', (destination) => {
    const p = universe.players[socket.id];
    if (!p || p.sector === destination) return;

    const validJumps = {
      'station': ['mining', 'nullsec'],
      'mining': ['station'],
      'nullsec': ['station', 'outpost'],
      'outpost': ['nullsec'],
      'pve': ['station']
    };

    if (!validJumps[p.sector]?.includes(destination)) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'NAVEGACIÓN', text: `Ruta bloqueada. Debes cruzar por las puertas intermedias.` });
      return;
    }

    socket.leave(p.sector);
    p.sector = destination;
    socket.join(destination);
    p.order = 'none';
  });

  // Astillero
  socket.on('purchase_ship', (shipKey) => {
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

    socket.emit('chat_broadcast', { channel: 'local', sender: 'ASTILLERO', text: `Has abordado tu [${ship.name}]. Bodega: ${ship.cargoMax} m³.` });
  });

  // Comercio Regional Asimétrico
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

  // Misiones PvE
  socket.on('accept_mission', (missionId) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station' || !MISSIONS_CATALOG[missionId]) return;
    p.activeMission = missionId;
    syncPilotToCloud(p);
    socket.emit('chat_broadcast', { channel: 'local', sender: 'AGENCIA', text: `Contrato aceptado: [${MISSIONS_CATALOG[missionId].title}].` });
  });

  socket.on('warp_to_mission', () => {
    const p = universe.players[socket.id];
    if (!p || !p.activeMission) return;
    const mission = MISSIONS_CATALOG[p.activeMission];
    if (!mission) return;

    socket.leave(p.sector);
    p.sector = 'pve';
    socket.join('pve');
    p.order = 'none';

    universe.pveEncounters[p.name] = {
      missionId: mission.id,
      targetName: mission.targetName,
      npcArmor: mission.hp,
      npcMaxArmor: mission.hp,
      dmg: mission.dmg,
      bounty: mission.bounty,
      lootOre: mission.lootOre,
      timer: 15,
      round: 1
    };
  });

  // Mercado Libre entre Jugadores
  socket.on('create_sell_order', async ({ amount, pricePerUnit }) => {
    const p = universe.players[socket.id];
    if (!p || (p.sector !== 'station' && p.sector !== 'outpost')) return;
    amount = parseInt(amount);
    pricePerUnit = parseInt(pricePerUnit);
    if (isNaN(amount) || amount <= 0 || isNaN(pricePerUnit) || pricePerUnit <= 0 || p.ore < amount) return;

    p.ore -= amount;
    syncPilotToCloud(p);

    const order = await MarketOrder.create({
      orderId: Date.now(),
      seller: p.name,
      corp: p.corp,
      amount: amount,
      pricePerUnit: pricePerUnit
    });
    cachedMarket.push(order);
  });

  socket.on('buy_market_order', async (orderId) => {
    const buyer = universe.players[socket.id];
    if (!buyer || (buyer.sector !== 'station' && buyer.sector !== 'outpost')) return;

    const order = await MarketOrder.findOne({ orderId: orderId });
    if (!order) return;

    const total = order.amount * order.pricePerUnit;
    if (buyer.wallet < total) return;
    const spaceLeft = (buyer.cargoMax || 30) - buyer.ore;
    if (spaceLeft < order.amount) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'MERCADO', text: "No tienes suficiente espacio en bodega." });
      return;
    }

    buyer.wallet -= total;
    buyer.ore += order.amount;
    syncPilotToCloud(buyer);

    let tax = universe.sectors.nullsec.sovereignty.ownerCorp !== "Ninguna" ? Math.round(total * 0.05) : 0;
    let net = total - tax;

    await Pilot.updateOne({ name: order.seller }, { $inc: { wallet: net } });
    const sellerOnline = Object.values(universe.players).find(p => p.name === order.seller);
    if (sellerOnline) sellerOnline.wallet += net;

    await MarketOrder.deleteOne({ orderId: orderId });
    cachedMarket = cachedMarket.filter(o => o.orderId !== orderId);
  });

  socket.on('cancel_market_order', async (orderId) => {
    const p = universe.players[socket.id];
    if (!p) return;
    const order = await MarketOrder.findOne({ orderId: orderId, seller: p.name });
    if (order) {
      p.ore += order.amount;
      syncPilotToCloud(p);
      await MarketOrder.deleteOne({ orderId: orderId });
      cachedMarket = cachedMarket.filter(o => o.orderId !== orderId);
    }
  });

  // Industria y Manufactura
  socket.on('start_industry_job', async (bpKey) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;
    const bp = BLUEPRINTS[bpKey];
    if (!bp || p.wallet < bp.fee || p.ore < bp.oreCost) return;

    p.wallet -= bp.fee;
    p.ore -= bp.oreCost;
    syncPilotToCloud(p);

    const newJob = await IndustryJob.create({
      jobId: Date.now(),
      pilot: p.name,
      bpKey: bpKey,
      blueprintName: bp.name,
      completesAt: Date.now() + (bp.buildTimeSec * 1000),
      completed: false
    });
    cachedJobs.push(newJob);
  });

  socket.on('claim_industry_job', async (jobId) => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'station') return;

    const job = await IndustryJob.findOne({ jobId: jobId, pilot: p.name, completed: true });
    if (!job) return;

    const bp = BLUEPRINTS[job.bpKey];
    if (bp.type === 'module') {
      p.weaponBonus = Math.max(p.weaponBonus, 20);
    } else if (bp.type === 'ship') {
      p.shipKey = 'cruiser';
      p.cargoMax = SHIP_TYPES.cruiser.cargoMax;
      p.maxArmor = SHIP_TYPES.cruiser.baseArmor + ((p.skills?.armor_upgrade || 0) * 15);
      p.armor = p.maxArmor;
    }
    syncPilotToCloud(p);

    await IndustryJob.deleteOne({ jobId: jobId });
    cachedJobs = cachedJobs.filter(j => j.jobId !== jobId);
  });

  // Habilidades Pasivas
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

  // Minería con control de capacidad de bodega
  socket.on('mine_cycle', () => {
    const p = universe.players[socket.id];
    if (p && p.sector === 'mining') {
      const shipCap = p.cargoMax || 30;
      if (p.ore >= shipCap) {
        socket.emit('chat_broadcast', { channel: 'local', sender: 'BODEGA', text: "¡Bodega llena! Vuelve a una estación para comerciar." });
        return;
      }
      const miningLvl = p.skills?.mining_efficiency || 0;
      const extracted = Math.min(shipCap - p.ore, 5 + (miningLvl * 2));
      p.ore += extracted;
      universe.sectors.mining.asteroidHp = Math.max(0, universe.sectors.mining.asteroidHp - 10);
      if (universe.sectors.mining.asteroidHp <= 0) universe.sectors.mining.asteroidHp = 100;
    }
  });

  // Combate y Táctica
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
      const spaceLeft = (p.cargoMax || 30) - p.ore;
      const takenOre = Math.min(spaceLeft, w.ore);
      p.ore += takenOre;
      p.wallet += w.credits;
      syncPilotToCloud(p);
      universe.sectors.nullsec.wrecks.splice(idx, 1);
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
        io.emit('chat_broadcast', { channel: 'galaxy', sender: 'SOBERANÍA', text: `¡[${p.corp}] domina el paso de Nullsec!` });
      }
    }
  });

  socket.on('send_sos', () => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'nullsec') return;
    io.emit('sos_alert', { pilot: `[${p.corp}] ${p.name}`, sectorId: 'nullsec', sectorName: universe.sectors.nullsec.name });
  });

  socket.on('repair', () => {
    const p = universe.players[socket.id];
    if (p && (p.sector === 'station' || p.sector === 'outpost') && p.wallet >= 50) {
      p.wallet -= 50;
      p.armor = p.maxArmor;
      p.shield = 100;
      syncPilotToCloud(p);
      socket.emit('chat_broadcast', { channel: 'local', sender: 'HANGAR', text: "Nave reparada completamente." });
    }
  });

  socket.on('set_corp', (corpTag) => {
    const p = universe.players[socket.id];
    if (!p) return;
    p.corp = corpTag.trim().toUpperCase().substring(0, 5) || "CORP";
    syncPilotToCloud(p);
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
  console.log(`Servidor MMO Maestro corriendo en puerto ${PORT}`);
});
