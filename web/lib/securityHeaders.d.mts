export const CONNECT_HOSTS: string[];
export const FRAME_HOSTS: string[];
export function contentSecurityPolicy(o?: { dev?: boolean; extraConnect?: string[] }): string;
export function rpcOrigins(env?: Record<string, string | undefined>): string[];
export function securityHeaders(o?: { dev?: boolean; env?: Record<string, string | undefined> }): { source: string; headers: { key: string; value: string }[] }[];
