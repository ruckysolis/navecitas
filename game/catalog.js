module.exports = {
  SHIP_TYPES: {
    'frigate': { name: "Fragata 'Rifter'", cargoMax: 30, baseArmor: 100, dmgBonus: 0, cost: 0, droneCapacity: 1 },
    'freighter': { name: "Carguero Pesado 'Mammoth'", cargoMax: 250, baseArmor: 180, dmgBonus: -10, cost: 500, droneCapacity: 0 },
    'cruiser': { name: "Crucero de Asalto 'Cerberus'", cargoMax: 60, baseArmor: 150, dmgBonus: 20, cost: 1200, droneCapacity: 3 }
  },

  DRONE_TYPES: {
    'combat_drone': { name: "Dron Ligero 'Hornet'", type: 'combat', dps: 12, cost: 150 },
    'mining_drone': { name: "Dron Minero 'Excavator'", type: 'mining', yield: 4, cost: 120 }
  },

  SKILL_DEFS: {
    'gunnery': { name: "Balística Espacial", desc: "+10% daño por nivel", baseTimeSec: 30, maxLevel: 5 },
    'armor_upgrade': { name: "Gestión de Blindaje", desc: "+15 HP casco por nivel", baseTimeSec: 40, maxLevel: 5 },
    'mining_efficiency': { name: "Extracción Minera", desc: "+2 m³ menas por nivel", baseTimeSec: 25, maxLevel: 5 },
    'drone_interfacing': { name: "Interfaz de Drones", desc: "+10% rendimiento de drones por nivel", baseTimeSec: 35, maxLevel: 5 }
  },

  BLUEPRINTS: {
    'laser_t2': { name: "Láser de Pulso T2", type: 'module', oreCost: 25, fee: 100, buildTimeSec: 30 },
    'heavy_cruiser': { name: "Crucero de Asalto 'Cerberus'", type: 'ship', oreCost: 60, fee: 300, buildTimeSec: 60 }
  },

  MISSIONS_CATALOG: {
    'pirate_scout': { id: 'pirate_scout', title: "Caza: Explorador Pirata", targetName: "Fragata Corsaria 'Bloodhound'", hp: 80, dmg: 18, bounty: 150, lootOre: 10 },
    'pirate_commander': { id: 'pirate_commander', title: "Caza Mayor: Comandante", targetName: "Crucero Pirata 'Vindicator'", hp: 160, dmg: 28, bounty: 450, lootOre: 30 }
  }
};
