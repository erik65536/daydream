/**
 * What building a world takes (shared/rules/estimate.ts), at the server's rates: measured from finished builds once
 * there are enough, the experiments' figures until then. The rates are asked for once a page load.
 */
import { useEffect, useState } from 'react';
import { BUILD_RATES, buildEstimate, type BuildRates, type GameLength, type WorldSize } from '@daydream/shared';
import { api } from '../api';

let asked: Promise<BuildRates> | undefined;

/** The rates estimates are made at. */
export function useBuildRates(): BuildRates {
  const [rates, setRates] = useState<BuildRates>(BUILD_RATES);
  useEffect(() => {
    asked ??= api.buildRates().then((r) => r.rates, () => BUILD_RATES);
    let alive = true;
    void asked.then((r) => alive && setRates(r));
    return () => {
      alive = false;
    };
  }, []);
  return rates;
}

export const useBuildEstimate = (size: WorldSize, length: GameLength) => buildEstimate(size, length, useBuildRates());

/** A span of time said plainly, never under ten minutes: "40 minutes", "1 hour", "1.5 hours"; `short`: "40 min", "1.5 h". */
export function hours(h: number, short = false): string {
  const minutes = Math.max(10, Math.round((h * 60) / 5) * 5);
  if (minutes < 60) return `${minutes} ${short ? 'min' : 'minutes'}`;
  const n = Math.round(h * 2) / 2;
  return `${n} ${short ? 'h' : n === 1 ? 'hour' : 'hours'}`;
}

/** Dollars said plainly: "less than a cent", "$0.85", "$12". */
export const dollars = (usd: number) => (usd < 0.005 ? 'less than a cent' : usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`);
