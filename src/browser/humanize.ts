import { config } from "../config.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function jitter(min = config.pace.minMs, max = config.pace.maxMs) {
  return Math.floor(min + Math.random() * (max - min));
}

export const pause = (min?: number, max?: number) => sleep(jitter(min, max));
