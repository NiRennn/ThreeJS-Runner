export interface SkinItem {
  id: string;
  name: string;
  price: number;
  description: string;
  hoodieColor: string;
  pantsColor: string;
  visorColor: string;
  backpackColor: string;
  icon: string;
}

export const SKINS_CATALOG: SkinItem[] = [
  {
    id: "default",
    name: "Оранжевый Бегун",
    price: 0,
    description: "Классический спортивный костюм бегуна",
    hoodieColor: "#ff5722",
    pantsColor: "#1b263b",
    visorColor: "#00f5d4",
    backpackColor: "#0d1b2a",
    icon: "🏃",
  },
  {
    id: "ninja",
    name: "Кибер Ниндзя",
    price: 150,
    description: "Темный костюм с неоново-голубым визором",
    hoodieColor: "#111827",
    pantsColor: "#1f2937",
    visorColor: "#06b6d4",
    backpackColor: "#374151",
    icon: "🥷",
  },
  {
    id: "mech",
    name: "Неоновый Мех",
    price: 300,
    description: "Футуристический фиолетово-розовый робот",
    hoodieColor: "#7c3aed",
    pantsColor: "#4c1d95",
    visorColor: "#ec4899",
    backpackColor: "#5b21b6",
    icon: "🤖",
  },
  {
    id: "gold",
    name: "Золотой Чемпион",
    price: 500,
    description: "Роскошный золотой металлический бронекостюм",
    hoodieColor: "#ffd700",
    pantsColor: "#b8860b",
    visorColor: "#ffffff",
    backpackColor: "#d4af37",
    icon: "👑",
  },
];

export interface EnvironmentItem {
  id: string;
  name: string;
  price: number;
  description: string;
  icon: string;
}

export const ENV_CATALOG: EnvironmentItem[] = [
  {
    id: "default",
    name: "Стандартное Окружение",
    price: 0,
    description: "Классический пригородный пейзаж с зелеными деревьями и домиками",
    icon: "🏙️",
  },
  {
    id: "newyear",
    name: "Новогодняя Сказка ❄️",
    price: 250,
    description: "Падающий пушистый снег, светящиеся шары на елочках и коробки с подарками у домов",
    icon: "🎄",
  },
  {
    id: "halloween",
    name: "Хэллоуин 🎃",
    price: 400,
    description: "Светящиеся резные тыквы Джек, парящие дружелюбные привидения и могилки с крестами",
    icon: "🎃",
  },
];

const WALLET_KEY = "three_runner_wallet_coins_v2";
const SKINS_KEY = "three_runner_unlocked_skins_v1";
const ACTIVE_SKIN_KEY = "three_runner_active_skin_v1";
const ENVS_KEY = "three_runner_unlocked_envs_v1";
const ACTIVE_ENV_KEY = "three_runner_active_env_v1";

export function getWalletCoins(): number {
  try {
    const val = localStorage.getItem(WALLET_KEY);
    if (val === null) {
      localStorage.setItem(WALLET_KEY, "999999");
      return 999999;
    }
    return parseInt(val, 10);
  } catch (err) {
    return 999999;
  }
}

export function addWalletCoins(amount: number): number {
  const current = getWalletCoins();
  const next = Math.max(0, current + amount);
  try {
    localStorage.setItem(WALLET_KEY, String(next));
  } catch (err) {
    console.error("Error saving wallet coins:", err);
  }
  return next;
}

export function deductWalletCoins(amount: number): boolean {
  const current = getWalletCoins();
  if (current < amount) return false;
  const next = current - amount;
  try {
    localStorage.setItem(WALLET_KEY, String(next));
  } catch (err) {
    console.error("Error deducting wallet coins:", err);
  }
  return true;
}

export function getUnlockedSkins(): string[] {
  try {
    const raw = localStorage.getItem(SKINS_KEY);
    if (!raw) {
      const initial = ["default"];
      localStorage.setItem(SKINS_KEY, JSON.stringify(initial));
      return initial;
    }
    return JSON.parse(raw) as string[];
  } catch (err) {
    return ["default"];
  }
}

export function unlockSkin(skinId: string): boolean {
  const skin = SKINS_CATALOG.find((s) => s.id === skinId);
  if (!skin) return false;

  const unlocked = getUnlockedSkins();
  if (unlocked.includes(skinId)) return true;

  if (deductWalletCoins(skin.price)) {
    const updated = [...unlocked, skinId];
    try {
      localStorage.setItem(SKINS_KEY, JSON.stringify(updated));
      localStorage.setItem(ACTIVE_SKIN_KEY, skinId);
    } catch (err) {
      console.error("Error unlocking skin:", err);
    }
    return true;
  }
  return false;
}

export function getActiveSkinId(): string {
  try {
    return localStorage.getItem(ACTIVE_SKIN_KEY) || "default";
  } catch (err) {
    return "default";
  }
}

export function setActiveSkinId(skinId: string): void {
  const unlocked = getUnlockedSkins();
  if (unlocked.includes(skinId)) {
    try {
      localStorage.setItem(ACTIVE_SKIN_KEY, skinId);
    } catch (err) {
      console.error("Error setting active skin:", err);
    }
  }
}

export function getUnlockedEnvs(): string[] {
  try {
    const raw = localStorage.getItem(ENVS_KEY);
    if (!raw) {
      const initial = ["default"];
      localStorage.setItem(ENVS_KEY, JSON.stringify(initial));
      return initial;
    }
    return JSON.parse(raw) as string[];
  } catch (err) {
    return ["default"];
  }
}

export function unlockEnv(envId: string): boolean {
  const env = ENV_CATALOG.find((e) => e.id === envId);
  if (!env) return false;

  const unlocked = getUnlockedEnvs();
  if (unlocked.includes(envId)) return true;

  if (deductWalletCoins(env.price)) {
    const updated = [...unlocked, envId];
    try {
      localStorage.setItem(ENVS_KEY, JSON.stringify(updated));
      localStorage.setItem(ACTIVE_ENV_KEY, envId);
    } catch (err) {
      console.error("Error unlocking environment:", err);
    }
    return true;
  }
  return false;
}

export function getActiveEnvId(): string {
  try {
    return localStorage.getItem(ACTIVE_ENV_KEY) || "default";
  } catch (err) {
    return "default";
  }
}

export function setActiveEnvId(envId: string): void {
  const unlocked = getUnlockedEnvs();
  if (unlocked.includes(envId)) {
    try {
      localStorage.setItem(ACTIVE_ENV_KEY, envId);
    } catch (err) {
      console.error("Error setting active env:", err);
    }
  }
}
