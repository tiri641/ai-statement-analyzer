const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function isAllowedServerHost(
  host: string,
  allowNonLoopbackHost: boolean,
): boolean {
  return isLoopbackHost(host) || allowNonLoopbackHost;
}
