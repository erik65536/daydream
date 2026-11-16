/** Builds a world map's land off the game's thread (worldchart.ts), so opening the map never stalls play. */
import { buildChart, type ChartInput } from './worldchart';

self.onmessage = async (e: MessageEvent<{ id: number; input: ChartInput }>) => {
  const { id, input } = e.data;
  try {
    const base = await buildChart(input);
    (self as unknown as Worker).postMessage({ id, base }, [base.owner.buffer, base.land, base.faded]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
