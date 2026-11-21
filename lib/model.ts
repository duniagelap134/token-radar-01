// Token Launch Radar — model (Node 22, standard library only).
//
// One sealed snapshot in, one ranked board out. Every figure is derived from
// the snapshot at runtime: no protocol name is ever special-cased and no
// median is ever hardcoded.
//
// Implied value for a pre-token protocol:
//
//   compMultiple = median(mcap_usd / tvl_usd) over live-token protocols in
//                  the same category; the global median when that category
//                  has fewer than 3 live comps. Clamped to [0.05, 1.0].
//   growthMult   = 1 + clamp(change_7d, -60, 120) / 100 * 0.5
//   maturityMult = 0.6 + min(age_days, 1095) / 1095 * 0.4   (age unknown: 365)
//   breadthMult  = 1 + min(max(chains - 1, 0), 5) * 0.02
//   implied      = max(1, round(tvl_usd * comp * growth * maturity * breadth))
//
// Rankable means: records no token (mcap, gecko_id and symbol all null),
// category outside the wrapped / staked / bridged / exchange set, name with
// no whole word wrapped / staked / staking, name not ending in a version
// marker, name not starting with an exchange brand. The board ranks every
// rankable protocol, strongest implied value first.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-2';
export const LIVE_ROWS = 24;

/** Categories whose products are a wrapped, staked or bridged form of something else, or an exchange. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX =
  /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

const DAY_MS = 86_400_000;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted-by-value list; the average of the two middles when even. */
export function median(values: number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? xs[(n - 1) / 2]! : (xs[n / 2 - 1]! + xs[n / 2]!) / 2;
}

export interface CompTable {
  /** Median mcap/TVL over every live-token protocol in the snapshot. */
  global: number;
  /** Per-category medians, only for categories with at least 3 live comps. */
  byCategory: Map<string, number>;
  /** How many live comps each category has. */
  counts: Map<string, number>;
}

/** Build the comparable-multiples table from the snapshot's live-token protocols. */
export function buildCompTable(snapshot: Snapshot): CompTable {
  const live = snapshot.protocols.filter(
    (p) => typeof p.mcap_usd === 'number' && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const global = median(live.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCategory = new Map<string, number>();
  const counts = new Map<string, number>();
  const groups = new Map<string, number[]>();
  for (const p of live) {
    if (p.category === null) continue;
    const g = groups.get(p.category) ?? [];
    g.push(p.mcap_usd! / p.tvl_usd);
    groups.set(p.category, g);
  }
  for (const [cat, ratios] of groups) {
    counts.set(cat, ratios.length);
    if (ratios.length >= 3) byCategory.set(cat, median(ratios));
  }
  return { global, byCategory, counts };
}

/** A category's comparable multiple: its own median, or the global median when thin. */
export function compMultiple(
  category: string | null,
  table: CompTable,
): { multiple: number; used: 'category' | 'global'; comps: number } {
  if (category !== null && table.byCategory.has(category)) {
    const m = table.byCategory.get(category)!;
    return { multiple: clamp(m, 0.05, 1.0), used: 'category', comps: table.counts.get(category) ?? 0 };
  }
  return {
    multiple: clamp(table.global, 0.05, 1.0),
    used: 'global',
    comps: category === null ? 0 : table.counts.get(category) ?? 0,
  };
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

export interface Score {
  implied: number;
  compMultiple: number;
  compUsed: 'category' | 'global';
  compCount: number;
  growthMultiplier: number;
  maturityMultiplier: number;
  breadthMultiplier: number;
  age: number | null;
}

/** Score one protocol: every multiplier from its own snapshot record. */
export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  table: CompTable,
): Score {
  const comp = compMultiple(p.category, table);
  const growthPct = p.change_7d === null ? 0 : clamp(p.change_7d, -60, 120);
  const growthMultiplier = 1 + (growthPct / 100) * 0.5;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? 365;
  const maturityMultiplier =
    0.6 + (Math.min(ageForModel, 1095) / 1095) * 0.4;
  const breadthMultiplier =
    1 + Math.min(Math.max(p.chains.length - 1, 0), 5) * 0.02;
  const implied = Math.max(
    1,
    Math.round(
      p.tvl_usd *
        comp.multiple *
        growthMultiplier *
        maturityMultiplier *
        breadthMultiplier,
    ),
  );
  return {
    implied,
    compMultiple: comp.multiple,
    compUsed: comp.used,
    compCount: comp.comps,
    growthMultiplier,
    maturityMultiplier,
    breadthMultiplier,
    age,
  };
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORIES.has(p.category as string) &&
    !WRAPPED_WORD.test(p.name) &&
    !VERSIONED_NAME.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  comp_multiple: number;
  comp_source: 'category' | 'global';
  comp_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  model: {
    comp_multiple: number;
    comp_source: 'category' | 'global';
    comp_count: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  comp_multiple: number;
  comp_source: 'category' | 'global';
  comp_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  watchlist: boolean;
  farm_steps: string[];
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  global_comp_multiple: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open so it shows up in the protocol's activity records.`;
  if (
    c.includes('dex') ||
    c.includes('yield') ||
    c.includes('leveraged farm') ||
    c.includes('liquidity')
  )
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open so it shows up in the protocol's activity records.`;
  if (c.includes('bridge'))
    return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside its app so the trip is not an empty hop.`;
  if (c.includes('staking') || c.includes('restak'))
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge, then leave the margin in place.`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${name} and place one real market position, then leave the funds working until the market resolves.`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares in the same wallet.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and keep the position open.`;
  if (c.includes('rwa'))
    return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} through ${name} and hold it in the same wallet.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active in the same wallet.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open so it shows up in the protocol's activity records.`;
}

/** One farm step as a single string carrying its cost and its time. */
function step(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * Derived only from the protocol's own record (category, chains, TVL, age).
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    step(
      'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper, never in a screenshot or a chat.',
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    step(
      action,
      `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      '15 minutes to set up',
    ),
    step(
      'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the wallet looks active across the whole farming window.',
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    step(
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot instead of a single week.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    step(
      'Before you withdraw, open the protocol\u2019s own points or rewards page and claim only from the link it publishes; a link from a stranger is never the claim page.',
      'no fee to check, and never pay to claim',
      '10 minutes',
    ),
    step(
      'Write the wallet, the dates and every transaction hash in a farm log so you can repeat the position later or unwind it cleanly.',
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

/** The ranked board: every rankable protocol, strongest implied value first. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const table = buildCompTable(snapshot);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, table) }));
  scored.sort(
    (a, b) =>
      b.s.implied - a.s.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    comp_multiple: round4(s.compMultiple),
    comp_source: s.compUsed,
    comp_count: s.compCount,
    growth_multiplier: round4(s.growthMultiplier),
    maturity_multiplier: round4(s.maturityMultiplier),
    breadth_multiplier: round4(s.breadthMultiplier),
    model: {
      comp_multiple: round4(s.compMultiple),
      comp_source: s.compUsed,
      comp_count: s.compCount,
      growth_multiplier: round4(s.growthMultiplier),
      maturity_multiplier: round4(s.maturityMultiplier),
      breadth_multiplier: round4(s.breadthMultiplier),
      age_days: s.age,
    },
    farm_steps: farmSteps(p, s.age),
  }));
}

/** The live-token protocols, by market cap, shown apart from the ranked board. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort(
      (a, b) =>
        (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd,
    )
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard needs: the board, the live set, and the model. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const table = buildCompTable(snapshot);
  const watchSet = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    global_comp_multiple: round4(table.global),
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      comp_multiple: r.comp_multiple,
      comp_source: r.comp_source,
      comp_count: r.comp_count,
      growth_multiplier: r.growth_multiplier,
      maturity_multiplier: r.maturity_multiplier,
      breadth_multiplier: r.breadth_multiplier,
      watchlist: watchSet.has(r.slug),
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of))
    throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string')
    throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0)
    throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols))
    throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string'))
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (
      typeof p.slug !== 'string' ||
      typeof p.name !== 'string' ||
      typeof p.tvl_usd !== 'number' ||
      !Number.isFinite(p.tvl_usd)
    ) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains)
        ? p.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: p.tvl_usd,
      change_7d:
        typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd:
        typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0)
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100)
    return `the board holds ${board.length} rows, under the 100-row floor`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++)
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++)
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd)
      return `row ${i + 1} outranks row ${i} on implied value`;
  if (
    board.length >= 2 &&
    board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd
  ) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0)
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.comp_multiple < 0.05 || r.comp_multiple > 1.0)
      return `${r.slug} has comp multiple ${r.comp_multiple} outside [0.05, 1.0]`;
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12)
      return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps)
      if (s.length < 20 || s.length > 600)
        return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

/** The dashboard's whole dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
