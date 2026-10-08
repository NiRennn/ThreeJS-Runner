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
import {
  SKINS_CATALOG,
  getWalletCoins,
  getUnlockedSkins,
  getActiveSkinId,
  unlockSkin,
  setActiveSkinId,
} from "./game/shopStorage";
import type { RunnerGame } from "./game/RunnerGame";
import musicAudioUrl from "./assets/audio/music.mp3";
import "./App.css";

const bgMusic = new Audio(musicAudioUrl);
bgMusic.loop = true;
bgMusic.volume = 0.35;

type ViewMode = "menu" | "playing" | "leaderboard" | "gameover" | "shop";

export default function App() {
  const [hud, setHud] = useState<RunnerHud>(INITIAL_RUNNER_HUD);
  const [viewMode, setViewMode] = useState<ViewMode>("menu");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [highScore, setHighScore] = useState<number>(0);

  const [walletCoins, setWalletCoins] = useState<number>(0);
  const [unlockedSkins, setUnlockedSkins] = useState<string[]>([]);
  const [activeSkinId, setActiveSkinIdState] = useState<string>("default");

  const [playerName, setPlayerName] = useState<string>("Бегун");
  const [scoreSaved, setScoreSaved] = useState<boolean>(false);
  const [isNewRecord, setIsNewRecord] = useState<boolean>(false);

  const [isMuted, setIsMuted] = useState<boolean>(() => {
    return localStorage.getItem("three_runner_music_muted") === "true";
  });

  const [isSfxMuted, setIsSfxMuted] = useState<boolean>(() => {
    return localStorage.getItem("three_runner_sfx_muted") === "true";
  });

  const gameRef = useRef<RunnerGame | null>(null);

  const tryPlayMusic = useCallback(() => {
    const muted = localStorage.getItem("three_runner_music_muted") === "true";
    bgMusic.muted = muted;
    if (!muted && bgMusic.paused) {
      bgMusic.play().catch(() => {});
    }
  }, []);

  const toggleMusic = () => {
    setIsMuted((prev) => {
      const next = !prev;
      localStorage.setItem("three_runner_music_muted", String(next));
      bgMusic.muted = next;
      if (!next && bgMusic.paused) {
        bgMusic.play().catch(() => {});
      }
      return next;
    });
  };

  const toggleSfx = () => {
    setIsSfxMuted((prev) => {
      const next = !prev;
      localStorage.setItem("three_runner_sfx_muted", String(next));
      if (gameRef.current) {
        gameRef.current.setSfxMuted(next);
      }
      return next;
    });
  };

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
    game.setSfxMuted(localStorage.getItem("three_runner_sfx_muted") === "true");
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
    tryPlayMusic();
    setViewMode("playing");
    setScoreSaved(false);
    setIsNewRecord(false);
    if (gameRef.current) {
      gameRef.current.restartGame();
    }
  };

  const handleOpenLeaderboard = () => {
    tryPlayMusic();
    setLeaderboard(getLeaderboard());
    setViewMode("leaderboard");
  };

  const handleOpenShop = () => {
    tryPlayMusic();
    setWalletCoins(getWalletCoins());
    setUnlockedSkins(getUnlockedSkins());
    setActiveSkinIdState(getActiveSkinId());
    setViewMode("shop");
  };

  const handleBuySkin = (skinId: string) => {
    if (unlockSkin(skinId)) {
      setWalletCoins(getWalletCoins());
      setUnlockedSkins(getUnlockedSkins());
      setActiveSkinIdState(getActiveSkinId());
      if (gameRef.current) {
        gameRef.current.updatePlayerSkin();
      }
      if (window.Telegram?.WebApp?.HapticFeedback) {
        try {
          window.Telegram.WebApp.HapticFeedback.notificationOccurred("success");
        } catch (err) {
          // Ignore
        }
      }
    }
  };

  const handleEquipSkin = (skinId: string) => {
    setActiveSkinId(skinId);
    setActiveSkinIdState(skinId);
    if (gameRef.current) {
      gameRef.current.updatePlayerSkin();
    }
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

      {/* AUDIO CONTROLS (MUSIC & SFX) */}
      <div className="audio-controls">
        <button
          className="audio-toggle-btn"
          onClick={toggleMusic}
          title={isMuted ? "Включить музыку" : "Выключить музыку"}
          aria-label="Переключить музыку"
        >
          {isMuted ? "🔇" : "🎵"}
        </button>

        <button
          className="audio-toggle-btn"
          onClick={toggleSfx}
          title={isSfxMuted ? "Включить звуковые эффекты" : "Выключить звуковые эффекты"}
          aria-label="Переключить звуковые эффекты"
        >
          {isSfxMuted ? "🔕" : "🔔"}
        </button>
      </div>

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
                className="btn btn--accent btn--large"
                onClick={handleOpenShop}
              >
                🛒 Магазин скинов
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

      {/* SHOP OVERLAY */}
      {viewMode === "shop" && (
        <section className="overlay-menu">
          <div className="menu-card menu-card--wide">
            <div className="menu-header">
              <h2>🛒 Магазин Скинов</h2>
              <div className="wallet-badge">
                🪙 Баланс: <strong>{walletCoins.toLocaleString()} монет</strong>
              </div>
            </div>

            <div className="skins-grid">
              {SKINS_CATALOG.map((skin) => {
                const isUnlocked = unlockedSkins.includes(skin.id);
                const isActive = activeSkinId === skin.id;
                const canAfford = walletCoins >= skin.price;

                return (
                  <div
                    key={skin.id}
                    className={`skin-card ${isActive ? "skin-card--active" : ""}`}
                  >
                    <div className="skin-card__icon">{skin.icon}</div>
                    <div className="skin-card__title">{skin.name}</div>
                    <div className="skin-card__palette">
                      <span
                        className="color-dot"
                        style={{ backgroundColor: skin.hoodieColor }}
                        title="Куртка"
                      />
                      <span
                        className="color-dot"
                        style={{ backgroundColor: skin.pantsColor }}
                        title="Штаны"
                      />
                      <span
                        className="color-dot"
                        style={{ backgroundColor: skin.visorColor }}
                        title="Визор"
                      />
                    </div>
                    <p className="skin-card__desc">{skin.description}</p>

                    <div className="skin-card__action">
                      {isActive ? (
                        <button className="btn btn--disabled" disabled>
                          ✓ Выбран
                        </button>
                      ) : isUnlocked ? (
                        <button
                          className="btn btn--primary"
                          onClick={() => handleEquipSkin(skin.id)}
                        >
                          Надеть
                        </button>
                      ) : (
                        <button
                          className={`btn ${canAfford ? "btn--success" : "btn--disabled"}`}
                          disabled={!canAfford}
                          onClick={() => handleBuySkin(skin.id)}
                        >
                          {canAfford ? `Купить (🪙 ${skin.price})` : `🪙 ${skin.price}`}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="menu-actions" style={{ marginTop: "20px" }}>
              <button
                className="btn btn--secondary btn--large"
                onClick={handleBackToMenu}
              >
                ◀ Назад в меню
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