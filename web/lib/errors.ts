/** What the browser sees instead of a raw error. */
export function genericError(status: number): string {
  if (status === 502 || status === 503 || status === 504) return 'NEAR could not be read right now. Try again in a minute.';
  return 'Something went wrong on the server. Try again later.';
}
