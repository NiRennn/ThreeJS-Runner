import { useCallback, useEffect, useRef, useState } from "react";
import { RunnerCanvas } from "./components/RunnerCanvas";
import { INITIAL_RUNNER_HUD } from "./game/types";
import type { RunnerHud } from "./game/types";
import {
  getHighScore,
  getLeaderboard,
  saveScore,
  type LeaderboardEntry,
} from "./game/leaderboard";
import type { RunnerGame } from "./game/RunnerGame";
import "./App.css";

type ViewMode = "menu" | "playing" | "leaderboard" | "gameover";

export default function App() {
  const [hud, setHud] = useState<RunnerHud>(INITIAL_RUNNER_HUD);
  const [viewMode, setViewMode] = useState<ViewMode>("menu");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [highScore, setHighScore] = useState<number>(0);

  const [playerName, setPlayerName] = useState<string>("Бегун");
  const [scoreSaved, setScoreSaved] = useState<boolean>(false);
  const [isNewRecord, setIsNewRecord] = useState<boolean>(false);

  const gameRef = useRef<RunnerGame | null>(null);

  // Initialize Telegram WebApp SDK & load leaderboard
  useEffect(() => {
    if (window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.ready();
      tg.expand();
      try {
        tg.enableClosingConfirmation();
      } catch (err) {
        // Ignore fallback
      }

      const tgUser = tg.initDataUnsafe?.user;
      if (tgUser?.first_name) {
        const name = tgUser.username ? `@${tgUser.username}` : tgUser.first_name;
        setPlayerName(name);
      }
    }

    const list = getLeaderboard();
    setLeaderboard(list);
    setHighScore(getHighScore());
  }, []);

  const handleGameInit = useCallback((game: RunnerGame) => {
    gameRef.current = game;
  }, []);

  const handleHudChange = useCallback(
    (nextHud: RunnerHud): void => {
      setHud(nextHud);

      if (nextHud.gameOver) {
        setViewMode((prev) => {
          if (prev !== "gameover") {
            const currentRecord = getHighScore();
            const recordBroken = nextHud.score > currentRecord && nextHud.score > 0;
            setIsNewRecord(recordBroken);

            if (window.Telegram?.WebApp?.HapticFeedback) {
              try {
                window.Telegram.WebApp.HapticFeedback.notificationOccurred(
                  recordBroken ? "success" : "warning",
                );
              } catch (err) {
                // Ignore fallback
              }
            }

            setScoreSaved(false);
            return "gameover";
          }
          return prev;
        });
      }
    },
    [],
  );

  const handleStartGame = () => {
    setViewMode("playing");
    setScoreSaved(false);
    setIsNewRecord(false);
    if (gameRef.current) {
      gameRef.current.restartGame();
    }
  };

  const handleOpenLeaderboard = () => {
    setLeaderboard(getLeaderboard());
    setViewMode("leaderboard");
  };

  const handleBackToMenu = () => {
    setHighScore(getHighScore());
    if (gameRef.current) {
      gameRef.current.resetToMenu();
    }
    setViewMode("menu");
  };

  const handleSaveScore = (e: React.FormEvent) => {
    e.preventDefault();
    if (scoreSaved || hud.score <= 0) return;

    const updated = saveScore(playerName, hud.score, hud.coins);
    setLeaderboard(updated);
    setHighScore(getHighScore());
    setScoreSaved(true);
    setViewMode("leaderboard");
  };

  // Keyboard shortcut to start/restart
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (viewMode === "menu" && (e.code === "Space" || e.code === "Enter")) {
        handleStartGame();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [viewMode]);

  return (
    <main className="runner">
      <RunnerCanvas
        onHudChange={handleHudChange}
        onGameInit={handleGameInit}
      />

      {/* ACTIVE GAMEPLAY HUD */}
      {viewMode === "playing" && (
        <section className="hud">
          <div className="hud__score">{hud.score}</div>

          <div className="hud__row">
            <span>Монеты</span>
            <strong>{hud.coins}</strong>
          </div>

          <div className="hud__bonuses">
            {hud.shield && <span className="bonus bonus--shield">🛡️ Щит</span>}

            {hud.magnetSeconds > 0 && (
              <span className="bonus bonus--magnet">
                🧲 Магнит: {hud.magnetSeconds}с
              </span>
            )}
          </div>
        </section>
      )}

      {/* CONTROLS HINT (Mobile Swipes & Keyboard) */}
      <section className="controls">
        <div>📱 Свайпы: Влево/Вправо, Вверх (прыжок), Вниз (подкат)</div>
        <div>💻 Клавиши: A/D или ←/→, W/Пробел, S/↓</div>
      </section>

      {/* MAIN MENU OVERLAY */}
      {viewMode === "menu" && (
        <section className="overlay-menu">
          <div className="menu-card">
            <div className="menu-logo">
              <span className="menu-logo__icon">🏃</span>
              <h1 className="menu-logo__title">SUBWAY RUNNER</h1>
              <span className="menu-logo__tag">3D EDITION</span>
            </div>

            <div className="menu-record-badge">
              🏆 Лучший Рекорд: <strong>{highScore.toLocaleString()}</strong>
            </div>

            <div className="menu-actions">
              <button
                className="btn btn--primary btn--large"
                onClick={handleStartGame}
              >
                🚀 Начать игру
              </button>

              <button
                className="btn btn--secondary btn--large"
                onClick={handleOpenLeaderboard}
              >
                🏆 Таблица лидеров
              </button>
            </div>
          </div>
        </section>
      )}

      {/* LEADERBOARD OVERLAY */}
      {viewMode === "leaderboard" && (
        <section className="overlay-menu">
          <div className="menu-card menu-card--wide">
            <div className="menu-header">
              <h2>🏆 Таблица лидеров</h2>
              <p>Топ-10 самых лучших результатов</p>
            </div>

            <div className="leaderboard-table-wrapper">
              <table className="leaderboard-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Игрок</th>
                    <th>Очки</th>
                    <th>Монеты</th>
                    <th>Дата</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((entry, index) => {
                    const isTop1 = index === 0;
                    const isTop2 = index === 1;
                    const isTop3 = index === 2;
                    const rankBadge = isTop1
                      ? "🥇"
                      : isTop2
                      ? "🥈"
                      : isTop3
                      ? "🥉"
                      : `${index + 1}`;

                    return (
                      <tr
                        key={entry.id}
                        className={isTop1 ? "row--gold" : ""}
                      >
                        <td className="rank-cell">{rankBadge}</td>
                        <td className="name-cell">{entry.name}</td>
                        <td className="score-cell">
                          {entry.score.toLocaleString()}
                        </td>
                        <td className="coins-cell">🪙 {entry.coins}</td>
                        <td className="date-cell">{entry.date}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="menu-actions">
              <button
                className="btn btn--secondary"
                onClick={handleBackToMenu}
              >
                ⬅️ Назад в меню
              </button>

              <button
                className="btn btn--primary"
                onClick={handleStartGame}
              >
                🚀 Играть заново
              </button>
            </div>
          </div>
        </section>
      )}

      {/* GAME OVER OVERLAY */}
      {viewMode === "gameover" && (
        <section className="game-over">
          <div className="game-over__panel">
            {isNewRecord && (
              <div className="new-record-banner">
                🌟 НОВЫЙ РЕКОРД! 🌟
              </div>
            )}

            <div className="game-over__label">Забег окончен</div>

            <div className="game-over__score">{hud.score.toLocaleString()}</div>

            <div className="game-over__stats">
              <span>Собрано монет: <strong>🪙 {hud.coins}</strong></span>
            </div>

            {!scoreSaved ? (
              <form onSubmit={handleSaveScore} className="save-score-form">
                <input
                  type="text"
                  className="save-score-input"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="Ваше имя"
                  maxLength={15}
                  required
                />
                <button type="submit" className="btn btn--save">
                  💾 Сохранить рекорд
                </button>
              </form>
            ) : (
              <div className="score-saved-msg">
                ✅ Результат сохранён в Таблице лидеров!
              </div>
            )}

            <div className="game-over__actions">
              <button
                className="btn btn--primary"
                onClick={handleStartGame}
              >
                🔄 Играть снова
              </button>

              <button
                className="btn btn--secondary"
                onClick={handleOpenLeaderboard}
              >
                🏆 Таблица лидеров
              </button>

              <button
                className="btn btn--tertiary"
                onClick={handleBackToMenu}
              >
                🏠 Главное меню
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}