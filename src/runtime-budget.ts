const budgetMs = 25_000
export const defaultAiTimeout = 12_000
export const defaultLineTimeout = 10_000

export function runtimeBudget(clock = Date.now, duration = budgetMs) {
  const deadline = clock() + duration
  let closed = false
  const remaining = () => closed ? 0 : Math.max(0, deadline - clock())
  return { clock, remaining, close: () => { closed = true } }
}

export type RuntimeBudget = ReturnType<typeof runtimeBudget>

export async function withinBudget(budget: RuntimeBudget, work: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work(), new Promise<void>((resolve) => {
      timer = setTimeout(() => { budget.close(); resolve() }, budget.remaining())
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    budget.close()
  }
}

function timeout(value: string | undefined, maximum: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : maximum
}

export const aiTimeout = (env: Env) => timeout(env.AI_TIMEOUT_MS, defaultAiTimeout)
export const lineTimeout = (env: Env) => timeout(env.LINE_TIMEOUT_MS, defaultLineTimeout)
