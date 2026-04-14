import { Web3Wallet, IWeb3Wallet } from '@walletconnect/web3wallet'
import { Core } from '@walletconnect/core'

const PROJECT_ID = '491914a84cf9f54a4628ee5648bd988c'
const ALGO_CHAIN = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe'
const WC_URI_CHANNEL = 'wc-uri-channel'
const TXID_CHANNEL = 'verity-txid'

let web3wallet: IWeb3Wallet | null = null
let uriChannel: BroadcastChannel | null = null

export async function initWCWallet(
  walletAddress: string,
  onSignRequest: (txnBytes: Uint8Array, wcTopic: string, wcId: number, dappName: string) => void
): Promise<void> {
  try {
    const core = new Core({ projectId: PROJECT_ID })

    web3wallet = await Web3Wallet.init({
      core,
      metadata: {
        name: 'Verity',
        description: 'See the truth before you sign.',
        url: 'http://localhost:5173',
        icons: []
      }
    })

    // Auto-approve session proposals from dApps
    web3wallet.on('session_proposal', async ({ id, params }) => {
      const dappName = params.proposer.metadata.name
      console.log('WC: Session proposal from', dappName)
      try {
        await web3wallet!.approveSession({
          id,
          namespaces: {
            algorand: {
              accounts: [`${ALGO_CHAIN}:${walletAddress}`],
              methods: ['algo_signTxn'],
              events: []
            }
          }
        })
        console.log('WC: Session approved for', dappName)
      } catch (e) {
        console.error('WC: Session approval failed:', e)
      }
    })

    // Handle signing requests from dApps
    web3wallet.on('session_request', async ({ topic, params, id }) => {
      console.log('WC: Sign request received')
      try {
        const { request } = params
        if (request.method === 'algo_signTxn') {
          const txnGroup = request.params[0]
          const txnB64 = txnGroup[0].txn
          const txnBytes = Uint8Array.from(Buffer.from(txnB64, 'base64'))

          // Find session to get dApp name
          const sessions = web3wallet!.getActiveSessions()
          const session = sessions[topic]
          const dappName = session?.peer?.metadata?.name || 'Unknown dApp'

          onSignRequest(txnBytes, topic, id, dappName)
        }
      } catch (e) {
        console.error('WC: Sign request error:', e)
      }
    })

    // Listen for URI from AlgoYield
    if (uriChannel) uriChannel.close()
    uriChannel = new BroadcastChannel(WC_URI_CHANNEL)
    uriChannel.onmessage = async (e) => {
      if (e.data.type === 'WC_URI' && e.data.uri) {
        console.log('WC: Received URI from dApp, pairing...')
        try {
          await web3wallet!.pair({ uri: e.data.uri })
          console.log('WC: Pairing complete')
        } catch (err) {
          console.error('WC: Pairing error:', err)
        }
      }
    }

    console.log('WC: Wallet initialized for', walletAddress)
  } catch (e) {
    console.error('WC: Init failed:', e)
    throw e
  }
}

export async function approveWCRequest(
  wcTopic: string,
  wcId: number,
  signedTxnBytes: Uint8Array,
  txId: string
): Promise<void> {
  if (!web3wallet) return
  try {
    await web3wallet.respondSessionRequest({
      topic: wcTopic,
      response: {
        id: wcId,
        jsonrpc: '2.0',
        result: [Buffer.from(signedTxnBytes).toString('base64')]
      }
    })
    // Broadcast txId to AlgoYield
    const bc = new BroadcastChannel(TXID_CHANNEL)
    bc.postMessage({ type: 'TXN_CONFIRMED', txId })
    bc.close()
    console.log('WC: Approved, txId broadcast:', txId)
  } catch (e) {
    console.error('WC: Approve response error:', e)
  }
}

export async function rejectWCRequest(wcTopic: string, wcId: number, isAttack: boolean): Promise<void> {
  if (!web3wallet) return
  try {
    await web3wallet.respondSessionRequest({
      topic: wcTopic,
      response: {
        id: wcId,
        jsonrpc: '2.0',
        error: { code: 4001, message: 'User rejected the request' }
      }
    })
    // Broadcast result to AlgoYield
    const bc = new BroadcastChannel(TXID_CHANNEL)
    bc.postMessage({ type: isAttack ? 'ATTACK_BLOCKED' : 'TXN_REJECTED' })
    bc.close()
    console.log('WC: Rejected request')
  } catch (e) {
    console.error('WC: Reject response error:', e)
  }
}