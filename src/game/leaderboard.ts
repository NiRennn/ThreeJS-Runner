export interface LeaderboardEntry {
  id: string;
  name: string;
  score: number;
  coins: number;
  date: string;
}

const LEADERBOARD_KEY = "three_runner_leaderboard_v1";

const DEFAULT_LEADERBOARD: LeaderboardEntry[] = [
  {
    id: "1",
    name: "SubwayHero",
    score: 18450,
    coins: 142,
    date: "09.08.2026",
  },
  {
    id: "2",
    name: "RunnerPro",
    score: 14200,
    coins: 110,
    date: "09.08.2026",
  },
  {
    id: "3",
    name: "DashMaster",
    score: 11800,
    coins: 85,
    date: "08.08.2026",
  },
  {
    id: "4",
    name: "CyberSurfer",
    score: 9350,
    coins: 64,
    date: "08.08.2026",
  },
  {
    id: "5",
    name: "SpeedDemon",
    score: 7100,
    coins: 48,
    date: "07.08.2026",
  },
];

export function getLeaderboard(): LeaderboardEntry[] {
  try {
    const raw = localStorage.getItem(LEADERBOARD_KEY);

    if (!raw) {
      localStorage.setItem(
        LEADERBOARD_KEY,
        JSON.stringify(DEFAULT_LEADERBOARD),
      );

      return DEFAULT_LEADERBOARD;
    }

    const parsed = JSON.parse(raw) as LeaderboardEntry[];

    return parsed.sort((a, b) => b.score - a.score);
  } catch (error) {
    console.error("Error reading leaderboard:", error);

    return DEFAULT_LEADERBOARD;
  }
}

export function saveScore(
  name: string,
  score: number,
  coins: number,
): LeaderboardEntry[] {
  const current = getLeaderboard();
  const trimmedName = name.trim() || "Игрок";
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, "0")}.${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}.${now.getFullYear()}`;

  const newEntry: LeaderboardEntry = {
    id: String(Date.now()),
    name: trimmedName,
    score,
    coins,
    date: dateStr,
  };

  const updated = [...current, newEntry]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  try {
    localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error("Error saving score to leaderboard:", error);
  }

  return updated;
}

export function getHighScore(): number {
  const leaderboard = getLeaderboard();

  return leaderboard.length > 0 ? leaderboard[0].score : 0;
}
