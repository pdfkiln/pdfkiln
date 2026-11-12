// A response Chromium keeps from the page (ORB, CORP, CORS) gets no
// Network.responseReceived: its status comes apart, from the network
// service, by Network.responseReceivedExtraInfo, before or after
// Network.loadingFailed. On a slow machine it may come after the page is
// ready: the request stays in flight until its status is read, the
// JavaScript delay bounding the wait. A request blocked before it is sent
// gets no status and holds nothing: one refused by the page's CSP, by its
// preflight, or by local network access (measured on Chromium 157).

export interface Block {
  errorText: string;
  blockedReason?: string;
  corsErrorStatus?: { corsError?: string };
}

// The CORS errors of the response itself; the others (the preflight's, the
// local network's, the request mode's) come before there is one.
const responseCors = new Set([
  'MissingAllowOriginHeader', 'MultipleAllowOriginValues', 'InvalidAllowOriginValue', 'AllowOriginMismatch', 'InvalidAllowCredentials',
  'WildcardOriginNotAllowed',
]);

// Blocked by Chromium rather than failed: read by its status only.
export function isBlock(e: Block): boolean {
  return Boolean(e.blockedReason || e.corsErrorStatus) || e.errorText === 'net::ERR_BLOCKED_BY_ORB';
}

// Blocked once its response came: its status will come too.
export function hadResponse(e: Block): boolean {
  return e.errorText === 'net::ERR_BLOCKED_BY_ORB' || e.errorText.startsWith('net::ERR_BLOCKED_BY_RESPONSE') || responseCors.has(e.corsErrorStatus?.corsError ?? '');
}

// Each response has its status, a redirect's included, the final one last.
const redirect = (status: number) => status >= 300 && status < 400;

export class Withheld {
  private readonly statuses = new Map<string, number>();
  private readonly waiting = new Map<string, (status: number) => void>();

  // The requests in flight, which the JavaScript delay waits for.
  constructor(private readonly inflight: Set<string>) {}

  // Network.responseReceivedExtraInfo.
  status(id: string, status: number): void {
    this.statuses.set(id, status);
    const read = this.waiting.get(id);
    if (!read || redirect(status)) return;
    this.waiting.delete(id);
    this.inflight.delete(id);
    read(status);
  }

  // Network.loadingFailed of a block: its status read now, or when it
  // comes, the request kept in flight until then.
  failed(id: string, e: Block, read: (status: number) => void): void {
    const status = this.statuses.get(id);
    if (status !== undefined && !redirect(status)) return read(status);
    this.waiting.set(id, read);
    if (hadResponse(e)) this.inflight.add(id);
  }
}
