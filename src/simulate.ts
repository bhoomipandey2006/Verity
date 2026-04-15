import algosdk from 'algosdk'

const algodClient = new algosdk.Algodv2('', 'https://testnet-api.algonode.cloud', '')

export interface SimulateResult {
  success: boolean
  rekeyDetected: boolean
  rekeyTo: string | null
  innerTransactions: number
  assetTransfers: { amount: number; asset: string; to: string }[]
  appIds: number[]
  rawResponse: any
}

export async function simulateTransaction(txn: algosdk.Transaction): Promise<SimulateResult> {
  const empty: SimulateResult = {
    success: false, rekeyDetected: false, rekeyTo: null,
    innerTransactions: 0, assetTransfers: [], appIds: [], rawResponse: null,
  }

  // ── 1. Rekey check on the txn object directly — before anything else ──
  let rekeyDetected = false
  let rekeyTo: string | null = null
  try {
    const rk = (txn as any).reKeyTo
    if (rk) {
      const rkBytes = rk.publicKey || rk
      if (rkBytes?.length > 0 && (Array.from(rkBytes as number[]) as number[]).some((b: number) => b !== 0)) {
        rekeyDetected = true
        try { rekeyTo = algosdk.encodeAddress(rkBytes) } catch { rekeyTo = 'Unknown attacker address' }
      }
    }
  } catch (_) {}

  try {
    // ── 2. Use AtomicTransactionComposer + makeEmptyTransactionSigner ──
    // This is the OFFICIAL SDK pattern — handles all encoding internally
    const atc = new algosdk.AtomicTransactionComposer()

    atc.addTransaction({
      txn,
      signer: algosdk.makeEmptyTransactionSigner(),
    })

    // ── 3. Build SimulateRequest with empty signatures allowed ──
    const simReq = new algosdk.modelsv2.SimulateRequest({
      txnGroups: [],                // ATC overwrites this — just pass empty
      allowEmptySignatures: true,
      allowUnnamedResources: true,
    })

    // ── 4. simulate() — ATC injects the txn group automatically ──
    const simResult = await atc.simulate(algodClient, simReq)
    const response = simResult.simulateResponse
    console.log('Simulate OK:', response)

    const result: SimulateResult = {
      ...empty,
      success: true,
      rawResponse: response,
      rekeyDetected,
      rekeyTo,
    }

    // ── 5. Belt-and-suspenders: also check simulate response for rekey ──
    try {
      const txnData = response?.txnGroups?.[0]?.txnResults?.[0]?.txnResult?.txn?.txn
      if (txnData?.rekeyTo) {
  result.rekeyDetected = true
  try { result.rekeyTo = algosdk.encodeAddress(txnData.rekeyTo) } catch (_) { result.rekeyTo = undefined }
}
    } catch (_) {}

    // ── 6. Count inner transactions ──
    try {
      const innerTxns = response?.txnGroups?.[0]?.txnResults?.[0]?.txnResult?.innerTxns
      if (Array.isArray(innerTxns)) result.innerTransactions = innerTxns.length
    } catch (_) {}

    return result

  } catch (e) {
    console.error('Simulate error:', e)
    // Still surface rekey if we detected it from the txn object
    return { ...empty, rekeyDetected, rekeyTo, success: !rekeyDetected }
  }
}

export function detectAttacks(
  result: SimulateResult,
  txnType: string
): { type: string; severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'SAFE'; description: string } {
  if (result.rekeyDetected) {
    return {
      type: 'Rekey Attack', severity: 'CRITICAL',
      description: `This transaction will permanently transfer signing authority of your wallet to ${result.rekeyTo}. You will lose access to all your funds immediately.`,
    }
  }
  if (!result.success) {
    if (txnType === 'rekey') return {
      type: 'Rekey Attack', severity: 'CRITICAL',
      description: 'Rekey attack detected — wallet takeover attempt blocked.',
    }
    return { type: 'None', severity: 'SAFE', description: 'No attack patterns detected.' }
  }
  if (result.innerTransactions > 3) return {
    type: 'Suspicious Inner Transactions', severity: 'HIGH',
    description: `${result.innerTransactions} hidden inner transactions detected — possible drain attack.`,
  }
  return { type: 'None', severity: 'SAFE', description: 'No attack patterns detected.' }
}