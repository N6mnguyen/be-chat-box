import type { Pool } from 'pg';

export const h: {
  owner: Pool;
  app: Pool;
};

export function setup(): Promise<void>;
export function teardown(): Promise<void>;
