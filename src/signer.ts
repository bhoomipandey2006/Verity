import algosdk from 'algosdk'
import { peraWallet } from './wallet'

const ALGOD_URL = 'https://testnet-api.algonode.cloud'
const algodClient = new algosdk.Algodv2('', ALGOD_URL, '')

export async function signAndSubmit(
  txnBase64: string,
  walletAddress: string
): Promise<string> {
  const txnBytes = Buffer.from(txnBase64, 'base64')
  const txn = algosdk.decodeUnsignedTransaction(txnBytes)

  const signedTxns = await peraWallet.signTransaction([[{ txn }]])
  const { txId } = await algodClient.sendRawTransaction(signedTxns[0]).do()
  
  await algosdk.waitForConfirmation(algodClient, txId, 4)
  return txId
}

export function getExplorerUrl(txId: string): string {
  return `https://testnet.algoexplorer.io/tx/${txId}`
}