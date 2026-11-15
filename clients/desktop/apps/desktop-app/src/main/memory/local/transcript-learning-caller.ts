import {
  MEMORY_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';

/** Host-asserted identity; no interface relay may supply this scheduler caller. */
export const CHAT_LEARNING_SCHEDULER_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-memory-idle-scheduler',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [MEMORY_GRANTS.learn],
};
