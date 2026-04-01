import { PeraWalletConnect } from '@perawallet/connect'

export const peraWallet = new PeraWalletConnect({
  shouldShowSignTxnToast: true,
})

export async function connectWallet(): Promise<string> {
  const accounts = await peraWallet.connect()
  peraWallet.connector?.on('disconnect', () => {
    window.location.reload()
  })
  return accounts[0]
}

export async function disconnectWallet(): Promise<void> {
  try {
    peraWallet.disconnect()
  } catch (e) {
    console.log('Disconnect error:', e)
  }
}

export function reconnectWallet(onSuccess: (address: string) => void): void {
  peraWallet.reconnectSession()
    .then((accounts) => {
      if (accounts?.length) {
        peraWallet.connector?.on('disconnect', () => window.location.reload())
        onSuccess(accounts[0])
      }
    })
    .catch(() => {})
}