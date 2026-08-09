import { useEffect, useRef } from "react";

import { RunnerGame } from "../game/RunnerGame";

import type { RunnerHud } from "../game/types";

interface RunnerCanvasProps {
  onHudChange: (hud: RunnerHud) => void;
  onGameInit?: (game: RunnerGame) => void;
}

export function RunnerCanvas({
  onHudChange,
  onGameInit,
}: RunnerCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const game = new RunnerGame(container, onHudChange);

    if (onGameInit) {
      onGameInit(game);
    }

    return () => {
      game.dispose();
    };
  }, [onHudChange, onGameInit]);

  return <div ref={containerRef} className="runner-canvas" />;
}