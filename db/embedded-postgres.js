import path from 'node:path';

export async function startEmbeddedPostgres({ name = 'vchat-pg' } = {}) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = 54330 + (process.pid % 1000);
  const databaseDir = path.join(process.env.TMPDIR ?? process.env.TEMP ?? '/tmp', `${name}-${process.pid}`);
  const server = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });
  await server.initialise();
  await server.start();

  return {
    adminUrl: `postgres://postgres:postgres@localhost:${port}/postgres`,
    async stop() {
      await server.stop().catch((error) => {
        if (error.code !== 'EBUSY') {
          throw error;
        }
      });
    },
  };
}
