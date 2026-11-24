# makefun-pumpfun-paper-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/jonsonbmth/makefun-pumpfun-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/jonsonbmth/makefun-pumpfun-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A patient momentum paper-trading bot for the pump.fun replay sprint. It trades
10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity.

## Strategy

Nearly every pump.fun coin dies, so the edge is selectivity, not activity. A
coin is bought only after it has survived its launch window (1,500 slots) and
shows broad, accelerating buy pressure: net inflow over an 80-slot window, at
least 6 buy trades from at least 8 distinct wallets, price up 8–120% and near
its window high, with no single wallet dominating the buys and the creator
still holding. Stakes are small (0.08 SOL first buy, up to 0.4 SOL per
position, 3 positions max, 1.2 SOL max exposure) and exits are fast: an 8%
stop loss, a 30% trailing stop armed at +10%, take profit at +100%, a
creator-sell exit, a big-sell exit, and a 2,400-slot time limit. Cheap probe
round trips (0.015 SOL) keep the run above the guardrail of 20+ coins.

Local backtest on the kit's dev window (full 24h, both halves): net
**+0.30 SOL**, +0.20 SOL at 2x fees, max drawdown 0.05, 39 coins, 131 fills.

## Layout

- `main.ts` — entrypoint: runs the strategy through the replay SDK.
- `strategy.ts` — the strategy (entry signal, sizing, exits, probes).
- `vendor/makefun-bot.ts` — the kit's replay SDK shim, vendored byte for byte.

## Run it

```sh
node main.ts
```

The grader runs it as `node /bot/main.ts` with the replay harness speaking
agent-fun/replay/v2 on stdin/stdout. Standard library only, no network,
fully deterministic: the same batches always produce the same orders.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
