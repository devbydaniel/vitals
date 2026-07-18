export function requireEnv(name: string): string {
  // eslint-disable-next-line security/detect-object-injection -- name is a caller-provided constant, process.env lookup is safe
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- name is a caller-provided constant, process.env lookup is safe
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}
