import { Redis } from 'ioredis';

const getRedisClient = () => {
  if (process.env.REDIS_URL) {
    const client = new Redis(process.env.REDIS_URL, {
      tls: {
        rejectUnauthorized: false,
      },
      maxRetriesPerRequest: 3,
    });

    client.on('error', (err: Error) => console.error('Redis Error:', err));
    return client;
  }

  console.warn('REDIS_URL missing; Redis disabled.');
  return null;
};

const redis = getRedisClient();
export default redis;
