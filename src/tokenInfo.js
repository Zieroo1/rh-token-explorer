import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC_URL = process.env.RPC_URL || 'https://poptye-always-win.poptyedev.com/';
const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0x0bd7d308f8e1639fab988df18a8011f41eacad73').toLowerCase();
const ETH_USD = process.env.ETH_USD ? Number(process.env.ETH_USD) : null;

// ---------------------------------------------------------------------------
// ABIs / event signatures (Uniswap V2 + V3)
// ---------------------------------------------------------------------------
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];
const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 obsIndex, uint16 obsCard, uint16 obsCardNext, uint8 feeProtocol, bool unlocked)',
];

const ifaceV2PairCreated = new ethers.Interface([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
]);
const ifaceV2Swap = new ethers.Interface([
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
]);
const ifaceV3PoolCreated = new ethers.Interface([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
]);
const ifaceV3Swap = new ethers.Interface([
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);

const V2_PAIR_CREATED = ifaceV2PairCreated.getEvent('PairCreated').topicHash;
const V2_SWAP = ifaceV2Swap.getEvent('Swap').topicHash;
const V3_POOL_CREATED = ifaceV3PoolCreated.getEvent('PoolCreated').topicHash;
const V3_SWAP = ifaceV3Swap.getEvent('Swap').topicHash;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const Q192 = 2n ** 192n;

let _provider = null;
function provider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}

// ---------------------------------------------------------------------------
// ERC-20 metadata (graceful: some fields may be missing/odd)
// ---------------------------------------------------------------------------
async function getErc20(address) {
  const c = new ethers.Contract(address, ERC20_ABI, provider());
  const safe = async (p, fallback) => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    safe(c.name(), 'Unknown'),
    safe(c.symbol(), '???'),
    safe(c.decimals(), 18n),
    safe(c.totalSupply(), 0n),
  ]);
  const dec = Number(decimals);
  return {
    address: ethers.getAddress(address),
    name,
    symbol,
    decimals: dec,
    totalSupply: totalSupply.toString(),
    totalSupplyFormatted: Number(ethers.formatUnits(totalSupply, dec)),
  };
}

async function balanceOf(tokenAddress, holder) {
  try {
    const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider());
    return await c.balanceOf(holder);
  } catch {
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Find DEX pools for a token: Uniswap V2 (PairCreated) + V3 (PoolCreated).
// Both events have token0/token1 indexed, so we can query by topic exactly.
// ---------------------------------------------------------------------------
async function findPools(token) {
  const tokenTopic = ethers.zeroPadValue(ethers.getAddress(token), 32);
  const lc = token.toLowerCase();

  const [v2a, v2b, v3a, v3b] = await Promise.all([
    provider().getLogs({ topics: [V2_PAIR_CREATED, tokenTopic], fromBlock: 0, toBlock: 'latest' }),
    provider().getLogs({ topics: [V2_PAIR_CREATED, null, tokenTopic], fromBlock: 0, toBlock: 'latest' }),
    provider().getLogs({ topics: [V3_POOL_CREATED, tokenTopic], fromBlock: 0, toBlock: 'latest' }),
    provider().getLogs({ topics: [V3_POOL_CREATED, null, tokenTopic], fromBlock: 0, toBlock: 'latest' }),
  ]);

  const pools = [];

  for (const log of [...v2a, ...v2b]) {
    const { token0, token1, pair } = ifaceV2PairCreated.parseLog(log).args;
    pools.push({
      version: 'v2',
      pool: ethers.getAddress(pair),
      token0: ethers.getAddress(token0),
      token1: ethers.getAddress(token1),
      quote: ethers.getAddress(token0.toLowerCase() === lc ? token1 : token0),
      tokenIsToken0: token0.toLowerCase() === lc,
      factory: ethers.getAddress(log.address),
      fee: null,
      createdBlock: log.blockNumber,
    });
  }

  for (const log of [...v3a, ...v3b]) {
    const { token0, token1, fee, pool } = ifaceV3PoolCreated.parseLog(log).args;
    pools.push({
      version: 'v3',
      pool: ethers.getAddress(pool),
      token0: ethers.getAddress(token0),
      token1: ethers.getAddress(token1),
      quote: ethers.getAddress(token0.toLowerCase() === lc ? token1 : token0),
      tokenIsToken0: token0.toLowerCase() === lc,
      factory: ethers.getAddress(log.address),
      fee: Number(fee),
      createdBlock: log.blockNumber,
    });
  }

  if (pools.length === 0) return [];

  // Rank: prefer WETH-quoted, then by quote-token liquidity actually held in the pool.
  for (const p of pools) {
    p.isWeth = p.quote.toLowerCase() === WETH_ADDRESS;
    p.quoteLiquidityRaw = await balanceOf(p.quote, p.pool);
  }
  pools.sort((a, b) => {
    if (a.isWeth !== b.isWeth) return a.isWeth ? -1 : 1;
    if (a.quoteLiquidityRaw !== b.quoteLiquidityRaw) return a.quoteLiquidityRaw > b.quoteLiquidityRaw ? -1 : 1;
    return b.createdBlock - a.createdBlock;
  });
  return pools;
}

// ---------------------------------------------------------------------------
// Pricing: dispatch by pool version. priceInQuote = quote per 1 token.
// ---------------------------------------------------------------------------
async function getPricing(pool, token, quoteMeta) {
  if (pool.version === 'v2') {
    const c = new ethers.Contract(pool.pool, V2_PAIR_ABI, provider());
    const [r0, r1] = await c.getReserves();
    const reserveToken = pool.tokenIsToken0 ? r0 : r1;
    const reserveQuote = pool.tokenIsToken0 ? r1 : r0;
    const rt = Number(ethers.formatUnits(reserveToken, token.decimals));
    const rq = Number(ethers.formatUnits(reserveQuote, quoteMeta.decimals));
    const priceInQuote = rt > 0 ? rq / rt : 0;
    // TVL = both sides valued in the quote token (V2: token side == quote side)
    const tvlQuote = rq + rt * priceInQuote;
    return {
      priceInQuote,
      marketCapQuote: priceInQuote * token.totalSupplyFormatted,
      liquidityQuote: tvlQuote,
      quoteSideQuote: rq,
    };
  }

  // ---- Uniswap V3 ----
  const c = new ethers.Contract(pool.pool, V3_POOL_ABI, provider());
  const slot0 = await c.slot0();
  const sqrtP = slot0.sqrtPriceX96; // bigint

  // raw price of token0 in token1 = (sqrtP^2) / 2^192, then adjust decimals to human units
  const ratioRaw = Number(sqrtP * sqrtP) / Number(Q192); // token1_raw per token0_raw
  const price0in1 = ratioRaw * 10 ** (pool.token0Decimals - pool.token1Decimals); // human token1 per token0

  // priceInQuote = quote per 1 token
  const priceInQuote = pool.tokenIsToken0 ? price0in1 : price0in1 > 0 ? 1 / price0in1 : 0;

  // TVL = both sides of the pool valued in the quote token.
  // quote side = WETH balance held by the pool; token side = token balance * price.
  const quoteRaw = pool.quoteLiquidityRaw ?? (await balanceOf(quoteMeta.address, pool.pool));
  const tokenRaw = await balanceOf(token.address, pool.pool);
  const quoteSide = Number(ethers.formatUnits(quoteRaw, quoteMeta.decimals));
  const tokenSide = Number(ethers.formatUnits(tokenRaw, token.decimals));
  const tvlQuote = quoteSide + tokenSide * priceInQuote;

  return {
    priceInQuote,
    marketCapQuote: priceInQuote * token.totalSupplyFormatted,
    liquidityQuote: tvlQuote,
    quoteSideQuote: quoteSide,
  };
}

// ---------------------------------------------------------------------------
// Trades: dispatch by pool version -> classified buys / sells
// ---------------------------------------------------------------------------
async function getTrades(pool, token, quoteMeta) {
  const swapTopic = pool.version === 'v2' ? V2_SWAP : V3_SWAP;
  const logs = await provider().getLogs({
    address: pool.pool,
    topics: [swapTopic],
    fromBlock: 0,
    toBlock: 'latest',
  });

  logs.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  const sliced = logs; // full history — no cap

  // 1) decode all swaps synchronously
  const trades = [];
  let buyVolQuote = 0;
  let sellVolQuote = 0;
  let buys = 0;
  let sells = 0;

  for (const log of sliced) {
    let isBuy, tokenAmtRaw, quoteAmtRaw, maker;

    if (pool.version === 'v2') {
      const a = ifaceV2Swap.parseLog(log).args;
      const tokenIn = pool.tokenIsToken0 ? a.amount0In : a.amount1In;
      const tokenOut = pool.tokenIsToken0 ? a.amount0Out : a.amount1Out;
      const quoteIn = pool.tokenIsToken0 ? a.amount1In : a.amount0In;
      const quoteOut = pool.tokenIsToken0 ? a.amount1Out : a.amount0Out;
      isBuy = tokenOut > 0n; // token leaves pool -> trader bought
      tokenAmtRaw = isBuy ? tokenOut : tokenIn;
      quoteAmtRaw = isBuy ? quoteIn : quoteOut;
      maker = a.to;
    } else {
      const a = ifaceV3Swap.parseLog(log).args;
      // signed: positive = into pool, negative = out of pool
      const tokenDelta = pool.tokenIsToken0 ? a.amount0 : a.amount1;
      const quoteDelta = pool.tokenIsToken0 ? a.amount1 : a.amount0;
      isBuy = tokenDelta < 0n; // token leaves pool -> trader bought
      tokenAmtRaw = tokenDelta < 0n ? -tokenDelta : tokenDelta;
      quoteAmtRaw = quoteDelta < 0n ? -quoteDelta : quoteDelta;
      maker = a.recipient;
    }

    const tokenAmt = Number(ethers.formatUnits(tokenAmtRaw, token.decimals));
    const quoteAmt = Number(ethers.formatUnits(quoteAmtRaw, quoteMeta.decimals));
    const price = tokenAmt > 0 ? quoteAmt / tokenAmt : 0;

    if (isBuy) {
      buys++;
      buyVolQuote += quoteAmt;
    } else {
      sells++;
      sellVolQuote += quoteAmt;
    }

    trades.push({
      type: isBuy ? 'buy' : 'sell',
      block: log.blockNumber,
      timestamp: null,
      txHash: log.transactionHash,
      maker: ethers.getAddress(maker),
      tokenAmount: tokenAmt,
      quoteAmount: quoteAmt,
      priceInQuote: price,
    });
  }

  // 2) resolve block timestamps in parallel (chunked to be gentle on the RPC)
  const uniqueBlocks = [...new Set(trades.map((t) => t.block))];
  const tsMap = new Map();
  const CONCURRENCY = 25;
  for (let i = 0; i < uniqueBlocks.length; i += CONCURRENCY) {
    const chunk = uniqueBlocks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (bn) => {
        try {
          const b = await provider().getBlock(bn);
          return [bn, b ? Number(b.timestamp) : null];
        } catch {
          return [bn, null];
        }
      })
    );
    for (const [bn, t] of results) tsMap.set(bn, t);
  }
  for (const t of trades) t.timestamp = tsMap.get(t.block) ?? null;

  return {
    trades,
    totals: {
      totalSwaps: logs.length,
      shown: sliced.length,
      buys,
      sells,
      buyVolumeQuote: buyVolQuote,
      sellVolumeQuote: sellVolQuote,
    },
  };
}

// ---------------------------------------------------------------------------
// Average entry market cap for a given wallet.
// A "buy" by the wallet = a pool Swap (token leaving the pool) whose transaction
// also transfers the token to that wallet (handles router-routed buys too).
// Average is weighted by tokens acquired (= effective cost basis as market cap).
// ---------------------------------------------------------------------------
async function computeEntry(walletInput, token, trades) {
  const wallet = ethers.getAddress(walletInput);
  const walletTopic = ethers.zeroPadValue(wallet, 32);

  // transactions in which the wallet received this token
  const received = await provider().getLogs({
    address: token.address,
    topics: [TRANSFER_TOPIC, null, walletTopic],
    fromBlock: 0,
    toBlock: 'latest',
  });
  const buyTxs = new Set(received.map((l) => l.transactionHash.toLowerCase()));
  const wl = wallet.toLowerCase();

  const buys = trades.filter(
    (t) => t.type === 'buy' && (buyTxs.has(t.txHash.toLowerCase()) || t.maker.toLowerCase() === wl)
  );

  if (buys.length === 0) {
    return { wallet, found: false, buysCount: 0 };
  }

  const supply = token.totalSupplyFormatted;
  let sumTokens = 0;
  let sumQuote = 0;
  let weightedMc = 0;
  let firstTs = null;
  let lastTs = null;

  for (const b of buys) {
    const mc = b.priceInQuote * supply;
    sumTokens += b.tokenAmount;
    sumQuote += b.quoteAmount;
    weightedMc += mc * b.tokenAmount;
    if (b.timestamp) {
      firstTs = firstTs == null ? b.timestamp : Math.min(firstTs, b.timestamp);
      lastTs = lastTs == null ? b.timestamp : Math.max(lastTs, b.timestamp);
    }
  }

  // tokens actually held right now (definitive on-chain balance)
  const balRaw = await balanceOf(token.address, wallet);
  const currentBalance = Number(ethers.formatUnits(balRaw, token.decimals));

  return {
    wallet,
    found: true,
    buysCount: buys.length,
    totalTokensBought: sumTokens,
    totalSpentQuote: sumQuote,
    avgEntryPriceQuote: sumTokens > 0 ? sumQuote / sumTokens : 0,
    avgEntryMcQuote: sumTokens > 0 ? weightedMc / sumTokens : 0,
    currentBalance,
    firstBuyTs: firstTs,
    lastBuyTs: lastTs,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function inspectToken(addressInput, ethUsdOverride = null, walletInput = null) {
  if (!ethers.isAddress(addressInput)) {
    throw new Error(`Invalid token address: ${addressInput}`);
  }
  const address = ethers.getAddress(addressInput);
  const ethUsd = ethUsdOverride != null ? ethUsdOverride : ETH_USD;

  const token = await getErc20(address);
  const pools = await findPools(address);

  const result = {
    token,
    quoteSymbol: 'ETH',
    ethUsd,
    hasPool: pools.length > 0,
    poolsFound: pools.length,
    pricing: null,
    pair: null,
    trades: [],
    totals: null,
    entry: null,
    warnings: [],
  };

  if (pools.length === 0) {
    result.warnings.push('No DEX pool (Uniswap V2 or V3) found for this token — cannot compute market cap or trades.');
    return result;
  }

  const pool = pools[0];
  const quoteMeta = await getErc20(pool.quote);
  // decimals needed for V3 price math
  pool.token0Decimals = pool.tokenIsToken0 ? token.decimals : quoteMeta.decimals;
  pool.token1Decimals = pool.tokenIsToken0 ? quoteMeta.decimals : token.decimals;

  result.quoteSymbol = quoteMeta.symbol;
  result.pair = {
    address: pool.pool,
    dex: pool.version === 'v3' ? `Uniswap V3${pool.fee ? ` (${pool.fee / 10000}% fee)` : ''}` : 'Uniswap V2',
    factory: pool.factory,
    quoteToken: { address: quoteMeta.address, symbol: quoteMeta.symbol, decimals: quoteMeta.decimals },
    createdBlock: pool.createdBlock,
  };

  if (pool.quote.toLowerCase() !== WETH_ADDRESS) {
    result.warnings.push(
      `This token is paired against ${quoteMeta.symbol}, not WETH — values are expressed in ${quoteMeta.symbol}.`
    );
  }

  const pricing = await getPricing(pool, token, quoteMeta);
  result.pricing = {
    ...pricing,
    marketCapUsd: ethUsd != null ? pricing.marketCapQuote * ethUsd : null,
  };

  const { trades, totals } = await getTrades(pool, token, quoteMeta);
  result.trades = trades;
  result.totals = {
    ...totals,
    buyVolumeUsd: ethUsd != null ? totals.buyVolumeQuote * ethUsd : null,
    sellVolumeUsd: ethUsd != null ? totals.sellVolumeQuote * ethUsd : null,
  };

  // optional: average entry market cap for a wallet
  if (walletInput && walletInput.trim()) {
    if (!ethers.isAddress(walletInput.trim())) {
      result.warnings.push(`Invalid wallet address: ${walletInput}`);
    } else {
      const entry = await computeEntry(walletInput.trim(), token, trades);
      if (entry.found) {
        entry.avgEntryMcUsd = ethUsd != null ? entry.avgEntryMcQuote * ethUsd : null;
        entry.totalSpentUsd = ethUsd != null ? entry.totalSpentQuote * ethUsd : null;
        entry.currentMcQuote = result.pricing.marketCapQuote;
        entry.pnlPct =
          entry.avgEntryMcQuote > 0
            ? (result.pricing.marketCapQuote / entry.avgEntryMcQuote - 1) * 100
            : null;

        // P&L on tokens actually held now (uses live balanceOf, not total bought)
        const price = result.pricing.priceInQuote;
        entry.currentValueQuote = entry.currentBalance * price;
        entry.costBasisHeldQuote = entry.currentBalance * entry.avgEntryPriceQuote;
        entry.unrealizedPnlQuote = entry.currentValueQuote - entry.costBasisHeldQuote;
        entry.unrealizedPnlPct =
          entry.costBasisHeldQuote > 0
            ? (entry.currentValueQuote / entry.costBasisHeldQuote - 1) * 100
            : null;
        entry.currentValueUsd = ethUsd != null ? entry.currentValueQuote * ethUsd : null;
        entry.unrealizedPnlUsd = ethUsd != null ? entry.unrealizedPnlQuote * ethUsd : null;
      }
      result.entry = entry;
    }
  }

  return result;
}
