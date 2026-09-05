const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const { SHIP_TYPES, DRONE_TYPES, SKILL_DEFS, BLUEPRINTS, MISSIONS_CATALOG, MINERAL_PRICES, SECTORS_MAP } = require('./game/catalog');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI || "PEGA_AQUI_TU_ENLACE_DE_MONGODB_ATLAS";

mongoose.connect(MONGO_URI)
  .then(() => console.log(">>> [BD EN LA NUBE]: Conexión exitosa a MongoDB Atlas <<<"))
  .catch(err => console.error("Error al conectar a MongoDB:", err.message));

const PilotSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  corp: { type: String, default: "Sin Corp" },
  wallet: { type: Number, default: 300 },
  ore: { type: Number, default: 10 },
  bistrimite: { type: Number, default: 0 },
  shipKey: { type: String, default: "frigate" },
  armor: { type: Number, default: 100 },
  shield: { type: Number, default: 100 },
  weaponBonus: { type: Number, default: 0 },
  drones: {
    combat: { type: Number, default: 0 },
    mining: { type: Number, default: 0 }
  },
  skills: {
    gunnery: { type: Number, default: 0 },
    armor_upgrade: { type: Number, default: 0 },
    mining_efficiency: { type: Number, default: 0 },
    drone_interfacing: { type: Number, default: 0 }
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
  sectors: SECTORS_MAP,
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
        bistrimite: p.bistrimite || 0,
        shipKey: p.shipKey,
        armor: p.armor,
        shield: p.shield,
        weaponBonus: p.weaponBonus,
        drones: p.drones,
        skills: p.skills,
        training: p.training,
        activeMission: p.activeMission
      },
      { upsert: false }
    );
  } catch (err) {
    console.error("Error persistiendo piloto:", err.message);
  }
}

// Bucle maestro (1 segundo)
setInterval(async () => {
  const now = Date.now();

  // 1. Regeneración continua de Capacitor
  for (let id in universe.players) {
    const p = universe.players[id];
    if (p.cap < 100) p.cap = Math.min(100, p.cap + 5);
  }

  // 2. Tormenta Cósmica en Nullsec (Ciclo de 45s calma / 45s tormenta)
  const storm = universe.sectors.nullsec.storm;
  storm.timer--;
  if (storm.timer <= 0) {
    storm.active = !storm.active;
    storm.timer = 45;
    const alertMsg = storm.active
      ? "¡ALERTA CÓSMICA! Tormenta electromagnética activa en Nullsec: daño ambiental constante, pero la Bistrimita cotiza al DOBLE (240 ISK/m³)."
      : "La tormenta electromagnética en Nullsec se ha disipado temporalmente.";
    io.emit('chat_broadcast', { channel: 'galaxy', sender: 'ALERTA AMBIENTAL', text: alertMsg });
  }

  // Daño ambiental durante la tormenta a naves en Nullsec
  if (storm.active) {
    for (let id in universe.players) {
      const p = universe.players[id];
      if (p.sector === 'nullsec' && p.armor > 0) {
        applyDamage(p, 5);
        const sock = io.sockets.sockets.get(id);
        if (sock) sock.emit('action_fx', { type: 'under_fire', damage: 5, target: 'player' });
        if (p.armor <= 0) handleDestruction(p, { name: "Tormenta Cósmica", corp: "Anomalía" });
      }
    }
  }

  // 3. Sistema de Emboscadas Piratas en sectores mineros y de combate
  for (let secKey in universe.sectors) {
    const sec = universe.sectors[secKey];
    if (sec.type !== 'mining' && sec.type !== 'combat') continue;

    // Asegurar que el sector tenga la propiedad inicializada
    if (!sec.pirateAmbush) sec.pirateAmbush = null;

    const pilotsInSec = Object.values(universe.players).filter(p => p.sector === secKey && p.armor > 0);

    if (pilotsInSec.length > 0) {
      if (!sec.pirateAmbush) {
        if (Math.random() < 0.05) {
          sec.pirateAmbush = {
            targetName: "Corsario Bloodhound de la Flota Roja",
            countdown: 10,
            active: false,
            hp: 90,
            dmg: 25
          };
          io.to(secKey).emit('chat_broadcast', {
            channel: 'local',
            sender: 'RADAR DE PROXIMIDAD',
            text: `¡SALTO HOSTIL DETECTADO! Una nave pirata saldrá de curvatura en 10 segundos. ¡Alínea motores o prepárate!`
          });
        }
      } else {
        if (!sec.pirateAmbush.active) {
          sec.pirateAmbush.countdown--;
          if (sec.pirateAmbush.countdown <= 0) {
            sec.pirateAmbush.active = true;
            io.to(secKey).emit('chat_broadcast', {
              channel: 'local',
              sender: 'ALERTA DE COMBATE',
              text: `¡${sec.pirateAmbush.targetName} ha entrado al sector y ha fijado armas!`
            });
          }
        } else {
          if (Math.floor(now / 1000) % 3 === 0 && pilotsInSec.length > 0) {
            const victim = pilotsInSec[Math.floor(Math.random() * pilotsInSec.length)];
            applyDamage(victim, sec.pirateAmbush.dmg);
            const sock = io.sockets.sockets.get(victim.id);
            if (sock) sock.emit('action_fx', { type: 'under_fire', damage: sec.pirateAmbush.dmg, target: 'player' });
            io.to(secKey).emit('chat_broadcast', {
              channel: 'local',
              sender: 'INCURSIÓN PIRATA',
              text: `${sec.pirateAmbush.targetName} abrió fuego contra ${victim.name} (-${sec.pirateAmbush.dmg} daño).`
            });
            if (victim.armor <= 0) handleDestruction(victim, { name: sec.pirateAmbush.targetName, corp: "Piratas" });
          }
        }
      }
    } else {
      sec.pirateAmbush = null;
    }
  }

  // 4. Warp Spool-up (Alineación)
  for (let id in universe.players) {
    const p = universe.players[id];
    if (p.spoolingWarp) {
      p.spoolingWarp.timer--;
      if (p.spoolingWarp.timer <= 0) {
        const dest = p.spoolingWarp.destination;
        p.spoolingWarp = null;
        p.dronesDeployed = false;

        const sock = io.sockets.sockets.get(id);
        if (sock) {
          sock.leave(p.sector);
          p.sector = dest;
          sock.join(dest);
          p.order = 'none';
          sock.emit('chat_broadcast', { channel: 'local', sender: 'NAVEGACIÓN', text: `Salto completado hacia ${universe.sectors[dest]?.name || dest}.` });
        }
      }
    }
  }

  // 5. Entrenamiento de Habilidades
  for (let id in universe.players) {
    const p = universe.players[id];
    if (p.training && now >= p.training.finishAt) {
      const skKey = p.training.skillKey;
      p.skills = p.skills || {};
      p.skills[skKey] = (p.skills[skKey] || 0) + 1;
      const skName = SKILL_DEFS[skKey]?.name || skKey;
      const newLvl = p.skills[skKey];
      p.training = null;

      const shipBase = SHIP_TYPES[p.shipKey]?.baseArmor || 100;
      p.maxArmor = shipBase + ((p.skills.armor_upgrade || 0) * 15);
      syncPilotToCloud(p);

      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        sock.emit('chat_broadcast', { channel: 'local', sender: 'NEURO-ENLACE', text: `¡Entrenamiento completado! [${skName} Nivel ${newLvl}].` });
      }
    }
  }

  // 6. Drones mineros pasivos (cada 5s)
  if (Math.floor(now / 1000) % 5 === 0) {
    for (let id in universe.players) {
      const p = universe.players[id];
      if (p.sector === 'mining' && p.dronesDeployed && p.drones?.mining > 0) {
        const droneSkillBonus = 1 + ((p.skills?.drone_interfacing || 0) * 0.10);
        const yieldPerDrone = Math.round(DRONE_TYPES.mining_drone.yield * droneSkillBonus);
        const totalYield = p.drones.mining * yieldPerDrone;
        const currentTotalCargo = (p.ore || 0) + (p.bistrimite || 0);
        const spaceLeft = (p.cargoMax || 30) - currentTotalCargo;
        const taken = Math.min(spaceLeft, totalYield);

        if (taken > 0) {
          p.ore += taken;
          universe.sectors.mining.asteroidHp = Math.max(0, universe.sectors.mining.asteroidHp - 5);
          const sock = io.sockets.sockets.get(p.id);
          if (sock) {
            sock.emit('chat_broadcast', { channel: 'local', sender: 'DRONES', text: `Drones mineros cargaron +${taken} m³ de mena.` });
          }
        }
      }
    }
  }

  // 7. Combate PvP en Nullsec
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

  // 8. Combate PvE
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

  // 9. Industria
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
    shipCatalog: SHIP_TYPES,
    droneCatalog: DRONE_TYPES
  });
}, 1000);

function resolvePveTurn(player, enc) {
  let logs = [];
  let totalDmg = 0;

  if (player.order === 'attack' && player.cap >= 25) {
    player.cap -= 25;
    let shipBonus = SHIP_TYPES[player.shipKey]?.dmgBonus || 0;
    let baseDmg = 30 + shipBonus + (player.weaponBonus || 0);
    let skillBonus = 1 + ((player.skills?.gunnery || 0) * 0.10);
    totalDmg += Math.max(5, Math.round(baseDmg * skillBonus));
  } else if (player.order === 'defense' && player.cap >= 20) {
    player.cap -= 20;
    player.shield = Math.min(100, player.shield + 25);
    logs.push("Regeneraste escudos (+25%).");
  }

  if (player.dronesDeployed && player.drones?.combat > 0) {
    let droneBonus = 1 + ((player.skills?.drone_interfacing || 0) * 0.10);
    let droneDmg = Math.round(player.drones.combat * DRONE_TYPES.combat_drone.dps * droneBonus);
    totalDmg += droneDmg;
    logs.push(`Drones hostigaron al objetivo (-${droneDmg} daño).`);
  }

  if (totalDmg > 0) {
    enc.npcArmor = Math.max(0, enc.npcArmor - totalDmg);
    logs.push(`Disparo efectivo contra ${enc.targetName}: -${totalDmg} daño.`);
    const sock = io.sockets.sockets.get(player.id);
    if (sock) sock.emit('action_fx', { type: 'laser_fire', damage: totalDmg, target: 'enemy' });
  }
  player.order = 'none';

  if (enc.npcArmor <= 0) {
    player.wallet += enc.bounty;
    const currentCargo = (player.ore || 0) + (player.bistrimite || 0);
    const spaceLeft = (player.cargoMax || 30) - currentCargo;
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
        text: `¡OBJETIVO DESTRUIDO! Recompensa: +${enc.bounty} ISK y +${takenOre} m³ de mineral.`
      });
    }
    return;
  }

  let npcDmg = enc.dmg;
  if (player.order === 'defense') npcDmg = Math.round(npcDmg * 0.6);
  applyDamage(player, npcDmg);
  logs.push(`${enc.targetName} respondió fuego (-${npcDmg} daño).`);
  const sock = io.sockets.sockets.get(player.id);
  if (sock) sock.emit('action_fx', { type: 'under_fire', damage: npcDmg, target: 'player' });

  if (player.armor <= 0) {
    delete universe.pveEncounters[player.name];
    player.activeMission = null;
    player.ore = 0;
    player.bistrimite = 0;
    player.sector = 'station';
    player.armor = 25;
    player.shield = 0;
    player.dronesDeployed = false;
    syncPilotToCloud(player);

    if (sock) {
      sock.leave('pve');
      sock.join('station');
      sock.emit('ship_destroyed', `Tu nave fue destruida por ${enc.targetName}. Cápsula eyectada a Jita.`);
    }
    return;
  }

  if (sock) sock.emit('combat_log', logs);
}

function resolveCombat(combatants) {
  let logs = [];

  combatants.forEach(attacker => {
    if (attacker.armor <= 0) return;
    const target = combatants.find(p => p.id !== attacker.id && p.armor > 0 && (p.corp === "Sin Corp" || p.corp !== attacker.corp));
    if (!target) return;

    if (target.spoolingWarp) {
      target.spoolingWarp = null;
      logs.push(`¡El impacto recibido por ${target.name} abortó su salto de curvatura!`);
    }

    let totalDmg = 0;
    if (attacker.order === 'attack' && attacker.cap >= 25) {
      attacker.cap -= 25;
      let shipBonus = SHIP_TYPES[attacker.shipKey]?.dmgBonus || 0;
      let baseDmg = target.order === 'defense' ? 15 : 35;
      let skillBonus = 1 + ((attacker.skills?.gunnery || 0) * 0.10);
      totalDmg += Math.max(5, Math.round((baseDmg + shipBonus + (attacker.weaponBonus || 0)) * skillBonus));
    } else if (attacker.order === 'defense' && attacker.cap >= 20) {
      attacker.cap -= 20;
      attacker.shield = Math.min(100, attacker.shield + 20);
      logs.push(`${attacker.name} reforzó defensas.`);
    }

    if (attacker.dronesDeployed && attacker.drones?.combat > 0) {
      let droneBonus = 1 + ((attacker.skills?.drone_interfacing || 0) * 0.10);
      let droneDmg = Math.round(attacker.drones.combat * DRONE_TYPES.combat_drone.dps * droneBonus);
      totalDmg += droneDmg;
      logs.push(`Drones de ${attacker.name} dispararon a ${target.name} (-${droneDmg} daño).`);
    }

    if (totalDmg > 0) {
      applyDamage(target, totalDmg);
      logs.push(`[${attacker.corp}] ${attacker.name} impactó a [${target.corp}] ${target.name} (-${totalDmg} daño total).`);
      const targetSock = io.sockets.sockets.get(target.id);
      if (targetSock) targetSock.emit('action_fx', { type: 'under_fire', damage: totalDmg, target: 'player' });
      const attSock = io.sockets.sockets.get(attacker.id);
      if (attSock) attSock.emit('action_fx', { type: 'laser_fire', damage: totalDmg, target: 'enemy' });

      if (target.armor <= 0) handleDestruction(target, attacker);
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
    bistrimite: victim.bistrimite || 0,
    credits: 300
  });

  io.emit('chat_broadcast', {
    channel: 'galaxy',
    sender: 'BAJA CONFIRMADA',
    text: `Flota de [${killer.corp}] aniquiló a [${victim.corp}] ${victim.name}. Toda su carga flotando en el pecio.`
  });

  victim.ore = 0;
  victim.bistrimite = 0;
  victim.shipKey = 'frigate';
  victim.sector = 'station';
  victim.armor = 30;
  victim.shield = 0;
  victim.order = 'none';
  victim.spoolingWarp = null;
  victim.dronesDeployed = false;
  victim.drones = { combat: 0, mining: 0 };
  syncPilotToCloud(victim);

  const victimSocket = io.sockets.sockets.get(victim.id);
  if (victimSocket) {
    victimSocket.leave('nullsec');
    victimSocket.join('station');
    victimSocket.emit('ship_destroyed', "Tu nave fue destruida. Toda tu carga de minerales quedó en el pecio.");
  }
}

io.on('connection', (socket) => {
  socket.on('pilot_login', async (data) => {
    // Soporta tanto si llega como objeto {name, password} o como texto antiguo
    const nameInput = typeof data === 'object' ? data.name : data;
    const passInput = typeof data === 'object' ? data.password : 'default_pass';

    const cleanName = (nameInput || '').trim().substring(0, 14);
    const cleanPass = (passInput || '').trim();

    if (!cleanName || !cleanPass) {
      socket.emit('login_error', "Debes ingresar tu nombre de piloto y contraseña.");
      return;
    }

    try {
      let saved = await Pilot.findOne({ name: cleanName });

      if (!saved) {
        const hash = await bcrypt.hash(cleanPass, 10);
        saved = await Pilot.create({
          name: cleanName,
          passwordHash: hash,
          corp: "Sin Corp",
          wallet: 300,
          ore: 10,
          bistrimite: 0,
          shipKey: 'frigate',
          armor: 100,
          shield: 100,
          drones: { combat: 0, mining: 0 }
        });
      } else {
        const valid = await bcrypt.compare(cleanPass, saved.passwordHash);
        if (!valid) {
          socket.emit('login_error', "Contraseña incorrecta. Acceso denegado a la nave.");
          return;
        }
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
        droneCapacity: ship.droneCapacity || 0,
        drones: saved.drones || { combat: 0, mining: 0 },
        dronesDeployed: false,
        spoolingWarp: null,
        cap: 100,
        ore: saved.ore,
        bistrimite: saved.bistrimite || 0,
        wallet: saved.wallet,
        weaponBonus: saved.weaponBonus || 0,
        skills: saved.skills || { gunnery: 0, armor_upgrade: 0, mining_efficiency: 0, drone_interfacing: 0 },
        training: saved.training || null,
        activeMission: saved.activeMission || null,
        order: 'none'
      };

      socket.join('station');
      socket.emit('login_success', universe.players[socket.id]);
      io.emit('chat_broadcast', { channel: 'galaxy', sender: 'RED', text: `${saved.name} [${saved.corp}] ha iniciado sesión de forma segura.` });
    } catch (e) {
      console.error("Error login:", e.message);
      socket.emit('login_error', "Error en el servidor de autenticación.");
    }
  });

  socket.on('warp_to', (destination) => {
    const p = universe.players[socket.id];
    if (!p || p.sector === destination || p.spoolingWarp) return;

    const validJumps = {
      'station': ['perimeter', 'akelios'],
      'perimeter': ['station', 'nullsec'],
      'akelios': ['station', 'nullsec'],
      'nullsec': ['perimeter', 'akelios', 'tartarus', 'outpost'],
      'tartarus': ['nullsec'],
      'outpost': ['nullsec'],
      'pve': ['station']
    };

    if (!validJumps[p.sector]?.includes(destination)) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'NAVEGACIÓN', text: `Ruta no autorizada.` });
      return;
    }

    if (p.sector === 'nullsec' || p.sector === 'mining') {
      p.spoolingWarp = { destination: destination, timer: 5 };
      socket.emit('chat_broadcast', { channel: 'local', sender: 'NAVEGACIÓN', text: `Alineando motores hacia ${universe.sectors[destination]?.name}. Salto en 5 segundos...` });
      return;
    }

    p.dronesDeployed = false;
    socket.leave(p.sector);
    p.sector = destination;
    socket.join(destination);
    p.order = 'none';
  });

  // Atacar al pirata de la emboscada si está activo
  socket.on('attack_ambush_pirate', () => {
    const p = universe.players[socket.id];
    if (!p || (p.sector !== 'mining' && p.sector !== 'nullsec')) return;
    const sec = universe.sectors[p.sector];
    if (!sec.pirateAmbush || !sec.pirateAmbush.active) return;

    if (p.cap < 25) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'SISTEMAS', text: "Capacitor insuficiente (-25 Gj requerido)." });
      return;
    }

    p.cap -= 25;
    let shipBonus = SHIP_TYPES[p.shipKey]?.dmgBonus || 0;
    let baseDmg = 35 + shipBonus + (p.weaponBonus || 0);
    let skillBonus = 1 + ((p.skills?.gunnery || 0) * 0.10);
    let totalDmg = Math.round(baseDmg * skillBonus);

    // Añadir daño de drones
    if (p.dronesDeployed && p.drones?.combat > 0) {
      totalDmg += Math.round(p.drones.combat * DRONE_TYPES.combat_drone.dps);
    }

    sec.pirateAmbush.hp -= totalDmg;
    socket.emit('action_fx', { type: 'laser_fire', damage: totalDmg, target: 'enemy' });

    if (sec.pirateAmbush.hp <= 0) {
      p.wallet += 300;
      sec.wrecks = sec.wrecks || [];
      sec.wrecks.push({
        id: Date.now(),
        name: `Pecio de Fragata Pirata`,
        ore: 25,
        bistrimite: p.sector === 'nullsec' ? 15 : 0,
        credits: 200
      });
      sec.pirateAmbush = null;
      io.to(p.sector).emit('chat_broadcast', {
        channel: 'local',
        sender: 'VICTORIA',
        text: `¡${p.name} destruyó la nave pirata atacante! Pecio disponible para saquear (+300 ISK recompensa cobrada).`
      });
    } else {
      socket.emit('chat_broadcast', {
        channel: 'local',
        sender: 'DISPARO',
        text: `Impactaste al pirata (-${totalDmg} HP). Blindaje restante del enemigo: ${sec.pirateAmbush.hp} HP.`
      });
    }
  });

  socket.on('mine_volatile_cycle', () => {
    const p = universe.players[socket.id];
    if (!p || p.sector !== 'nullsec') return;

    const currentTotalCargo = (p.ore || 0) + (p.bistrimite || 0);
    const shipCap = p.cargoMax || 30;
    if (currentTotalCargo >= shipCap) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'BODEGA', text: "Bodega al límite." });
      return;
    }

    const miningLvl = p.skills?.mining_efficiency || 0;
    const extracted = Math.min(shipCap - currentTotalCargo, 3 + miningLvl);
    p.bistrimite = (p.bistrimite || 0) + extracted;

    socket.emit('action_fx', { type: 'mining_laser', yield: extracted, mineral: 'Bistrimita' });

    io.to('nullsec').emit('chat_broadcast', {
      channel: 'local',
      sender: 'RADAR',
      text: `¡Firma de extracción detectada! Nave cosechando Bistrimita Volátil en coordenadas abiertas.`
    });

    if (Math.random() < 0.25) {
      p.cap = Math.max(0, p.cap - 25);
      applyDamage(p, 15);
      socket.emit('action_fx', { type: 'under_fire', damage: 15, target: 'player' });
      socket.emit('chat_broadcast', {
        channel: 'local',
        sender: 'ALERTA NAVE',
        text: `¡DESCARGA VOLÁTIL! La veta colapsó (-25 capacitor, -15 blindaje).`
      });
      if (p.armor <= 0) handleDestruction(p, { name: "Anomalía Volátil", corp: "Entorno" });
    }
  });

  socket.on('mine_cycle', () => {
    const p = universe.players[socket.id];
    if (p && p.sector === 'mining') {
      const currentCargo = (p.ore || 0) + (p.bistrimite || 0);
      const shipCap = p.cargoMax || 30;
      if (currentCargo >= shipCap) {
        socket.emit('chat_broadcast', { channel: 'local', sender: 'BODEGA', text: "Bodega saturada." });
        return;
      }
      const miningLvl = p.skills?.mining_efficiency || 0;
      const extracted = Math.min(shipCap - currentCargo, 5 + (miningLvl * 2));
      p.ore += extracted;
      universe.sectors.mining.asteroidHp = Math.max(0, universe.sectors.mining.asteroidHp - 10);
      if (universe.sectors.mining.asteroidHp <= 0) universe.sectors.mining.asteroidHp = 100;
      socket.emit('action_fx', { type: 'mining_laser', yield: extracted, mineral: 'Veldspar' });
    }
  });

  socket.on('sell_all_minerals', () => {
    const p = universe.players[socket.id];
    if (!p || (p.sector !== 'station' && p.sector !== 'outpost')) return;

    const baseRate = universe.sectors[p.sector].npcBuyPrice;
    const isStorm = universe.sectors.nullsec.storm.active;
    const bistrimiteRate = isStorm ? MINERAL_PRICES.bistrimite * 2 : MINERAL_PRICES.bistrimite;

    const earnedBase = (p.ore || 0) * baseRate;
    const earnedVolatile = (p.bistrimite || 0) * bistrimiteRate;
    const totalEarned = earnedBase + earnedVolatile;

    if (totalEarned <= 0) return;

    p.wallet += totalEarned;
    socket.emit('chat_broadcast', {
      channel: 'local',
      sender: 'LOGÍSTICA',
      text: `Liquidación total: +${earnedBase} ISK por menas y +${earnedVolatile} ISK por Bistrimita (${isStorm ? '¡BONIFICACIÓN DE TORMENTA x2!' : ''}). Total: +${totalEarned} ISK.`
    });

    p.ore = 0;
    p.bistrimite = 0;
    syncPilotToCloud(p);
  });

  socket.on('loot_wreck', (wreckId) => {
    const p = universe.players[socket.id];
    if (!p) return;
    const sec = universe.sectors[p.sector];
    if (!sec || !sec.wrecks) return;
    const idx = sec.wrecks.findIndex(w => w.id === wreckId);
    if (idx !== -1) {
      const w = sec.wrecks[idx];
      let currentCargo = (p.ore || 0) + (p.bistrimite || 0);
      let spaceLeft = (p.cargoMax || 30) - currentCargo;

      let takenBistrimite = Math.min(spaceLeft, w.bistrimite || 0);
      spaceLeft -= takenBistrimite;
      let takenOre = Math.min(spaceLeft, w.ore || 0);

      p.bistrimite = (p.bistrimite || 0) + takenBistrimite;
      p.ore += takenOre;
      p.wallet += w.credits;
      syncPilotToCloud(p);

      sec.wrecks.splice(idx, 1);
      socket.emit('chat_broadcast', {
        channel: 'local',
        sender: 'SAQUEO',
        text: `Pecio desmantelado: +${takenBistrimite} Bistrimita, +${takenOre} Menas, +${w.credits} ISK.`
      });
    }
  });

  socket.on('buy_drone', (droneType) => {
    const p = universe.players[socket.id];
    if (!p || (p.sector !== 'station' && p.sector !== 'outpost')) return;

    const drone = DRONE_TYPES[droneType];
    if (!drone || p.wallet < drone.cost) return;

    const currentTotalDrones = (p.drones.combat || 0) + (p.drones.mining || 0);
    const shipMaxDrones = SHIP_TYPES[p.shipKey]?.droneCapacity || 0;

    if (currentTotalDrones >= shipMaxDrones) {
      socket.emit('chat_broadcast', { channel: 'local', sender: 'HANGAR', text: `Bahías de drones llenas.` });
      return;
    }

    p.wallet -= drone.cost;
    p.drones[drone.type] = (p.drones[drone.type] || 0) + 1;
    syncPilotToCloud(p);
  });

  socket.on('toggle_drones', () => {
    const p = universe.players[socket.id];
    if (!p) return;
    if ((p.drones.combat || 0) + (p.drones.mining || 0) === 0) return;
    p.dronesDeployed = !p.dronesDeployed;
  });

  socket.on('purchase_ship', (shipKey) => {
    const p = universe.players[socket.id];
    if (!p || (p.sector !== 'station' && p.sector !== 'outpost')) return;

    const ship = SHIP_TYPES[shipKey];
    if (!ship || p.wallet < ship.cost) return;

    p.wallet -= ship.cost;
    p.shipKey = shipKey;
    p.cargoMax = ship.cargoMax;
    p.droneCapacity = ship.droneCapacity || 0;
    p.maxArmor = ship.baseArmor + ((p.skills?.armor_upgrade || 0) * 15);
    p.armor = p.maxArmor;
    p.shield = 100;
    syncPilotToCloud(p);
  });

  socket.on('accept_mission', (missionId) => {
    const p = universe.players[socket.id];
    if (!p || (p.sector !== 'station' && p.sector !== 'outpost') || !MISSIONS_CATALOG[missionId]) return;
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
    if (!order || buyer.wallet < order.amount * order.pricePerUnit) return;

    const currentCargo = (buyer.ore || 0) + (buyer.bistrimite || 0);
    if ((buyer.cargoMax || 30) - currentCargo < order.amount) return;

    const total = order.amount * order.pricePerUnit;
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
      p.droneCapacity = SHIP_TYPES.cruiser.droneCapacity;
      p.maxArmor = SHIP_TYPES.cruiser.baseArmor + ((p.skills?.armor_upgrade || 0) * 15);
      p.armor = p.maxArmor;
    }
    syncPilotToCloud(p);

    await IndustryJob.deleteOne({ jobId: jobId });
    cachedJobs = cachedJobs.filter(j => j.jobId !== jobId);
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
      socket.emit('chat_broadcast', { channel: 'local', sender: 'HANGAR', text: "Nave reacondicionada." });
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
  console.log(`Servidor MMO con Peligro Extremo corriendo en puerto ${PORT}`);
});
