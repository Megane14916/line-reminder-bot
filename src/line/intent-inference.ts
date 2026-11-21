export type IntentInference = (prompt: { instructions: string; date: string; inputs: string[] }, signal: AbortSignal) => Promise<unknown>

export function workersAiInference(ai: Ai, model: string): IntentInference {
  return async ({ instructions, date, inputs }, signal) => {
    const output = await ai.run(model, {
      messages: [{ role: 'system', content: `${instructions} /no_think\n${date}` },
        ...inputs.map((content) => ({ role: 'user' as const, content }))],
      response_format: { type: 'json_object' }, max_tokens: 1024, temperature: 0,
      ...(model === '@cf/qwen/qwen3.8-27b'
        ? { reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false } } : {}),
    }, { signal }) as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | undefined
    return output?.response ?? output?.choices?.[0]?.message?.content
  }
}

export function geminiInference(apiKey: string | undefined, model: string): IntentInference {
  return async ({ instructions, date, inputs }, signal) => {
    if (!apiKey) {
      console.error('GEMINI_API_KEY is missing')
      throw new Error('Gemini credentials unavailable')
    }
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', redirect: 'manual', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${instructions}\n${date}` }] },
        contents: [{ role: 'user', parts: inputs.map((text) => ({ text })) }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024 },
      }),
    })
    if (!response.ok) {
      console.error('Gemini inference HTTP error', { status: response.status })
      await response.body?.cancel()
      throw new Error('Gemini inference failed')
    }
    const output = await response.json<{ candidates?: { finishReason?: string; content?: {
      parts?: { text?: string; thought?: boolean }[]
    } }[] }>()
    const candidate = output.candidates?.[0]
    if (candidate?.finishReason !== 'STOP') return
    return candidate.content?.parts?.filter((part) => !part.thought).map((part) => part.text).join('')
  }
}

export function configuredInference(env: Env, previousError: string | null): IntentInference {
  const provider: string = env.AI_PROVIDER
  const apiKey = env.GEMINI_API_KEY?.trim()
  const workers = workersAiInference(env.AI, env.AI_MODEL)
  const gemini = geminiInference(apiKey, env.GEMINI_MODEL)
  if (provider === 'gemini') return gemini
  if (provider !== 'auto' || !apiKey) return workers
  // A timed-out attempt has used its inference budget, so select Workers AI on the Inbox retry.
  if (previousError === 'ai_timeout' || previousError === 'ai_unavailable') return workers
  return async (prompt, signal) => {
    try {
      return await gemini(prompt, signal)
    } catch (error) {
      if (signal.aborted) throw error
      return workers(prompt, signal)
    }
  }
}
