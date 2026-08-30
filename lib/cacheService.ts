import redisClient from '../config/redis';

// In-memory fallback cache if Redis is unavailable or disconnecting
const memoryCache = new Map<string, { value: any; expiresAt: number }>();

/**
 * Cache-Aside Helper: Get cached item or execute fetcher and store result
 * @param key Unique cache key string
 * @param ttlSeconds Time to live in seconds
 * @param fetchFn Async function to fetch fresh data if key misses
 */
export async function cacheGetOrSet<T>(
  key: string,
  ttlSeconds: number,
  fetchFn: () => Promise<T>
): Promise<T> {
  // 1. Try Redis cache
  try {
    if (redisClient?.isOpen) {
      const cached = await redisClient.get(key);
      if (cached) {
        return JSON.parse(String(cached));
      }
    }
  } catch (err) {
    // Redis fail-soft: fallback to memory cache
  }

  // 2. Try In-Memory cache fallback
  const memItem = memoryCache.get(key);
  if (memItem && memItem.expiresAt > Date.now()) {
    return memItem.value as T;
  }

  // 3. Cache miss: Execute database query
  const freshData = await fetchFn();

  // 4. Store in Redis & In-Memory cache
  if (freshData !== null && freshData !== undefined) {
    try {
      if (redisClient?.isOpen) {
        await redisClient.setEx(key, ttlSeconds, JSON.stringify(freshData));
      }
    } catch (err) {
      // Ignore redis set error
    }

    memoryCache.set(key, {
      value: freshData,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  return freshData;
}

/**
 * Invalidate a specific cache key or pattern
 */
export async function cacheDel(key: string): Promise<void> {
  memoryCache.delete(key);
  try {
    if (redisClient?.isOpen) {
      await redisClient.del(key);
    }
  } catch (err) {
    // Ignore error
  }
}
