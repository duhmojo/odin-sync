// ES-DE system names (the folder names ES-DE uses under ROMs/, gamelists/ and
// downloaded_media/) and the matching libretro database / thumbnail names.
const SYSTEMS = {
  nes: {
    name: "Nintendo Entertainment System",
    libretro: "Nintendo - Nintendo Entertainment System",
    aliases: ["famicom", "fc"],
  },
  fds: {
    name: "Famicom Disk System",
    libretro: "Nintendo - Family Computer Disk System",
    aliases: [],
  },
  snes: {
    name: "Super Nintendo",
    libretro: "Nintendo - Super Nintendo Entertainment System",
    aliases: ["sfc", "superfamicom", "supernintendo"],
  },
  n64: { name: "Nintendo 64", libretro: "Nintendo - Nintendo 64", aliases: ["nintendo64"] },
  gb: { name: "Game Boy", libretro: "Nintendo - Game Boy", aliases: ["gameboy"] },
  gbc: { name: "Game Boy Color", libretro: "Nintendo - Game Boy Color", aliases: ["gameboycolor"] },
  gba: {
    name: "Game Boy Advance",
    libretro: "Nintendo - Game Boy Advance",
    aliases: ["gameboyadvance"],
  },
  nds: { name: "Nintendo DS", libretro: "Nintendo - Nintendo DS", aliases: ["ds", "nintendods"] },
  n3ds: {
    name: "Nintendo 3DS",
    libretro: "Nintendo - Nintendo 3DS",
    aliases: ["3ds", "nintendo3ds"],
  },
  virtualboy: { name: "Virtual Boy", libretro: "Nintendo - Virtual Boy", aliases: ["vb"] },
  gc: {
    name: "GameCube",
    libretro: "Nintendo - GameCube",
    aliases: ["gamecube", "ngc"],
    disc: true,
  },
  wii: { name: "Wii", libretro: "Nintendo - Wii", aliases: [], disc: true },
  psx: {
    name: "PlayStation",
    libretro: "Sony - PlayStation",
    aliases: ["ps1", "playstation", "psone"],
    disc: true,
  },
  ps2: {
    name: "PlayStation 2",
    libretro: "Sony - PlayStation 2",
    aliases: ["playstation2"],
    disc: true,
  },
  psp: {
    name: "PlayStation Portable",
    libretro: "Sony - PlayStation Portable",
    aliases: [],
    disc: true,
  },
  mastersystem: {
    name: "Master System",
    libretro: "Sega - Master System - Mark III",
    aliases: ["sms"],
  },
  megadrive: {
    name: "Mega Drive",
    libretro: "Sega - Mega Drive - Genesis",
    aliases: ["genesis", "md"],
  },
  gamegear: { name: "Game Gear", libretro: "Sega - Game Gear", aliases: ["gg"] },
  sega32x: { name: "Sega 32X", libretro: "Sega - 32X", aliases: ["32x"] },
  segacd: {
    name: "Sega CD",
    libretro: "Sega - Mega-CD - Sega CD",
    aliases: ["megacd"],
    disc: true,
  },
  saturn: { name: "Sega Saturn", libretro: "Sega - Saturn", aliases: [], disc: true },
  dreamcast: { name: "Dreamcast", libretro: "Sega - Dreamcast", aliases: ["dc"], disc: true },
  pcengine: {
    name: "PC Engine",
    libretro: "NEC - PC Engine - TurboGrafx 16",
    aliases: ["tg16", "turbografx16"],
  },
  pcenginecd: {
    name: "PC Engine CD",
    libretro: "NEC - PC Engine CD - TurboGrafx-CD",
    aliases: ["tgcd"],
    disc: true,
  },
  ngp: { name: "Neo Geo Pocket", libretro: "SNK - Neo Geo Pocket", aliases: [] },
  ngpc: { name: "Neo Geo Pocket Color", libretro: "SNK - Neo Geo Pocket Color", aliases: [] },
  wonderswan: { name: "WonderSwan", libretro: "Bandai - WonderSwan", aliases: ["ws"] },
  wonderswancolor: {
    name: "WonderSwan Color",
    libretro: "Bandai - WonderSwan Color",
    aliases: ["wsc"],
  },
  atari2600: { name: "Atari 2600", libretro: "Atari - 2600", aliases: [] },
  atari7800: { name: "Atari 7800", libretro: "Atari - 7800", aliases: [] },
  atarilynx: { name: "Atari Lynx", libretro: "Atari - Lynx", aliases: ["lynx"] },
  atarijaguar: { name: "Atari Jaguar", libretro: "Atari - Jaguar", aliases: ["jaguar"] },
  colecovision: { name: "ColecoVision", libretro: "Coleco - ColecoVision", aliases: ["coleco"] },
  intellivision: { name: "Intellivision", libretro: "Mattel - Intellivision", aliases: [] },
  msx: { name: "MSX", libretro: "Microsoft - MSX", aliases: ["msx1"] },
};

function compact(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Guesses the ES-DE system from a folder name such as "psx", "PS1" or "Nintendo DS".
function guessSystem(folderName) {
  const key = compact(folderName);
  if (!key) return "";
  for (const [id, system] of Object.entries(SYSTEMS)) {
    if (key === id || system.aliases.includes(key) || key === compact(system.name)) return id;
    if (key === compact(system.libretro)) return id;
  }
  return "";
}

module.exports = { SYSTEMS, guessSystem };
