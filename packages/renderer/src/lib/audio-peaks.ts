/**
 * Loudness of a recording as a row of bars, for its thumbnail. The file is decoded once and the
 * result kept, so a recording that shows in several places costs one decode.
 */
export type AudioPeaks = {
  /** One value per bar, 0 to 1, where 1 is the loudest part of the recording. */
  peaks: number[];
  /** Length in seconds. */
  duration: number;
};

const BARS = 22;
/** Larger recordings keep their icon: decoding holds the whole file in memory as raw samples. */
const MAX_BASE64_LENGTH = 24 * 1024 * 1024;
const MAX_CACHED = 48;
const cache = new Map<string, Promise<AudioPeaks | null>>();

const decode = async (dataBase64: string): Promise<AudioPeaks | null> => {
  if (typeof OfflineAudioContext !== "function" || dataBase64.length > MAX_BASE64_LENGTH) return null;
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  // An offline context decodes without opening an audio device.
  const buffer = await new OfflineAudioContext(1, 1, 44_100).decodeAudioData(bytes.buffer);
  const samples = buffer.getChannelData(0);
  const perBar = Math.max(1, Math.floor(samples.length / BARS));
  // A few hundred samples per bar are enough to find its peak.
  const stride = Math.max(1, Math.floor(perBar / 400));
  const peaks: number[] = [];
  for (let bar = 0; bar < BARS; bar += 1) {
    let peak = 0;
    const stop = Math.min(samples.length, (bar + 1) * perBar);
    for (let index = bar * perBar; index < stop; index += stride) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    peaks.push(peak);
  }
  const loudest = Math.max(...peaks);
  return { peaks: loudest > 0 ? peaks.map((peak) => peak / loudest) : peaks, duration: buffer.duration };
};

/** Peaks of the recording stored under `key`, or null when it cannot be decoded here. */
export const loadAudioPeaks = (key: string, dataBase64: string): Promise<AudioPeaks | null> => {
  let pending = cache.get(key);
  if (!pending) {
    pending = decode(dataBase64).catch(() => null);
    cache.set(key, pending);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  }
  return pending;
};
