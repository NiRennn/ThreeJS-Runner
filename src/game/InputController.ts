export type InputAction =
  | "left"
  | "right"
  | "jump"
  | "slide"
  | "restart";

const KEY_TO_ACTION: Readonly<Record<string, InputAction>> = {
  KeyA: "left",
  ArrowLeft: "left",

  KeyD: "right",
  ArrowRight: "right",

  KeyW: "jump",
  ArrowUp: "jump",
  Space: "jump",

  KeyS: "slide",
  ArrowDown: "slide",

  KeyR: "restart",
};

export class InputController {
  private readonly heldActions = new Set<InputAction>();

  private readonly pressedActions = new Set<InputAction>();

  // Touch Swipe Tracking
  private touchStartX = 0;
  private touchStartY = 0;
  private isSwiping = false;

  constructor() {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.handleWindowBlur);

    // Touch events for mobile swipe controls
    window.addEventListener("touchstart", this.handleTouchStart, {
      passive: false,
    });
    window.addEventListener("touchmove", this.handleTouchMove, {
      passive: false,
    });
    window.addEventListener("touchend", this.handleTouchEnd, {
      passive: false,
    });
    window.addEventListener("touchcancel", this.handleTouchCancel);
  }

  /**
   * Возвращает true только один раз после нажатия или свайпа.
   */
  consume(action: InputAction): boolean {
    if (!this.pressedActions.has(action)) {
      return false;
    }

    this.pressedActions.delete(action);

    return true;
  }

  /**
   * Принудительно триггерит действие (для свайпов и кнопок UI)
   */
  triggerAction(action: InputAction): void {
    this.pressedActions.add(action);
    this.heldActions.add(action);

    // Haptic feedback for Telegram Mini App
    if (window.Telegram?.WebApp?.HapticFeedback) {
      try {
        window.Telegram.WebApp.HapticFeedback.impactOccurred("light");
      } catch (err) {
        // Ignore fallback
      }
    }
  }

  isHeld(action: InputAction): boolean {
    return this.heldActions.has(action);
  }

  endFrame(): void {
    this.pressedActions.clear();
  }

  reset(): void {
    this.heldActions.clear();
    this.pressedActions.clear();
    this.isSwiping = false;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.handleWindowBlur);

    window.removeEventListener("touchstart", this.handleTouchStart);
    window.removeEventListener("touchmove", this.handleTouchMove);
    window.removeEventListener("touchend", this.handleTouchEnd);
    window.removeEventListener("touchcancel", this.handleTouchCancel);

    this.reset();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const action = KEY_TO_ACTION[event.code];

    if (!action) {
      return;
    }

    event.preventDefault();

    if (!this.heldActions.has(action)) {
      this.pressedActions.add(action);
    }

    this.heldActions.add(action);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    const action = KEY_TO_ACTION[event.code];

    if (!action) {
      return;
    }

    this.heldActions.delete(action);
  };

  private readonly handleWindowBlur = (): void => {
    this.reset();
  };

  /*
   * -----------------------------------------------------
   * МОБИЛЬНЫЕ СВАЙПЫ (TOUCH SWIPES)
   * -----------------------------------------------------
   */

  private readonly handleTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    this.touchStartX = touch.clientX;
    this.touchStartY = touch.clientY;
    this.isSwiping = true;
  };

  private readonly handleTouchMove = (event: TouchEvent): void => {
    if (!this.isSwiping) return;

    // Предотвращаем стандартный скролл страницы на телефоне во время игры
    if (event.cancelable) {
      event.preventDefault();
    }
  };

  private readonly handleTouchEnd = (event: TouchEvent): void => {
    if (!this.isSwiping || event.changedTouches.length === 0) return;

    this.isSwiping = false;

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - this.touchStartX;
    const deltaY = touch.clientY - this.touchStartY;

    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    const minSwipeDistance = 30; // 30px порог свайпа

    if (Math.max(absX, absY) < minSwipeDistance) {
      return;
    }

    if (absX > absY) {
      // Горизонтальный свайп
      if (deltaX < 0) {
        this.triggerAction("left");
      } else {
        this.triggerAction("right");
      }
    } else {
      // Вертикальный свайп
      if (deltaY < 0) {
        this.triggerAction("jump");
      } else {
        this.triggerAction("slide");
      }
    }
  };

  private readonly handleTouchCancel = (): void => {
    this.isSwiping = false;
  };
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        enableClosingConfirmation: () => void;
        initDataUnsafe?: {
          user?: {
            id: number;
            first_name?: string;
            last_name?: string;
            username?: string;
          };
        };
        HapticFeedback?: {
          impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
          notificationOccurred: (type: "error" | "success" | "warning") => void;
        };
      };
    };
  }
}