import {
  CodexGatewayProxyService as PortableGatewayProxy,
  type CodexGatewayProxyServiceOptions,
} from '@canopy/desktop-shared/node/opencode/gateway-proxy';
import { recordSessionProxyFailure } from './ai-credits-quota-state';

export * from '@canopy/desktop-shared/node/opencode/gateway-proxy';

/** Electron retains its session failure sink; the broker is host independent. */
export class CodexGatewayProxyService extends PortableGatewayProxy {
  constructor(options: CodexGatewayProxyServiceOptions = {}) {
    super({ ...options, recordSessionProxyFailure });
  }
}

let singleton: CodexGatewayProxyService | null = null;
export function getCodexGatewayProxyService(): CodexGatewayProxyService {
  singleton ??= new CodexGatewayProxyService();
  return singleton;
}
