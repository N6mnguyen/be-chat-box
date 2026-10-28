export function startEmbeddedPostgres(options?: {
  name?: string;
}): Promise<{
  adminUrl: string;
  stop: () => Promise<void>;
}>;
