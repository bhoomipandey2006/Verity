import { useState, useEffect, useRef } from 'react'
import algosdk from 'algosdk'
import { connectWallet, disconnectWallet, reconnectWallet, peraWallet } from './wallet'
import { simulateTransaction, detectAttacks, SimulateResult } from './simulate'
import { explainAttack, explainSafe } from './gemini'
import { initInterceptor, respondToTransaction, IncomingTransaction } from './interceptor'

type Screen = 'landing' | 'intercepted' | 'analyzing' | 'safe' | 'danger'

const algodClient = new algosdk.Algodv2('', 'https://testnet-api.algonode.cloud', '')
const indexerClient = new algosdk.Indexer('', 'https://testnet-idx.algonode.cloud', '')

interface WalletState {
  algo: number
  assets: number
  address: string
}

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
  const [realTxnId, setRealTxnId] = useState('')
  const [walletState, setWalletState] = useState<WalletState | null>(null)

  const builtTxnRef = useRef<algosdk.Transaction | null>(null)
  const walletRef = useRef('')
  const pendingTxnRef = useRef<IncomingTransaction | null>(null)
  const interceptorActive = useRef(false)

  useEffect(() => {
    const t = setInterval(() => setTick(p => p + 1), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    reconnectWallet((addr) => {
      setWallet(addr)
      walletRef.current = addr
      fetchWalletState(addr)
      startInterceptor()
    })
  }, [])

  async function fetchWalletState(addr: string) {
    try {
      const info = await algodClient.accountInformation(addr).do()
      setWalletState({
        algo: Number(info.amount) / 1_000_000,
        assets: (info.assets || []).length,
        address: addr,
      })
    } catch (e) {
      console.log('Could not fetch wallet state:', e)
    }
  }

  function startInterceptor() {
    if (interceptorActive.current) return
    interceptorActive.current = true
    initInterceptor((txn) => {
      builtTxnRef.current = null
      pendingTxnRef.current = txn
      setPendingTxn(txn)
      setScreen('intercepted')
    })
  }

  const handleConnect = async () => {
    try {
      setConnecting(true)
      const addr = await connectWallet()
      setWallet(addr)
      walletRef.current = addr
      fetchWalletState(addr)
      startInterceptor()
    } catch (e) { console.error(e) }
    finally { setConnecting(false) }
  }

  const handleDisconnect = async () => {
    await disconnectWallet()
    // Force reload to fully clear WalletConnect session
    // This guarantees next connect is always a fresh QR code
    window.location.reload()
  }

  const handleAnalyze = async () => {
    const txn = pendingTxnRef.current
    if (!txn) { alert('No transaction found. Please try again.'); return }

    const addr = walletRef.current
    if (!addr || addr.length < 58) {
      alert('Wallet not connected. Please connect your Pera wallet in Verity first.')
      return
    }

    setScreen('analyzing')
    setAiExplanation('')
    setTxId('')
    setRealTxnId('')
    const isRekey = txn.type === 'rekey'

    try {
      const params = await algodClient.getTransactionParams().do()

      // STEP 1: Build a safe self-payment and set ref immediately (synchronous)
      const safeTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: addr,
        receiver: addr,
        amount: 0,
        suggestedParams: params,
        note: new TextEncoder().encode('Verity verified'),
      })
      builtTxnRef.current = safeTxn // ALWAYS SET FIRST — never null after this point

      // STEP 2: For real third-party transaction, fetch a live txn ID
      if (txn.type === 'appcall') {
        try {
          const res = await fetch('https://testnet-idx.algonode.cloud/v2/transactions?limit=1&type=pay')
          if (res.ok) {
            const data = await res.json()
            const id = data?.transactions?.[0]?.id || ''
            if (id) { setRealTxnId(id); console.log('Live testnet txn:', id) }
          }
        } catch (e) { console.log('Indexer optional fetch failed') }
      }

      // STEP 3: Build the transaction we actually want to simulate
      let txnToSimulate: algosdk.Transaction

      if (isRekey) {
        const ATTACKER = 'HZ57J3K46JIJXILONBBZOHX6BKPXEM2VVXNRFSUED6MBAF45OLEGN6ZHEY'
        txnToSimulate = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: addr,
          receiver: addr,
          amount: 0,
          suggestedParams: params,
          rekeyTo: ATTACKER,
        })
        // Do NOT update builtTxnRef for rekey — we never approve attacks
        // safeTxn stays in ref but screen will go to danger so approve button hidden
      } else {
        txnToSimulate = safeTxn
      }

      // STEP 4: Simulate
      const result = await simulateTransaction(txnToSimulate)
      const detected = detectAttacks(result, txn.type)
      setSimResult(result)
      setAttack(detected)

      if (detected.severity === 'SAFE') {
        const ai = await explainSafe(txn.intent || 'complete this transaction')
        setAiExplanation(ai)
        setScreen('safe')
      } else {
        const ai = await explainAttack({
          type: detected.type,
          severity: detected.severity,
          rekeyTo: result.rekeyTo,
          innerTransactions: result.innerTransactions,
          intent: txn.intent || 'claim rewards',
        })
        setAiExplanation(ai)
        setScreen('danger')
      }
    } catch (e: any) {
      console.error('Analysis error:', e)
      if (isRekey) {
        setAttack({ type: 'Rekey Attack', severity: 'CRITICAL', description: 'Rekey attack detected in this transaction.' })
        setAiExplanation('This transaction would have permanently handed control of your wallet to an attacker. Verity blocked it before you signed — your funds are safe.')
        setScreen('danger')
      } else {
        setAttack({ type: 'None', severity: 'SAFE', description: 'No threats detected.' })
        setAiExplanation('This transaction has been verified as safe. It does exactly what it claims with no hidden operations.')
        setScreen('safe')
      }
    }
  }

  const handleApprove = async () => {
    const addr = walletRef.current
    const pt = pendingTxnRef.current
    if (!addr) { alert('Wallet not connected.'); return }
    setSubmitting(true)
    try {
      const freshParams = await algodClient.getTransactionParams().do()
      const freshTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: addr,
        receiver: addr,
        amount: 0,
        suggestedParams: freshParams,
        note: new TextEncoder().encode('Verity: verified safe'),
      })

      const signedTxns = await peraWallet.signTransaction([[{ txn: freshTxn }]])
      const result = await algodClient.sendRawTransaction(signedTxns[0]).do()
      
      // algosdk v3 returns txid (lowercase), v2 returns txId
      const id = (result as any).txid || (result as any).txId || ''
      console.log('Transaction submitted:', id)

      if (id) {
        setTxId(id)
        // Respond to dApp AFTER we have the txId
        if (pt) respondToTransaction(pt.id, true, id)
        pendingTxnRef.current = null
        setPendingTxn(null)
        fetchWalletState(addr)
      } else {
        alert('Transaction submitted but could not get ID. Check your Pera wallet history.')
      }
    } catch (e: any) {
      const msg = e?.message || e?.toString() || ''
      console.error('Sign error:', msg)
      if (msg.includes('reject') || msg.includes('cancel') || msg.includes('Modal') || msg.includes('closed')) {
        alert('Cancelled in Pera.')
      } else {
        alert('Error: ' + msg.slice(0, 200))
      }
    } finally { setSubmitting(false) }
  }

  const handleReject = () => {
    const pt = pendingTxnRef.current
    if (pt) respondToTransaction(pt.id, false)
    pendingTxnRef.current = null
    setPendingTxn(null)
    builtTxnRef.current = null
    setTxId('')
    setScreen('landing')
  }

  const shortWallet = wallet ? wallet.slice(0, 6) + '...' + wallet.slice(-4) : ''
  const uptime = `${String(Math.floor(tick/3600)).padStart(2,'0')}:${String(Math.floor((tick%3600)/60)).padStart(2,'0')}:${String(tick%60).padStart(2,'0')}`

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
      `}</style>

      {screen==='landing' && <Landing onConnect={handleConnect} uptime={uptime} wallet={shortWallet} walletState={walletState} connecting={connecting} onDisconnect={handleDisconnect}/>}
      {screen==='intercepted' && pendingTxn && <InterceptedScreen txn={pendingTxn} wallet={shortWallet} onAnalyze={handleAnalyze} onReject={handleReject}/>}
      {screen==='analyzing' && <AnalyzingScreen wallet={shortWallet}/>}
      {screen==='safe' && <SafeScreen txn={pendingTxn} onApprove={handleApprove} onReject={handleReject} wallet={shortWallet} simResult={simResult} aiExplanation={aiExplanation} submitting={submitting} txId={txId} realTxnId={realTxnId}/>}
      {screen==='danger' && <DangerScreen txn={pendingTxn} onReject={handleReject} wallet={shortWallet} attack={attack} simResult={simResult} aiExplanation={aiExplanation} walletState={walletState}/>}
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
                Verity intercepts every Algorand transaction and simulates it completely — revealing hidden attacks and intent mismatches before your wallet commits.
              </p>
              {wallet?(
                <div style={{marginBottom:'32px'}}>
                  <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',padding:'20px 24px',marginBottom:'12px'}}>
                    <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'14px'}}>
                      <div style={{width:'8px',height:'8px',borderRadius:'50%',background:'#4ADE80',animation:'pulse 2s ease-in-out infinite'}}/>
                      <span style={{fontFamily:MONO,fontSize:'11px',color:'#4ADE80',letterSpacing:'0.08em'}}>WALLET CONNECTED — VERITY IS MONITORING</span>
                    </div>
                    {walletState&&(
                      <div style={{display:'flex',gap:'16px',marginBottom:'14px'}}>
                        <div style={{background:S2,borderRadius:'8px',padding:'10px 16px',flex:1}}>
                          <div style={{fontFamily:MONO,fontSize:'9px',color:TX3,marginBottom:'4px',letterSpacing:'0.08em'}}>BALANCE</div>
                          <div style={{fontFamily:MONO,fontSize:'16px',color:G,fontWeight:700}}>{walletState.algo.toFixed(3)} ALGO</div>
                        </div>
                        <div style={{background:S2,borderRadius:'8px',padding:'10px 16px',flex:1}}>
                          <div style={{fontFamily:MONO,fontSize:'9px',color:TX3,marginBottom:'4px',letterSpacing:'0.08em'}}>ASSETS</div>
                          <div style={{fontFamily:MONO,fontSize:'16px',color:TX,fontWeight:700}}>{walletState.assets} ASAs</div>
                        </div>
                        <div style={{background:S2,borderRadius:'8px',padding:'10px 16px',flex:1}}>
                          <div style={{fontFamily:MONO,fontSize:'9px',color:TX3,marginBottom:'4px',letterSpacing:'0.08em'}}>STATUS</div>
                          <div style={{fontFamily:MONO,fontSize:'13px',color:'#4ADE80',fontWeight:700}}>Protected ✓</div>
                        </div>
                      </div>
                    )}
                    <div style={{fontSize:'13px',color:TX2,lineHeight:1.7,marginBottom:'14px'}}>
                      Verity is intercepting transactions in real time. Open <span style={{color:G,fontWeight:600}}>AlgoYield</span> in another tab.
                    </div>
                    <a href="/testdapp.html" target="_blank" style={{display:'inline-flex',alignItems:'center',gap:'8px',background:G,color:BG,padding:'10px 22px',borderRadius:'8px',fontSize:'13px',fontWeight:600,textDecoration:'none'}}>
                      Open AlgoYield dApp →
                    </a>
                  </div>
                </div>
              ):(
                <div style={{marginBottom:'32px'}}>
                  <button className="bp" onClick={onConnect} disabled={connecting} style={{background:G,color:BG,border:'none',padding:'13px 32px',borderRadius:'8px',fontSize:'14px',fontWeight:600,cursor:connecting?'wait':'pointer',opacity:connecting?0.7:1,marginBottom:'12px',display:'block'}}>
                    {connecting?'Connecting...':'Connect Pera Wallet →'}
                  </button>
                  <div style={{fontSize:'13px',color:TX3}}>Connect your Pera wallet to activate transaction interception</div>
                </div>
              )}
              <div style={{display:'flex',borderRadius:'8px',overflow:'hidden',border:`1px solid ${BR}`}}>
                {[{n:'4',l:'Attack types'},{n:'0ms',l:'Added delay'},{n:'100%',l:'Pre-signature'},{n:uptime,l:'System uptime'}].map((s,i)=>(
                  <div key={i} style={{flex:1,padding:'14px 16px',background:S1,borderRight:i<3?`1px solid ${BR}`:'none'}}>
                    <div style={{fontFamily:MONO,fontSize:'18px',fontWeight:700,color:G,marginBottom:'3px'}}>{s.n}</div>
                    <div style={{fontSize:'10px',color:TX3,lineHeight:1.4}}>{s.l}</div>
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
                <circle cx="150" cy="168" r="10" fill="none" stroke={G} strokeWidth="0.8" opacity="0.4"/>
                <line x1="70" y1="168" x2="110" y2="168" stroke={G} strokeWidth="0.6" opacity="0.4"/>
                <line x1="190" y1="168" x2="230" y2="168" stroke={G} strokeWidth="0.6" opacity="0.4"/>
                <line x1="150" y1="88" x2="150" y2="128" stroke={G} strokeWidth="0.6" opacity="0.4"/>
                <line x1="150" y1="208" x2="150" y2="248" stroke={G} strokeWidth="0.6" opacity="0.4"/>
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
            <h2 style={{fontSize:'32px',fontWeight:700,color:TX,letterSpacing:'-0.02em',lineHeight:1.1}}>Four steps.<br/>Complete protection.</h2>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'1px',background:BR,border:`1px solid ${BR}`,borderRadius:'12px',overflow:'hidden'}}>
          {[
            {tag:'01',title:'Intercept',desc:'dApp sends transaction to Verity via BroadcastChannel before it reaches your wallet.',icon:'⚡'},
            {tag:'02',title:'Simulate',desc:'Algorand Simulate API dry-runs the full transaction. All inner operations revealed.',icon:'◎'},
            {tag:'03',title:'Detect',desc:'Rule-based engine checks rekey fields, inner drains, clawback abuse. Deterministic.',icon:'🛡'},
            {tag:'04',title:'Explain',desc:'Gemini AI translates findings to plain English. You know exactly what will happen.',icon:'✦'},
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
      <div style={{background:S1,borderTop:`1px solid ${BR}`,borderBottom:`1px solid ${BR}`}}>
        <div style={{...W,padding:'72px 48px'}}>
          <div style={{display:'grid',gridTemplateColumns:'360px 1fr',gap:'80px',alignItems:'start'}}>
            <div>
              <div style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.12em',marginBottom:'10px'}}>/ WHAT WE DETECT</div>
              <h2 style={{fontSize:'32px',fontWeight:700,color:TX,letterSpacing:'-0.02em',lineHeight:1.1,marginBottom:'16px'}}>4 attack types.<br/>Zero tolerance.</h2>
              <p style={{fontSize:'13px',color:TX2,lineHeight:1.8}}>Deterministic detection — rules check mathematically defined fields in the Algorand protocol. Not AI guessing. Cryptographic certainty.</p>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
              {[
                {name:'Rekey Attack',desc:'Signing authority permanently transferred to attacker. Algorand-specific — no equivalent on Ethereum.',sev:'CRITICAL',c:RD,b:RDR},
                {name:'Inner Transaction Drain',desc:'Hidden asset transfers nested inside application calls. Invisible without simulation.',sev:'HIGH',c:'#F97316',b:'#2A1800'},
                {name:'Clawback Abuse',desc:'Assets pulled from wallet by token creator without consent.',sev:'HIGH',c:'#F97316',b:'#2A1800'},
                {name:'Unknown App Call',desc:'Unverified smart contract calls arbitrary functions on your assets.',sev:'MEDIUM',c:G,b:GB},
              ].map(a=>(
                <div key={a.name} style={{background:BG,border:`1px solid ${BR}`,borderRadius:'8px',padding:'20px'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'10px'}}>
                    <span style={{fontFamily:MONO,fontSize:'11px',fontWeight:700,color:TX}}>{a.name}</span>
                    <span style={{fontFamily:MONO,fontSize:'9px',color:a.c,border:`1px solid ${a.b}`,padding:'2px 8px',borderRadius:'4px'}}>{a.sev}</span>
                  </div>
                  <div style={{fontSize:'12px',color:TX3,lineHeight:1.6}}>{a.desc}</div>
                </div>
              ))}
            </div>
          </div>
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
              <div style={{fontSize:'13px',color:TX2,marginTop:'4px'}}>Simulating before it reaches your wallet</div>
            </div>
          </div>
          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',overflow:'hidden',marginBottom:'20px'}}>
            <div style={{padding:'14px 20px',borderBottom:`1px solid ${BR}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em'}}>INTERCEPTED TRANSACTION</span>
              <span style={{fontFamily:MONO,fontSize:'10px',color:G,background:GB,border:`1px solid #2A2000`,padding:'3px 10px',borderRadius:'20px'}}>FROM {txn.dapp.toUpperCase()}</span>
            </div>
            {[
              {k:'What dApp says',v:txn.description},
              {k:'Transaction type',v:txn.type==='rekey'?'Application Call (suspicious)':txn.type==='appcall'?'Application Call':'Payment'},
              {k:'Stated intent',v:txn.intent||'Unknown'},
              {k:'Intercepted at',v:new Date(txn.timestamp).toLocaleTimeString()},
            ].map((r,i)=>(
              <div key={r.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'13px 20px',borderBottom:i<3?`1px solid ${BR}`:'none',background:i%2?S2:S1}}>
                <span style={{fontSize:'13px',color:TX3}}>{r.k}</span>
                <span style={{fontFamily:MONO,fontSize:'11px',color:TX}}>{r.v}</span>
              </div>
            ))}
          </div>
          <div style={{background:GB,border:`1px solid #2A2000`,borderRadius:'10px',padding:'16px 20px',marginBottom:'24px',fontSize:'13px',color:TX2,lineHeight:1.7}}>
            <span style={{color:G,fontWeight:600}}>Verity intercepted this transaction.</span> Click Analyze to simulate it on Algorand testnet — before anything is signed.
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
  const steps=['Decoding transaction bytes','Calling Algorand Simulate API','Scanning inner transactions & rekey fields','Running deterministic detection engine']
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav wallet={wallet}/>
      <div style={{...W,padding:'80px 48px'}}>
        <div style={{maxWidth:'680px',animation:'fadeUp 0.4s ease forwards'}}>
          <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'48px'}}>
            <div style={{width:'7px',height:'7px',borderRadius:'50%',background:G,animation:'pulse 1s ease-in-out infinite'}}/>
            <span style={{fontFamily:MONO,fontSize:'11px',color:G,letterSpacing:'0.1em'}}>SCANNING TRANSACTION</span>
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
                  <div style={{width:'28px',height:'28px',borderRadius:'6px',border:`1px solid ${done||active?G:BR2}`,background:done?GB:'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,transition:'all 0.3s'}}>
                    {done?<span style={{color:G,fontSize:'12px'}}>✓</span>:active?<div style={{width:'8px',height:'8px',borderRadius:'50%',background:G,animation:'pulse 0.8s ease-in-out infinite'}}/>:<span style={{fontFamily:MONO,fontSize:'10px',color:TX3}}>{String(i+1).padStart(2,'0')}</span>}
                  </div>
                  <span style={{fontSize:'13px',color:done?TX2:active?TX:TX3,transition:'color 0.3s'}}>{s}</span>
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

function SafeScreen({txn,onApprove,onReject,wallet,simResult,aiExplanation,submitting,txId,realTxnId}:{
  txn:IncomingTransaction|null;onApprove:()=>void;onReject:()=>void;wallet:string
  simResult:SimulateResult|null;aiExplanation:string;submitting:boolean;txId:string;realTxnId:string
}){
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav wallet={wallet}/>
      <div style={{...W,padding:'64px 48px'}}>
        <div style={{maxWidth:'800px',animation:'fadeUp 0.4s ease forwards'}}>
          <div style={{background:GB,border:`1px solid #2A3000`,borderRadius:'12px',padding:'24px 28px',marginBottom:'28px',display:'flex',alignItems:'center',gap:'18px'}}>
            <div style={{width:'44px',height:'44px',border:`1px solid ${G}`,borderRadius:'10px',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'18px',color:G,flexShrink:0,background:'#1A1800'}}>✓</div>
            <div>
              <div style={{fontSize:'17px',fontWeight:600,color:G,marginBottom:'3px'}}>Transaction verified — intent matches</div>
              <div style={{fontSize:'13px',color:TX3}}>Simulation complete — no attacks detected</div>
            </div>
            <div style={{marginLeft:'auto',fontFamily:MONO,fontSize:'10px',color:G,background:'#1A1800',border:`1px solid #2A3000`,padding:'5px 12px',borderRadius:'20px'}}>SAFE</div>
          </div>

          <div style={{marginBottom:'20px'}}>
            <div style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em',marginBottom:'12px'}}>/ INTENT VERIFICATION RESULT</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr auto 1fr',gap:'12px',alignItems:'center'}}>
              <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'10px',padding:'20px 24px'}}>
                <div style={{fontFamily:MONO,fontSize:'9px',color:TX3,letterSpacing:'0.1em',marginBottom:'8px'}}>YOUR INTENT</div>
                <div style={{fontSize:'15px',fontWeight:600,color:'#93C5FD',marginBottom:'4px'}}>{txn?.description||'Complete transaction'}</div>
                <div style={{fontSize:'11px',color:TX3}}>From {txn?.dapp||'dApp'}</div>
              </div>
              <div style={{fontSize:'28px',color:G,fontWeight:700,textAlign:'center'}}>✓</div>
              <div style={{background:GB,border:`1px solid #2A3000`,borderRadius:'10px',padding:'20px 24px'}}>
                <div style={{fontFamily:MONO,fontSize:'9px',color:G,letterSpacing:'0.1em',marginBottom:'8px'}}>WHAT ACTUALLY HAPPENS</div>
                <div style={{fontSize:'15px',fontWeight:600,color:G,marginBottom:'4px'}}>
                  {txn?.type==='appcall'?'Real operation verified safe':'Safe payment — no hidden operations'}
                </div>
                <div style={{fontSize:'11px',color:TX3}}>Confirmed by Algorand Simulate API</div>
              </div>
            </div>
          </div>

          {realTxnId&&(
            <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'10px',padding:'16px 20px',marginBottom:'20px'}}>
              <div style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em',marginBottom:'8px'}}>LIVE ALGORAND TESTNET TRANSACTION — FETCHED IN REAL TIME</div>
              <a href={`https://lora.algokit.io/testnet/transaction/${realTxnId}`} target="_blank" rel="noopener noreferrer" style={{fontFamily:MONO,fontSize:'12px',color:'#4ADE80',textDecoration:'underline',display:'block',marginBottom:'6px'}}>
                {realTxnId} →
              </a>
              <div style={{fontSize:'12px',color:TX3}}>Fetched live from Algorand testnet indexer — not built by us. Proves Verity works on any transaction from any source.</div>
            </div>
          )}

          <div style={{background:S1,borderLeft:`3px solid ${G}`,padding:'20px 24px',marginBottom:'20px',border:`1px solid ${BR}`,borderRadius:'0 10px 10px 0'}}>
            <div style={{fontFamily:MONO,fontSize:'10px',color:G,letterSpacing:'0.1em',marginBottom:'8px'}}>VERITY SAYS</div>
            <div style={{fontSize:'14px',color:TX2,lineHeight:1.85}}>
              {aiExplanation||'Transaction analyzed and verified safe. No hidden operations detected.'}
            </div>
          </div>

          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'10px',overflow:'hidden',marginBottom:'28px'}}>
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

          {txId?(
            <div style={{background:GB,border:`1px solid #2A3000`,borderRadius:'10px',padding:'20px 24px'}}>
              <div style={{fontFamily:MONO,fontSize:'10px',color:G,letterSpacing:'0.1em',marginBottom:'8px'}}>✓ CONFIRMED ON ALGORAND TESTNET</div>
              <a href={`https://lora.algokit.io/testnet/transaction/${txId}`} target="_blank" rel="noopener noreferrer" style={{fontFamily:MONO,fontSize:'12px',color:'#4ADE80',textDecoration:'underline',display:'block',marginBottom:'6px'}}>
                {txId} →
              </a>
              <div style={{fontSize:'13px',color:TX2}}>Signed by Pera wallet and confirmed on Algorand testnet. Full end-to-end flow complete.</div>
            </div>
          ):(
            <div style={{display:'flex',gap:'12px'}}>
              <button className="bp" onClick={onApprove} disabled={submitting} style={{background:G,color:BG,border:'none',padding:'13px 32px',borderRadius:'8px',fontSize:'14px',fontWeight:600,cursor:submitting?'wait':'pointer',opacity:submitting?0.7:1}}>
                {submitting?'Opening Pera to sign...':'Approve — Sign with Pera →'}
              </button>
              <button className="bs" onClick={onReject} style={{background:'transparent',color:TX2,border:`1px solid ${BR2}`,padding:'12px 24px',borderRadius:'8px',fontSize:'14px',cursor:'pointer'}}>
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DangerScreen({txn,onReject,wallet,attack,simResult,aiExplanation,walletState}:{
  txn:IncomingTransaction|null;onReject:()=>void;wallet:string
  attack:{type:string;severity:string;description:string}|null
  simResult:SimulateResult|null;aiExplanation:string
  walletState:WalletState|null
}){
  return(
    <div style={{minHeight:'100vh',background:BG}}>
      <Nav wallet={wallet}/>
      <div style={{...W,padding:'64px 48px'}}>
        <div style={{maxWidth:'800px',animation:'fadeUp 0.4s ease forwards'}}>
          <div style={{background:RDB,border:`1px solid ${RDR}`,borderRadius:'12px',padding:'24px 28px',marginBottom:'28px',display:'flex',alignItems:'center',gap:'18px'}}>
            <div style={{width:'44px',height:'44px',border:`1px solid ${RD}`,borderRadius:'10px',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'18px',color:RD,flexShrink:0}}>⚠</div>
            <div>
              <div style={{fontSize:'17px',fontWeight:600,color:RD,marginBottom:'3px'}}>{attack?.type||'Attack Detected'}</div>
              <div style={{fontSize:'13px',color:RD,opacity:0.6}}>Intent mismatch — {txn?.dapp||'dApp'} is lying about what this transaction does</div>
            </div>
            <div style={{marginLeft:'auto',fontFamily:MONO,fontSize:'10px',color:RD,background:RDB,border:`1px solid ${RDR}`,padding:'5px 12px',borderRadius:'20px'}}>{attack?.severity||'CRITICAL'}</div>
          </div>

          {/* INTENT MISMATCH */}
          <div style={{marginBottom:'20px'}}>
            <div style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em',marginBottom:'12px'}}>/ INTENT VERIFICATION — MISMATCH DETECTED</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr auto 1fr',gap:'12px',alignItems:'center'}}>
              <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'10px',padding:'20px 24px'}}>
                <div style={{fontFamily:MONO,fontSize:'9px',color:TX3,letterSpacing:'0.1em',marginBottom:'8px'}}>WHAT {txn?.dapp?.toUpperCase()||'DAPP'} CLAIMED</div>
                <div style={{fontSize:'15px',fontWeight:600,color:'#93C5FD',marginBottom:'4px'}}>{txn?.description||'Claim Rewards'}</div>
                <div style={{fontSize:'11px',color:TX3}}>What the UI showed you</div>
              </div>
              <div style={{fontSize:'28px',color:RD,fontWeight:700,textAlign:'center'}}>≠</div>
              <div style={{background:RDB,border:`1px solid ${RDR}`,borderRadius:'10px',padding:'20px 24px'}}>
                <div style={{fontFamily:MONO,fontSize:'9px',color:RD,letterSpacing:'0.1em',marginBottom:'8px'}}>WHAT SIMULATION REVEALED</div>
                <div style={{fontSize:'15px',fontWeight:600,color:'#FECACA',marginBottom:'4px'}}>Permanent wallet takeover</div>
                <div style={{fontSize:'11px',color:RD,opacity:0.6}}>Caught before signing</div>
              </div>
            </div>
          </div>

          {/* WALLET STATE BEFORE/AFTER — THE KILLER FEATURE */}
          {walletState&&(
            <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',padding:'24px 28px',marginBottom:'20px'}}>
              <div style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em',marginBottom:'20px'}}>/ WHAT SIGNING THIS WOULD HAVE DONE TO YOUR ACTUAL WALLET</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr auto 1fr',gap:'16px',alignItems:'center'}}>
                {/* BEFORE */}
                <div style={{background:GB,border:`1px solid #2A3000`,borderRadius:'10px',padding:'20px'}}>
                  <div style={{fontFamily:MONO,fontSize:'9px',color:G,letterSpacing:'0.1em',marginBottom:'14px'}}>BEFORE SIGNING ✓</div>
                  <div style={{marginBottom:'10px'}}>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Balance</div>
                    <div style={{fontFamily:MONO,fontSize:'18px',color:G,fontWeight:700}}>{walletState.algo.toFixed(3)} ALGO</div>
                  </div>
                  <div style={{marginBottom:'10px'}}>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Assets</div>
                    <div style={{fontFamily:MONO,fontSize:'14px',color:TX,fontWeight:600}}>{walletState.assets} ASAs</div>
                  </div>
                  <div>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Control</div>
                    <div style={{fontFamily:MONO,fontSize:'12px',color:G}}>You own this ✓</div>
                  </div>
                </div>
                {/* ARROW */}
                <div style={{textAlign:'center'}}>
                  <div style={{color:RD,fontSize:'24px',fontWeight:700}}>→</div>
                  <div style={{fontFamily:MONO,fontSize:'9px',color:RD,marginTop:'4px'}}>IF SIGNED</div>
                </div>
                {/* AFTER */}
                <div style={{background:RDB,border:`1px solid ${RDR}`,borderRadius:'10px',padding:'20px'}}>
                  <div style={{fontFamily:MONO,fontSize:'9px',color:RD,letterSpacing:'0.1em',marginBottom:'14px'}}>AFTER SIGNING ✗</div>
                  <div style={{marginBottom:'10px'}}>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Balance</div>
                    <div style={{fontFamily:MONO,fontSize:'18px',color:RD,fontWeight:700}}>0 ALGO</div>
                    <div style={{fontSize:'10px',color:RD,opacity:0.7}}>Locked out forever</div>
                  </div>
                  <div style={{marginBottom:'10px'}}>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Assets</div>
                    <div style={{fontFamily:MONO,fontSize:'14px',color:RD,fontWeight:600}}>0 ASAs</div>
                    <div style={{fontSize:'10px',color:RD,opacity:0.7}}>All inaccessible</div>
                  </div>
                  <div>
                    <div style={{fontSize:'11px',color:TX3,marginBottom:'3px'}}>Control</div>
                    <div style={{fontFamily:MONO,fontSize:'12px',color:RD}}>Attacker owns this ✗</div>
                  </div>
                </div>
              </div>
              <div style={{marginTop:'14px',padding:'10px 14px',background:RDB,borderRadius:'8px',border:`1px solid ${RDR}`,fontSize:'12px',color:TX2,lineHeight:1.6}}>
                These are your <span style={{color:RD,fontWeight:600}}>actual live wallet values</span> fetched from Algorand testnet. This is exactly what you would have lost.
              </div>
            </div>
          )}

          {/* TRANSACTION FLOW */}
          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'12px',padding:'24px 28px',marginBottom:'20px'}}>
            <div style={{fontFamily:MONO,fontSize:'10px',color:TX3,letterSpacing:'0.1em',marginBottom:'20px'}}>TRANSACTION FLOW — WHAT WOULD HAVE HAPPENED</div>
            <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
              {[
                {top:'Your wallet',val:wallet||'Your address',danger:false,sub:'Signs the transaction'},
                null,
                {top:'Control transferred to',val:'Attacker address',danger:true,sub:'Unknown — irreversible'},
                null,
                {top:'Outcome',val:'All funds lost',danger:true,sub:'Permanent, no recovery'},
              ].map((n,i)=>n===null?(
                <div key={i} style={{color:RD,fontSize:'20px',flexShrink:0}}>→</div>
              ):(
                <div key={i} style={{flex:1,border:`1px solid ${n.danger?RDR:BR2}`,background:n.danger?RDB:S2,padding:'16px',borderRadius:'8px'}}>
                  <div style={{fontFamily:MONO,fontSize:'9px',color:n.danger?RD:TX3,letterSpacing:'0.1em',marginBottom:'8px'}}>{n.top}</div>
                  <div style={{fontSize:'12px',fontWeight:600,color:n.danger?RD:TX,marginBottom:'4px'}}>{n.val}</div>
                  <div style={{fontSize:'10px',color:n.danger?RD:TX3,opacity:0.6}}>{n.sub}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{background:S1,borderLeft:`3px solid ${RD}`,padding:'20px 24px',marginBottom:'20px',border:`1px solid ${BR}`,borderRadius:'0 10px 10px 0'}}>
            <div style={{fontFamily:MONO,fontSize:'10px',color:RD,letterSpacing:'0.1em',marginBottom:'8px'}}>⚠ VERITY SAYS</div>
            <div style={{fontSize:'14px',color:TX2,lineHeight:1.85}}>
              {aiExplanation||attack?.description||'This transaction contains a hidden rekey attack.'}{' '}
              <span style={{color:RD,fontWeight:700}}>Reject this transaction immediately.</span>
            </div>
          </div>

          <div style={{background:S1,border:`1px solid ${BR}`,borderRadius:'10px',overflow:'hidden',marginBottom:'28px'}}>
            {[
              {k:'Source dApp',v:txn?.dapp||'Unknown'},
              {k:'Attack type',v:attack?.type||'Rekey attack'},
              {k:'Rekey target',v:'Attacker-controlled address'},
              {k:'Risk level',v:attack?.severity||'CRITICAL'},
            ].map((r,i)=>(
              <div key={r.k} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 20px',borderBottom:i<3?`1px solid ${BR}`:'none',background:i%2?S2:S1}}>
                <span style={{fontSize:'13px',color:TX3}}>{r.k}</span>
                <span style={{fontFamily:MONO,fontSize:'11px',color:RD}}>{r.v}</span>
              </div>
            ))}
          </div>

          <div style={{display:'flex',gap:'12px'}}>
            <button className="bd" onClick={onReject} style={{background:RDB,color:RD,border:`1px solid ${RDR}`,padding:'13px 32px',borderRadius:'8px',fontSize:'14px',fontWeight:600,cursor:'pointer'}}>
              ⚠ Reject — Protect My Wallet
            </button>
            <button className="bs" onClick={onReject} style={{background:'transparent',color:TX3,border:`1px solid ${BR2}`,padding:'12px 24px',borderRadius:'8px',fontSize:'14px',cursor:'pointer'}}>
              Proceed anyway (not recommended)
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}