export interface RunnerHud {
  score: number
  coins: number
  shield: boolean
  magnetSeconds: number
  gameOver: boolean
}

export const INITIAL_RUNNER_HUD: RunnerHud = {
  score: 0,
  coins: 0,
  shield: false,
  magnetSeconds: 0,
  gameOver: false,
}