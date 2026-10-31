// Errors as wkhtmltopdf 0.12.6 reports them. It saw the network through
// Qt 4.8's QNetworkReply: its error codes, their names and its HTTP status
// mapping decide the exit code and the last line on stderr
// (src/lib/utilities.cc handleError, src/lib/multipageloader.cc amfinished).

// QNetworkReply::NetworkError.
export const QT_ERRORS: Record<number, string> = {
  0: 'NoError',
  1: 'ConnectionRefusedError',
  2: 'RemoteHostClosedError',
  3: 'HostNotFoundError',
  4: 'TimeoutError',
  5: 'OperationCanceledError',
  6: 'SslHandshakeFailedError',
  7: 'TemporaryNetworkFailureError',
  99: 'UnknownNetworkError',
  101: 'ProxyConnectionRefusedError',
  102: 'ProxyConnectionClosedError',
  103: 'ProxyNotFoundError',
  104: 'ProxyTimeoutError',
  105: 'ProxyAuthenticationRequiredError',
  199: 'UnknownProxyError',
  201: 'ContentAccessDenied',
  202: 'ContentOperationNotPermittedError',
  203: 'ContentNotFoundError',
  204: 'AuthenticationRequiredError',
  205: 'ContentReSendError',
  299: 'UnknownContentError',
  301: 'ProtocolUnknownError',
  302: 'ProtocolInvalidOperationError',
  399: 'ProtocolFailure',
};

// qnetworkaccesshttpbackend.cpp statusCodeFromHttp.
export function qtErrorForHttpStatus(status: number): number {
  switch (status) {
    case 401: return 204;
    case 403: return 202;
    case 404: return 203;
    case 405: return 202;
    case 407: return 105;
    case 418: return 302;
    default:
      if (status > 500) return 301;
      if (status >= 400) return 299;
      return 399;
  }
}

// Chromium's net error names (Network.loadingFailed errorText) to the
// closest QNetworkReply error.
export function qtErrorForChromium(errorText: string): number {
  const e = errorText.replace(/^net::/, '');
  if (e === 'ERR_NAME_NOT_RESOLVED' || e === 'ERR_NAME_RESOLUTION_FAILED' || e === 'ERR_ADDRESS_INVALID') return 3;
  if (e === 'ERR_CONNECTION_REFUSED') return 1;
  if (e === 'ERR_CONNECTION_CLOSED' || e === 'ERR_CONNECTION_RESET' || e === 'ERR_EMPTY_RESPONSE') return 2;
  if (e === 'ERR_TIMED_OUT' || e === 'ERR_CONNECTION_TIMED_OUT') return 4;
  if (e === 'ERR_ABORTED') return 5;
  if (e.startsWith('ERR_SSL') || e.startsWith('ERR_CERT')) return 6;
  if (e === 'ERR_INTERNET_DISCONNECTED' || e === 'ERR_NETWORK_CHANGED') return 7;
  if (e === 'ERR_PROXY_CONNECTION_FAILED') return 101;
  if (e === 'ERR_TUNNEL_CONNECTION_FAILED') return 102;
  if (e === 'ERR_FILE_NOT_FOUND') return 203;
  if (e === 'ERR_ACCESS_DENIED' || e === 'ERR_BLOCKED_BY_CLIENT') return 201;
  if (e === 'ERR_UNKNOWN_URL_SCHEME' || e === 'ERR_DISALLOWED_URL_SCHEME') return 301;
  return 99;
}

// What QNetworkReply::errorString said, for the "Failed to load" lines.
// Qt names the host it did not find for http only: over https, the socket
// has no peer name yet and the message reads "Host  not found" (measured on
// wkhtmltopdf 0.12.6, Linux and Windows).
export function qtErrorString(code: number, url: string, status: number, statusText: string): string {
  const host = (() => {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' ? '' : u.hostname;
    } catch {
      return '';
    }
  })();
  switch (code) {
    case 1: return 'Connection refused';
    case 2: return 'Connection closed';
    case 3: return `Host ${host} not found`;
    case 4: return 'Socket operation timed out';
    case 5: return 'Operation canceled';
    case 6: return 'SSL handshake failed';
    case 204: return 'Host requires authentication';
    case 301: return `Protocol "${(url.split(':')[0] ?? '')}" is unknown`;
    default:
      if (status) return `Error downloading ${url} - server replied: ${statusText}`;
      return 'Unknown error';
  }
}

const HTTP_MESSAGES: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Page not found',
  405: 'Method Not Allowed', 500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable',
  505: 'HTTP Version Not Supported',
};

// errorCode: 0, an HTTP status, or 1000 + a QNetworkReply error. Returns
// the exit code and the line wkhtmltopdf writes, even with --quiet.
export function handleError(success: boolean, errorCode: number): { code: number; line?: string } {
  if (errorCode) {
    const code = errorCode === 404 ? 2 : errorCode === 401 ? 3 : 1;
    if (errorCode < 1000) {
      return { code, line: `Exit with code ${code} due to http error: ${errorCode} ${HTTP_MESSAGES[errorCode] ?? ''}` };
    }
    return { code, line: `Exit with code ${code} due to network error: ${QT_ERRORS[errorCode - 1000] ?? ''}` };
  }
  if (!success) return { code: 1, line: 'Exit with code 1, due to unknown error.' };
  return { code: 0 };
}
