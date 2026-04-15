# VERITY — Transaction Consent Verification for Algorand

> **"See the truth before you sign."**

[![AlgoBharat HackSeries 3.0](https://img.shields.io/badge/AlgoBharat-HackSeries%203.0-gold)](https://dorahacks.io/hackathon/hack-series-3)
[![Built on Algorand](https://img.shields.io/badge/Built%20on-Algorand-blue)](https://algorand.com)
[![AlgoKit](https://img.shields.io/badge/AlgoKit-2.10-green)](https://github.com/algorandfoundation/algokit-cli)
[![Live Demo](https://img.shields.io/badge/Live-Demo-brightgreen)](https://verity-beta-drab.vercel.app/)

---

## What Is Verity

Verity is a transaction consent verification layer for Algorand.

Before any transaction reaches Pera wallet — before the user signs anything — Verity intercepts it, decodes the raw transaction bytes, simulates it using Algorand's native Simulate API, and asks one question:

**Is this transaction doing what you think it is doing?**

This is the first product to surface Algorand's Simulate API in a user-facing interface.

---

## The Problem

In February 2023, over $9.2 million was drained from Algorand wallets in 72 hours. The protocol was not compromised. The users signed transactions they did not understand.

On Algorand, a single hidden field — `rekey-to` — can permanently transfer signing authority of a wallet to an attacker's address. It is invisible in the UI. It is hidden inside encoded transaction bytes. Once signed, it is irreversible.

India's DPDP Act mandates that user consent must be informed and specific. At the Algorand transaction layer today — it isn't. Verity fixes that.

---

## Live Demo

🔗 **[Live Deployment](https://verity-beta-drab.vercel.app/)**

📹 **[Demo Video](https://youtu.be/W_aF_zZjSvc?si=2u_Df9Xdc23ZT_xl)**

---

## How It Works

dApp builds real transaction bytes using algosdk
→ Sends encoded bytes to Verity
→ Verity calls algosdk.decodeUnsignedTransaction()
→ Verity calls Algorand Simulate API (live dry-run)
→ Detection engine checks: rekey-to field, inner transactions, clawback
→ Shows user: "Is this what you intended?"
→ YES → Pera Wallet signs → Testnet confirmation → Explorer link
→ NO → Nothing sent to Pera → Wallet safe

---

## The Demo Flow

### Scene 1 — Safe Transaction

User clicks "Stake 0.001 ALGO" on AlgoYield dApp → Verity intercepts → Simulate API confirms clean → User clicks YES → Pera signs → Real Algorand testnet transaction confirmed with explorer link.

### Scene 2 — Rekey Attack Caught

User clicks "Claim 50 ALGO Rewards" → AlgoYield secretly injects `rekeyTo` field in encoded bytes → Verity decodes bytes and discovers hidden attack field → Shows CRITICAL warning with real wallet balance → User clicks NO → Attack blocked before Pera ever sees it.

---

## Tech Stack

| Layer                    | Technology                                         |
| ------------------------ | -------------------------------------------------- |
| Project Scaffold         | AlgoKit 2.10.2                                     |
| Frontend                 | React 18 + TypeScript + Vite                       |
| Wallet                   | Pera Wallet Connect SDK                            |
| Blockchain SDK           | algosdk (official Algorand JS SDK)                 |
| Transaction Simulation   | Algorand Simulate API (testnet-api.algonode.cloud) |
| Transaction Interception | BroadcastChannel Web API                           |
| AI Explanation           | Google Gemini 2.0 Flash                            |
| Network                  | Algorand Testnet                                   |
| Deployment               | Vercel                                             |

---

## Detection Engine

Verity checks four attack types deterministically:

| Attack                      | Detection Method                                 | Severity |
| --------------------------- | ------------------------------------------------ | -------- |
| **Rekey Attack**            | `rekey-to` field present in decoded bytes        | CRITICAL |
| **Inner Transaction Drain** | Inner transaction count > 3 in simulate response | HIGH     |
| **Clawback Abuse**          | `assetSender` ≠ transaction sender               | HIGH     |
| **Unknown App Call**        | Unverified application ID                        | MEDIUM   |

**The detection is not AI.** Rules check mathematically defined fields in the Algorand protocol specification. AI (Gemini) only translates findings to plain English — it makes zero safety decisions.

---

## Why The Simulate API Matters

Algorand's Simulate API dry-runs any transaction in a sandboxed environment and returns every operation that would execute — including all inner transactions, rekey fields, and asset transfers — **without submitting to the chain.**

This is the infrastructure that makes Verity possible. No other user-facing product on Algorand uses it.

---

## Running Locally

```bash
# Clone the repository
git clone https://github.com/bhoomipandey2006/Verity
cd verity/projects/Verity

# Install dependencies
npm install

# Add your Gemini API key
echo "VITE_GEMINI_API_KEY=your_key_here" >> .env

# Start development server
npm run dev
```

Open `http://localhost:5173` — connect Pera wallet.

Open `http://localhost:5173/testdapp.html` — the AlgoYield test dApp.

---

## Architecture

AlgoYield dApp
↓ builds real transaction bytes with algosdk
↓ sends encoded bytes via BroadcastChannel
Verity (this repo)
↓ decodeUnsignedTransaction(bytes)
↓ Algorand Simulate API
↓ Detection Engine (deterministic rules)
↓ Gemini AI (explanation only)
↓ User confirms YES or NO
↓ (if YES) Pera Wallet signs
↓ Algorand Testnet
↓ Explorer confirmation link

---

## Technical Proof — The Attack Is Real

The malicious transaction in the demo is built entirely by AlgoYield using its own algosdk instance. Verity calls `decodeUnsignedTransaction()` on bytes it received — it never calls any `make*` function for the attack scenario. The `rekey-to` field is discovered during decoding. Verity had zero prior knowledge.

In production, the transport layer is WalletConnect — the same protocol used by Tinyman, Folks Finance, and every Algorand dApp. The decode-and-simulate pipeline is identical.

---

## Business Model

**Phase 1 — Current:** Detection engine and verification layer working end-to-end on Algorand testnet.

**Phase 2 — Round 3:**

```javascript
import { verity } from "@verity/sdk";
verity.protect(transaction);
```

Two lines. Any Algorand dApp. Every transaction automatically verified before reaching any wallet. Users protected without installing anything.

**Revenue:** B2B SaaS — dApps pay for API access. No dApp can afford the reputational damage of a $9M drain event on their platform.

**DPDP Compliance:** Every dApp serving Indian users needs verifiable transaction consent. Verity is that infrastructure.

---

## Team

**Team Procrastinator**
AlgoBharat HackSeries 3.0 — Round 2

---

## Submission Links

- 🌐 [Live Demo](https://verity-beta-drab.vercel.app/)
- 📹 [Demo Video](https://youtu.be/W_aF_zZjSvc?si=2u_Df9Xdc23ZT_xl)
- 📋 [DoraHacks](https://dorahacks.io/hackathon/hack-series-3)
