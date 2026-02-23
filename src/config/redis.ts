import { Redis } from 'ioredis';

const getRedisClient = () => {
  if (process.env.REDIS_URL) {
    const client = new Redis(process.env.REDIS_URL, {
      tls: {
        rejectUnauthorized: false,
      },
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      retryStrategy: (times: number) => {
        if (times > 3) {
          console.error('Redis: max reconnection attempts reached, giving up.');
          return null; // Stop retrying — prevents serverless cold-start hangs
        }
        return Math.min(times * 200, 1000); // Exponential backoff: 200ms, 400ms, 600ms
      },
    });

    client.on('error', (err: Error) => console.error('Redis Error:', err));
    client.on('connect', () => console.log('Redis connected'));

    return client;
  }

  console.warn('REDIS_URL missing; Redis disabled.');
  return null;
};

const redis = getRedisClient();
export default redis;
