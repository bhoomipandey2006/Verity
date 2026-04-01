export interface IncomingTransaction {
  id: string
  dapp: string
  txnBase64?: string
  type: string
  from: string
  to: string
  amount: number
  rekeyTo?: string
  note?: string
  description: string
  intent: string
  timestamp: number
}

const CHANNEL = 'verity-interceptor'
let bc: BroadcastChannel | null = null

export function initInterceptor(onTxn: (t: IncomingTransaction) => void) {
  if (bc) bc.close()
  bc = new BroadcastChannel(CHANNEL)
  bc.onmessage = (e) => {
    if (e.data.type === 'TXN_REQUEST') {
      console.log('Interceptor received transaction:', e.data.payload)
      onTxn(e.data.payload)
    }
  }
  console.log('Verity interceptor active on channel:', CHANNEL)
}

export function respondToTransaction(id: string, approved: boolean, txId?: string) {
  if (!bc) return
  bc.postMessage({ type: 'TXN_RESPONSE', payload: { id, approved, txId } })
  console.log('Verity responded:', { id, approved, txId })
}

export function closeInterceptor() {
  if (bc) { bc.close(); bc = null }
}