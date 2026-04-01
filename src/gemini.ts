const MODEL = 'gemini-2.0-flash'
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

async function call(prompt: string, maxTokens: number): Promise<string | null> {
  const key = import.meta.env.VITE_GEMINI_API_KEY
  console.log('Gemini key:', key ? `found (${key.length} chars)` : 'MISSING')
  if (!key) return null

  try {
    const res = await fetch(`${BASE}/${MODEL}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens },
      }),
    })
    const data = await res.json()
    console.log('Gemini status:', res.status, JSON.stringify(data).slice(0, 100))
    if (data?.error?.code === 429 || res.status === 429) {
      console.log('Gemini quota exceeded — using fallback text')
      return null
    }
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null
  } catch (e) {
    console.error('Gemini fetch error:', e)
    return null
  }
}

export async function explainAttack(attack: {
  type: string; severity: string; rekeyTo: string | null
  innerTransactions: number; intent: string
}): Promise<string> {
  const text = await call(
    `You are a blockchain security expert explaining a serious finding to a non-technical user.
The user intended to: ${attack.intent}
Attack detected: ${attack.type} (${attack.severity})
${attack.rekeyTo ? `Attacker address: ${attack.rekeyTo}` : ''}
Write exactly 2 sentences. First: what this attack would have done to their wallet. Second: that Verity blocked it and they are safe.
Plain English only. No jargon. No bullet points.`,
    150
  )
  return text ?? `This transaction contained a hidden ${attack.type.toLowerCase()} that would have given an attacker permanent control of your wallet and all your funds. Verity detected and blocked it before you signed — your wallet is completely safe.`
}

export async function explainSafe(intent: string): Promise<string> {
  const text = await call(
    `You are a blockchain security expert. A user intended to ${intent} on Algorand.
Verity simulated the transaction and found zero attacks, no rekey fields, no suspicious operations.
Write exactly 1 sentence confirming this is safe. Plain English. Reassuring but brief.`,
    80
  )
  return text ?? 'This transaction has been fully simulated and verified — it does exactly what it claims with no hidden operations.'
}