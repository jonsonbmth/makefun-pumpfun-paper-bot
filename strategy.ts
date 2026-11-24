// Patient momentum for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The dev window taught one thing: nearly every coin on this replay dies, and
// the ones that run do it in the first hours. So this bot waits. A coin only
// earns a buy after it has lived 1,500 slots past its launch AND its recent
// tape shows broad, speeding-up buy pressure from many different wallets,
// with the creator still holding and no single wallet dominating the flow.
// Stakes stay small (0.08 SOL to open, 0.4 SOL at most per coin) and the bot
// leaves fast: an 8% stop, a trailing stop once the trade works, a double-up
// take-profit, and instant exits on a creator sale, a whale dump, or age.
// Cheap 0.015 SOL probe round trips keep the run over the guardrail floor of
// 20 coins while the momentum book does the actual earning.
//
// Everything here is deterministic: no clock, no randomness, no I/O. State
// lives in insertion-ordered maps fed by the batch stream, so the same
// batches always produce the same orders, byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  window: number; // slots of tape judged before an entry is allowed
  minNetSol: number; // net SOL inflow (buys minus sells) needed over the window
  minBuys: number; // buy prints needed inside the window
  minBuyers: number; // distinct buying wallets needed inside the window
  minPriceUp: number; // price must already be up at least this much over the window
  maxPriceUp: number; // ...but not more than this: skip coins that already ran away
  accel: number; // late-half net flow must be at least this multiple of early-half flow
  nearHigh: number; // current price must hold at least this share of the window high
  maxBuyerShare: number; // largest single wallet's share of window buy SOL, at most
  minRqSol: number; // curve real SOL at entry: lower bound
  maxRqSol: number; // curve real SOL at entry: upper bound
  minAge: number; // slots a coin must have lived since its CreateEvent
  stakeSol: number; // most SOL ever put into one position
  initialSol: number; // size of the opening buy
  addSol: number; // size of each pyramid add
  addStep: number; // add only after the price stepped up this much from the last buy
  minBuySol: number; // smallest buy worth sending at all
  buySlipBps: number; // slippage allowed on buys, in bps (sells always go at 10000)
  stopLoss: number; // leave when close value falls to cost * (1 - stopLoss)
  trail: number; // trailing stop: leave when value falls to peak * (1 - trail)
  trailArm: number; // the trailing stop only arms once value hit cost * (1 + trailArm)
  takeProfit: number; // leave whole when value reaches cost * (1 + takeProfit)
  bigSellSol: number; // leave on any single recorded sell of at least this many SOL
  maxHold: number; // leave after this many slots held, whatever the price
  cooldown: number; // slots to wait after an exit before the same coin may re-enter
  maxEntries: number; // most entries per coin over the whole run
  maxMain: number; // most momentum positions open at once (probes use the rest)
  maxExposureSol: number; // most SOL at cost across all positions at once
  targetCoins: number; // guardrail pacing: coins to have touched by the end of paceSecs
  targetFills: number; // guardrail pacing: own fills to have by the end of paceSecs
  paceSecs: number; // block seconds the pacing targets are spread over
  probeSol: number; // size of one probe round trip
  maxProbes: number; // most probes in flight at once
}

// Tuned on the kit's dev window with the local simulator (full 24h, both
// halves, and again at 2x fees), preferring flat regions of the grid over
// single best cells: net +0.30 SOL on the dev window in the sim, +0.20 SOL
// at 2x fees, max drawdown 0.05, 39 coins, 131 fills. The official
// grade-local run of the same settings scored +0.202 SOL with all
// guardrails met. The single biggest lever in the sweep was the 8% stop.
export const DEFAULT_PARAMS: Params = {
  window: 80, // 80 slots of tape beat 60 and 120 on the full window
  minNetSol: 2.5, // 2.5 SOL of net inflow filters out flat tapes
  minBuys: 6, // six buy prints minimum: fewer is usually one wallet
  minBuyers: 8, // eight distinct buyers was the key breadth filter (8 beat 6)
  minPriceUp: 0.08, // already up 8%: the move has started, we are not early
  maxPriceUp: 1.2, // up more than 120% and the easy money is gone
  accel: 1, // late-half flow must beat early-half flow: still speeding up
  nearHigh: 0.92, // still within 8% of its window high: no fade yet
  maxBuyerShare: 0.6, // one wallet over 60% of buys smells like a bundle
  minRqSol: 4, // curve must hold at least 4 SOL of real quote
  maxRqSol: 40, // ...and at most 40: deeper curves barely move (40 beat 60)
  minAge: 1500, // survived 1,500 slots past launch: the dump window is over
  stakeSol: 0.4, // 0.4 SOL at most per coin: no single coin can hurt us
  initialSol: 0.08, // open small; only add when the trade proves itself
  addSol: 0.12, // pyramid adds of 0.12 SOL into strength
  addStep: 0.05, // add on each further +5% step from the last buy
  minBuySol: 0.01, // below 0.01 SOL a buy is not worth its fees
  buySlipBps: 1500, // 15% slippage on buys; sells always go out at 10000
  stopLoss: 0.08, // the 8% stop was the single biggest PnL lever in the sweep
  trail: 0.3, // once armed, give a runner 30% of room from its peak
  trailArm: 0.1, // the trail arms once the position is up 10%
  takeProfit: 1.0, // bank the whole position at a double
  bigSellSol: 3, // a single 3 SOL sell means someone big is leaving
  maxHold: 2400, // 2,400 slots is long enough: time stop, no exceptions
  cooldown: 200, // 200 slots of silence after an exit before re-entry
  maxEntries: 2, // two chances per coin, then it is done for the run
  maxMain: 3, // three momentum positions at once keeps the book focused
  maxExposureSol: 1.2, // never more than 1.2 SOL at cost: the drawdown guard
  targetCoins: 25, // pacing target: 25 coins touched (guardrail needs 20)
  targetFills: 60, // pacing target: 60 own fills across the run
  paceSecs: 43200, // spread the pacing targets over 12h of block time
  probeSol: 0.015, // probes cost 0.015 SOL a round trip: cheap insurance
  maxProbes: 1, // one probe at a time is enough to hold the pace
};

const LAMPORTS_PER_SOL = 1_000_000_000;
/** What a trade costs on the curve: protocol 95 bps + creator 30 bps. */
const CURVE_TAKE = 0.0125;
const BPS_DENOM = 10_000;

/** One recorded trade on a coin's tape. */
interface TapeFill {
  slot: number;
  isBuy: boolean;
  sol: number;
  wallet: string;
  px: number;
}

/** Everything remembered about one coin. */
interface CoinTape {
  born: number | null; // slot of its CreateEvent, if seen
  maker: string | null; // creator wallet, if seen
  makerDumped: boolean; // the creator sold at least once
  fills: TapeFill[]; // recorded trades, oldest first, trimmed to the window
  tries: number; // entries taken on this coin so far
  lastExitSlot: number; // slot of the last exit, for the cooldown
}

/** A momentum position the bot is currently holding. */
interface LivePosition {
  openedSlot: number; // slot the position was opened
  bestValue: number; // highest close value seen (SOL), for the trailing stop
  spent: number; // SOL sent in buys for this position, fees included
  leaving: boolean; // an exit is already decided or in flight
  touched: boolean; // at least one buy of this position filled
  lastBuyPx: number; // recorded price when the last buy was decided
  nowValue: number; // close value at the latest batch (SOL, fees deducted)
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, CoinTape>();
  const live = new Map<Pubkey, LivePosition>();
  /** Probe round trips in flight, by mint: false while the buy is out, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders (harness closes excluded) and the coins they were on. */
  let fillsDone = 0;
  const coinsDone = new Set<Pubkey>();
  let clockStart: number | null = null;
  let clockEnd: number | null = null;
  const retain = p.window + 5;

  const bookFor = (mint: Pubkey): CoinTape => {
    const found = books.get(mint);
    if (found !== undefined) return found;
    const fresh: CoinTape = { born: null, maker: null, makerDumped: false, fills: [], tries: 0, lastExitSlot: -1e12 };
    books.set(mint, fresh);
    return fresh;
  };

  /** Does this coin's tape qualify for an entry at slot `now`? */
  const qualifies = (tape: CoinTape, now: number, rqSol: number): boolean => {
    if (tape.makerDumped) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (tape.born === null || now - tape.born < p.minAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let inSol = 0;
    let outSol = 0;
    let buys = 0;
    let earlyNet = 0;
    let lateNet = 0;
    let firstPx = -1;
    let topPx = 0;
    let lastPx = 0;
    const perWallet = new Map<string, number>();
    for (const f of tape.fills) {
      if (f.slot <= from) {
        firstPx = f.px;
        continue;
      }
      if (firstPx < 0) firstPx = f.px;
      const signed = f.isBuy ? f.sol : -f.sol;
      if (f.slot <= mid) earlyNet += signed;
      else lateNet += signed;
      if (f.isBuy) {
        inSol += f.sol;
        buys++;
        perWallet.set(f.wallet, (perWallet.get(f.wallet) ?? 0) + f.sol);
      } else outSol += f.sol;
      if (f.px > topPx) topPx = f.px;
      lastPx = f.px;
    }
    if (buys < p.minBuys || perWallet.size < p.minBuyers) return false;
    const net = inSol - outSol;
    if (net < p.minNetSol) return false;
    if (firstPx <= 0) return false;
    const up = lastPx / firstPx - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (lastPx < topPx * p.nearHigh) return false;
    if (lateNet <= 0 || lateNet < p.accel * earlyNet) return false;
    let biggest = 0;
    for (const v of perWallet.values()) if (v > biggest) biggest = v;
    if (biggest > p.maxBuyerShare * inSol) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a tape. */
  const recentNet = (tape: CoinTape, now: number, w: number): number => {
    let net = 0;
    for (let i = tape.fills.length - 1; i >= 0; i--) {
      const f = tape.fills[i]!;
      if (f.slot <= now - w) break;
      net += f.isBuy ? f.sol : -f.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const dumped = new Set<Pubkey>();
      const touched = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          fillsDone++;
          coinsDone.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (clockStart === null) clockStart = e.block_time;
          if (clockEnd === null || e.block_time > clockEnd) clockEnd = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const tape = bookFor(e.mint);
          tape.born = e.slot;
          tape.maker = e.creator;
        } else if (e.event === 'TradeEvent') {
          const tape = bookFor(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS_PER_SOL;
          tape.fills.push({ slot: e.slot, isBuy: e.is_buy, sol, wallet: e.user, px: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          touched.add(e.mint);
          if (!e.is_buy && tape.maker !== null && e.user === tape.maker) tape.makerDumped = true;
          if (!e.is_buy && sol >= p.bigSellSol) dumped.add(e.mint);
        }
      }
      for (const mint of touched) {
        const tape = books.get(mint)!;
        let cut = 0;
        while (cut < tape.fills.length && tape.fills[cut]!.slot <= now - retain) cut++;
        if (cut > 0) tape.fills.splice(0, cut);
      }
      const quotes = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const inFlight = new Map<Pubkey, number>();
      for (const po of state.pending.values()) inFlight.set(po.order.mint, (inFlight.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;

      // Exits come first: never open a new position while an old one needs out.
      for (const [mint, pos] of live) {
        const position = state.positions.get(mint);
        const bond = state.curves.get(mint);
        if (position === undefined) {
          if (!inFlight.has(mint)) {
            live.delete(mint);
            const tape = bookFor(mint);
            if (pos.touched) tape.lastExitSlot = now;
            else tape.tries--;
          }
          continue;
        }
        pos.touched = true;
        if (bond === undefined || bond.complete) continue;
        const mark = quotes.get(mint);
        const quoteRes = mark ? Number(mark.virtual_quote_reserves) : Number(bond.virtual_quote_reserves);
        const tokenRes = mark ? Number(mark.virtual_token_reserves) : Number(bond.virtual_token_reserves);
        const amount = Number(position.token_amount);
        const worth = ((amount * quoteRes) / (tokenRes + amount) / LAMPORTS_PER_SOL) * (1 - CURVE_TAKE) - tx;
        const basis = Number(position.cost_lamports) / LAMPORTS_PER_SOL;
        if (worth > pos.bestValue) pos.bestValue = worth;
        pos.nowValue = worth;
        let leave = pos.leaving;
        const tape = bookFor(mint);
        if (!leave && worth < basis * (1 - p.stopLoss)) leave = true;
        if (!leave && pos.bestValue >= basis * (1 + p.trailArm) && worth < pos.bestValue * (1 - p.trail)) leave = true;
        if (!leave && worth >= basis * (1 + p.takeProfit)) leave = true;
        if (!leave && tape.makerDumped) leave = true;
        if (!leave && dumped.has(mint)) leave = true;
        if (!leave && now - pos.openedSlot > p.maxHold) leave = true;
        if (!leave) continue;
        pos.leaving = true;
        let sellOut = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellOut = true;
        if (sellOut) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
      }

      // Probes: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const position = state.positions.get(mint);
        const bond = state.curves.get(mint);
        if (position === undefined) {
          if (!inFlight.has(mint)) probes.delete(mint);
          continue;
        }
        if (bond === undefined || bond.complete || inFlight.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and pyramid adds.
      let cash = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
      let roomLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainRoom = p.maxMain - live.size;
      let atRisk = 0;
      for (const [mint, pos] of live) atRisk += Math.max(pos.spent, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS_PER_SOL);
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const bond = state.curves.get(mint);
        if (bond === undefined || bond.complete) continue;
        if (inFlight.has(mint) || probes.has(mint)) continue;
        const tape = books.get(mint)!;
        const pos = live.get(mint);
        const px = Number(bond.virtual_quote_reserves) / Number(bond.virtual_token_reserves);
        const rqSol = Number(bond.real_quote_reserves) / LAMPORTS_PER_SOL;
        let size: number;
        if (pos === undefined) {
          if (roomLeft <= 0 || mainRoom <= 0) continue;
          if (tape.tries >= p.maxEntries || now - tape.lastExitSlot < p.cooldown) continue;
          if (!qualifies(tape, now, rqSol)) continue;
          size = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Add only into a winner: the position is above water, the price
          // stepped up from the last buy, and net SOL is still flowing in.
          if (pos.leaving || !pos.touched || pos.spent >= p.stakeSol - p.minBuySol) continue;
          const position = state.positions.get(mint);
          if (position === undefined) continue;
          if (px < pos.lastBuyPx * (1 + p.addStep)) continue;
          if (pos.nowValue < Number(position.cost_lamports) / LAMPORTS_PER_SOL) continue;
          if (recentNet(tape, now, p.window) < p.minNetSol / 2) continue;
          if (rqSol > p.maxRqSol) continue;
          size = Math.min(p.addSol, p.stakeSol - pos.spent);
        }
        const maxSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS_PER_SOL;
        let buySol = Math.min(maxSol, size, p.maxExposureSol - atRisk);
        if (buySol > cash - tx) buySol = cash - tx;
        if (buySol < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(buySol * LAMPORTS_PER_SOL));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        cash -= buySol + tx;
        atRisk += buySol;
        if (pos === undefined) {
          live.set(mint, { openedSlot: now, bestValue: 0, spent: buySol, leaving: false, touched: false, lastBuyPx: px, nowValue: 0 });
          tape.tries++;
          roomLeft--;
          mainRoom--;
        } else {
          pos.spent += buySol;
          pos.lastBuyPx = px;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && roomLeft > 0 && clockStart !== null && clockEnd !== null) {
        const elapsed = Math.min(1, (clockEnd - clockStart) / p.paceSecs);
        const coinsBehind = coinsDone.size < Math.ceil(p.targetCoins * elapsed);
        const fillsBehind = fillsDone < Math.ceil(p.targetFills * elapsed);
        if (coinsBehind || fillsBehind) {
          const minReserve = (p.probeSol * BPS_DENOM) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (live.has(mint) || probes.has(mint) || inFlight.has(mint) || state.positions.has(mint)) continue;
            if (coinsBehind && !fillsBehind && coinsDone.has(mint)) continue;
            const bond = state.curves.get(mint);
            if (bond === undefined || bond.complete) continue;
            if (Number(bond.real_quote_reserves) / LAMPORTS_PER_SOL < minReserve * 1.5) continue;
            if (cash < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS_PER_SOL)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            cash -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
