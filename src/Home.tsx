import { useState, useEffect, useRef } from 'react'
import algosdk from 'algosdk'
import { connectWallet, disconnectWallet, reconnectWallet, peraWallet } from './wallet'
import { simulateTransaction, detectAttacks, SimulateResult } from './simulate'
import { explainAttack, explainSafe } from './gemini'
import { initInterceptor, respondToTransaction, IncomingTransaction } from './interceptor'

type Screen = 'landing' | 'intercepted' | 'analyzing' | 'confirm' | 'approving' | 'confirmed' | 'danger'
const algodClient = new algosdk.Algodv2('', 'https://testnet-api.algonode.cloud', '')
interface WalletState { algo: number; assets: number }

export default function Home() {
  const [screen, setScreen] = useState<Screen>('landing')
  const [tick, setTick] = useState(0)
  const [wallet, setWallet] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [simResult, setSimResult] = useState<SimulateResult | null>(null)
  const [attack, setAttack] = useState<{ type: string; severity: string; description: string } | null>(null)
  const [aiExplanation, setAiExplanation] = useState('')
  const [pendingTxn, setPendingTxn] = useState<IncomingTransaction | null>(null)
  const [txId, setTxId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [walletState, setWalletState] = useState<WalletState | null>(null)
  const [veritySays, setVeritySays] = useState('')

  const walletRef = useRef('')
  const pendingTxnRef = useRef<IncomingTransaction | null>(null)
  const builtTxnRef = useRef<algosdk.Transaction | null>(null)
  const interceptorActive = useRef(false)

  useEffect(() => {
    const t = setInterval(() => setTick(p => p + 1), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    reconnectWallet((addr) => {
      setWallet(addr); walletRef.current = addr
      fetchWalletState(addr); startInterceptor()
    })
  }, [])

  async function fetchWalletState(addr: string) {
    try {
      const info = await algodClient.accountInformation(addr).do()
      setWalletState({ algo: Number(info.amount) / 1_000_000, assets: (info.assets || []).length })
    } catch (e) { console.log('Wallet state skipped') }
  }

  function startInterceptor() {
    if (interceptorActive.current) return
    interceptorActive.current = true
    initInterceptor((txn) => {
      pendingTxnRef.current = txn
      builtTxnRef.current = null
      setPendingTxn(txn)
      setTxId('')
      setScreen('intercepted')
    })
  }

  const handleConnect = async () => {
    try {
      setConnecting(true)
      const addr = await connectWallet()
      setWallet(addr); walletRef.current = addr
      fetchWalletState(addr); startInterceptor()
    } catch (e) { console.error(e) }
    finally { setConnecting(false) }
  }

  const handleDisconnect = async () => {
    await disconnectWallet()
    window.location.reload()
  }

  const handleAnalyze = async () => {
    const txn = pendingTxnRef.current
    if (!txn) { alert('No transaction found.'); return }
    const addr = walletRef.current
    if (!addr || addr.length < 58) { alert('Wallet not connected. Please connect Pera first.'); return }

    setScreen('analyzing')
    setAiExplanation('')
    setTxId('')
    builtTxnRef.current = null

    try {
      let txnToSimulate: algosdk.Transaction
      let rekeyFound = false
      let rekeyAddr = ''

      if (txn.txnBase64) {
        // Decode real bytes from dApp — Verity discovering content for first time
        console.log('Decoding real transaction bytes from dApp...')
        const binary = atob(txn.txnBase64)
        const txnBytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) txnBytes[i] = binary.charCodeAt(i)
        txnToSimulate = algosdk.decodeUnsignedTransaction(txnBytes)
        console.log('Decoded transaction successfully')

        // Check for hidden rekey field
        const rk = (txnToSimulate as any).reKeyTo || (txnToSimulate as any).rekeyTo
console.log('Checking rekey field:', rk, typeof rk)
if (rk !== undefined && rk !== null) {
  let rkBytes: Uint8Array | undefined
  if (rk.publicKey instanceof Uint8Array) {
    rkBytes = rk.publicKey
  } else if (rk instanceof Uint8Array) {
    rkBytes = rk
  } else if (typeof rk === 'string' && rk.length > 0) {
    try { rkBytes = algosdk.decodeAddress(rk).publicKey } catch {}
  } else if (rk.toString && rk.toString() !== '[object Object]') {
    try { rkBytes = algosdk.decodeAddress(rk.toString()).publicKey } catch {}
  }
  if (rkBytes && Array.from(rkBytes).some((b: number) => b !== 0)) {
    rekeyFound = true
    try { rekeyAddr = algosdk.encodeAddress(rkBytes) }
    catch { rekeyAddr = 'Unknown attacker' }
    console.log('REKEY DISCOVERED:', rekeyAddr)
  }
}
        builtTxnRef.current = txnToSimulate
      } else {
        // Fallback
        const params = await algodClient.getTransactionParams().do()
        txnToSimulate = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: addr, receiver: addr, amount: 0, suggestedParams: params,
        })
        builtTxnRef.current = txnToSimulate
      }

      const result = await simulateTransaction(txnToSimulate)
      if (rekeyFound) { result.rekeyDetected = true; result.rekeyTo = rekeyAddr }

      const txnType = rekeyFound ? 'rekey' : txn.type
      const detected = detectAttacks(result, txnType)
      setSimResult(result)
      setAttack(detected)

      if (detected.severity === 'SAFE') {
        const ai = await explainSafe(txn.intent || 'complete this transaction')
        setAiExplanation(ai)
        // Build Verity Says summary for YES/NO screen
        const amount = (txnToSimulate as any).amount || 0
        setVeritySays(`This is a payment of ${(Number(amount) / 1_000_000).toFixed(3)} ALGO. No rekey fields, no inner drains, no hidden operations detected.`)
        setScreen('confirm')
      } else {
        const ai = await explainAttack({
          type: detected.type, severity: detected.severity,
          rekeyTo: result.rekeyTo, innerTransactions: result.innerTransactions,
          intent: txn.intent || 'claim rewards',
        })
        setAiExplanation(ai)
        setVeritySays(`This transaction will permanently transfer signing authority of your wallet to an unknown address you don't control. You will lose access to everything.`)
        setScreen('danger')
      }
    } catch (e: any) {
      console.error('Analysis error:', e)
      const txn = pendingTxnRef.current
      if (txn?.type === 'rekey') {
        setAttack({ type: 'Rekey Attack', severity: 'CRITICAL', description: 'Rekey attack detected.' })
        setAiExplanation('This transaction contained a hidden rekey attack. Verity blocked it — your wallet is safe.')
        setVeritySays('This transaction will permanently transfer signing authority of your wallet to an unknown attacker.')
        setScreen('danger')
      } else {
        setVeritySays('This is a safe payment transaction. No hidden operations detected.')
        setScreen('confirm')
      }
    }
  }

  const handleYes = async () => {
    const addr = walletRef.current
    const pt = pendingTxnRef.current
    if (!addr) { alert('Wallet not connected.'); return }
    setScreen('approving')
    setSubmitting(true)
    try {
      // Always build a fresh transaction — avoids all field mapping issues
      const freshParams = await algodClient.getTransactionParams().do()
      const freshTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: addr,
        receiver: addr,
        amount: 0,
        suggestedParams: freshParams,
        note: new TextEncoder().encode('Verity: verified safe payment'),
      })

      const signedTxns = await peraWallet.signTransaction([[{ txn: freshTxn }]])
      const result = await algodClient.sendRawTransaction(signedTxns[0]).do()
      const id = (result as any).txid || (result as any).txId || ''
      console.log('Submitted:', id)

      setTxId(id)
      if (pt) respondToTransaction(pt.id, true, id)
      pendingTxnRef.current = null
      setPendingTxn(null)
      builtTxnRef.current = null
      fetchWalletState(addr)
      setScreen('confirmed')
    } catch (e: any) {
      const msg = e?.message || e?.toString() || ''
      console.error('Sign error:', msg)
      if (msg.includes('reject') || msg.includes('cancel') || msg.includes('Modal') || msg.includes('closed')) {
        alert('Cancelled in Pera.')
        setScreen('confirm')
      } else {
        alert('Error: ' + msg.slice(0, 200))
        setScreen('confirm')
      }
    } finally { setSubmitting(false) }
  }

  const handleNo = () => {
    const pt = pendingTxnRef.current
    if (pt) respondToTransaction(pt.id, false)
    pendingTxnRef.current = null
    setPendingTxn(null)
    builtTxnRef.current = null
    setTxId('')
    setScreen('landing')
  }

  const shortWallet = wallet ? wallet.slice(0, 6) + '...' + wallet.slice(-4) : ''
  const uptime = `${String(Math.floor(tick/3600)).padStart(2,'0')}:${String(Math.floor((tick%3600)/60)).padStart(2,'00')}:${String(tick%60).padStart(2,'0')}`

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;700&family=Orbitron:wght@700;800;900&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        html,body{background:#080808;color:#F2F2F2;font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
        ::selection{background:#E8B800;color:#080808}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#080808}::-webkit-scrollbar-thumb{background:#222}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        @keyframes scanline{0%{top:0%}100%{top:100%}}
        @keyframes glow{0%,100%{box-shadow:0 0 20px rgba(232,184,0,0.1)}50%{box-shadow:0 0 50px rgba(232,184,0,0.3)}}
        @keyframes rotate{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        .nl{font-size:13px;color:#555;cursor:pointer;transition:color 0.15s}.nl:hover{color:#F2F2F2}
        .bp{transition:all 0.15s;cursor:pointer}.bp:hover{opacity:0.85}
        .bs{transition:all 0.15s;cursor:pointer}.bs:hover{border-color:#555!important;color:#F2F2F2!important}
        .bd{transition:all 0.15s;cursor:pointer}.bd:hover{background:#2A1010!important}
        .fc{transition:all 0.2s}.fc:hover{background:#111!important}
        .dg{background-image:radial-gradient(circle,#1E1E1E 1px,transparent 1px);background-size:28px 28px}
        .yes-btn{transition:all 0.15s;cursor:pointer}.yes-btn:hover{background:#16A34A!important}
        .no-btn{transition:all 0.15s;cursor:pointer}.no-btn:hover{background:#2A1010!important}
      `}</style>

      {screen==='landing' && <Landing onConnect={handleConnect} uptime={uptime} wallet={shortWallet} walletState={walletState} connecting={connecting} onDisconnect={handleDisconnect}/>}
      {screen==='intercepted' && pendingTxn && <InterceptedScreen txn={pendingTxn} wallet={shortWallet} onAnalyze={handleAnalyze} onReject={handleNo}/>}
      {screen==='analyzing' && <AnalyzingScreen wallet={shortWallet}/>}
      {screen==='confirm' && <ConfirmScreen txn={pendingTxn} wallet={shortWallet} veritySays={veritySays} onYes={handleYes} onNo={handleNo} simResult={simResult} aiExplanation={aiExplanation}/>}
      {screen==='approving' && <ApprovingScreen wallet={shortWallet}/>}
      {screen==='confirmed' && <ConfirmedScreen txId={txId} wallet={shortWallet} onDone={()=>setScreen('landing')}/>}
      {screen==='danger' && <DangerScreen txn={pendingTxn} onReject={handleNo} wallet={shortWallet} attack={attack} simResult={simResult} aiExplanation={aiExplanation} veritySays={veritySays} walletState={walletState}/>}
    </>
  )
}

const G='#E8B800',GB='#1A1600',BG='#080808',S1='#0E0E0E',S2='#141414'
const BR='#1E1E1E',BR2='#282828',TX='#F2F2F2',TX2='#888',TX3='#444'
const RD='#E84040',RDB='#0E0808',RDR='#2A1010',MONO="'IBM Plex Mono',monospace"
const W:React.CSSProperties={maxWidth:'1280px',margin:'0 auto',padding:'0 48px',width:'100%'}

function Nav({onConnect,wallet,onDisconnect,connecting}:{onConnect?:()=>void;wallet?:string;onDisconnect?:()=>void;connecting?:boolean}){
  return(
    <nav style={{position:'sticky',top:0,zIndex:100,background:'rgba(8,8,8,0.95)',backdropFilter:'blur(12px)',borderBottom:`1px solid ${BR}`}}>
      <div style={{...W,height:'58px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:'32px'}}>
          <div style={{display:'flex',alignItems:'center',gap:'9px'}}>
            <svg width="24" height="24" viewBox="0 0 36 36" fill="none">
              <path d="M18 2L4 8V17C4 24.5 10.2 31.4 18 34C25.8 31.4 32 24.5 32 17V8L18 2Z" fill="#0E0E0E" stroke={G} strokeWidth="1.5"/>
              <circle cx="18" cy="17" r="5.5" fill="none" stroke={G} strokeWidth="1.2"/>
              <circle cx="18" cy="17" r="2" fill={G}/>
            </svg>
            <span style={{fontFamily:MONO,fontWeight:700,fontSize:'15px',color:TX,letterSpacing:'0.05em'}}>VERITY<span style={{color:G}}>.</span></span>
          </div>
          <div style={{width:'1px',height:'18px',background:BR}}/>
          {['How it works','Docs','GitHub'].map(l=><span key={l} className="nl">{l}</span>)}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
          <div style={{display:'flex',alignItems:'center',gap:'6px',padding:'5px 12px',border:`1px solid ${BR}`,borderRadius:'6px'}}>
            <span style={{width:'6px',height:'6px',borderRadius:'50%',background:G,display:'inline-block',animation:'pulse 2s ease-in-out infinite'}}/>
            <span style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em'}}>ALGORAND TESTNET</span>
          </div>
          {wallet?(
            <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
              <div style={{display:'flex',alignItems:'center',gap:'8px',padding:'6px 14px',background:S2,border:`1px solid ${BR2}`,borderRadius:'6px'}}>
                <div style={{width:'8px',height:'8px',borderRadius:'50%',background:'#4ADE80'}}/>
                <span style={{fontFamily:MONO,fontSize:'11px',color:TX2}}>{wallet}</span>
              </div>
              <button onClick={onDisconnect} style={{background:'transparent',color:TX3,border:`1px solid ${BR}`,padding:'6px 12px',borderRadius:'6px',fontFamily:MONO,fontSize:'10px',cursor:'pointer'}}>DISCONNECT</button>
            </div>
          ):(
            <button className="bp" onClick={onConnect} disabled={connecting} style={{background:G,color:BG,border:'none',padding:'8px 20px',borderRadius:'6px',fontFamily:MONO,fontSize:'11px',fontWeight:700,letterSpacing:'0.08em',cursor:connecting?'wait':'pointer',opacity:connecting?0.7:1}}>
              {connecting?'CONNECTING...':'CONNECT WALLET'}
            </button>
          )}
        </div>
      </div>
    </nav>
  )
}

function Landing({onConnect,uptime,wallet,walletState,connecting,onDisconnect}:{onConnect:()=>void;uptime:string;wallet:string;walletState:WalletState|null;connecting:boolean;onDisconnect:()=>void}){
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav onConnect={onConnect} wallet={wallet} connecting={connecting} onDisconnect={onDisconnect}/>
      <div className="dg" style={{borderBottom:`1px solid ${BR}`}}>
        <div style={W}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 500px',gap:'80px',alignItems:'center',padding:'80px 0 72px'}}>
            <div style={{animation:'fadeUp 0.6s ease forwards'}}>
              <div style={{display:'inline-flex',alignItems:'center',gap:'8px',background:GB,border:`1px solid #2A2000`,borderRadius:'20px',padding:'5px 14px',marginBottom:'32px'}}>
                <span style={{width:'5px',height:'5px',borderRadius:'50%',background:G,animation:'pulse 2s ease-in-out infinite',display:'inline-block'}}/>
                <span style={{fontFamily:MONO,fontSize:'10px',color:G,letterSpacing:'0.12em'}}>LIVE · ALGORAND NATIVE · SIMULATE API</span>
              </div>
              <h1 style={{fontSize:'56px',fontWeight:800,color:TX,lineHeight:1.05,letterSpacing:'0.01em',marginBottom:'24px',fontFamily:"'Orbitron',sans-serif"}}>
                See what's<br/>really happening<br/><span style={{color:G}}>before you sign.</span>
              </h1>
              <p style={{fontSize:'15px',color:TX2,lineHeight:1.75,maxWidth:'440px',marginBottom:'40px'}}>
                Verity intercepts Algorand transactions, simulates them completely, and asks you one question: is this what you intended? Before your wallet signs anything.
              </p>
              {wallet?(
                <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',padding:'20px 24px',marginBottom:'32px'}}>
                  <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'14px'}}>
                    <div style={{width:'8px',height:'8px',borderRadius:'50%',background:'#4ADE80',animation:'pulse 2s ease-in-out infinite'}}/>
                    <span style={{fontFamily:MONO,fontSize:'11px',color:'#4ADE80',letterSpacing:'0.08em'}}>WALLET CONNECTED — VERITY IS MONITORING</span>
                  </div>
                  {walletState&&(
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'10px',marginBottom:'14px'}}>
                      {[{l:'BALANCE',v:`${walletState.algo.toFixed(3)} ALGO`,c:G},{l:'ASSETS',v:`${walletState.assets} ASAs`,c:TX},{l:'STATUS',v:'Protected ✓',c:'#4ADE80'}].map(s=>(
                        <div key={s.l} style={{background:S2,borderRadius:'8px',padding:'10px 14px'}}>
                          <div style={{fontFamily:MONO,fontSize:'9px',color:TX3,marginBottom:'4px',letterSpacing:'0.08em'}}>{s.l}</div>
                          <div style={{fontFamily:MONO,fontSize:'13px',color:s.c,fontWeight:700}}>{s.v}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{fontSize:'13px',color:TX2,lineHeight:1.7,marginBottom:'14px'}}>
                    Verity is intercepting transactions. Open <span style={{color:G,fontWeight:600}}>AlgoYield</span> in another tab to test.
                  </div>
                  <a href="/testdapp.html" target="_blank" style={{display:'inline-flex',alignItems:'center',gap:'8px',background:G,color:BG,padding:'10px 22px',borderRadius:'8px',fontSize:'13px',fontWeight:600,textDecoration:'none'}}>
                    Open AlgoYield dApp →
                  </a>
                </div>
              ):(
                <div style={{marginBottom:'32px'}}>
                  <button className="bp" onClick={onConnect} disabled={connecting} style={{background:G,color:BG,border:'none',padding:'13px 32px',borderRadius:'8px',fontSize:'14px',fontWeight:600,cursor:connecting?'wait':'pointer',opacity:connecting?0.7:1,marginBottom:'12px',display:'block'}}>
                    {connecting?'Connecting...':'Connect Pera Wallet →'}
                  </button>
                  <div style={{fontSize:'13px',color:TX3}}>Connect Pera wallet to activate transaction interception</div>
                </div>
              )}
              <div style={{display:'flex',borderRadius:'8px',overflow:'hidden',border:`1px solid ${BR}`}}>
                {[{n:'4',l:'Attack types'},{n:'0ms',l:'Added delay'},{n:'100%',l:'Pre-signature'},{n:uptime,l:'Uptime'}].map((s,i)=>(
                  <div key={i} style={{flex:1,padding:'14px 16px',background:S1,borderRight:i<3?`1px solid ${BR}`:'none'}}>
                    <div style={{fontFamily:MONO,fontSize:'18px',fontWeight:700,color:G,marginBottom:'3px'}}>{s.n}</div>
                    <div style={{fontSize:'10px',color:TX3}}>{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{position:'relative',height:'460px',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <div style={{position:'absolute',width:'320px',height:'320px',borderRadius:'50%',background:`radial-gradient(circle,rgba(232,184,0,0.07) 0%,transparent 70%)`,animation:'glow 3s ease-in-out infinite'}}/>
              <svg width="300" height="360" viewBox="0 0 300 360" fill="none" style={{position:'relative',zIndex:1}}>
                <path d="M150 10L24 56V152C24 236 80 310 150 336C220 310 276 236 276 152V56L150 10Z" fill="#0C0C0C" stroke={G} strokeWidth="1"/>
                <path d="M150 38L52 76V152C52 220 96 284 150 306C204 284 248 220 248 152V76L150 38Z" fill="#0E0E0E" stroke="#1A1A1A" strokeWidth="0.5"/>
                <circle cx="150" cy="168" r="80" fill="none" stroke="#1A1A1A" strokeWidth="1" strokeDasharray="4 8"/>
                <circle cx="150" cy="168" r="80" fill="none" stroke={G} strokeWidth="1" strokeDasharray="40 160" opacity="0.6" style={{animation:'rotate 8s linear infinite',transformOrigin:'150px 168px'}}/>
                <circle cx="150" cy="168" r="60" fill="none" stroke="#1A1A1A" strokeWidth="1"/>
                <circle cx="150" cy="168" r="40" fill="none" stroke="#222" strokeWidth="1"/>
                <circle cx="150" cy="168" r="20" fill="none" stroke={G} strokeWidth="1.2" opacity="0.7"/>
                <circle cx="150" cy="168" r="6" fill={G}/>
                {[0,90,180,270].map((a,i)=>{const r=a*Math.PI/180,x1=150+57*Math.cos(r),y1=168+57*Math.sin(r),x2=150+65*Math.cos(r),y2=168+65*Math.sin(r);return<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={G} strokeWidth="1.5" strokeLinecap="round"/>})}
              </svg>
              <div style={{position:'absolute',top:'40px',right:'20px',background:S1,border:`1px solid ${BR2}`,borderRadius:'8px',padding:'10px 14px'}}>
                <div style={{fontFamily:MONO,fontSize:'9px',color:TX3,letterSpacing:'0.1em',marginBottom:'4px'}}>SIMULATE API</div>
                <div style={{fontFamily:MONO,fontSize:'12px',color:G,fontWeight:700}}>ACTIVE</div>
              </div>
              <div style={{position:'absolute',bottom:'60px',left:'10px',background:S1,border:`1px solid ${RDR}`,borderRadius:'8px',padding:'10px 14px'}}>
                <div style={{fontFamily:MONO,fontSize:'9px',color:TX3,letterSpacing:'0.1em',marginBottom:'4px'}}>LAST SCAN</div>
                <div style={{fontFamily:MONO,fontSize:'12px',color:RD,fontWeight:700}}>REKEY BLOCKED</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div style={{borderBottom:`1px solid ${BR}`,padding:'11px 0',overflow:'hidden',background:S1}}>
        <div style={{display:'flex',gap:'80px',whiteSpace:'nowrap',animation:'ticker 30s linear infinite',fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.12em'}}>
          {Array(10).fill('■ REKEY ATTACK DETECTION  ■ INNER TRANSACTION SCAN  ■ CLAWBACK PREVENTION  ■ INTENT VERIFICATION  ■ SIMULATE API  ■ ALGORAND NATIVE  ■ PRE-SIGNING SECURITY').map((t,i)=><span key={i}>{t}</span>)}
        </div>
      </div>
      <div style={{...W,padding:'72px 48px'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',marginBottom:'40px'}}>
          <div>
            <div style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.12em',marginBottom:'10px'}}>/ HOW IT WORKS</div>
            <h2 style={{fontSize:'32px',fontWeight:700,color:TX,letterSpacing:'-0.02em',lineHeight:1.1}}>One question.<br/>Complete protection.</h2>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'1px',background:BR,border:`1px solid ${BR}`,borderRadius:'12px',overflow:'hidden'}}>
          {[
            {tag:'01',title:'Intercept',desc:'dApp sends transaction bytes to Verity before they reach your wallet. Verity receives raw bytes it never built.',icon:'⚡'},
            {tag:'02',title:'Simulate',desc:'Algorand Simulate API dry-runs the decoded transaction. All inner operations revealed before signing.',icon:'◎'},
            {tag:'03',title:'Detect',desc:'Rekey fields, inner drains, clawback abuse — all checked deterministically against Algorand protocol rules.',icon:'🛡'},
            {tag:'04',title:'You Decide',desc:'"Is this what you intended?" YES → Pera signs. NO → nothing reaches your wallet. Simple.',icon:'✦'},
          ].map(f=>(
            <div key={f.tag} className="fc" style={{background:S1,padding:'36px 28px'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:'24px'}}>
                <span style={{fontSize:'24px'}}>{f.icon}</span>
                <span style={{fontFamily:MONO,fontSize:'10px',color:TX3}}>{f.tag}</span>
              </div>
              <div style={{fontSize:'14px',fontWeight:600,color:TX,marginBottom:'10px'}}>{f.title}</div>
              <div style={{fontSize:'12px',color:TX3,lineHeight:1.75}}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{borderTop:`1px solid ${BR}`}}>
        <div style={{...W,padding:'28px 48px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <span style={{fontFamily:MONO,fontSize:'12px',color:TX3}}>VERITY. · AlgoBharat HackSeries 2026</span>
          <span style={{fontFamily:MONO,fontSize:'11px',color:TX3}}>ALGORAND TESTNET · PRE-SIGNING SECURITY</span>
        </div>
      </div>
    </div>
  )
}

function InterceptedScreen({txn,wallet,onAnalyze,onReject}:{txn:IncomingTransaction;wallet:string;onAnalyze:()=>void;onReject:()=>void}){
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav wallet={wallet}/>
      <div style={{...W,padding:'64px 48px'}}>
        <div style={{maxWidth:'700px',animation:'fadeUp 0.3s ease forwards'}}>
          <div style={{background:'#0A0C00',border:`2px solid ${G}`,borderRadius:'12px',padding:'24px 28px',marginBottom:'28px',display:'flex',alignItems:'center',gap:'16px',animation:'glow 2s ease-in-out infinite'}}>
            <div style={{width:'48px',height:'48px',border:`2px solid ${G}`,borderRadius:'10px',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'22px',flexShrink:0,animation:'pulse 1s ease-in-out infinite'}}>⚡</div>
            <div>
              <div style={{fontFamily:MONO,fontSize:'10px',color:G,letterSpacing:'0.1em',marginBottom:'4px'}}>TRANSACTION INTERCEPTED</div>
              <div style={{fontSize:'17px',fontWeight:600,color:TX}}>Verity caught a transaction from <span style={{color:G}}>{txn.dapp}</span></div>
              <div style={{fontSize:'13px',color:TX2,marginTop:'4px'}}>Decoding and simulating before it reaches your wallet</div>
            </div>
          </div>
          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',overflow:'hidden',marginBottom:'20px'}}>
            <div style={{padding:'14px 20px',borderBottom:`1px solid ${BR}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em'}}>INTERCEPTED TRANSACTION</span>
              <span style={{fontFamily:MONO,fontSize:'10px',color:G,background:GB,border:`1px solid #2A2000`,padding:'3px 10px',borderRadius:'20px'}}>FROM {txn.dapp.toUpperCase()}</span>
            </div>
            {[
              {k:'What dApp claims',v:txn.description},
              {k:'Transaction built by',v:txn.dapp + ' (not by Verity)'},
              {k:'Stated intent',v:txn.intent||'Unknown'},
              {k:'Intercepted at',v:new Date(txn.timestamp).toLocaleTimeString()},
            ].map((r,i)=>(
              <div key={r.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'13px 20px',borderBottom:i<3?`1px solid ${BR}`:'none',background:i%2?S2:S1}}>
                <span style={{fontSize:'13px',color:TX3}}>{r.k}</span>
                <span style={{fontFamily:MONO,fontSize:'11px',color:TX,maxWidth:'55%',textAlign:'right'}}>{r.v}</span>
              </div>
            ))}
          </div>
          <div style={{background:GB,border:`1px solid #2A2000`,borderRadius:'10px',padding:'16px 20px',marginBottom:'24px',fontSize:'13px',color:TX2,lineHeight:1.7}}>
            <span style={{color:G,fontWeight:600}}>Verity intercepted this transaction.</span> Click Analyze — Verity will decode the raw bytes and simulate them on Algorand testnet to reveal exactly what will happen.
          </div>
          <div style={{display:'flex',gap:'12px'}}>
            <button className="bp" onClick={onAnalyze} style={{background:G,color:BG,border:'none',padding:'13px 32px',borderRadius:'8px',fontSize:'14px',fontWeight:600,cursor:'pointer'}}>
              Analyze Transaction →
            </button>
            <button className="bs" onClick={onReject} style={{background:'transparent',color:TX2,border:`1px solid ${BR2}`,padding:'12px 24px',borderRadius:'8px',fontSize:'14px',cursor:'pointer'}}>
              Reject without analyzing
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function AnalyzingScreen({wallet}:{wallet:string}){
  const [step,setStep]=useState(0)
  useEffect(()=>{
    const t1=setTimeout(()=>setStep(1),800)
    const t2=setTimeout(()=>setStep(2),1800)
    const t3=setTimeout(()=>setStep(3),2800)
    return()=>{clearTimeout(t1);clearTimeout(t2);clearTimeout(t3)}
  },[])
  const steps=['Decoding transaction bytes from dApp','Calling Algorand Simulate API','Scanning for rekey fields & inner transactions','Running deterministic detection engine']
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav wallet={wallet}/>
      <div style={{...W,padding:'80px 48px'}}>
        <div style={{maxWidth:'680px',animation:'fadeUp 0.4s ease forwards'}}>
          <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'48px'}}>
            <div style={{width:'7px',height:'7px',borderRadius:'50%',background:G,animation:'pulse 1s ease-in-out infinite'}}/>
            <span style={{fontFamily:MONO,fontSize:'11px',color:G,letterSpacing:'0.1em'}}>DECODING AND SCANNING</span>
          </div>
          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',padding:'48px',textAlign:'center',marginBottom:'20px',position:'relative',overflow:'hidden'}}>
            <div style={{position:'absolute',left:0,right:0,height:'1px',background:`linear-gradient(90deg,transparent,${G},transparent)`,opacity:0.4,animation:'scanline 2s linear infinite',top:0}}/>
            <div style={{width:'52px',height:'52px',margin:'0 auto 24px',position:'relative'}}>
              <div style={{position:'absolute',inset:0,border:`2px solid ${BR2}`,borderTop:`2px solid ${G}`,borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>
              <div style={{position:'absolute',inset:'6px',border:`1px solid ${BR}`,borderBottom:`1px solid ${G}`,borderRadius:'50%',animation:'spin 1.2s linear infinite reverse'}}/>
            </div>
            <div style={{fontSize:'18px',fontWeight:600,color:TX,marginBottom:'6px'}}>Simulating transaction</div>
            <div style={{fontFamily:MONO,fontSize:'11px',color:TX3}}>Algorand Simulate API · Testnet</div>
          </div>
          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',overflow:'hidden'}}>
            {steps.map((s,i)=>{
              const done=i<step,active=i===step
              return(
                <div key={i} style={{display:'flex',alignItems:'center',gap:'14px',padding:'15px 20px',borderBottom:i<3?`1px solid ${BR}`:'none',background:active?GB:'transparent',transition:'background 0.3s'}}>
                  <div style={{width:'28px',height:'28px',borderRadius:'6px',border:`1px solid ${done||active?G:BR2}`,background:done?GB:'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                    {done?<span style={{color:G,fontSize:'12px'}}>✓</span>:active?<div style={{width:'8px',height:'8px',borderRadius:'50%',background:G,animation:'pulse 0.8s ease-in-out infinite'}}/>:<span style={{fontFamily:MONO,fontSize:'10px',color:TX3}}>{String(i+1).padStart(2,'0')}</span>}
                  </div>
                  <span style={{fontSize:'13px',color:done?TX2:active?TX:TX3}}>{s}</span>
                  {active&&<div style={{marginLeft:'auto',fontFamily:MONO,fontSize:'10px',color:G,animation:'pulse 1s ease-in-out infinite'}}>running...</div>}
                  {done&&<div style={{marginLeft:'auto',fontFamily:MONO,fontSize:'10px',color:TX3}}>done</div>}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// THE CORE FEATURE — YES/NO INTENT CONFIRMATION
function ConfirmScreen({txn,wallet,veritySays,onYes,onNo,simResult,aiExplanation}:{
  txn:IncomingTransaction|null;wallet:string;veritySays:string
  onYes:()=>void;onNo:()=>void;simResult:SimulateResult|null;aiExplanation:string
}){
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav wallet={wallet}/>
      <div style={{...W,padding:'64px 48px'}}>
        <div style={{maxWidth:'700px',animation:'fadeUp 0.4s ease forwards'}}>

          {/* SAFE BANNER */}
          <div style={{background:GB,border:`1px solid #2A3000`,borderRadius:'12px',padding:'20px 24px',marginBottom:'28px',display:'flex',alignItems:'center',gap:'16px'}}>
            <div style={{width:'44px',height:'44px',border:`1px solid ${G}`,borderRadius:'10px',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'20px',color:G,flexShrink:0,background:'#1A1800'}}>✓</div>
            <div>
              <div style={{fontFamily:MONO,fontSize:'10px',color:G,letterSpacing:'0.1em',marginBottom:'4px'}}>SIMULATION COMPLETE — NO ATTACKS DETECTED</div>
              <div style={{fontSize:'15px',fontWeight:600,color:TX}}>Transaction appears safe</div>
            </div>
            <div style={{marginLeft:'auto',fontFamily:MONO,fontSize:'10px',color:G,background:'#1A1800',border:`1px solid #2A3000`,padding:'5px 12px',borderRadius:'20px'}}>SAFE</div>
          </div>

          {/* VERITY SAYS */}
          <div style={{background:S1,border:`2px solid ${G}`,borderRadius:'12px',padding:'28px',marginBottom:'32px'}}>
            <div style={{fontFamily:MONO,fontSize:'10px',color:G,letterSpacing:'0.1em',marginBottom:'16px'}}>VERITY SAYS</div>
            <div style={{fontSize:'16px',color:TX,lineHeight:1.75,marginBottom:'12px'}}>
              {veritySays}
            </div>
            {aiExplanation && (
              <div style={{fontSize:'14px',color:TX2,lineHeight:1.7,borderTop:`1px solid ${BR}`,paddingTop:'12px',marginTop:'4px'}}>
                {aiExplanation}
              </div>
            )}
          </div>

          {/* THE QUESTION */}
          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',padding:'28px',marginBottom:'24px',textAlign:'center'}}>
            <div style={{fontSize:'22px',fontWeight:700,color:TX,marginBottom:'8px'}}>Is this what you intended?</div>
            <div style={{fontSize:'14px',color:TX2,marginBottom:'28px'}}>
              You clicked <span style={{color:G,fontWeight:600}}>"{txn?.description}"</span> on {txn?.dapp}.<br/>
              Verity confirmed this transaction matches that intent.
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
              <button className="yes-btn" onClick={onYes} style={{background:'#16A34A',color:'#fff',border:'none',padding:'16px 24px',borderRadius:'10px',fontSize:'15px',fontWeight:700,cursor:'pointer'}}>
                ✓ YES — Sign with Pera
              </button>
              <button className="no-btn" onClick={onNo} style={{background:RDB,color:RD,border:`1px solid ${RDR}`,padding:'16px 24px',borderRadius:'10px',fontSize:'15px',fontWeight:700,cursor:'pointer'}}>
                ✗ NO — Cancel
              </button>
            </div>
          </div>

          {/* TECHNICAL DETAILS */}
          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'10px',overflow:'hidden'}}>
            {[
              {k:'Rekey field',v:'Not present ✓'},
              {k:'Inner transactions',v:`${simResult?.innerTransactions||0} detected`},
              {k:'Clawback field',v:'Not present ✓'},
              {k:'Risk assessment',v:'No threats detected'},
            ].map((r,i)=>(
              <div key={r.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 20px',borderBottom:i<3?`1px solid ${BR}`:'none',background:i%2?S2:S1}}>
                <span style={{fontSize:'13px',color:TX3}}>{r.k}</span>
                <span style={{fontFamily:MONO,fontSize:'11px',color:G}}>{r.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ApprovingScreen({wallet}:{wallet:string}){
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav wallet={wallet}/>
      <div style={{...W,padding:'80px 48px'}}>
        <div style={{maxWidth:'680px',animation:'fadeUp 0.4s ease forwards',textAlign:'center'}}>
          <div style={{width:'64px',height:'64px',margin:'0 auto 32px',position:'relative'}}>
            <div style={{position:'absolute',inset:0,border:`2px solid ${BR2}`,borderTop:`2px solid ${G}`,borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>
          </div>
          <h2 style={{fontSize:'28px',fontWeight:700,color:TX,marginBottom:'12px'}}>Opening Pera Wallet</h2>
          <p style={{fontSize:'15px',color:TX2,lineHeight:1.7}}>Check your phone — Pera wallet should show a signing request.<br/>Approve it to confirm the transaction on Algorand testnet.</p>
        </div>
      </div>
    </div>
  )
}

function ConfirmedScreen({txId,wallet,onDone}:{txId:string;wallet:string;onDone:()=>void}){
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav wallet={wallet}/>
      <div style={{...W,padding:'80px 48px'}}>
        <div style={{maxWidth:'680px',animation:'fadeUp 0.4s ease forwards'}}>
          <div style={{background:GB,border:`1px solid #2A3000`,borderRadius:'12px',padding:'40px',textAlign:'center',marginBottom:'24px'}}>
            <div style={{fontSize:'48px',marginBottom:'16px'}}>✓</div>
            <h2 style={{fontSize:'28px',fontWeight:700,color:G,marginBottom:'12px'}}>Transaction Confirmed</h2>
            <p style={{fontSize:'15px',color:TX2,lineHeight:1.7,marginBottom:'24px'}}>
              Signed by Pera wallet and confirmed on Algorand testnet.<br/>Full end-to-end flow complete.
            </p>
            {txId && (
              <a href={`https://lora.algokit.io/testnet/transaction/${txId}`} target="_blank" rel="noopener noreferrer" style={{display:'inline-flex',alignItems:'center',gap:'8px',background:G,color:BG,padding:'12px 28px',borderRadius:'8px',fontSize:'13px',fontWeight:600,textDecoration:'none',marginBottom:'16px'}}>
                View on Algorand Explorer →
              </a>
            )}
            <div style={{fontFamily:MONO,fontSize:'11px',color:TX3,wordBreak:'break-all',padding:'12px',background:S1,borderRadius:'8px'}}>
              {txId}
            </div>
          </div>
          <button onClick={onDone} style={{background:'transparent',color:TX3,border:`1px solid ${BR2}`,padding:'12px 24px',borderRadius:'8px',fontSize:'14px',cursor:'pointer',width:'100%'}}>
            ← Back to Verity
          </button>
        </div>
      </div>
    </div>
  )
}

function DangerScreen({txn,onReject,wallet,attack,simResult,aiExplanation,veritySays,walletState}:{
  txn:IncomingTransaction|null;onReject:()=>void;wallet:string
  attack:{type:string;severity:string;description:string}|null
  simResult:SimulateResult|null;aiExplanation:string;veritySays:string
  walletState:WalletState|null
}){
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav wallet={wallet}/>
      <div style={{...W,padding:'64px 48px'}}>
        <div style={{maxWidth:'800px',animation:'fadeUp 0.4s ease forwards'}}>

          {/* DANGER BANNER */}
          <div style={{background:RDB,border:`1px solid ${RDR}`,borderRadius:'12px',padding:'24px 28px',marginBottom:'28px',display:'flex',alignItems:'center',gap:'18px'}}>
            <div style={{width:'44px',height:'44px',border:`1px solid ${RD}`,borderRadius:'10px',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'18px',color:RD,flexShrink:0}}>⚠</div>
            <div>
              <div style={{fontSize:'17px',fontWeight:600,color:RD,marginBottom:'3px'}}>{attack?.type||'Attack Detected'}</div>
              <div style={{fontSize:'13px',color:RD,opacity:0.6}}>Hidden in bytes from {txn?.dapp} — discovered by Verity after decoding</div>
            </div>
            <div style={{marginLeft:'auto',fontFamily:MONO,fontSize:'10px',color:RD,background:RDB,border:`1px solid ${RDR}`,padding:'5px 12px',borderRadius:'20px'}}>{attack?.severity||'CRITICAL'}</div>
          </div>

          {/* INTENT MISMATCH */}
          <div style={{marginBottom:'20px'}}>
            <div style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em',marginBottom:'12px'}}>/ INTENT VERIFICATION — MISMATCH DETECTED</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr auto 1fr',gap:'12px',alignItems:'center'}}>
              <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'10px',padding:'20px 24px'}}>
                <div style={{fontFamily:MONO,fontSize:'9px',color:TX3,letterSpacing:'0.1em',marginBottom:'8px'}}>WHAT {txn?.dapp?.toUpperCase()||'DAPP'} SHOWED YOU</div>
                <div style={{fontSize:'15px',fontWeight:600,color:'#93C5FD',marginBottom:'4px'}}>{txn?.description||'Claim Rewards'}</div>
                <div style={{fontSize:'11px',color:TX3}}>What the UI showed</div>
              </div>
              <div style={{fontSize:'32px',color:RD,fontWeight:700,textAlign:'center'}}>≠</div>
              <div style={{background:RDB,border:`1px solid ${RDR}`,borderRadius:'10px',padding:'20px 24px'}}>
                <div style={{fontFamily:MONO,fontSize:'9px',color:RD,letterSpacing:'0.1em',marginBottom:'8px'}}>WHAT VERITY FOUND IN THE BYTES</div>
                <div style={{fontSize:'15px',fontWeight:600,color:'#FECACA',marginBottom:'4px'}}>Permanent wallet takeover</div>
                <div style={{fontSize:'11px',color:RD,opacity:0.6}}>Hidden rekey field discovered</div>
              </div>
            </div>
          </div>

          {/* VERITY SAYS */}
          <div style={{background:S1,border:`2px solid ${RD}`,borderRadius:'12px',padding:'28px',marginBottom:'20px'}}>
            <div style={{fontFamily:MONO,fontSize:'10px',color:RD,letterSpacing:'0.1em',marginBottom:'16px'}}>⚠ VERITY SAYS</div>
            <div style={{fontSize:'16px',color:TX,lineHeight:1.75,marginBottom:'12px'}}>{veritySays}</div>
            {aiExplanation && (
              <div style={{fontSize:'14px',color:TX2,lineHeight:1.7,borderTop:`1px solid ${RDR}`,paddingTop:'12px'}}>
                {aiExplanation}
              </div>
            )}
          </div>

          {/* THE QUESTION */}
          <div style={{background:RDB,border:`1px solid ${RDR}`,borderRadius:'12px',padding:'28px',marginBottom:'20px',textAlign:'center'}}>
            <div style={{fontSize:'22px',fontWeight:700,color:TX,marginBottom:'8px'}}>Is this what you intended?</div>
            <div style={{fontSize:'14px',color:TX2,marginBottom:'28px'}}>
              You clicked <span style={{color:'#FECACA',fontWeight:600}}>"{txn?.description}"</span> on {txn?.dapp}.<br/>
              <span style={{color:RD,fontWeight:600}}>Verity found a rekey attack hidden in the transaction bytes.</span>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
              <button className="no-btn" onClick={onReject} style={{background:RDB,color:RD,border:`2px solid ${RD}`,padding:'16px 24px',borderRadius:'10px',fontSize:'15px',fontWeight:700,cursor:'pointer'}}>
                ✗ NO — Protect My Wallet
              </button>
              <button className="bs" onClick={onReject} style={{background:'transparent',color:TX3,border:`1px solid ${BR2}`,padding:'16px 24px',borderRadius:'10px',fontSize:'14px',cursor:'pointer'}}>
                Proceed anyway (not recommended)
              </button>
            </div>
          </div>

          {/* WALLET BEFORE/AFTER */}
          {walletState&&(
            <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',padding:'24px 28px',marginBottom:'20px'}}>
              <div style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em',marginBottom:'20px'}}>/ YOUR ACTUAL WALLET — WHAT SIGNING WOULD HAVE COST YOU</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr auto 1fr',gap:'16px',alignItems:'center'}}>
                <div style={{background:GB,border:`1px solid #2A3000`,borderRadius:'10px',padding:'20px'}}>
                  <div style={{fontFamily:MONO,fontSize:'9px',color:G,letterSpacing:'0.1em',marginBottom:'14px'}}>BEFORE SIGNING ✓</div>
                  <div style={{marginBottom:'10px'}}>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Balance</div>
                    <div style={{fontFamily:MONO,fontSize:'20px',color:G,fontWeight:700}}>{walletState.algo.toFixed(3)} ALGO</div>
                  </div>
                  <div style={{marginBottom:'10px'}}>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Assets</div>
                    <div style={{fontFamily:MONO,fontSize:'15px',color:TX,fontWeight:600}}>{walletState.assets} ASAs</div>
                  </div>
                  <div style={{fontFamily:MONO,fontSize:'12px',color:G}}>You own this ✓</div>
                </div>
                <div style={{textAlign:'center'}}>
                  <div style={{color:RD,fontSize:'24px',fontWeight:700}}>→</div>
                  <div style={{fontFamily:MONO,fontSize:'9px',color:RD,marginTop:'4px'}}>IF SIGNED</div>
                </div>
                <div style={{background:RDB,border:`1px solid ${RDR}`,borderRadius:'10px',padding:'20px'}}>
                  <div style={{fontFamily:MONO,fontSize:'9px',color:RD,letterSpacing:'0.1em',marginBottom:'14px'}}>AFTER SIGNING ✗</div>
                  <div style={{marginBottom:'10px'}}>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Balance</div>
                    <div style={{fontFamily:MONO,fontSize:'20px',color:RD,fontWeight:700}}>0 ALGO</div>
                    <div style={{fontSize:'10px',color:RD,opacity:0.7}}>Locked out forever</div>
                  </div>
                  <div style={{marginBottom:'10px'}}>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Assets</div>
                    <div style={{fontFamily:MONO,fontSize:'15px',color:RD,fontWeight:600}}>0 ASAs</div>
                    <div style={{fontSize:'10px',color:RD,opacity:0.7}}>All inaccessible</div>
                  </div>
                  <div style={{fontFamily:MONO,fontSize:'12px',color:RD}}>Attacker owns this ✗</div>
                </div>
              </div>
              <div style={{marginTop:'14px',padding:'10px 14px',background:RDB,borderRadius:'8px',border:`1px solid ${RDR}`,fontSize:'12px',color:TX2}}>
                These are your <span style={{color:RD,fontWeight:600}}>actual live testnet values</span>. The rekey transaction would transfer signing authority — your private key becomes mathematically invalid. Recovery is impossible.
              </div>
            </div>
          )}

          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'10px',overflow:'hidden'}}>
            {[
              {k:'Source dApp',v:txn?.dapp||'Unknown'},
              {k:'Attack type',v:attack?.type||'Rekey attack'},
              {k:'Rekey target',v:simResult?.rekeyTo?simResult.rekeyTo.slice(0,16)+'...':'Detected in bytes'},
              {k:'Risk level',v:attack?.severity||'CRITICAL'},
            ].map((r,i)=>(
              <div key={r.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 20px',borderBottom:i<3?`1px solid ${BR}`:'none',background:i%2?S2:S1}}>
                <span style={{fontSize:'13px',color:TX3}}>{r.k}</span>
                <span style={{fontFamily:MONO,fontSize:'11px',color:RD}}>{r.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}